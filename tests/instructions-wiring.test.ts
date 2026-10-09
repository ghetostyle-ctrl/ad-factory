import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyRhythmInstruction } from "../server/copy-instructions";
import {
  defaultInstructionsRoot,
  InstructionsLoader,
  instructionsEventMessage,
  loadInstructions,
  THRESHOLDS_FILE,
} from "../server/instructions";
import { videoScriptInstructions } from "../server/script-instructions";
import { writeVideoScript } from "../server/script-writer";
import { prepareVideoPlanning, videoPlanningInstructions } from "../server/video-planning";
import { generateVideoScript, reviewVideoScript } from "../server/video-scripts";
import type { CreativePlan } from "../shared/creative-plan";
import { planningFixture, sourceReference, sourceStrategy } from "./source-planning-fixture";
import { planningHttpFixture } from "./video-planning-http-fixture";

// 지시 파일 연결(사용자 결정 2026-10-07): 기획·대본·검토·카피 프롬프트는 instructions/*.md 절로 조립된다(분리 전과 같은 바이트인지는
// tests/instructions-golden.test.ts). 여기서는 (1) 파일을 고치면 다음 호출부터 바뀌고(재시작 없음), (2) 깨진 편집은 마지막 성공본으로
// 같은 출력을 내며 경고를 남기고, (3) 대본 검토 기록과 기획 산출물에 그때 읽은 지시 파일 해시가 남는지(D5) 확인한다. 모델 호출 없음.
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
// 저장소의 instructions/ 를 임시 폴더로 복사해 그 폴더만 고친다.
function tempInstructions(): string {
  const root = mkdtempSync(join(tmpdir(), "studio-instructions-wiring-"));
  roots.push(root);
  cpSync(defaultInstructionsRoot(), root, { recursive: true });
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
type Hypothesis = CreativePlan["hypotheses"][number];
const scriptInput = (hypothesis: Hypothesis) => ({
  seconds: 36,
  hypothesis,
  hasClips: false,
  infoClips: true,
  hybrid: true,
});

test("editing a section or a threshold changes the next prompt; a broken edit keeps the last good prompt and leaves a warning", () => {
  const fixture = planningHttpFixture();
  try {
    const { hypothesis } = fixture;
    const root = tempInstructions();
    const loader = new InstructionsLoader({ root });
    const first = loader.load();
    expect(first.warnings).toEqual([]);
    const baseline = videoScriptInstructions(scriptInput(hypothesis), first);
    // 복사본은 저장소 파일과 같은 프롬프트를 만든다
    expect(baseline).toBe(videoScriptInstructions(scriptInput(hypothesis), loadInstructions()));
    // (1) 절 본문 수정 → 다음 호출의 프롬프트가 바뀐다
    const scriptMd = readFileSync(join(root, "script.md"), "utf8");
    expect(scriptMd).toContain("SHAPE: subjects[] (who and what appears)");
    rewrite(
      root,
      "script.md",
      scriptMd.replace(
        "SHAPE: subjects[] (who and what appears)",
        "SHAPE (edited): subjects[] (who and what appears)",
      ),
    );
    const edited = videoScriptInstructions(scriptInput(hypothesis), loader.load());
    expect(edited).not.toBe(baseline);
    expect(edited).toContain("SHAPE (edited): subjects[] (who and what appears)");
    expect(baseline).not.toContain("SHAPE (edited)");
    // 임계값 수정 → PACING 머리·환산표·리듬 규칙이 같이 바뀐다
    const thresholds = JSON.parse(readFileSync(join(root, THRESHOLDS_FILE), "utf8")) as Record<
      string,
      { value: number }
    >;
    rewrite(
      root,
      THRESHOLDS_FILE,
      JSON.stringify({
        ...thresholds,
        COPY_BEAT_TARGET_CHARS: { ...thresholds["COPY_BEAT_TARGET_CHARS"], value: 24 },
      }),
    );
    const retuned = loader.load();
    expect(retuned.thresholds.COPY_BEAT_TARGET_CHARS).toBe(24);
    const retunedPrompt = videoScriptInstructions(scriptInput(hypothesis), retuned);
    expect(retunedPrompt).toContain("target 24 Korean characters including spaces");
    expect(retunedPrompt).toContain("24자 ≈");
    expect(copyRhythmInstruction(false, retuned)).toContain("Target 24 Korean characters");
    expect(videoPlanningInstructions("hybrid_explainer_v1", retuned)).toContain(
      "Target 24 Korean characters",
    );
    // (2) 깨진 편집(절 머리글 이름 변경) → 마지막 성공본 + 경고, 프롬프트는 그대로
    const reviewMd = readFileSync(join(root, "review.md"), "utf8");
    rewrite(root, "review.md", reviewMd.replace("## REVIEW_RULE_7", "## REVIEW_RULE_SEVEN"));
    const broken = loader.load();
    expect(broken.digest).toBe(retuned.digest);
    expect(broken.warnings).toHaveLength(1);
    expect(broken.warnings[0]).toContain("마지막 성공본");
    expect(broken.warnings[0]).toContain("REVIEW_RULE_7");
    expect(videoScriptInstructions(scriptInput(hypothesis), broken)).toBe(retunedPrompt);
    expect(videoPlanningInstructions("immersive_explanations_v1", broken)).toBe(
      videoPlanningInstructions("immersive_explanations_v1", retuned),
    );
    // 고치면 경고가 사라진다
    rewrite(root, "review.md", reviewMd);
    expect(loader.load().warnings).toEqual([]);
  } finally {
    fixture.close();
  }
});

test("the written script review and the creative plan record the instructions digest (D5) with an event naming it", async () => {
  const fixture = planningHttpFixture();
  try {
    const { store, job, hypothesis, connection } = fixture;
    const result = await writeVideoScript({
      store,
      id: job.id,
      number: 1,
      hypothesis,
      durationSec: 36,
      signal: fixture.task.signal,
      providers: {
        videoPlanning: (task) => prepareVideoPlanning(task, connection),
        videoScript: (current, chosen, number, signal, feedback, _connection, planning) =>
          generateVideoScript(current, chosen, number, signal, feedback, connection, planning),
        reviewVideoScript: (task) => reviewVideoScript(task, connection),
      },
    });
    const current = loadInstructions();
    expect(result.review.instructionsDigest).toBe(current.digest);
    expect(result.review.instructionsLoadedAt).toBe(current.loadedAt);
    expect(instructionsEventMessage({ digest: result.review.instructionsDigest })).toBe(
      `지시 파일 ${current.digest.slice(0, 8)} 적용`,
    );
  } finally {
    fixture.close();
  }
  const planning = planningFixture();
  try {
    planning.library.addSource(planning.project.id, sourceReference);
    await planning.planner.plan(planning.job(), sourceStrategy, new AbortController().signal);
    const after = planning.job();
    const current = loadInstructions();
    // 기획 산출물 옆 작은 산출물 + 이벤트(creativePlan 안에는 넣지 않는다 — approvedPlanDigest 불변)
    expect(after.artifacts.some((item) => item.name === "instructions-plan.json")).toBe(true);
    const saved = JSON.parse(
      readFileSync(
        join(planning.store.root, "artifacts", after.id, "instructions-plan.json"),
        "utf8",
      ),
    ) as { instructionsDigest: string; instructionsLoadedAt: string; warnings: string[] };
    expect(saved.instructionsDigest).toBe(current.digest);
    expect(saved.instructionsLoadedAt).toBe(current.loadedAt);
    expect(saved.warnings).toEqual([]);
    expect(
      after.events.some(
        (event) => event.message === `기획 · 지시 파일 ${current.digest.slice(0, 8)} 적용`,
      ),
    ).toBe(true);
    expect(JSON.stringify(after.creativePlan)).not.toContain(current.digest);
  } finally {
    planning.close();
  }
});
