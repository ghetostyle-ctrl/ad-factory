import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  SUCCESS_AI_DEFAULT_URL,
  SUITE_APP_IDS,
  SUITE_APPS,
  type SuiteAppDef,
  type SuiteAppId,
  type SuiteAppStatus,
  type SuiteStartResult,
  suiteAppUrl,
} from "../shared/suite-apps";
import { logger } from "./logger";

// AD 스위트의 다른 앱(키워드와처 3000 · Success AI 3001)을 같은 PC 에서 찾고, 꺼져 있으면 켠다.
// 사이드바 메뉴에서 앱을 고르면 화면이 POST /api/suite/apps/:id/start 를 부르고, 포트가 열리면 그 주소로 이동한다.
// 앱 폴더는 (1) 사용자가 알려 줘 저장한 경로 (2) 환경 변수 (3) 통합 설치 폴더(ad-suite) (4) 흔한 위치(Downloads·홈·C:\) 순으로 찾는다.
// 실행은 서버와 분리된 프로세스로 띄우고(창 없음, 로그는 data/logs), 서버는 포트가 열릴 때까지만 기다린다.

export type SuiteLaunch = (app: SuiteAppDef, dir: string, logFile: string) => Promise<void>;
export type SuiteProbe = (host: string, port: number) => Promise<boolean>;
export type SuiteAppsOptions = {
  // AD FACTORY 앱 폴더(통합 설치본은 ad-suite/ad-factory 라 형제 폴더에 다른 앱이 있다).
  readonly appRoot?: string;
  readonly home?: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  // 로그·저장 경로 파일을 두는 data 폴더.
  readonly dataDir?: string;
  readonly probe?: SuiteProbe;
  readonly launch?: SuiteLaunch;
  readonly sleep?: (ms: number) => Promise<void>;
  // 켠 뒤 포트가 열리기를 기다리는 상한(Next.js 첫 컴파일이 느려 기본 90초).
  readonly waitMs?: number;
  readonly pollMs?: number;
};
const SavedDirsSchema = z.record(z.string(), z.string());
const SAVED_FILE = "suite-apps.json";

