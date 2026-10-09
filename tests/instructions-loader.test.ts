import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODE_CONSTANTS,
  defaultInstructionsRoot,
  derivedTokens,
  fillSection,
  INSTRUCTION_FILES,
  INSTRUCTION_SECTIONS,
  InstructionsError,
  InstructionsLoader,
  instructionsEventMessage,
  instructionsStamp,
  loadInstructions,
  parseSections,
  parseThresholds,
  resolveTokens,
  type SectionSpec,
  sectionJson,
  sectionOf,
  THRESHOLD_NAMES,
  THRESHOLDS_FILE,
} from "../server/instructions";
import {
  COPY_BEAT_MAX_CHARS,
  COPY_BEAT_TARGET_CHARS,
  COPY_CHANGE_WARNING_RATE,
} from "../shared/copy-polish";
import { INFO_GRAPHIC_BAND } from "../shared/flow-info-prompts";
import {
  EXPLAINER_PHASE_SLACK_MS,
  HYBRID_ENDING_IMAGE_MAX_SEC,
} from "../shared/hybrid-script-rules";
import { CAPTION_LEAD_MS } from "../shared/narration-captions";
import {
  EXPLAINER_HOLD_MS,
  SILENCE_GAP_MAX_MS,
  SILENCE_TRIM_MIN_CUT_MS,
  TIMELINE_DEFAULTS,
} from "../shared/render-timeline";
import { VERIFY_FEEDBACK_MAX } from "../shared/script-rules";
import {
  CAPTION_LINE_MAX_CHARS,
  CUT_MAX_SEC,
  EXPLAINER_CUT_MAX_SEC,
  EXPLAINER_MAX_RATIO,
  MOTION_GRAPHIC_MAX_RATIO,
  NARRATION_MAX_CHARS_PER_SEC,
  NARRATION_MIN_CHARS_PER_SEC,
  NARRATION_MIN_SENTENCE_CHARS,
  NARRATION_TARGET_CHARS_PER_SEC,
  SILENT_CUTS_MAX,
  STILL_MAX_SEC,
  SUBJECT_KEY_WORD_MIN_CHARS,
  VEO_HINT_RATIO,
  VEO_MAX_RATIO,
  VIDEO_LONG_MIN_SEC,
  VIDEO_SHORT_MAX_SEC,
  VOICE_GAP_SEC,
} from "../shared/video-script";

// 지시 파일 로더(D2·D3·D4): 절 파서, 토큰 치환, 임계값 범위 검증, mtime 재로드, 마지막 성공본 폴백, digest, root 주입.
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const repoThresholds = () => readFileSync(join(defaultInstructionsRoot(), THRESHOLDS_FILE), "utf8");
function tempRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "studio-instructions-"));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text, "utf8");
  return root;
}
// mtime 을 확실히 바꿔 저장한다(같은 ms 안의 연속 쓰기는 mtime 이 같을 수 있다).
let tick = 0;
function rewrite(root: string, name: string, text: string): void {
  writeFileSync(join(root, name), text, "utf8");
  tick += 2;
  const when = new Date(Date.now() + tick * 1000);
  utimesSync(join(root, name), when, when);
}
const SPECS: readonly SectionSpec[] = [
  { file: "script.md", key: "SCRIPT_PACING_HEAD" },
  { file: "script.md", key: "SCRIPT_OPENING", runtime: ["seconds"] },
  { file: "hybrid.md", key: "EXPLAINER_GRAMMAR" },
  { file: "hybrid.md", key: "HYBRID_PLANNING_RULES" },
  { file: "examples.md", key: "SCENE_PLAN_EXAMPLE_SENTENCE", json: true },
];
const SCRIPT_MD = `# script.md — 설명 글은 첫 머리글 앞에 둔다

## SCRIPT_PACING_HEAD

PACING: target {{COPY_BEAT_TARGET_CHARS}} chars, hard maximum {{COPY_BEAT_MAX_CHARS}}; graphics at most {{MOTION_GRAPHIC_MAX_PERCENT}}%; clips A..{{VEO_SHOTS_MAX}}; phases {{PHASE_TABLE}}.

## SCRIPT_OPENING
Guide {{seconds}}s; total {{VIDEO_MIN_SEC}}–{{VIDEO_MAX_SEC}} seconds.

`;
const HYBRID_MD = `## EXPLAINER_GRAMMAR
R7 a cut lasts 2–{{EXPLAINER_CUT_MAX_SEC}} seconds.

## HYBRID_PLANNING_RULES
HYBRID SCENE PLAN: ending at most {{HYBRID_ENDING_IMAGE_MAX_SEC}} seconds.
{{@EXPLAINER_GRAMMAR}}
`;
const EXAMPLES_MD = `## SCENE_PLAN_EXAMPLE_SENTENCE
{
  "purpose": "mechanism",
  "cuts": [{ "len": 3, "goal": "캡슐 하나에 600밀리그램이 들어 있다" }]
}
`;
const baseFiles = () => ({
  [THRESHOLDS_FILE]: repoThresholds(),
  "script.md": SCRIPT_MD,
  "hybrid.md": HYBRID_MD,
  "examples.md": EXAMPLES_MD,
});

