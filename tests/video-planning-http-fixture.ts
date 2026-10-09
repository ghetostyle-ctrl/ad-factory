import { rmSync } from "node:fs";
import { z } from "zod";
import { evidencePack } from "../server/evidence-pack";
import { ProjectStore } from "../server/project-store";
import { CreativePlanSchema } from "../shared/creative-plan";
import { CreateSourceSchema } from "../shared/sources";
import type { VideoCopyEditingResponse, VideoPlanningDraft } from "../shared/video-planning";
import type { ScriptResponseInput, VideoCopyResponse } from "../shared/video-script";
import { scriptResponseValue } from "./automation-http-fixture";
import { hfLabelFixture } from "./hf-label-fixture";
import { providerStore, response } from "./provider-fixtures";
import { sourceFact, sourcePlanResponse, sourceReference } from "./source-planning-fixture";
import { fixtureVideoPlanning } from "./video-planning-fixture";
import { hybridScriptResponse } from "./video-script-fixture";

const RequestSchema = z.object({
  model: z.string(),
  input: z.string(),
  text: z.object({
    format: z.object({
      name: z.enum([
        "video_planning",
        "video_copy_editing",
        "video_copy",
        "video_script",
        "video_script_review",
      ]),
      strict: z.boolean(),
      schema: z.unknown().optional(),
    }),
  }),
});
type RequestName = z.infer<typeof RequestSchema>["text"]["format"]["name"];
type CapturedRequest = {
  readonly name: RequestName;
  readonly model: string;
  readonly strict: boolean;
  readonly prompt: string;
  readonly data: Record<string, unknown>;
  // 요청이 보낸 json_schema(정책별 응답 형태 확인용)
  readonly schema: unknown;
};
// 요청의 json_schema 가 어느 정책의 응답을 요구하는지: 혼합형 기획은 explainerScene, 혼합형 대본은 explainerAnchor 를 요구한다.
const schemaRequires = (schema: unknown, field: string) =>
  JSON.stringify(schema ?? null).includes(`"${field}"`);

// 카피 먼저 흐름(2026-10-08) 픽스처 카피 8문장: 아래 혼합형 장면 픽스처(hybridScriptResponse)의 문장별 컷 시간에 읽는 시간이 들어가도록
// 글자 수를 맞췄다(초당 5.5자 + 0.3초 ≤ 컷 합계: 14·12·12·28·28·25·25·36자 이하). 합쳐서 추정 약 32.6초다(30~60초 안).
export const FIXTURE_COPY: VideoCopyResponse = {
  lines: [
    { chainStep: "pain", text: "뭘 사도 똑같아 보이죠." },
    { chainStep: "believed_cause", text: "비싸야 좋은 줄 알죠." },
    { chainStep: "real_cause", text: "차이는 속 원료예요." },
    { chainStep: "requirement", text: "그러니 사기 전에 원료 이름만 한 줄 읽으면 돼요." },
    { chainStep: "product_fact", text: "이 캡슐은 다른 기름 없이 올리브 오일만 담았어요." },
    { chainStep: "reason_why", text: "냉압착으로 짜서 원료가 그대로 살아 있거든요." },
    { chainStep: "outcome", text: "그래서 아침마다 한 알이 가볍게 느껴져요." },
    { chainStep: "cta", text: "오늘 사기 전에 한번 비교해 보세요." },
  ],
};
// 너무 긴 카피(추정 발화 60초 초과): 한 호흡 40자 이내 10문장이라 길이 규칙만 어긴다.
export const FIXTURE_COPY_OVERLONG: VideoCopyResponse = {
  lines: [
    { chainStep: "pain", text: "아침마다 영양제를 고르려고 진열대 앞에서 한참을 서성이다 지쳐요." },
    {
      chainStep: "believed_cause",
      text: "비싼 제품이면 당연히 좋을 거라고 오랫동안 그렇게만 믿어 왔죠.",
    },
    {
      chainStep: "real_cause",
      text: "하지만 겉모습이 같아도 안에 든 원료는 제품마다 완전히 달라요.",
    },
    {
      chainStep: "requirement",
      text: "그러니 사기 전에 원료 이름을 처음부터 끝까지 천천히 읽어 보면 돼요.",
    },
    {
      chainStep: "product_fact",
      text: "이 캡슐은 다른 기름을 전혀 섞지 않고 올리브 오일만 가득 담았어요.",
    },
    {
      chainStep: "reason_why",
      text: "차갑게 눌러 짜는 냉압착 방식이라 원료의 신선함이 그대로 남아 있거든요.",
    },
    {
      chainStep: "outcome",
      text: "그래서 이제는 아침마다 한 알씩 마음 편하게 챙겨 먹을 수 있어요.",
    },
    {
      chainStep: "outcome",
      text: "고르는 시간이 줄어들고 하루가 한결 가볍게 시작되는 기분이 들어요.",
    },
    { chainStep: "outcome", text: "매번 망설이던 마음이 사라지고 선택에 대한 확신이 생겨났어요." },
    { chainStep: "cta", text: "오늘 사기 전에 원료 이름을 꼭 한번 비교해 보세요." },
  ],
};