export function probePort(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ host, port });
    const finish = (up: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      done(up);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

// 서버 프로세스와 분리해 켠다. Windows 는 PowerShell Start-Process(창 없음), 그 밖은 sh + nohup. 둘 다 바로 돌아온다.
export async function launchDetached(
  app: SuiteAppDef,
  dir: string,
  logFile: string,
): Promise<void> {
  const script = resolve(import.meta.dir, "..", "scripts", "start-suite-app.ps1");
  const cmd =
    process.platform === "win32"
      ? [
          "powershell.exe",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script,
          "-Dir",
          dir,
          "-Command",
          app.command,
          "-Log",
          logFile,
        ]
      : [
          "sh",
          "-c",
          `export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; cd "$0" && nohup ${app.command} >> "$1" 2>&1 &`,
          dir,
          logFile,
        ];
  const child = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe", stdin: "ignore" });
  const code = await child.exited;
  if (code !== 0) {
    const stderr = await new Response(child.stderr).text();
    throw new Error(stderr.trim() || `실행 명령이 종료 코드 ${code}로 끝났습니다.`);
  }
}

export class SuiteApps {
  private readonly appRoot: string;
  private readonly home: string;
  private readonly platform: NodeJS.Platform;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly dataDir: string;
  private readonly probe: SuiteProbe;
  private readonly launch: SuiteLaunch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly waitMs: number;
  private readonly pollMs: number;
  // 같은 앱을 동시에 두 번 켜지 않도록 진행 중인 시작을 공유한다.
  private readonly starting = new Map<SuiteAppId, Promise<SuiteStartResult>>();

  constructor(options: SuiteAppsOptions = {}) {
    this.appRoot = options.appRoot ?? resolve(import.meta.dir, "..");
    this.home = options.home ?? homedir();
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.dataDir = options.dataDir ?? resolve(this.appRoot, "data");
    this.probe = options.probe ?? probePort;
    this.launch = options.launch ?? launchDetached;
    this.sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    this.waitMs = options.waitMs ?? 90_000;
    this.pollMs = options.pollMs ?? 1000;
  }

  private savedDirs(): Record<string, string> {
    try {
      const file = join(this.dataDir, SAVED_FILE);
      if (!existsSync(file)) return {};
      return SavedDirsSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      return {};
    }
  }
  private saveDir(id: SuiteAppId, dir: string): void {
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(
      join(this.dataDir, SAVED_FILE),
      `${JSON.stringify({ ...this.savedDirs(), [id]: dir }, null, 2)}\n`,
      "utf8",
    );
  }
  private static isAppDir(dir: string): boolean {
    return existsSync(join(dir, "package.json"));
  }
  // 앱 폴더 후보를 순서대로 돌려준다(존재하는 것만).
  candidates(app: SuiteAppDef): string[] {
    const roots = [
      resolve(this.appRoot, ".."),
      join(this.home, "ad-suite"),
      join(this.home, "Downloads"),
      join(this.home, "Desktop"),
      join(this.home, "Documents"),
      this.home,
      ...(this.platform === "win32" ? ["C:\\"] : []),
    ];
    const list = [
      this.savedDirs()[app.id],
      this.env[app.dirEnv],
      ...roots.flatMap((root) => app.folderNames.map((name) => join(root, name))),
    ];
    const seen = new Set<string>();
    const found: string[] = [];
    for (const item of list) {
      if (!item) continue;
      const dir = resolve(item);
      const key = dir.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (SuiteApps.isAppDir(dir)) found.push(dir);
    }
    return found;
  }
  discover(app: SuiteAppDef): string | null {
    return this.candidates(app)[0] ?? null;
  }
  private logFile(app: SuiteAppDef): string {
    return join(this.dataDir, "logs", `suite-${app.id}.log`);
  }
  async status(id: SuiteAppId): Promise<SuiteAppStatus> {
    const app = SUITE_APPS[id];
    const dir = this.discover(app);
    return {
      id,
      name: app.name,
      summary: app.summary,
      port: app.port,
      url: suiteAppUrl(id),
      up: await this.probe(app.host, app.port),
      dir,
      ready: dir !== null && existsSync(join(dir, "node_modules")),
      logFile: dir === null ? null : this.logFile(app),
    };
  }
  statuses(): Promise<SuiteAppStatus[]> {
    return Promise.all(SUITE_APP_IDS.map((id) => this.status(id)));
  }

  // 켜져 있으면 그대로, 아니면 찾아서 켜고 포트가 열릴 때까지 기다린다. 같은 앱의 동시 요청은 하나의 시작을 같이 기다린다.
  ensureUp(id: SuiteAppId, requestedDir?: string): Promise<SuiteStartResult> {
    const pending = this.starting.get(id);
    if (pending) return pending;
    const task = this.start(id, requestedDir).finally(() => {
      if (this.starting.get(id) === task) this.starting.delete(id);
    });
    this.starting.set(id, task);
    return task;
  }
  private async start(id: SuiteAppId, requestedDir?: string): Promise<SuiteStartResult> {
    const app = SUITE_APPS[id];
    if (requestedDir !== undefined) {
      const dir = resolve(requestedDir);
      if (!isAbsolute(requestedDir) || !SuiteApps.isAppDir(dir))
        return this.result(await this.status(id), {
          reason: "not_found",
          message: `${requestedDir} 에서 ${app.name} 앱(package.json)을 찾지 못했습니다. 앱 폴더의 전체 경로를 적어 주세요.`,
          hint: null,
        });
      this.saveDir(id, dir);
    }
    const before = await this.status(id);
    if (before.up)
      return this.result(before, {
        reason: "running",
        message: `${app.name}가 이미 켜져 있습니다.`,
      });
    if (before.dir === null)
      return this.result(before, {
        reason: "not_found",
        message: `${app.name} 폴더를 이 PC 에서 찾지 못했습니다. 설치했다면 폴더 경로를 알려 주시고, 아직이면 아래 명령으로 설치해 주세요.`,
        hint: `git clone ${app.repo} && cd ${app.folderNames[0]} && ${app.installCommand}`,
      });
    if (!before.ready)
      return this.result(before, {
        reason: "not_installed",
        message: `${app.name} 폴더는 있지만 설치가 끝나지 않았습니다(node_modules 없음). 터미널에서 아래 명령을 한 번 실행한 뒤 다시 눌러 주세요.`,
        hint: `cd "${before.dir}" && ${app.installCommand}`,
      });
    const logFile = this.logFile(app);
    mkdirSync(join(this.dataDir, "logs"), { recursive: true });
    try {
      logger.info({ app: id, dir: before.dir, logFile }, "suite.launch");
      await this.launch(app, before.dir, logFile);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn({ app: id, reason }, "suite.launch_failed");
      return this.result(before, {
        reason: "launch_failed",
        message: `${app.name}를 켜지 못했습니다: ${reason}`,
        hint: `cd "${before.dir}" && ${app.command}`,
      });
    }
    const deadline = Date.now() + this.waitMs;
    while (Date.now() < deadline) {
      await this.sleep(this.pollMs);
      if (await this.probe(app.host, app.port))
        return this.result(await this.status(id), {
          reason: "started",
          started: true,
          message: `${app.name}를 켰습니다.`,
        });
    }
    return this.result(await this.status(id), {
      reason: "timeout",
      started: true,
      message: `${app.name}를 켰지만 ${Math.round(this.waitMs / 1000)}초 안에 응답하지 않았습니다. 잠시 뒤 다시 누르거나 로그를 확인해 주세요: ${logFile}`,
      hint: `cd "${before.dir}" && ${app.command}`,
    });
  }
  private result(
    status: SuiteAppStatus,
    extra: {
      readonly reason: SuiteStartResult["reason"];
      readonly message: string;
      readonly started?: boolean;
      readonly hint?: string | null;
    },
  ): SuiteStartResult {
    return {
      ...status,
      started: extra.started ?? false,
      reason: extra.reason,
      message: extra.message,
      hint: extra.hint ?? null,
    };
  }
}

// Success AI 내보내기 API 주소(가져오기·미디어 다운로드). SUCCESS_AI_URL 로 바꿀 수 있고 기본은 127.0.0.1:3001.
export function successAiBaseUrl(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const raw = env["SUCCESS_AI_URL"]?.trim();
  if (!raw) return SUCCESS_AI_DEFAULT_URL;
  try {
    const url = new URL(raw);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return SUCCESS_AI_DEFAULT_URL;
    return url.origin.endsWith("/") ? url.origin : `${url.origin}/`;
  } catch {
    return SUCCESS_AI_DEFAULT_URL;
  }
}
