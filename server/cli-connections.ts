import { z } from "zod";
import type { CliConnection, CliConnections } from "../shared/cli-connections";
import { type CliRunner, runCliProcess } from "./cli-process";
import { publicError } from "./errors";
import { claudeCodeBin, codexBin } from "./provider-environment";

export async function checkCliConnection(input: {
  readonly provider: "codex" | "claudeCode";
  readonly binary: string | null;
  readonly directory: string;
  readonly run?: CliRunner;
}): Promise<CliConnection> {
  if (!input.binary)
    return {
      installed: false,
      version: null,
      authentication: "unavailable",
      message: "설치된 실행 파일을 찾을 수 없습니다. 설치 후 앱을 다시 실행하세요.",
    };
  const run = input.run ?? runCliProcess;
  const task = {
    binary: input.binary,
    directory: input.directory,
    stdin: "",
    signal: new AbortController().signal,
    timeoutMs: 15_000,
  };
  try {
    const [version, auth] = await Promise.all([
      run({ ...task, args: ["--version"] }),
      run({
        ...task,
        args: input.provider === "codex" ? ["login", "status"] : ["auth", "status", "--json"],
      }),
    ]);
    const versionText = version.code === 0 ? version.stdout.trim().slice(0, 100) : null;
    const claude =
      input.provider === "claudeCode"
        ? z.object({ loggedIn: z.boolean() }).safeParse(JSON.parse(auth.stdout || "{}"))
        : null;
    const ready =
      input.provider === "codex"
        ? auth.code === 0 &&
          !/not logged/i.test(auth.stdout + auth.stderr) &&
          /logged in/i.test(`${auth.stdout}\n${auth.stderr}`)
        : auth.code === 0 && claude?.success === true && claude.data.loggedIn;
    const loggedOut =
      input.provider === "codex"
        ? /not logged|log in|login required/i.test(`${auth.stdout}\n${auth.stderr}`)
        : claude?.success === true && !claude.data.loggedIn;
    return {
      installed: true,
      version: versionText,
      authentication: ready ? "ready" : loggedOut ? "login_required" : "unknown",
      message: ready
        ? "로그인 확인 완료 · 실제 모델 생성은 아직 실행하지 않았습니다."
        : loggedOut
          ? "해당 도구에서 로그인한 뒤 다시 확인하세요."
          : "로그인 상태를 확인하지 못했습니다. 설치 버전과 도구 실행 상태를 확인하세요.",
    };
  } catch (error) {
    // 연결 확인 경계: CLI의 원시 응답에는 계정 정보가 있어 공개 오류 문구만 반환한다.
    if (!(error instanceof Error)) throw error;
    return {
      installed: true,
      version: null,
      authentication: "unknown",
      message: publicError(error),
    };
  }
}
export async function checkCliConnections(directory: string): Promise<CliConnections> {
  const [codex, claudeCode] = await Promise.all([
    checkCliConnection({ provider: "codex", binary: codexBin, directory }),
    checkCliConnection({ provider: "claudeCode", binary: claudeCodeBin, directory }),
  ]);
  return { codex, claudeCode, checkedAt: new Date().toISOString() };
}
