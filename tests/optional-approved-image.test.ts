import { expect, test } from "bun:test";
import { generateVideoScript, verifyVideoScript } from "../server/video-scripts";
import { classifyScriptProblems } from "../shared/script-rules";
import { fixtureVideoPlanning } from "./video-planning-fixture";
import { planningHttpFixture } from "./video-planning-http-fixture";

function graphicEndingFixture() {
  const fixture = planningHttpFixture();
  fixture.replies.script = {
    ...fixture.replies.script,
    sentences: fixture.replies.script.sentences.map((sentence, index, all) => ({
      ...sentence,
      cuts: sentence.cuts.map((cut) => {
        if (
          cut.source !== "approved_image" &&
          cut.source !== "card_slide" &&
          index !== all.length - 1
        )
          return cut;
        return {
          ...cut,
          source: "motion_graphic",
          veoClip: "",
          stillId: "",
          phase: "",
          graphicKind: "callout",
          graphicLines: ["제품명", "핵심 원료", "비교해 보세요"],
        };
      }),
    })),
  };
  return fixture;
}

test("new policy reaches response repair before the real writer can overwrite a graphic ending", async () => {
  // Given: the provider returns no ad card and a deliberate graphic ending.
  const fixture = graphicEndingFixture();
  const planned = { ...fixtureVideoPlanning(), visualPolicy: "immersive_explanations_v1" as const };
  try {
    // When
    const written = await generateVideoScript(
      fixture.job,
      fixture.hypothesis,
      1,
      fixture.task.signal,
      undefined,
      fixture.connection,
      planned,
    );
    const rules = classifyScriptProblems(written.value, {
      number: 1,
      durationSec: written.value.durationSec,
      hypothesis: fixture.hypothesis,
      infoClipsAllowed: false,
    });
    // Then
    expect(written.value.cuts.some((cut) => cut.source === "approved_image")).toBe(false);
    expect(written.value.cuts.at(-1)).toMatchObject({
      source: "motion_graphic",
      graphicKind: "callout",
      graphicLines: ["제품명", "핵심 원료", "비교해 보세요"],
    });
    expect(written.repairs?.some((repair) => repair.includes("마지막 컷을 대표 이미지로"))).toBe(
      false,
    );
    expect(rules.hard.some((problem) => problem.includes("대표 이미지"))).toBe(false);
    expect(() => verifyVideoScript(written.value, 1, fixture.hypothesis.id)).not.toThrow();
  } finally {
    fixture.close();
  }
});

test("legacy writer retains required representative image repair and resume validation", async () => {
  // Given
  const fixture = graphicEndingFixture();
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
    // Then
    expect(written.value.cuts.at(-1)).toMatchObject({ source: "approved_image", graphicLines: [] });
    expect(written.repairs?.some((repair) => repair.includes("마지막 컷을 대표 이미지로"))).toBe(
      true,
    );
    const removed = {
      ...written.value,
      cuts: written.value.cuts.map((cut) => ({ ...cut, source: "motion_graphic" as const })),
    };
    expect(() => verifyVideoScript(removed, 1, fixture.hypothesis.id)).toThrow();
  } finally {
    fixture.close();
  }
});
