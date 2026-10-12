import { z } from "zod";

// AD 스위트의 다른 두 앱(키워드와처·Success AI 광고수집기). 사이드바 앱 전환 메뉴가 이 정의로 상태를 보여 주고,
// 서버(server/suite-apps.ts)가 꺼져 있으면 같은 PC 에서 찾아서 켠다. 주소는 고정 포트(SUITE-DESIGN.md "앱 전환 URL").
export const SUITE_APP_IDS = ["keyword-watcher", "success-ai"] as const;
export const SuiteAppIdSchema = z.enum(SUITE_APP_IDS);
export type SuiteAppId = z.infer<typeof SuiteAppIdSchema>;

export type SuiteAppDef = {
  readonly id: SuiteAppId;
  readonly name: string;
  readonly summary: string;
  readonly host: "127.0.0.1";
  readonly port: number;
  // 같은 PC 에서 앱 폴더를 찾을 때 쓰는 폴더 이름(GitHub 저장소 이름·설치 스크립트가 만드는 이름 순).
  readonly folderNames: readonly string[];
  // 폴더 위치를 직접 지정하는 환경 변수(.env 또는 셸).
  readonly dirEnv: string;
  // 폴더 안에서 서버를 켜는 명령(설치 스크립트·README 와 같은 명령).
  readonly command: string;
  readonly repo: string;
  // 설치가 안 끝났을 때 사용자가 터미널에 붙여 넣을 명령(README 의 설치 절차와 같다).
  readonly installCommand: string;
};
export const SUITE_APPS: Readonly<Record<SuiteAppId, SuiteAppDef>> = {
  "keyword-watcher": {
    id: "keyword-watcher",
    name: "키워드와처",
    summary: "검색량·시장 트렌드 추적",
    host: "127.0.0.1",
    port: 3000,
    folderNames: ["keyword-watcher", "trendwatch"],
    dirEnv: "KEYWORD_WATCHER_DIR",
    command: "bun run start",
    repo: "https://github.com/ghetostyle-ctrl/keyword-watcher",
    installCommand: "bun install && cp -n .env.example .env && bun run build",
  },
  "success-ai": {
    id: "success-ai",
    name: "Success AI 광고수집기",
    summary: "구글·메타 광고 레퍼런스 수집",
    host: "127.0.0.1",
    port: 3001,
    folderNames: ["success_ai", "success-ai"],
    dirEnv: "SUCCESS_AI_DIR",
    command: "npm run dev -- --hostname 127.0.0.1 --port 3001",
    repo: "https://github.com/ghetostyle-ctrl/success_ai",
    installCommand:
      "npm install && cp -n .env.example .env.local && cp -n .env.example .env && npx prisma generate && npx prisma db push",
  },
};
export function suiteAppUrl(id: SuiteAppId): string {
  const app = SUITE_APPS[id];
  return `http://${app.host}:${app.port}/`;
}
// Success AI 의 내보내기 API 기본 주소(가져오기·미디어 다운로드가 쓴다). 3000 은 키워드와처라 Success AI 가 아니다.
export const SUCCESS_AI_DEFAULT_URL = suiteAppUrl("success-ai");

export const SuiteAppStatusSchema = z.object({
  id: SuiteAppIdSchema,
  name: z.string(),
  summary: z.string(),
  port: z.number().int(),
  url: z.string(),
  // 포트에 연결되는지(= 켜져 있는지).
  up: z.boolean(),
  // 같은 PC 에서 찾은 앱 폴더. 못 찾으면 null.
  dir: z.string().nullable(),
  // 폴더는 있는데 의존성 설치(node_modules)가 안 끝났으면 false.
  ready: z.boolean(),
  logFile: z.string().nullable(),
});
export type SuiteAppStatus = z.infer<typeof SuiteAppStatusSchema>;
export const SuiteAppsResponseSchema = z.object({ apps: z.array(SuiteAppStatusSchema) });

export const SUITE_START_REASONS = [
  "running", // 이미 켜져 있어 그대로 연다
  "started", // 이번에 켰고 포트가 열렸다
  "not_found", // 앱 폴더를 못 찾았다(경로를 알려 주거나 설치)
  "not_installed", // 폴더는 있는데 설치가 안 끝났다
  "timeout", // 켰지만 기다리는 동안 포트가 열리지 않았다(로그 확인)
  "launch_failed", // 실행 명령 자체가 실패했다
] as const;
export const SuiteStartResultSchema = SuiteAppStatusSchema.extend({
  started: z.boolean(),
  reason: z.enum(SUITE_START_REASONS),
  message: z.string(),
  // 사용자가 터미널에 붙여 넣을 수 있는 명령(설치 미완료·폴더 없음일 때).
  hint: z.string().nullable(),
});
export type SuiteStartResult = z.infer<typeof SuiteStartResultSchema>;
export const SuiteStartRequestSchema = z.object({
  // 사용자가 직접 알려 준 앱 폴더. 유효하면 저장해 다음부터 먼저 쓴다.
  dir: z.string().trim().min(1).max(500).optional(),
});
export type SuiteStartRequest = z.infer<typeof SuiteStartRequestSchema>;
