import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app";
import { env } from "../server/config";
import { JobStore } from "../server/store";
import { probePort, SuiteApps, successAiBaseUrl } from "../server/suite-apps";
import {
  SUITE_APPS,
  type SuiteAppDef,
  SuiteAppsResponseSchema,
  SuiteStartResultSchema,
} from "../shared/suite-apps";

// 사이드바 앱 전환: 다른 스위트 앱(키워드와처 3000 · Success AI 3001)이 꺼져 있으면 같은 PC 에서 찾아 켜고 포트가 열리면 주소를 돌려준다.
// 실제 실행·포트 검사는 주입한 스텁으로 대신한다(이 테스트는 아무 프로세스도 띄우지 않는다).
const origin = `http://127.0.0.1:${env.PORT}`;
const roots: string[] = [];
const stores: JobStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
// 홈 폴더 모양을 흉내 낸다: home/Downloads/success_ai 에 package.json(+node_modules).
function fakeHome(layout: Record<string, { readonly installed: boolean }>): string {
  const home = tempDir("studio-suite-home-");
  for (const [relative, spec] of Object.entries(layout)) {
    const dir = join(home, relative);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}\n", "utf8");
    if (spec.installed) mkdirSync(join(dir, "node_modules"), { recursive: true });
  }
  return home;
}
type Launched = { readonly app: SuiteAppDef; readonly dir: string; readonly logFile: string };
function harness(options: {
  readonly home: string;
  readonly up?: Set<number>;
  readonly launchFails?: boolean;
  readonly comesUpAfterLaunch?: boolean;
  readonly env?: Record<string, string>;
}) {
  const up = options.up ?? new Set<number>();
  const launched: Launched[] = [];
  const dataDir = tempDir("studio-suite-data-");
  const suite = new SuiteApps({
    appRoot: join(options.home, "ad-factory-standalone"),
    home: options.home,
    platform: "linux",
    env: options.env ?? {},
    dataDir,
    probe: async (_host, port) => up.has(port),
    launch: async (app, dir, logFile) => {
      launched.push({ app, dir, logFile });
      if (options.launchFails) throw new Error("npm: command not found");
      if (options.comesUpAfterLaunch ?? true) up.add(app.port);
    },
    sleep: async () => undefined,
    waitMs: 50,
    pollMs: 10,
  });
  return { suite, launched, up, dataDir };
}

test("probePort reports a listening local port as up and a closed one as down", async () => {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data() {},
      open(socket) {
        socket.end();
      },
    },
  });
  try {
    expect(await probePort("127.0.0.1", server.port)).toBe(true);
  } finally {
    server.stop(true);
  }
  expect(await probePort("127.0.0.1", server.port)).toBe(false);
});

test("finds the app folder in the common install places and reports installed/ready state", async () => {
  const home = fakeHome({
    "Downloads/success_ai": { installed: true },
    "ad-suite/keyword-watcher": { installed: false },
  });
  const { suite } = harness({ home, up: new Set([3000]) });
  const [watcher, successAi] = await suite.statuses();
  expect(successAi?.id).toBe("success-ai");
  expect(successAi?.up).toBe(false);
  expect(successAi?.dir).toBe(join(home, "Downloads", "success_ai"));
  expect(successAi?.ready).toBe(true);
  expect(successAi?.url).toBe("http://127.0.0.1:3001/");
  expect(watcher?.id).toBe("keyword-watcher");
  expect(watcher?.up).toBe(true);
  expect(watcher?.dir).toBe(join(home, "ad-suite", "keyword-watcher"));
  expect(watcher?.ready).toBe(false);
});

test("the sibling folder of the suite install and the env var come before the common places", async () => {
  const home = fakeHome({
    "Downloads/success_ai": { installed: true },
    "ad-factory-standalone/../success_ai": { installed: true },
    "elsewhere/my-success": { installed: true },
  });
  const sibling = harness({ home });
  expect(sibling.suite.discover(SUITE_APPS["success-ai"])).toBe(join(home, "success_ai"));
  const viaEnv = harness({ home, env: { SUCCESS_AI_DIR: join(home, "elsewhere", "my-success") } });
  expect(viaEnv.suite.discover(SUITE_APPS["success-ai"])).toBe(
    join(home, "elsewhere", "my-success"),
  );
});

test("an app that is already up is opened without launching anything", async () => {
  const home = fakeHome({ "Downloads/success_ai": { installed: true } });
  const { suite, launched } = harness({ home, up: new Set([3001]) });
  const result = await suite.ensureUp("success-ai");
  expect(result.reason).toBe("running");
  expect(result.up).toBe(true);
  expect(result.started).toBe(false);
  expect(launched).toHaveLength(0);
});

test("a stopped app is launched once from its folder and reported up when the port opens", async () => {
  const home = fakeHome({ "Downloads/success_ai": { installed: true } });
  const { suite, launched } = harness({ home });
  const [first, second] = await Promise.all([
    suite.ensureUp("success-ai"),
    suite.ensureUp("success-ai"),
  ]);
  expect(first.reason).toBe("started");
  expect(first.up).toBe(true);
  expect(first.started).toBe(true);
  expect(first.url).toBe("http://127.0.0.1:3001/");
  expect(second).toEqual(first);
  expect(launched).toHaveLength(1);
  expect(launched[0]?.dir).toBe(join(home, "Downloads", "success_ai"));
  expect(launched[0]?.app.command).toBe("npm run dev -- --hostname 127.0.0.1 --port 3001");
  expect(launched[0]?.logFile.endsWith(join("logs", "suite-success-ai.log"))).toBe(true);
});

