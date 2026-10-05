import { z } from "zod";
import { sineWav } from "./render-fixture";

// 로컬 Typecast 픽스처(Bun.serve 127.0.0.1:0). 실 API 호출 0회. with-timestamps 요청 본문을 zod 로 검증해
// 와이어 형태가 어긋나면 실제 API 처럼 422 로 돌려준다.
export const TypecastRequestSchema = z
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
      .strict()
      .optional(),
    output: z
      .object({
        audio_format: z.enum(["wav", "mp3"]).optional(),
        audio_tempo: z.number().min(0.5).max(2).optional(),
        target_lufs: z.number().optional(),
        volume: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type TypecastRequest = z.infer<typeof TypecastRequestSchema>;
export function typecastFixture() {
  const requests: {
    path: string;
    query: string;
    headers: Record<string, string>;
    body: unknown;
  }[] = [];
  const control = {
    // 0 이면 정상, 아니면 그 상태 코드로 {detail} 응답
    status: 0,
    // 429 를 이만큼 돌려준 뒤 200
    rateLimitTimes: 0,
    // 문장 index(요청 순서) 별 길이(초). 없으면 글자 수/5.5/템포
    durationByIndex: new Map<number, number>(),
    durationScale: 1,
    // 응답 audio_duration 을 실제 WAV 와 다르게(교차검증 테스트)
    declaredOffsetSec: 0,
    // WAV 대신 아무 바이트
    corruptAudio: false,
    plan: "lite",
    planCredits: 200000,
    usedCredits: 1000,
    concurrencyLimit: 5,
  };
  let rateLimited = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : null;
      requests.push({
        path: url.pathname,
        query: url.search,
        headers: Object.fromEntries(request.headers.entries()),
        body,
      });
      if (!request.headers.get("x-api-key"))
        return Response.json({ detail: "Invalid API key" }, { status: 401 });
      if (url.pathname === "/typecast/v1/users/me/subscription")
        return Response.json({
          plan: control.plan,
          credits: { plan_credits: control.planCredits, used_credits: control.usedCredits },
          limits: {
            concurrency_limit: control.concurrencyLimit,
            custom_voice_slot: 50,
            professional_voice_slot: 0,
          },
        });
      if (url.pathname !== "/typecast/v1/text-to-speech/with-timestamps")
        return Response.json({ detail: "Not found" }, { status: 404 });
      if (control.status)
        return Response.json(
          { detail: `Local fixture status ${control.status}` },
          { status: control.status },
        );
      if (rateLimited < control.rateLimitTimes) {
        rateLimited++;
        return Response.json({ detail: "Too many requests" }, { status: 429 });
      }
      const parsed = TypecastRequestSchema.safeParse(body);
      if (!parsed.success) return Response.json({ detail: parsed.error.message }, { status: 422 });
      const index = requests.filter((item) => item.path === url.pathname).length - 1;
      const tempo = parsed.data.output?.audio_tempo ?? 1;
      const durationSec =
        (control.durationByIndex.get(index) ??
          ([...parsed.data.text].length / 5.5) * control.durationScale) / tempo;
      const tokens = parsed.data.text.split(/\s+/).filter((token) => token.length > 0);
      const step = durationSec / Math.max(1, tokens.length);
      const audio = control.corruptAudio
        ? new Uint8Array(64).fill(7)
        : sineWav(Math.round(durationSec * 1000));
      return Response.json({
        audio: Buffer.from(audio).toString("base64"),
        audio_format: "wav",
        audio_duration: durationSec + control.declaredOffsetSec,
        words: tokens.map((text, position) => ({
          text,
          start: Number((position * step).toFixed(3)),
          end: Number(((position + 1) * step).toFixed(3)),
        })),
        characters: null,
      });
    },
  });
  const connection = {
    apiKey: "local-fixture-only",
    baseUrl: `http://127.0.0.1:${server.port}/typecast/`,
  };
  return {
    server,
    requests,
    control,
    connection,
    synthesisRequests: () =>
      requests.filter((item) => item.path === "/typecast/v1/text-to-speech/with-timestamps"),
    close: () => server.stop(true),
  };
}