test("parses `## KEY` sections, substitutes thresholds, derived values and code constants, and inlines {{@KEY}} includes", () => {
  const root = tempRoot(baseFiles());
  const loader = new InstructionsLoader({ root, sections: SPECS, now: () => new Date(0) });
  const snapshot = loader.load();
  expect(sectionOf(snapshot, "SCRIPT_PACING_HEAD")).toBe(
    "PACING: target 34 chars, hard maximum 40; graphics at most 40%; clips A..4; phases early 0–3s, mid 3–5.5s, late 5.5–8s.",
  );
  // 소문자 토큰은 로드 때 남고 fillSection 이 채운다
  expect(sectionOf(snapshot, "SCRIPT_OPENING")).toBe("Guide {{seconds}}s; total 30–60 seconds.");
  expect(fillSection(sectionOf(snapshot, "SCRIPT_OPENING"), { seconds: 36 })).toBe(
    "Guide 36s; total 30–60 seconds.",
  );
  expect(() => fillSection(sectionOf(snapshot, "SCRIPT_OPENING"), {})).toThrow(InstructionsError);
  // 포함(include)은 치환이 끝난 절 본문을 그대로 끼운다
  expect(sectionOf(snapshot, "HYBRID_PLANNING_RULES")).toBe(
    "HYBRID SCENE PLAN: ending at most 3 seconds.\nR7 a cut lasts 2–4 seconds.",
  );
  // JSON 절은 파싱되고 JSON.stringify 로 예전 상수와 같은 바이트가 된다
  expect(JSON.stringify(sectionJson(snapshot, "SCENE_PLAN_EXAMPLE_SENTENCE"))).toBe(
    '{"purpose":"mechanism","cuts":[{"len":3,"goal":"캡슐 하나에 600밀리그램이 들어 있다"}]}',
  );
  // 메타데이터
  expect(snapshot.digest).toMatch(/^[0-9a-f]{64}$/u);
  expect(snapshot.loadedAt).toBe("1970-01-01T00:00:00.000Z");
  expect(snapshot.warnings).toEqual([]);
  expect(snapshot.files.map((file) => file.name).sort()).toEqual(
    ["examples.md", "hybrid.md", "script.md", THRESHOLDS_FILE].sort(),
  );
  expect(snapshot.thresholds.COPY_BEAT_TARGET_CHARS).toBe(34);
  expect(instructionsStamp(snapshot)).toEqual({
    instructionsDigest: snapshot.digest,
    instructionsLoadedAt: snapshot.loadedAt,
  });
  expect(instructionsEventMessage(snapshot)).toBe(`지시 파일 ${snapshot.digest.slice(0, 8)} 적용`);
  // 바뀐 파일이 없으면 같은 스냅샷(객체)을 돌려준다
  expect(loader.load()).toBe(snapshot);
});

