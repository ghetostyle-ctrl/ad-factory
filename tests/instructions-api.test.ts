import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createApp } from "../server/app";
import { env } from "../server/config";
import { defaultInstructionsRoot, type SectionSpec, THRESHOLDS_FILE } from "../server/instructions";
import { instructionsStatus } from "../server/instructions-status";
import { JobStore } from "../server/store";
import { InstructionsStatusSchema } from "../shared/instructions-status";

// GET /api/instructions(D6): 파일 목록·해시·마지막 로드·경고·임계값·절 KEY 와 글자 수를 돌려주고 절 본문은 보내지 않는다.
// 로더는 임시 폴더와 작은 절 목록을 주입해 돌린다(저장소의 instructions/*.md 와 무관).
const origin = `http://127.0.0.1:${env.PORT}`;
const roots: string[] = [];
const stores: JobStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const SPECS: readonly SectionSpec[] = [
  { file: "script.md", key: "SCRIPT_PACING_HEAD" },
  { file: "script.md", key: "SCRIPT_OPENING", runtime: ["seconds"] },
  { file: "hybrid.md", key: "EXPLAINER_GRAMMAR" },
  { file: "examples.md", key: "SCENE_PLAN_EXAMPLE_SENTENCE", json: true },
];
const SCRIPT_MD = `## SCRIPT_PACING_HEAD
PACING: target {{COPY_BEAT_TARGET_CHARS}} chars, hard maximum {{COPY_BEAT_MAX_CHARS}}.

## SCRIPT_OPENING
Guide {{seconds}}s; total {{VIDEO_MIN_SEC}}–{{VIDEO_MAX_SEC}} seconds.
`;
const HYBRID_MD = "## EXPLAINER_GRAMMAR\nR7 a cut lasts 2–{{EXPLAINER_CUT_MAX_SEC}} seconds.\n";
const EXAMPLES_MD = '## SCENE_PLAN_EXAMPLE_SENTENCE\n{ "purpose": "mechanism" }\n';
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
function instructionsRoot(files: Record<string, string>): string {
  const root = tempDir("studio-instructions-api-");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text, "utf8");
  return root;
}
const baseFiles = () => ({
  [THRESHOLDS_FILE]: readFileSync(join(defaultInstructionsRoot(), THRESHOLDS_FILE), "utf8"),
  "script.md": SCRIPT_MD,
  "hybrid.md": HYBRID_MD,
  "examples.md": EXAMPLES_MD,
});
// mtime 을 확실히 바꿔 저장한다(같은 ms 안의 연속 쓰기는 mtime 이 같을 수 있다).
let tick = 0;
function rewrite(root: string, name: string, text: string): void {
  writeFileSync(join(root, name), text, "utf8");
  tick += 2;
  const when = new Date(Date.now() + tick * 1000);
  utimesSync(join(root, name), when, when);
}
function appFor(root: string) {
  const store = new JobStore(tempDir("studio-instructions-store-"));
  stores.push(store);
  return createApp(store, undefined, undefined, {
    instructions: { root, sections: SPECS, now: () => new Date(0) },
  });
}
const fetchStatus = async (app: ReturnType<typeof createApp>) => {
  const response = await app.request(`${origin}/api/instructions`);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const body: unknown = await response.json();
  return { body, status: InstructionsStatusSchema.parse(body) };
};

