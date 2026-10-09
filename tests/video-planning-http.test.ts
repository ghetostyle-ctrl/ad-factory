import { afterEach, expect, test } from "bun:test";
import { AutomationEnrollment } from "../server/automation-enrollment";
import { writeVideoScript } from "../server/script-writer";
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
  const plan = fixture.job.creativePlan;
  const target = plan?.targets?.find((item) => item.id === fixture.hypothesis.targetId);
  return {
    target: target
      ? {
          ...target,
          fragments: (plan?.fragments ?? []).filter((item) => target.fragmentIds.includes(item.id)),
        }
      : null,
    visualAssets: {
      projectClips: [],
      realProductPhotos: 0,
      note: expect.stringContaining("Generated packaging cannot reproduce the real label"),
    },
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
    voices: fixture.voices.map(({ id, title, content }) => ({
      id,
      title,
      content,
      reviewOf: "unknown",
    })),
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
    durationRange: { min: 30, max: 60 },
    infoClipsAllowed: false,
    // 새 기획의 기본 시각 정책은 혼합형(2026-10-07)
    visualPolicy: "hybrid_explainer_v1",
    userFeedback: task.userFeedback,
  };
  expect(fixture.dataFor("video_planning")).toEqual(context);
  expect(fixture.dataFor("video_copy_editing")).toEqual({ ...context, planning: fixture.draft });
  expect(stages).toEqual(["planning", "copy"]);
  expect(result.value).toEqual({
    ...fixture.draft,
    visualPolicy: "hybrid_explainer_v1",
    copy: { ...fixture.draft.copy, lines: fixture.replies.editing.lines },
    copyReview: fixture.replies.editing.review,
  });
  expect(result.model.effectiveModel).toBe("fixture-observed-model");
  // 혼합형 기획 요청: 장면마다 explainerScene 을 요구하고 이름표 계획(explanation)·글자 카드(graphic)는 없다
  const schema = JSON.stringify(fixture.requests[0]?.schema);
  expect(schema).toContain('"explainerScene"');
  expect(schema).not.toContain('"explanation"');
  expect(schema).not.toContain('"graphic"');
  expect(fixture.requests[0]?.prompt).toContain("HYBRID SCENE PLAN");
});

test("the immersive policy keeps its 2026-10-06 planning prompt and response schema when asked for", async () => {
  // Given
  const fixture = setup();
  // When
  const result = await prepareVideoPlanning(
    { ...fixture.task, visualPolicy: "immersive_explanations_v1" },
    fixture.connection,
  );
  // Then
  expect(result.value).toEqual({
    ...fixture.immersiveDraft,
    visualPolicy: "immersive_explanations_v1",
    copy: { ...fixture.immersiveDraft.copy, lines: fixture.replies.editing.lines },
    copyReview: fixture.replies.editing.review,
  });
  expect(fixture.dataFor("video_planning")["visualPolicy"]).toBe("immersive_explanations_v1");
  const schema = JSON.stringify(fixture.requests[0]?.schema);
  expect(schema).toContain('"explanation"');
  expect(schema).not.toContain('"explainerScene"');
  expect(fixture.requests[0]?.prompt).toContain("EXPLANATION PLAN:");
  expect(fixture.requests[0]?.prompt).not.toContain("HYBRID SCENE PLAN");
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
  "reordered lines",
] as const)("rebuilds a copy review with %s from the actual changes", async (failure) => {
  // Given
  const fixture = setup();
  const reply = fixture.replies.editing;
  const draftLines = fixture.draft.copy.lines;
  switch (failure) {
    case "missing edit":
      reply.review.edits = reply.review.edits.slice(1);
      break;
    case "wrong before":
      reply.review.edits = reply.review.edits.map((edit) => ({ ...edit, before: "Invented" }));
      break;
    case "wrong after":
      reply.review.edits = reply.review.edits.map((edit) => ({ ...edit, after: "Unreturned" }));
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
      reply.lines = draftLines;
      break;
    case "reordered lines":
      reply.lines = [...reply.lines].reverse();
      break;
    default:
      failure satisfies never;
  }
  // When
  const result = await prepareVideoPlanning(fixture.task, fixture.connection);
  // Then: the record always equals the real before/after of every changed field
  const actual = draftLines.flatMap((line, lineIndex) =>
    (["text", "screenText"] as const).flatMap((key) =>
      line[key] === reply.lines[lineIndex]?.[key]
        ? []
        : [
            {
              lineIndex,
              field: key === "text" ? ("narration" as const) : ("screenText" as const),
              before: line[key],
              after: reply.lines[lineIndex]?.[key] ?? "",
            },
          ],
    ),
  );
  const { copyReview } = result.value;
  expect(copyReview.edits.map(({ reason: _reason, ...edit }) => edit)).toEqual(actual);
  expect(copyReview.status).toBe(actual.length > 0 ? "revised" : "pass");
  expect(copyReview.edits.every((edit) => edit.reason.length > 0)).toBe(true);
  expect(result.value.copy.lines).toEqual(reply.lines);
});