test("parser keeps inner blank lines, trims the edges, ignores text before the first heading and rejects duplicates", () => {
  const sections = parseSections("intro\n\n## A\n\nline 1\n\nline 2\n\n\n## B\nx\n", "t.md");
  expect(sections.get("A")).toBe("line 1\n\nline 2");
  expect(sections.get("B")).toBe("x");
  expect(sections.has("intro")).toBe(false);
  expect(() => parseSections("## A\n1\n## A\n2\n", "t.md")).toThrow("두 번");
  // 윈도 줄바꿈도 같은 결과
  expect(parseSections("## A\r\nx\r\ny\r\n", "t.md").get("A")).toBe("x\ny");
  const { text, missing } = resolveTokens("{{A}} {{b}} {{C}}", (name) =>
    name === "A" ? 1 : undefined,
  );
  expect(text).toBe("1 {{b}} {{C}}");
  expect(missing).toEqual(["C"]);
});

test("the first load fails loudly: missing section, unresolvable token, wrong file, bad JSON section, undeclared runtime token", () => {
  const cases: readonly [string, Record<string, string>, string][] = [
    ["절 없음", { "hybrid.md": "## EXPLAINER_GRAMMAR\nx\n" }, "HYBRID_PLANNING_RULES 이 없습니다"],
    [
      "토큰 치환 불가",
      { "script.md": SCRIPT_MD.replace("{{VEO_SHOTS_MAX}}", "{{NOT_A_THING}}") },
      "{{NOT_A_THING}}",
    ],
    [
      "다른 파일에 있음",
      {
        "script.md": SCRIPT_MD.replace("## SCRIPT_OPENING", "## X"),
        "hybrid.md": `${HYBRID_MD}\n## SCRIPT_OPENING\ny\n`,
      },
      "script.md 에 있어야",
    ],
    ["JSON 아님", { "examples.md": "## SCENE_PLAN_EXAMPLE_SENTENCE\n{ not json\n" }, "JSON 이어야"],
    [
      "선언 안 된 호출 시점 토큰",
      { "script.md": SCRIPT_MD.replace("{{seconds}}", "{{secondz}}") },
      "{{secondz}}",
    ],
    [
      "빈 절",
      { "hybrid.md": "## EXPLAINER_GRAMMAR\n\n## HYBRID_PLANNING_RULES\nx\n" },
      "비어 있습니다",
    ],
    ["파일 없음", { "examples.md": "" }, "SCENE_PLAN_EXAMPLE_SENTENCE 이 없습니다"],
  ];
  for (const [label, override, message] of cases) {
    const root = tempRoot({ ...baseFiles(), ...override });
    const loader = new InstructionsLoader({ root, sections: SPECS });
    expect(() => loader.load(), label).toThrow(InstructionsError);
    expect(() => loader.load(), label).toThrow(message);
    expect(loader.current, label).toBeNull();
  }
  // 폴더 자체가 없으면 파일마다 읽기 오류
  expect(() =>
    new InstructionsLoader({
      root: join(tmpdir(), "no-such-instructions"),
      sections: SPECS,
    }).load(),
  ).toThrow("읽을 수 없습니다");
});

test("thresholds.json is validated: required names, ranges, relations, unknown names, invalid JSON", () => {
  const parsed = JSON.parse(repoThresholds()) as Record<string, { value: number }>;
  const edit = (name: string, value: number) =>
    JSON.stringify({ ...parsed, [name]: { ...parsed[name], value } });
  expect(() => parseThresholds(edit("CUT_MAX_SEC", 9))).toThrow("허용 범위 [2, 8] 밖");
  expect(() => parseThresholds(edit("COPY_BEAT_TARGET_CHARS", 50))).toThrow(
    "COPY_BEAT_TARGET_CHARS(50) <= COPY_BEAT_MAX_CHARS(40)",
  );
  expect(() => parseThresholds(edit("VIDEO_SHORT_MAX_SEC", 45))).toThrow("<");
  const { CUT_MAX_SEC: _dropped, ...rest } = parsed;
  expect(() => parseThresholds(JSON.stringify(rest))).toThrow("CUT_MAX_SEC 항목이 없습니다");
  expect(() =>
    parseThresholds(
      JSON.stringify({ ...parsed, EXTRA: { value: 1, min: 0, max: 2, description: "x" } }),
    ),
  ).toThrow("알 수 없는 임계값 EXTRA");
  expect(() => parseThresholds("{ broken")).toThrow("JSON 이 아닙니다");
  expect(() =>
    parseThresholds(
      JSON.stringify({ ...parsed, CUT_MAX_SEC: { value: 5, min: 9, max: 8, description: "x" } }),
    ),
  ).toThrow("min(9)이 max(8)보다");
  // 파생 토큰
  const thresholds = parseThresholds(repoThresholds());
  expect(derivedTokens(thresholds)).toMatchObject({
    MOTION_GRAPHIC_MAX_PERCENT: 40,
    VEO_MAX_PERCENT: 50,
    EXPLAINER_MAX_PERCENT: 50,
    INFO_GRAPHIC_BAND_BOTTOM_FREE: 35,
  });
});

