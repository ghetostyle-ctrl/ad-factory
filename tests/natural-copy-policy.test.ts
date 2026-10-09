import { expect, test } from "bun:test";
import { prepareVideoPlanning } from "../server/video-planning";
import { generateVideoScript, reviewVideoScript } from "../server/video-scripts";
import { planningHttpFixture } from "./video-planning-http-fixture";

function policyIds(prompt: string): string[] {
  return [...prompt.matchAll(/<copy-rhythm-policy id="([^"]+)">/g)].map((match) => match[1] ?? "");
}

// 카피 리듬 정책: immersive(2026-10-06)는 natural_v1, 혼합형(새 기획의 기본, 2026-10-07)은 사용자 결정대로 짧은 호흡(legacy_rhythm,
// 26자 목표·40자 한도)을 기획·교정·대본·검토 네 요청에 똑같이 쓴다. 기획이 없는 예전 대본도 legacy_rhythm 이다.
test("the default hybrid planning, copy, storyboard and review requests select the short-beat policy", async () => {
  // Given
  const fixture = planningHttpFixture();
  try {
    // When
    const plan = await prepareVideoPlanning(fixture.task, fixture.connection);
    const written = await generateVideoScript(
      fixture.job,
      fixture.hypothesis,
      1,
      fixture.task.signal,
      undefined,
      fixture.connection,
      plan.value,
    );
    await reviewVideoScript(
      {
        job: fixture.job,
        hypothesis: fixture.hypothesis,
        script: written.value,
        signal: fixture.task.signal,
      },
      fixture.connection,
    );
    // Then
    expect(plan.value.visualPolicy).toBe("hybrid_explainer_v1");
    expect(
      fixture.requests.map((request) => ({
        name: request.name,
        policies: policyIds(request.prompt),
      })),
    ).toEqual([
      { name: "video_planning", policies: ["legacy_rhythm"] },
      { name: "video_copy_editing", policies: ["legacy_rhythm"] },
      { name: "video_script", policies: ["legacy_rhythm"] },
      { name: "video_script_review", policies: ["legacy_rhythm"] },
    ]);
  } finally {
    fixture.close();
  }
});

test("the immersive policy still selects only the natural policy in all four requests", async () => {
  // Given
  const fixture = planningHttpFixture();
  try {
    // When
    const plan = await prepareVideoPlanning(
      { ...fixture.task, visualPolicy: "immersive_explanations_v1" },
      fixture.connection,
    );
    const written = await generateVideoScript(
      fixture.job,
      fixture.hypothesis,
      1,
      fixture.task.signal,
      undefined,
      fixture.connection,
      plan.value,
    );
    await reviewVideoScript(
      {
        job: fixture.job,
        hypothesis: fixture.hypothesis,
        script: written.value,
        signal: fixture.task.signal,
      },
      fixture.connection,
    );
    // Then
    expect(plan.value.visualPolicy).toBe("immersive_explanations_v1");
    expect(
      fixture.requests.map((request) => ({
        name: request.name,
        policies: policyIds(request.prompt),
      })),
    ).toEqual([
      { name: "video_planning", policies: ["natural_v1"] },
      { name: "video_copy_editing", policies: ["natural_v1"] },
      { name: "video_script", policies: ["natural_v1"] },
      { name: "video_script_review", policies: ["natural_v1"] },
    ]);
  } finally {
    fixture.close();
  }
});

test("legacy storyboards and reviews retain the previous policy without changing stored planning", async () => {
  // Given
  const fixture = planningHttpFixture();
  try {
    // When
    const written = await generateVideoScript(
      fixture.job,
      fixture.hypothesis,
      1,
      fixture.task.signal,
      undefined,
      fixture.connection,
    );
    await reviewVideoScript(
      {
        job: fixture.job,
        hypothesis: fixture.hypothesis,
        script: written.value,
        signal: fixture.task.signal,
      },
      fixture.connection,
    );
    // Then
    expect(fixture.requests.map((request) => policyIds(request.prompt))).toEqual([
      ["legacy_rhythm"],
      ["legacy_rhythm"],
    ]);
    expect(written.value.planning).toBeUndefined();
  } finally {
    fixture.close();
  }
});