export function planningHttpFixture() {
  const store = providerStore();
  const library = new ProjectStore(store.db);
  const project = library.createProject({ name: "Video planning fixture", description: "" });
  const fact = library.addSource(project.id, sourceFact);
  const voices = Array.from({ length: 5 }, (_, index) =>
    library.addSource(
      project.id,
      CreateSourceSchema.parse({
        kind: "review",
        title: `Voice ${index}`,
        content: `Customer question ${index}`,
      }),
    ),
  );
  for (const item of [
    { kind: "review", title: "Inactive voice", content: "Excluded inactive", status: "inactive" },
    {
      kind: "review",
      title: "Invented voice",
      content: "Excluded assumption",
      evidence: "hypothesis",
    },
    { kind: "review", title: "Link without content", url: "https://example.com/review" },
    {
      kind: "product_fact",
      title: "Assumed fact",
      content: "Excluded fact",
      evidence: "hypothesis",
    },
  ])
    library.addSource(project.id, CreateSourceSchema.parse(item));
  const reference = library.addSource(
    project.id,
    CreateSourceSchema.parse({
      ...sourceReference,
      referenceData: {
        platform: "meta",
        brand: "Reference brand",
        headlines: ["Reference headline"],
        bodies: ["Reference body"],
        transcriptSegments: [],
        media: [],
        observations: [],
      },
    }),
  );
  const snapshot = library.snapshot(project.id);
  const plan = sourcePlanResponse(fact.id, [reference.id]);
  const hypothesis = plan.hypotheses[0];
  const originalJob = store.list()[0];
  if (!hypothesis || !originalJob)
    throw new TypeError("Planning fixture requires a job and hypothesis");
  const analysis = {
    sourceId: reference.id,
    observedStructure: ["Question precedes demonstration"],
    inferences: [],
    unknowns: ["Performance unobserved"],
  };
  const job = store.change(originalJob.id, (value) => {
    value.projectId = project.id;
    value.sourceSnapshot = snapshot;
    value.creativePlan = CreativePlanSchema.parse({
      ...plan,
      sourceDigest: snapshot.digest,
      referenceAnalyses: [analysis],
      sourceCoverage: evidencePack(snapshot).coverage,
    });
  });
  const planning = fixtureVideoPlanning();
  // immersive(2026-10-06) 기획 응답: 장면마다 explanation null, 세 번째 장면은 글자 카드(graphic).
  const immersiveDraft: VideoPlanningDraft = {
    durationSec: 54,
    audience: planning.audience,
    concept: planning.concept,
    copy: planning.copy,
  };
  // 혼합형(기본 정책, 2026-10-07) 기획 응답: 실사 장면은 explainerScene null, 글자 카드 대신 설명 장면(비유: 숫자 → 체감 물체).
  const draft: VideoPlanningDraft = {
    ...immersiveDraft,
    concept: {
      ...planning.concept,
      scenePlan: [
        {
          scene: "현관에서 멈칫하는 손",
          source: "generated",
          reason: "실제 촬영본이 없어 상황 장면을 생성한다.",
          explainerScene: null,
        },
        {
          scene: "뚜껑을 끝까지 닫는 동작",
          source: "generated",
          reason: "동작이 설득력이라 영상 클립으로 만든다.",
          explainerScene: null,
        },
        {
          scene: "용량 오백밀리리터를 컵 두 개로 보여 주는 비유",
          source: "info_clip",
          reason: "확인된 숫자를 글자 대신 체감 물체로 보여 준다.",
          explainerScene: {
            sceneType: "analogy",
            objects: [
              {
                subjectId: "tumbler",
                appearance: "matte clay-white tumbler with a flat screw lid",
                color: "accent1",
              },
              {
                subjectId: "cups",
                appearance: "two translucent standard drinking cups",
                color: "accent2",
              },
            ],
            actions: [
              "The tumbler rises from the clay table",
              "Two translucent cups fill beside it to the same total height",
            ],
            emphasis: [{ kind: "ghost_object", target: "cups", afterAction: 1 }],
            analogy: "two standard cups of water",
          },
        },
      ],
    },
  };
  const firstLine = draft.copy.lines[0];
  if (!firstLine) throw new TypeError("Planning fixture requires copy lines");
  const changedLine = {
    text: "가방을 닫기 전에, 텀블러 크기부터 살펴보세요.",
    screenText: "가방과 크기 비교",
  };
  const replies: {
    editing: VideoCopyEditingResponse;
    // 대본 응답: 예전·immersive 스키마 요청에는 script, 혼합형 스키마 요청(explainerAnchor 요구)에는 hybridScript.
    script: ScriptResponseInput;
    hybridScript: ScriptResponseInput;
    // 카피 먼저 흐름의 편지 1 응답. copyOverlong 은 control.copyOverlongOnce 가 켜졌을 때 한 번만 쓴다.
    copy: VideoCopyResponse;
    copyOverlong: VideoCopyResponse;
  } = {
    copy: FIXTURE_COPY,
    copyOverlong: FIXTURE_COPY_OVERLONG,
    script: scriptResponseValue(),
    hybridScript: hybridScriptResponse(),
    editing: {
      lines: draft.copy.lines.map((line, index) => (index === 0 ? changedLine : line)),
      review: {
        status: "revised",
        summary: "첫 문장의 말과 화면을 구체화했습니다.",
        edits: [
          {
            lineIndex: 0,
            field: "narration",
            before: firstLine.text,
            after: changedLine.text,
            reason: "자연스러운 구어체",
          },
          {
            lineIndex: 0,
            field: "screenText",
            before: firstLine.screenText,
            after: changedLine.screenText,
            reason: "비교 대상을 명시",
          },
        ],
      },
    },
  };
  // 제어: copyOverlongOnce = 다음 카피 요청 한 번은 너무 긴 카피를 돌려준다.
  // sceneDropLastOnce = 다음 장면 요청(copyLines 있음) 한 번은 마지막 문장을 빼고 돌려준다(문장 수 불일치).
  const control = { copyOverlongOnce: false, sceneDropLastOnce: false };
  const requests: CapturedRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const parsed = RequestSchema.parse(await request.json());
      const marker = "\nDATA:\n";
      const offset = parsed.input.lastIndexOf(marker);
      if (offset < 0) throw new TypeError("Structured DATA is missing");
      const data = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(parsed.input.slice(offset + marker.length)));
      requests.push({
        name: parsed.text.format.name,
        model: parsed.model,
        strict: parsed.text.format.strict,
        prompt: parsed.input,
        data,
        schema: parsed.text.format.schema,
      });
      const name = parsed.text.format.name;
      const schema = parsed.text.format.schema;
      switch (name) {
        case "video_planning":
          return response(schemaRequires(schema, "explainerScene") ? draft : immersiveDraft);
        case "video_copy_editing":
          return response(replies.editing);
        case "video_copy": {
          if (control.copyOverlongOnce) {
            control.copyOverlongOnce = false;
            return response(replies.copyOverlong);
          }
          return response(replies.copy);
        }
        case "video_script": {
          const script = schemaRequires(schema, "explainerAnchor")
            ? replies.hybridScript
            : replies.script;
          // 카피 먼저 흐름의 편지 2: 요청에 확정 문장(copyLines)이 있다. 모델이 문장을 전부 제멋대로 바꿔 돌려준 것처럼 답해
          // 앱이 카피 원문으로 되돌리는지 본다(바뀐 글에 없는 어절의 콜아웃은 빼서 응답 자체는 일관되게 둔다).
          if (Array.isArray(data["copyLines"])) {
            const changed = script.sentences.map((sentence) => {
              const text = `${sentence.text} 모델이 바꾼 문장`;
              return {
                ...sentence,
                text,
                callouts: sentence.callouts.filter((callout) => text.includes(callout.word)),
              };
            });
            const dropLast = control.sceneDropLastOnce;
            control.sceneDropLastOnce = false;
            return response({
              ...script,
              infoClips: script.infoClips.map((clip) => {
                if (!("infoLines" in clip)) throw new TypeError("Copy-first requires hybrid clips");
                return {
                  ...clip,
                  labelLayer: hfLabelFixture(
                    clip.infoLines.length,
                    clip.objects.map((object) => object.subjectId),
                  ),
                };
              }),
              sentences: dropLast ? changed.slice(0, -1) : changed,
            });
          }
          return response({
            ...script,
            sentences: script.sentences.map((sentence, index) =>
              index === 0
                ? {
                    ...sentence,
                    text: changedLine.text,
                    // 바뀐 문장에 없는 어절의 콜아웃은 뺀다(혼합형 픽스처의 첫 문장 콜아웃)
                    callouts: sentence.callouts.filter((callout) =>
                      changedLine.text.includes(callout.word),
                    ),
                    cuts: sentence.cuts.map((cut) => ({
                      ...cut,
                      onScreenText: changedLine.screenText,
                    })),
                  }
                : sentence,
            ),
          });
        }
        case "video_script_review":
          return response({ status: "pass", summary: "검토 완료", issues: [] });
        default:
          return name satisfies never;
      }
    },
  });
  return {
    store,
    job,
    hypothesis,
    fact,
    voices,
    reference,
    analysis,
    draft,
    immersiveDraft,
    replies,
    control,
    requests,
    connection: {
      apiKey: "local-planning-fixture",
      baseUrl: `http://127.0.0.1:${server.port}/v1/`,
    },
    task: { job, hypothesis, number: 1, durationSec: 36, signal: new AbortController().signal },
    dataFor(name: RequestName) {
      const request = requests.find((item) => item.name === name);
      if (!request) throw new TypeError(`Missing fixture request ${name}`);
      return request.data;
    },
    close() {
      server.stop(true);
      store.close();
      rmSync(store.root, { recursive: true, force: true });
    },
  };
}
