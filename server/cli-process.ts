import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { StudioError } from "./errors";

export type CliProcessInput = {
  readonly binary: string;
  readonly args: readonly string[];
  readonly directory: string;
  readonly stdin: string;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
};
export type CliProcessResult = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
};
export type CliRunner = (input: CliProcessInput) => Promise<CliProcessResult>;

// CLI가 자체 로그인 저장소를 읽도록 OS 실행 환경만 전달한다. 앱의 공급자 키는 전달하지 않는다.
export function cliEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = new Set([
    "path",
    "systemroot",
    "windir",
    "comspec",
    "pathext",
    "userprofile",
    "home",
    "homedrive",
    "homepath",
    "appdata",
    "localappdata",
    "temp",
    "tmp",
    "programfiles",
    "programfiles(x86)",
    "systemdrive",
    "lang",
    "lc_all",
    "codex_home",
    "claude_config_dir",
    "ssl_cert_file",
    "ssl_cert_dir",
    "node_extra_ca_certs",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ]);
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => allowed.has(key.toLowerCase())),
  );
}

export const runCliProcess: CliRunner = (input) => {
  input.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const wrapper = /.(cmd|bat|ps1)$/i.test(input.binary);
    const name = basename(input.binary).replace(/.(cmd|bat|ps1)$/i, "");
    const script =
      name === "codex"
        ? join(dirname(input.binary), "node_modules", "@openai", "codex", "bin", "codex.js")
        : name === "claude"
          ? join(dirname(input.binary), "node_modules", "@anthropic-ai", "claude-code", "cli.js")
          : null;
    const node = wrapper ? Bun.which("node") : null;
    if (wrapper && (!script || !existsSync(script) || !node)) {
      reject(
        new StudioError(
          "cli_wrapper",
          "CLI 설치 경로를 확인하세요. Windows에서는 실제 실행 파일 또는 Node.js가 있는 표준 npm 설치가 필요합니다.",
        ),
      );
      return;
    }
    const child = spawn(
      wrapper && node ? node : input.binary,
      [...(wrapper && script ? [script] : []), ...input.args],
      {
        cwd: input.directory,
        windowsHide: true,
        shell: false,
        env: cliEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let failure: StudioError | DOMException | null = null;
    const stop = (error: StudioError | DOMException) => {
      failure = error;
      child.kill();
    };
    const abort = () => stop(new DOMException("Cancelled", "AbortError"));
    const timer = setTimeout(
      () =>
        stop(
          new StudioError(
            "cli_timeout",
            "AI 연결 응답 시간이 초과되었습니다. 사용량과 실행 상태를 확인한 뒤 재개하세요.",
          ),
        ),
      input.timeoutMs ?? 240_000,
    );
    input.signal.addEventListener("abort", abort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", abort);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024)
        stop(new StudioError("cli_output", "AI 연결 응답이 최대 크기를 초과했습니다."));
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE")
        stop(new StudioError("cli_input", "AI 연결에 입력을 전달하지 못했습니다."));
    });
    child.once("error", () => {
      cleanup();
      reject(
        new StudioError(
          "cli_start",
          "AI 실행 파일을 시작하지 못했습니다. 설치 경로와 버전을 확인하세요.",
        ),
      );
    });
    child.once("close", (code) => {
      cleanup();
      if (failure) reject(failure);
      else resolve({ code, stdout: Buffer.concat(chunks).toString("utf8"), stderr });
    });
    child.stdin.end(input.stdin);
    if (input.signal.aborted) abort();
  });
};

export function requireCliSuccess(result: CliProcessResult, label: string): void {
  if (result.code === 0) return;
  const detail = `${result.stderr}\n${result.stdout}`;
  const reason = /rate.limit|usage.limit|limit reached|quota|out of.*usage/i.test(detail)
    ? "사용량 한도에 도달했습니다. 한도 회복 후 재개하세요."
    : /login|log in|authenticat|unauthorized|not logged/i.test(detail)
      ? "로그인이 필요합니다. 해당 도구에서 로그인한 뒤 연결을 확인하세요."
      : "실행에 실패했습니다. 설치 버전·로그인·선택한 모델을 확인하세요.";
  throw new StudioError("cli_exit", `${label}: ${reason}`);
}