test("GET /api/instructions lists files, digests, load time, thresholds and section keys without section bodies", async () => {
  const root = instructionsRoot(baseFiles());
  const app = appFor(root);
  const { body, status } = await fetchStatus(app);
  expect(status.folder).toBe(basename(root));
  expect(status.loaded).toBe(true);
  expect(status.digest).toMatch(/^[0-9a-f]{64}$/u);
  expect(status.loadedAt).toBe("1970-01-01T00:00:00.000Z");
  expect(status.warnings).toEqual([]);
  expect(status.files.map((file) => file.name).sort()).toEqual(
    ["examples.md", "hybrid.md", "script.md", THRESHOLDS_FILE].sort(),
  );
  for (const file of status.files) {
    expect(file.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(file.size).toBeGreaterThan(0);
    expect(Number.isNaN(new Date(file.modifiedAt).getTime())).toBe(false);
  }
  // 절은 KEY·파일·글자 수·호출 시점 토큰만, 본문은 없다
  expect(status.sections.map((section) => section.key)).toEqual(SPECS.map((spec) => spec.key));
  const opening = status.sections.find((section) => section.key === "SCRIPT_OPENING");
  expect(opening).toMatchObject({ file: "script.md", runtime: ["seconds"], json: false });
  expect(opening?.chars).toBe("Guide {{seconds}}s; total 30–60 seconds.".length);
  expect(
    status.sections.find((section) => section.key === "SCENE_PLAN_EXAMPLE_SENTENCE"),
  ).toMatchObject({ json: true, runtime: [] });
  const text = JSON.stringify(body);
  expect(text).not.toContain("PACING: target");
  expect(text).not.toContain("R7 a cut");
  // 임계값은 파일 값 그대로
  expect(status.thresholds["COPY_BEAT_TARGET_CHARS"]).toBe(34);
  expect(status.thresholds["EXPLAINER_CUT_MAX_SEC"]).toBe(4);
  expect(Object.keys(status.thresholds).length).toBeGreaterThan(30);
  // 허용 범위·설명도 함께(카드가 "값 (min–max) — 설명" 으로 그린다)
  expect(status.thresholdDetails["EXPLAINER_CUT_MAX_SEC"]).toMatchObject({
    value: 4,
    min: 2,
    max: 8,
  });
  expect(status.thresholdDetails["EXPLAINER_CUT_MAX_SEC"]?.description.length).toBeGreaterThan(0);
});

test("after a broken edit the status keeps the last good digest and reports the reason; a fix clears it", async () => {
  const root = instructionsRoot(baseFiles());
  const app = appFor(root);
  const first = (await fetchStatus(app)).status;
  rewrite(root, "script.md", SCRIPT_MD.replace("## SCRIPT_OPENING", "## RENAMED"));
  const broken = (await fetchStatus(app)).status;
  expect(broken.loaded).toBe(true);
  expect(broken.digest).toBe(first.digest);
  expect(broken.warnings).toHaveLength(1);
  expect(broken.warnings[0]).toContain("마지막 성공본");
  expect(broken.warnings[0]).toContain("SCRIPT_OPENING");
  // 임계값 범위 밖도 같은 방식으로 경고로 남고 성공본은 유지된다
  const parsed = JSON.parse(baseFiles()[THRESHOLDS_FILE]) as Record<string, { value: number }>;
  rewrite(
    root,
    THRESHOLDS_FILE,
    JSON.stringify({ ...parsed, CUT_MAX_SEC: { ...parsed["CUT_MAX_SEC"], value: 99 } }),
  );
  const outOfRange = (await fetchStatus(app)).status;
  expect(outOfRange.loaded).toBe(true);
  expect(outOfRange.thresholds["CUT_MAX_SEC"]).toBe(5);
  expect(outOfRange.warnings[0]).toContain("허용 범위");
  rewrite(root, THRESHOLDS_FILE, baseFiles()[THRESHOLDS_FILE]);
  rewrite(root, "script.md", `${SCRIPT_MD}\n`);
  const fixed = (await fetchStatus(app)).status;
  expect(fixed.loaded).toBe(true);
  expect(fixed.warnings).toEqual([]);
  expect(fixed.digest).not.toBe(first.digest);
});

test("a first load that fails answers 200 with loaded=false, the reasons and the files that do exist", async () => {
  const partial = instructionsRoot({
    [THRESHOLDS_FILE]: baseFiles()[THRESHOLDS_FILE],
    "script.md": SCRIPT_MD,
  });
  const { status } = await fetchStatus(appFor(partial));
  expect(status.loaded).toBe(false);
  expect(status.digest).toBeNull();
  expect(status.loadedAt).toBeNull();
  expect(status.sections).toEqual([]);
  expect(status.thresholds).toEqual({});
  expect(status.files.map((file) => file.name).sort()).toEqual(
    ["script.md", THRESHOLDS_FILE].sort(),
  );
  expect(status.warnings.some((warning) => warning.includes("hybrid.md"))).toBe(true);
  expect(status.warnings.some((warning) => warning.includes("examples.md"))).toBe(true);
  // 폴더 자체가 없어도 500 이 아니다
  const missing = instructionsStatus({
    root: join(tmpdir(), "no-such-instructions-folder"),
    sections: SPECS,
  });
  expect(missing.loaded).toBe(false);
  expect(missing.files).toEqual([]);
  expect(missing.warnings.length).toBeGreaterThan(0);
  expect(missing.warnings[0]).toContain("읽을 수 없습니다");
});

test("the status route is same-origin only", async () => {
  const app = appFor(instructionsRoot(baseFiles()));
  const foreign = await app.request(`http://evil.example:${env.PORT}/api/instructions`);
  expect(foreign.status).toBe(403);
});
