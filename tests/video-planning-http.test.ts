import { afterEach, expect, test } from "bun:test";
import { StudioError } from "../server/errors";
import { prepareVideoPlanning } from "../server/video-planning";
import { generateVideoScript, reviewVideoScript } from "../server/video-scripts";
import { planningHttpFixture } from "./video-planning-http-fixture";

const fixtures: ReturnType<typeof planningHttpFixture>[] = [];
function setup() {
  const fixture = planningHttpFixture();
  fixtures.push(fixture);
  return fixture;
}
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});
function expectedContext(fixture: ReturnType<typeof planningHttpFixture>) {
  return {
    brief: {
      name: fixture.job.name,
      productDescription: fixture.job.productDescription,
      audience: fixture.job.audience,
      objective: fixture.job.objective,
    },
    hypothesis: fixture.hypothesis,
    customerQuestion: fixture.job.creativePlan?.customerQuestions[0],
    facts: [
      {
        id: fixture.fact.id,
        title: fixture.fact.title,
        kind: fixture.fact.kind,
        content: fixture.fact.content,
      },
    ],
    voices: fixture.voices.map(({ id, title, content }) => ({ id, title, content })),
    references: [
      {
        sourceId: fixture.reference.id,
        title: fixture.reference.title,
        content: fixture.reference.content,
        analysis: fixture.analysis,
        referenceData: fixture.reference.referenceData,
      },
    ],
  };
}

test("sends complete source context and resolved customer question to planning and copy editing", async () => {
  // Given
  const fixture = setup();
  const stages: string[] = [];
  const task = {
    ...fixture.task,
    userFeedback: "Show the bag comparison first",
    onProgress: (stage: "planning" | "copy") => stages.push(stage),
  };
  // When
  const result = await prepareVideoPlanning(task, fixture.connection);
  // Then
  expect(fixture.requests.map(({ name, model, strict }) => ({ name, model, strict }))).toEqual([
    { name: "video_planning", model: "fixture-text-model", strict: true },
    { name: "video_copy_editing", model: "fixture-text-model", strict: true },
  ]);
  const context = {
    ...expectedContext(fixture),
    durationTarget: 36,
    userFeedback: task.userFeedback,
  };
  expect(fixture.dataFor("video_planning")).toEqual(context);
  expect(fixture.dataFor("video_copy_editing")).toEqual({ ...context, planning: fixture.draft });
  expect(stages).toEqual(["planning", "copy"]);
  expect(result.value).toEqual({
    ...fixture.draft,
    copy: { ...fixture.draft.copy, lines: fixture.replies.editing.lines },
    copyReview: fixture.replies.editing.review,
  });
  expect(result.model.effectiveModel).toBe("fixture-observed-model");
});

test("accepts unchanged copy only with a pass review and empty edit history", async () => {
  // Given
  const fixture = setup();
  fixture.replies.editing = {
    lines: fixture.draft.copy.lines,
    review: { status: "pass", summary: "변경 없이 통과했습니다.", edits: [] },
  };
  const task = {
    ...fixture.task,
    hypothesis: { ...fixture.hypothesis, customerQuestionId: "missing-question" },
  };
  // When
  const result = await prepareVideoPlanning(task, fixture.connection);
  // Then
  expect(result.value.copy).toEqual(fixture.draft.copy);
  expect(result.value.copyReview).toEqual(fixture.replies.editing.review);
  expect(fixture.dataFor("video_planning")["customerQuestion"]).toBeNull();
  expect(fixture.dataFor("video_planning")["userFeedback"]).toBeNull();
});

test.each([
  "missing edit",
  "wrong before",
  "wrong after",
  "duplicate edit",
  "wrong line index",
  "pass with changes",
  "revised without changes",
  "changed line count",
  "reordered lines",
] as const)("rejects copy review with %s through the HTTP provider boundary", async (failure) => {
  // Given
  const fixture = setup();
  const reply = fixture.replies.editing;
  switch (failure) {
    case "missing edit":
      reply.review.edits = reply.review.edits.slice(1);
      break;
    case "wrong before":
      reply.review.edits = reply.review.edits.map((edit) => ({
        ...edit,
        before: "Invented original",
      }));
      break;
    case "wrong after":
      reply.review.edits = reply.review.edits.map((edit) => ({
        ...edit,
        after: "Unreturned correction",
      }));
      break;
    case "duplicate edit":
      reply.review.edits = reply.review.edits.flatMap((edit) => [edit, edit]);
      break;
    case "wrong line index":
      reply.review.edits = reply.review.edits.map((edit) => ({ ...edit, lineIndex: 3 }));
      break;
    case "pass with changes":
      reply.review.status = "pass";
      break;
    case "revised without changes":
      reply.lines = fixture.draft.copy.lines;
      reply.review.edits = [];
      break;
    case "changed line count":
      reply.lines = [...reply.lines, ...reply.lines];
      break;
    case "reordered lines":
      reply.lines = [...reply.lines].reverse();
      break;
    default:
      failure satisfies never;
  }
  // When
  const result = prepareVideoPlanning(fixture.task, fixture.connection);
  // Then
  await expect(result).rejects.toBeInstanceOf(StudioError);
  await expect(result).rejects.toMatchObject({ code: "video_copy_review" });
  expect(fixture.requests.map((request) => request.name)).toEqual([
    "video_planning",
    "video_copy_editing",
  ]);
});

test("passes edited copy into the storyboard writer and preserves planning through final review", async () => {
  // Given
  const fixture = setup();
  const planned = await prepareVideoPlanning(fixture.task, fixture.connection);
  // When
  const written = await generateVideoScript(
    fixture.job,
    fixture.hypothesis,
    1,
    fixture.task.signal,
    undefined,
    fixture.connection,
    planned.value,
  );
  const reviewed = await reviewVideoScript(
    {
      job: fixture.job,
      hypothesis: fixture.hypothesis,
      script: written.value,
      signal: fixture.task.signal,
    },
    fixture.connection,
  );
  // Then
  expect(fixture.dataFor("video_script")).toMatchObject({
    ...expectedContext(fixture),
    planning: planned.value,
  });
  expect(written.value.planning).toEqual(planned.value);
  expect(written.value.voiceover[0]?.text).toBe(fixture.replies.editing.lines[0]?.text);
  expect(written.value.cuts[0]?.onScreenText).toBe(fixture.replies.editing.lines[0]?.screenText);
  expect(fixture.dataFor("video_script_review")).toMatchObject({
    ...expectedContext(fixture),
    planning: planned.value,
  });
  expect(fixture.dataFor("video_script_review")["pairs"]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        sentenceIndex: 0,
        text: fixture.replies.editing.lines[0]?.text,
        cuts: expect.arrayContaining([
          expect.objectContaining({ onScreenText: fixture.replies.editing.lines[0]?.screenText }),
        ]),
      }),
    ]),
  );
  expect(reviewed.value.status).toBe("pass");
});
