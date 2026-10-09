import { z } from "zod";
import { CreativeSchema, StrategySchema } from "../shared/planning";
import { renderScript, sineWav } from "./render-fixture";
import { flatOf, hybridScriptResponse, nestedScriptResponse } from "./video-script-fixture";

// 모델 응답(video_script, 문장 우선·컷 중첩) 픽스처: 렌더 대본 36초를 중첩 형태로. 정지 이미지 컷 하나에 글줄을 붙여
// 자동 수리(R4)가 실제 변환 경로에서 도는지 확인할 수 있게 한다.
export function scriptResponseValue() {
  const nested = nestedScriptResponse(flatOf(renderScript(1, "concept-1", 36)));
  return {
    ...nested,
    sentences: nested.sentences.map((sentence) => ({
      ...sentence,
      cuts: sentence.cuts.map((cut) =>
        cut.source === "still_image" && cut.stillId === "S1" && cut.onScreenText === ""
          ? { ...cut, graphicLines: ["잘못 붙은 글줄"] }
          : cut,
      ),
    })),
  };
}

// Typecast with-timestamps 요청 본문(계획서의 와이어 형태). 어긋나면 422 로 돌려 실제 API 처럼 드러낸다.
const TypecastBodySchema = z
  .object({
    voice_id: z.string().min(1),
    text: z.string().min(1).max(2000),
    model: z.enum(["ssfm-v30", "ssfm-v21"]),
    language: z.string().optional(),
    prompt: z
      .object({
        emotion_type: z.string(),
        previous_text: z.string().optional(),
        next_text: z.string().optional(),
      })
      .optional(),
    output: z
      .object({
        audio_format: z.enum(["wav", "mp3"]).optional(),
        audio_tempo: z.number().min(0.5).max(2).optional(),
        target_lufs: z.number().optional(),
        volume: z.number().optional(),
      })
      .optional(),
  })
  .strict();
export const passReviewValue = {
  status: "pass",
  summary: "Actual fixture inspected",
  issues: [],
  revisionPrompt: null,
};