test("the repository thresholds.json carries exactly the current code constants", () => {
  const thresholds = parseThresholds(repoThresholds());
  expect(Object.keys(thresholds).sort()).toEqual([...THRESHOLD_NAMES].sort());
  expect(thresholds).toMatchObject({
    COPY_BEAT_TARGET_CHARS,
    COPY_BEAT_MAX_CHARS,
    COPY_CHANGE_WARNING_RATE,
    NARRATION_MIN_CHARS_PER_SEC,
    NARRATION_TARGET_CHARS_PER_SEC,
    NARRATION_MAX_CHARS_PER_SEC,
    NARRATION_MIN_SENTENCE_CHARS,
    VOICE_GAP_SEC,
    CUT_MAX_SEC,
    EXPLAINER_CUT_MAX_SEC,
    EXPLAINER_MAX_RATIO,
    EXPLAINER_HOLD_MS,
    HYBRID_ENDING_IMAGE_MAX_SEC,
    SILENCE_GAP_MAX_MS,
    SILENCE_TRIM_MIN_CUT_MS,
    TIMELINE_SLACK_MS: TIMELINE_DEFAULTS.slackMs,
    TIMELINE_MAX_SPREAD_MS: TIMELINE_DEFAULTS.maxSpreadMs,
    TIMELINE_MAX_EXTEND_MS: TIMELINE_DEFAULTS.maxExtendMs,
    MOTION_GRAPHIC_MAX_RATIO,
    VEO_MAX_RATIO,
    VEO_HINT_RATIO,
    STILL_MAX_SEC,
    SILENT_CUTS_MAX,
    CAPTION_LINE_MAX_CHARS,
    CAPTION_LEAD_MS,
    VERIFY_FEEDBACK_MAX,
    SUBJECT_KEY_WORD_MIN_CHARS,
    VIDEO_SHORT_MAX_SEC,
    VIDEO_LONG_MIN_SEC,
    INFO_GRAPHIC_BAND_TOP: INFO_GRAPHIC_BAND.top,
    INFO_GRAPHIC_BAND_BOTTOM: INFO_GRAPHIC_BAND.bottom,
  });
  // 조립 보유 시간과 대본 규칙의 여유는 같은 값이어야 한다(한 임계값으로 묶는다)
  expect(EXPLAINER_PHASE_SLACK_MS).toBe(EXPLAINER_HOLD_MS);
  // 아직 export 되지 않은 상수(값은 코드 리터럴과 같아야 한다): narration-captions MIN/MAX, script-rules SCENE_HOLD_SEC, video-script NEAR_DUPLICATE_*
  expect(thresholds).toMatchObject({
    CAPTION_MIN_CHARS: 7,
    CAPTION_MIN_MS: 500,
    CAPTION_MAX_MS: 2000,
    SCENE_HOLD_SEC: 2,
    NEAR_DUPLICATE_RATIO: 0.75,
    NEAR_DUPLICATE_MIN_BIGRAMS: 6,
  });
  expect(TIMELINE_DEFAULTS.gapMs).toBe(Math.round(thresholds.VOICE_GAP_SEC * 1000));
  expect(CODE_CONSTANTS["TIMELINE_MAX_TEMPO"]).toBe(1.3);
});