test("a copy review that changes the number of lines keeps the draft copy instead of stopping", async () => {
  // Given
  const fixture = setup();
  const reply = fixture.replies.editing;
  reply.lines = [...reply.lines, ...reply.lines];
  // When
  const result = await prepareVideoPlanning(fixture.task, fixture.connection);
  // Then
  expect(result.value.copy).toEqual(fixture.draft.copy);
  expect(result.value.copyReview.status).toBe("pass");
  expect(result.value.copyReview.edits).toEqual([]);
  expect(result.value.copyReview.summary).toContain("문장 수");
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
    durationTarget: 54,
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

type JsonSchemaNode = {
  required?: string[];
  properties?: Record<string, JsonSchemaNode | undefined>;
  items?: JsonSchemaNode;
};
test("the script writer picks the hybrid response schema from the default planning policy on the wire", async () => {
  // Given: 실제 기획·대본·검토 함수를 그대로 쓰되 연결만 로컬 HTTP 픽스처로 돌린다(script-writer 경로).
  // 설명 컷(I1~I3)은 Flow 모드에서만 허용되므로 새 작업 기본값대로 Flow 로 승인한다.
  // 이 픽스처의 시장 조각(욕망·고통)은 영문 자리표시자라 한국어 결과 문장이 되받을 수 없다 → 사슬 없는 가설(예전 기획 형태)로 쓴다.
  // 사슬 규칙 자체는 tests/script-chain.test.ts 가 다룬다.
  const fixture = setup();
  new AutomationEnrollment(fixture.store).start(fixture.job.id, {
    mode: "creative",
    imageCount: 1,
    videoCount: 1,
    scriptApproval: "auto",
    clipMode: "flow",
  });
  const { chain: _chain, ...hypothesis } = fixture.hypothesis;
  // When
  const result = await writeVideoScript({
    store: fixture.store,
    id: fixture.job.id,
    number: 1,
    hypothesis,
    durationSec: 36,
    signal: fixture.task.signal,
    providers: {
      videoPlanning: (task) => prepareVideoPlanning(task, fixture.connection),
      videoScript: (job, hypothesis, number, signal, feedback, _connection, planning) =>
        generateVideoScript(
          job,
          hypothesis,
          number,
          signal,
          feedback,
          fixture.connection,
          planning,
        ),
      reviewVideoScript: (task) => reviewVideoScript(task, fixture.connection),
    },
  });
  // Then: 기획 → 카피 교정 → 대본 → 검토 순서로 보냈고, 대본 요청의 json_schema 가 혼합형(explainerAnchor·장면 필드 필수)이다.
  expect(fixture.requests.map((request) => request.name)).toEqual([
    "video_planning",
    "video_copy_editing",
    "video_script",
    "video_script_review",
  ]);
  const request = fixture.requests.find((item) => item.name === "video_script");
  const schema = request?.schema as JsonSchemaNode | undefined;
  expect(request?.strict).toBe(true);
  expect(schema?.required).toContain("explainerAnchor");
  const clip = schema?.properties?.["infoClips"]?.items;
  expect(clip?.required).toEqual(
    expect.arrayContaining(["sceneType", "objects", "actions", "emphasis"]),
  );
  expect(clip?.required).not.toEqual(expect.arrayContaining(["graphicOrder"]));
  // 2026-10-08: 혼합형 응답도 INFO 인포그래픽 문구(infoLines)를 요구한다(이름표 annotations 는 여전히 없음).
  expect(JSON.stringify(schema)).toContain('"infoLines"');
  expect(JSON.stringify(schema)).not.toContain('"annotations"');
  expect(request?.data["planning"]).toMatchObject({ visualPolicy: "hybrid_explainer_v1" });
  // 저장된 대본은 혼합형 정책·설명 세계 기준·장면 종류를 유지하고 규칙·검토를 통과한다.
  expect(result.script.planning?.visualPolicy).toBe("hybrid_explainer_v1");
  expect(result.script.explainerAnchor.length).toBeGreaterThan(0);
  expect(result.script.infoClips.length).toBeGreaterThan(0);
  expect(result.script.infoClips.every((item) => item.sceneType !== "")).toBe(true);
  expect(result.review.accepted).toBe("pass");
  expect(result.review.hardProblems).toEqual([]);
});