test("missing folder, unfinished install, failed launch and timeout each explain what to do without launching twice", async () => {
  const nowhere = harness({ home: fakeHome({}) });
  const notFound = await nowhere.suite.ensureUp("success-ai");
  expect(notFound.reason).toBe("not_found");
  expect(notFound.up).toBe(false);
  expect(notFound.hint).toContain("git clone https://github.com/ghetostyle-ctrl/success_ai");
  expect(nowhere.launched).toHaveLength(0);

  const bare = harness({ home: fakeHome({ success_ai: { installed: false } }) });
  const notInstalled = await bare.suite.ensureUp("success-ai");
  expect(notInstalled.reason).toBe("not_installed");
  expect(notInstalled.hint).toContain("npm install");
  expect(bare.launched).toHaveLength(0);

  const broken = harness({
    home: fakeHome({ success_ai: { installed: true } }),
    launchFails: true,
  });
  const failed = await broken.suite.ensureUp("success-ai");
  expect(failed.reason).toBe("launch_failed");
  expect(failed.message).toContain("npm: command not found");
  expect(failed.hint).toContain("npm run dev");

  const slow = harness({
    home: fakeHome({ success_ai: { installed: true } }),
    comesUpAfterLaunch: false,
  });
  const timeout = await slow.suite.ensureUp("success-ai");
  expect(timeout.reason).toBe("timeout");
  expect(timeout.started).toBe(true);
  expect(timeout.up).toBe(false);
  expect(timeout.message).toContain("suite-success-ai.log");
  expect(slow.launched).toHaveLength(1);
});

test("a folder the user points at is validated, remembered in data/suite-apps.json and used first", async () => {
  const home = fakeHome({ "odd/place/success_ai": { installed: true } });
  const { suite, launched, dataDir } = harness({ home });
  const wrong = await suite.ensureUp("success-ai", join(home, "odd"));
  expect(wrong.reason).toBe("not_found");
  expect(wrong.message).toContain("package.json");
  const relative = await suite.ensureUp("success-ai", "odd/place/success_ai");
  expect(relative.reason).toBe("not_found");
  expect(launched).toHaveLength(0);
  const right = await suite.ensureUp("success-ai", join(home, "odd", "place", "success_ai"));
  expect(right.reason).toBe("started");
  expect(launched[0]?.dir).toBe(join(home, "odd", "place", "success_ai"));
  const saved = JSON.parse(readFileSync(join(dataDir, "suite-apps.json"), "utf8")) as Record<
    string,
    string
  >;
  expect(saved["success-ai"]).toBe(join(home, "odd", "place", "success_ai"));
  const again = new SuiteApps({
    appRoot: join(home, "ad-factory-standalone"),
    home,
    platform: "linux",
    env: {},
    dataDir,
    probe: async () => false,
    launch: async () => undefined,
  });
  expect(again.discover(SUITE_APPS["success-ai"])).toBe(join(home, "odd", "place", "success_ai"));
});

test("GET /api/suite/apps and POST /api/suite/apps/:id/start are wired with the same-origin guard", async () => {
  const home = fakeHome({ "Downloads/success_ai": { installed: true } });
  const store = new JobStore(tempDir("studio-suite-store-"));
  stores.push(store);
  const app = createApp(store, undefined, undefined, {
    suite: {
      home,
      appRoot: join(home, "ad-factory-standalone"),
      platform: "linux",
      env: {},
      probe: async (_host, port) => port === 3000,
      launch: async () => undefined,
      sleep: async () => undefined,
      waitMs: 20,
      pollMs: 5,
    },
  });
  const list = await app.request(`${origin}/api/suite/apps`);
  expect(list.status).toBe(200);
  const apps = SuiteAppsResponseSchema.parse(await list.json()).apps;
  expect(apps.map((item) => [item.id, item.up])).toEqual([
    ["keyword-watcher", true],
    ["success-ai", false],
  ]);
  const noOrigin = await app.request(`${origin}/api/suite/apps/success-ai/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(noOrigin.status).toBe(403);
  const unknown = await app.request(`${origin}/api/suite/apps/other/start`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: origin },
    body: "{}",
  });
  expect(unknown.status).toBe(404);
  const started = await app.request(`${origin}/api/suite/apps/success-ai/start`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: origin },
    body: "{}",
  });
  expect(started.status).toBe(200);
  const result = SuiteStartResultSchema.parse(await started.json());
  // 스텁 포트 검사는 3001 을 끝까지 닫힌 것으로 보므로 timeout 으로 돌아온다(실행 자체는 1회 요청됨).
  expect(result.reason).toBe("timeout");
  expect(result.started).toBe(true);
  expect(result.dir).toBe(join(home, "Downloads", "success_ai"));
});

test("Success AI export base URL defaults to 3001 and only accepts loopback overrides", () => {
  expect(successAiBaseUrl({})).toBe("http://127.0.0.1:3001/");
  expect(successAiBaseUrl({ SUCCESS_AI_URL: "http://localhost:3101" })).toBe(
    "http://localhost:3101/",
  );
  expect(successAiBaseUrl({ SUCCESS_AI_URL: "http://evil.test:3001" })).toBe(
    "http://127.0.0.1:3001/",
  );
  expect(successAiBaseUrl({ SUCCESS_AI_URL: "not a url" })).toBe("http://127.0.0.1:3001/");
  expect(new URL("api/references/export", successAiBaseUrl({})).href).toBe(
    "http://127.0.0.1:3001/api/references/export",
  );
});