test("a changed file is re-read on the next load; a broken edit keeps the last good snapshot with a warning until it is fixed", () => {
  const root = tempRoot(baseFiles());
  const warnings: string[] = [];
  const loader = new InstructionsLoader({
    root,
    sections: SPECS,
    onWarning: (message) => warnings.push(message),
  });
  const first = loader.load();
  // 값 변경 → 다음 load 가 새 본문·새 digest
  const parsed = JSON.parse(repoThresholds()) as Record<string, { value: number }>;
  rewrite(
    root,
    THRESHOLDS_FILE,
    JSON.stringify({
      ...parsed,
      COPY_BEAT_TARGET_CHARS: { ...parsed["COPY_BEAT_TARGET_CHARS"], value: 24 },
    }),
  );
  const second = loader.load();
  expect(second).not.toBe(first);
  expect(second.digest).not.toBe(first.digest);
  expect(second.thresholds.COPY_BEAT_TARGET_CHARS).toBe(24);
  expect(sectionOf(second, "SCRIPT_PACING_HEAD")).toContain("target 24 chars");
  expect(second.warnings).toEqual([]);
  // 깨진 편집 → 마지막 성공본 유지 + 경고(한국어) + onWarning 1회(같은 원인 반복 호출에도)
  rewrite(root, "hybrid.md", "## EXPLAINER_GRAMMAR\nonly one\n");
  const broken = loader.load();
  expect(broken.digest).toBe(second.digest);
  expect(sectionOf(broken, "HYBRID_PLANNING_RULES")).toBe(
    sectionOf(second, "HYBRID_PLANNING_RULES"),
  );
  expect(broken.warnings).toHaveLength(1);
  expect(broken.warnings[0]).toContain("마지막 성공본");
  expect(broken.warnings[0]).toContain("HYBRID_PLANNING_RULES 이 없습니다");
  expect(broken.warnings[0]).toContain(second.digest.slice(0, 8));
  loader.load();
  loader.load();
  expect(warnings).toHaveLength(1);
  // 다른 원인이면 다시 1회
  rewrite(root, "hybrid.md", "## EXPLAINER_GRAMMAR\n{{NOPE}}\n## HYBRID_PLANNING_RULES\nx\n");
  expect(loader.load().warnings[0]).toContain("{{NOPE}}");
  expect(warnings).toHaveLength(2);
  // 고치면 경고가 사라지고 새 본문이 쓰인다
  rewrite(root, "hybrid.md", HYBRID_MD.replace("R7 a cut", "R7 every cut"));
  const fixed = loader.load();
  expect(fixed.warnings).toEqual([]);
  expect(sectionOf(fixed, "EXPLAINER_GRAMMAR")).toBe("R7 every cut lasts 2–4 seconds.");
  expect(fixed.digest).not.toBe(second.digest);
  // 파일을 지우면 읽기 오류지만 역시 마지막 성공본
  rmSync(join(root, "examples.md"));
  const removed = loader.load();
  expect(removed.warnings[0]).toContain("examples.md: 읽을 수 없습니다");
  expect(sectionJson(removed, "SCENE_PLAN_EXAMPLE_SENTENCE")).toEqual(
    sectionJson(fixed, "SCENE_PLAN_EXAMPLE_SENTENCE"),
  );
});

test("loadInstructions caches one loader per root and the registry is consistent with the file list and README", () => {
  const root = tempRoot(baseFiles());
  const a = loadInstructions({ root, sections: SPECS });
  const b = loadInstructions({ root, sections: SPECS });
  expect(b).toBe(a);
  // 등록부: 파일은 INSTRUCTION_FILES 안, 키는 유일, 모든 파일에 절이 하나 이상
  const keys = INSTRUCTION_SECTIONS.map((item) => item.key);
  expect(new Set(keys).size).toBe(keys.length);
  for (const item of INSTRUCTION_SECTIONS) expect(INSTRUCTION_FILES).toContain(item.file);
  for (const file of INSTRUCTION_FILES)
    expect(
      INSTRUCTION_SECTIONS.some((item) => item.file === file),
      file,
    ).toBe(true);
  // README 는 모든 절 키와 임계값 이름을 표에 적는다(초안 유지 검사)
  const readme = readFileSync(join(defaultInstructionsRoot(), "README.md"), "utf8");
  for (const key of keys) expect(readme, key).toContain(`\`${key}\``);
  for (const name of THRESHOLD_NAMES) expect(readme, name).toContain(`\`${name}\``);
  for (const name of Object.keys(CODE_CONSTANTS)) expect(readme, name).toContain(`\`${name}\``);
});