// AI 대본 검토 응답(VideoScriptReviewSchema 형태). scriptReviseOnce 가 켜져 있으면 한 번만 revise,
// scriptMismatchOnce 가 켜져 있으면 한 번만 '말과 그림 불일치'(문장·컷 번호 포함) 로 revise.
function scriptReviewValue(control: { scriptReviseOnce: boolean; scriptMismatchOnce: boolean }) {
  if (control.scriptMismatchOnce) {
    control.scriptMismatchOnce = false;
    return {
      status: "revise",
      summary: "픽스처 대본 검토: 2번째 문장의 그림이 말과 다릅니다",
      issues: [
        {
          sentenceIndex: 1,
          cutIndexes: [2, 3],
          problem: "문장이 말하는 600밀리그램이 묶인 컷 화면에 없습니다",
          fix: "600mg 클로즈업 컷을 이 문장 범위에 넣거나 숫자를 빼세요",
        },
      ],
    };
  }
  if (!control.scriptReviseOnce)
    return { status: "pass", summary: "픽스처 대본 검토 통과", issues: [] };
  control.scriptReviseOnce = false;
  return {
    status: "revise",
    summary: "픽스처 대본 검토: 메모체 문장",
    issues: [
      {
        sentenceIndex: 0,
        cutIndexes: [],
        problem: "첫 문장이 메모체입니다",
        fix: "시청자에게 말을 거는 완전한 문장으로 바꾸세요",
      },
    ],
  };
}
export const fixtureStrategy = StrategySchema.parse({
  positioning: "Fixture strategy",
  audienceInsight: "Known audience",
  valueProposition: "Documented facts",
  messageAngles: ["Facts"],
  risks: [],
  measurementPlan: "Actual metrics only",
});
export const fixtureCreative = CreativeSchema.parse({
  concept: "Fixture",
  headline: "Facts",
  primaryText: "Factual description",
  description: "Documented facts",
  callToAction: "LEARN_MORE",
  imagePrompt: "Fixture square concept",
  rationale: "Fixture only",
  checks: [],
});
export const fixturePng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nAAAAABJRU5ErkJggg==";
export function httpFixture() {
  const requests: { path: string; method: string; body: Record<string, unknown> }[] = [];
  const remote = new Map<string, Record<string, unknown>>();
  const control = {
    empty: false,
    zero: false,
    spend: 20,
    revisions: 0,
    failPath: "",
    holdPath: "",
    hold: Promise.resolve(),
    limitOffset: 0,
    copyChanged: false,
    lostActivationResponse: false,
    // Typecast: 0 이면 정상, 아니면 그 상태 코드로 {detail} 응답. durationSec 0 이면 글자 수/5.5초(템포 반영).
    typecastStatus: 0,
    typecastDurationSec: 0,
    typecastPlan: "lite",
    typecastPlanCredits: 200000,
    typecastUsedCredits: 1000,
    typecastConcurrency: 5,
    // AI 대본 검토(video_script_review): true 면 다음 한 번만 revise 를 돌려주고 pass 로 돌아간다(기본 pass).
    scriptReviseOnce: false,
    // true 면 다음 한 번만 '말과 그림 불일치' revise(sentenceIndex 1, cutIndexes [2,3])
    scriptMismatchOnce: false,
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body =
        request.method === "POST"
          ? z.record(z.string(), z.unknown()).parse(await request.json())
          : {};
      requests.push({ path, method: request.method, body });
      if (path === control.holdPath && request.method === "POST") await control.hold;
      if (path === control.failPath)
        return Response.json({ error: "Local fixture failure" }, { status: 503 });
      if (path === "/openai/images/generations")
        return Response.json({ model: body["model"], data: [{ b64_json: fixturePng }] });
      if (path === "/typecast/v1/text-to-speech/with-timestamps") {
        if (control.typecastStatus)
          return Response.json(
            { detail: `Local Typecast fixture status ${control.typecastStatus}` },
            { status: control.typecastStatus },
          );
        const parsed = TypecastBodySchema.safeParse(body);
        if (!parsed.success)
          return Response.json({ detail: parsed.error.message }, { status: 422 });
        const tempo = parsed.data.output?.audio_tempo ?? 1;
        const durationSec = control.typecastDurationSec || parsed.data.text.length / 5.5 / tempo;
        const tokens = parsed.data.text.split(/\s+/).filter((token) => token.length > 0);
        const step = durationSec / Math.max(1, tokens.length);
        return Response.json({
          audio: Buffer.from(sineWav(Math.round(durationSec * 1000))).toString("base64"),
          audio_format: "wav",
          audio_duration: durationSec,
          words: tokens.map((text, index) => ({
            text,
            start: Number((index * step).toFixed(3)),
            end: Number(((index + 1) * step).toFixed(3)),
          })),
          characters: null,
        });
      }
      if (path === "/typecast/v1/users/me/subscription")
        return Response.json({
          plan: control.typecastPlan,
          credits: {
            plan_credits: control.typecastPlanCredits,
            used_credits: control.typecastUsedCredits,
          },
          limits: {
            concurrency_limit: control.typecastConcurrency,
            custom_voice_slot: 50,
            professional_voice_slot: 0,
          },
        });
      if (path === "/openai/responses") {
        const { name: format, schema } = z
          .object({
            text: z.object({
              format: z.object({ name: z.string(), schema: z.unknown().optional() }),
            }),
          })
          .parse(body).text.format;
        // 혼합형(2026-10-07) 대본 요청은 explainerAnchor 를 요구하는 json_schema 로 구분해 혼합형 응답을 돌려준다
        const hybridScript =
          format === "video_script" && JSON.stringify(schema ?? null).includes('"explainerAnchor"');
        const value =
          format === "strategy"
            ? fixtureStrategy
            : format === "creative"
              ? fixtureCreative
              : format === "start_image_review" || format === "clip_review"
                ? passReviewValue
                : format === "video_script_review"
                  ? scriptReviewValue(control)
                  : format === "video_script"
                    ? hybridScript
                      ? hybridScriptResponse()
                      : scriptResponseValue()
                    : format === "image_review"
                      ? control.revisions-- > 0
                        ? {
                            status: "revise",
                            summary: "Revise fixture",
                            issues: ["Fixture contrast"],
                            revisionPrompt: "Revised fixture",
                          }
                        : passReviewValue
                      : {
                          summary: "Fixture observed performance",
                          observations: ["Observed metrics only"],
                          hypotheses: [],
                          recommendations: ["Wait for more observations"],
                          limitations: ["Local HTTP fixture, not actual campaign performance"],
                        };
        return Response.json({
          model: body["model"],
          status: "completed",
          output: [{ content: [{ type: "output_text", text: JSON.stringify(value) }] }],
        });
      }
      if (path === "/meta/me/adaccounts")
        return Response.json({
          data: [{ id: "act_123", name: "LOCAL HTTP FIXTURE ONLY", currency: "USD" }],
        });
      if (path.endsWith("/insights"))
        return Response.json({
          data: control.empty
            ? []
            : [
                {
                  spend: String(control.zero ? 0 : control.spend),
                  impressions: control.zero ? "0" : "1000",
                  clicks: control.zero ? "0" : "20",
                  date_start: "2026-09-24",
                  date_stop: "2026-09-24",
                  actions: [],
                  action_values: [],
                },
              ],
        });
      if (request.method === "POST") {
        if (path.endsWith("/adimages"))
          return Response.json({ images: { fixture: { hash: "fixture-image-hash" } } });
        if (/\/meta\/\d+$/.test(path)) {
          remote.set(path, { ...remote.get(path), status: body["status"] });
          if (
            control.lostActivationResponse &&
            path === "/meta/1001" &&
            body["status"] === "ACTIVE"
          )
            await new Promise<void>(() => {});
          return Response.json({ success: true });
        }
        const id = path.endsWith("/campaigns")
          ? "1001"
          : path.endsWith("/adsets")
            ? "1002"
            : path.endsWith("/adcreatives")
              ? "1003"
              : "1004";
        remote.set(`/meta/${id}`, body);
        return Response.json({ id });
      }
      const item = remote.get(path);
      if (path === "/meta/1001")
        return Response.json({
          ...item,
          account_id: "123",
          spend_cap: String(Number(item?.["spend_cap"] ?? 0) + control.limitOffset),
        });
      if (path === "/meta/1002")
        return Response.json({
          ...item,
          daily_budget: String(item?.["daily_budget"]),
          end_time: item?.["end_time"],
        });
      if (path === "/meta/1003" && control.copyChanged)
        return Response.json({
          object_story_spec: {
            page_id: "456",
            link_data: {
              image_hash: "fixture-image-hash",
              link: "https://example.com",
              message: "TAMPERED",
              name: "Facts",
              description: "Documented facts",
              call_to_action: { type: "LEARN_MORE", value: { link: "https://example.com" } },
            },
          },
        });
      if (path === "/meta/1004")
        return Response.json({
          ...item,
          adset_id: "1002",
          creative: { id: "1003" },
          effective_status: item?.["status"] ?? "PAUSED",
        });
      if (item) return Response.json(item);
      return Response.json({ error: `Unmapped local fixture route ${path}` }, { status: 404 });
    },
  });
  return { server, requests, control };
}
