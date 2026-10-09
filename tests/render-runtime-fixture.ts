import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomaticProduction, type ProductionProviders } from "../server/automation-production";
import { ClipProduction } from "../server/clip-production";
import { evidencePack } from "../server/evidence-pack";
import { saveModelSettings } from "../server/model-settings";
import { MusicLibrary } from "../server/music-library";
import { ProductionAssets } from "../server/production-assets";
import { ProjectStore } from "../server/project-store";
import { type FfmpegRunner, ffmpegCapabilities, runFfmpeg } from "../server/render/ffmpeg";
import { resolveFont } from "../server/render/fonts";
import { renderPreflight } from "../server/render/preflight";
import { RenderPipeline, type RenderPipelineDeps } from "../server/render-pipeline";
import { RenderProduction } from "../server/render-production";
import { StartImageProduction } from "../server/start-image-production";
import { StillProduction } from "../server/still-production";
import { JobStore } from "../server/store";
import { VoiceProduction } from "../server/voice-production";
import { CreativePlanSchema } from "../shared/creative-plan";
import type { Job } from "../shared/schema";
import { CreateProjectSchema, CreateSourceSchema } from "../shared/sources";
import { type VideoScript, videoTargetSeconds } from "../shared/video-script";
import { automationBrief } from "./automation-fixture";
import { fixtureCreative, fixtureStrategy } from "./automation-http-fixture";
import {
  projectClip,
  renderProfile,
  renderScript,
  sineWav,
  tinyClip,
  tinyStill,
} from "./render-fixture";

// 렌더 파이프라인 E2E 공용 픽스처: 유료 공급자(Typecast·OpenAI 이미지·비전 검토·Veo)는 전부 스텁(호출 수 기록),
// 미디어는 lavfi, 렌더는 108x192/10fps 프로파일. 실제 외부 호출 0회.
export const model = {
  provider: "openai",
  requestedModel: "fixture-text",
  effectiveModel: "fixture-text",
  quality: null,
} as const;
const pass = {
  status: "pass" as const,
  summary: "Fixture reviewed",
  issues: [] as string[],
  revisionPrompt: null,
};
export type RenderFixtureOptions = {
  // 대본 생성기(기본 renderScript: 소스 6종·효과 8종·클립 A~D·정지 이미지)
  readonly script?: (job: Job, hypothesisId: string, number: number) => VideoScript;
  // 그래픽·조립 단계를 스텁으로(ffmpeg 호출 없이 빠르게)
  readonly stubRender?: boolean;
  readonly clipReview?: boolean;
};
export async function renderRuntimeFixture(options: RenderFixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "studio-render-runtime-"));
  const store = new JobStore(root);
  const library = new ProjectStore(store.db);
  const project = library.createProject(CreateProjectSchema.parse({ name: "Render fixture" }));
  const source = library.addSource(
    project.id,
    CreateSourceSchema.parse({
      kind: "product_fact",
      title: "Documented fact",
      content: automationBrief.productDescription,
    }),
  );
  saveModelSettings(root, {
    textProvider: "openai",
    textModel: "fixture-text",
    codexModel: null,
    imageModel: "gpt-image-2",
    imageQuality: "high",
    ttsProvider: "typecast",
    ttsSelection: "auto",
    ttsVoiceId: null,
    ttsTempo: 1,
  });
  // 촬영본 1개(오디오 keep) — project_clip 컷과 keep 오디오 경로를 지나게 한다
  const media = join(root, "media");
  await Bun.write(join(media, ".keep"), "");
  const clipBytes = new Uint8Array(await Bun.file(tinyClip(join(media, "veo.mp4"))).arrayBuffer());
  const productionAssets = new ProductionAssets(library, root);
  const uploaded = await productionAssets.add(
    project.id,
    new File(
      [await Bun.file(projectClip(join(media, "project.mp4"), 4)).arrayBuffer()],
      "촬영본 Opening scene.mp4",
      {
        type: "video/mp4",
      },
    ),
  );
  productionAssets.update(project.id, uploaded.id, {
    title: "촬영본 Opening scene",
    settings: { ...uploaded.settings, audio: "keep" },
  });
  const counts = {
    // 대본 생성·AI 대본 검토 호출 수(둘 다 스텁)
    script: 0,
    scriptReview: 0,
    voice: 0,
    image: 0,
    startImage: 0,
    // 정지 이미지(S1..) 생성 호출 수. 시작 이미지(startImage)와 같은 1024x1536 크기라 프롬프트로 구분한다.
    still: 0,
    review: 0,
    veoCreate: 0,
    veoAwait: 0,
    subscription: 0,
    preflight: 0,
  };
  const log: string[] = [];
  const veoPrompts: string[] = [];
  // 대본 생성 스텁이 받은 피드백(다시 쓰기·검토 수정 요청 전달 확인용)
  const scriptFeedback: (string | undefined)[] = [];
  const control = {
    // 내레이션 실측 길이 배수(3 이면 voice_overflow)
    durationScale: 1,
    // AI 대본 검토 스텁: pass 는 항상 통과, revise-once 는 영상마다 첫 검토만 revise, revise 는 항상 revise,
    // mismatch-once 는 첫 검토만 '말과 그림 불일치'(문장 1 ↔ 컷 2·3) 로 revise
    scriptReview: "pass" as "pass" | "revise-once" | "revise" | "mismatch-once",
    // 대본 생성 스텁이 만드는 hard 규칙 위반: pass 는 없음, latin-always 는 매 생성 첫 문장에 영문(3회 모두 거부 → needsFix 초안),
    // latin-fewest-second 는 1·3회차에 영문 2문장, 2회차에 1문장(hard 가 가장 적은 2회차 초안이 저장되는지)
    scriptRules: "pass" as "pass" | "latin-always" | "latin-fewest-second",
    // Veo await 를 붙잡아 둘 약속(stop/resume 테스트)
    holdAwait: null as Promise<void> | null,
    awaitError: null as Error | null,
    credentials: { openai: "k", gemini: "k", typecast: "k" },
  };
  // 이미지 스텁은 lavfi 로 만든 진짜 PNG 를 돌려준다(fixturePng 1x1 은 손상된 PNG 라 ffmpeg -loop 가 멈춘다)
  const png = new Uint8Array(await Bun.file(tinyStill(join(media, "still.png"))).arrayBuffer());
  // 영상 번호별 AI 대본 검토 호출 수(revise-once 판정용)·대본 생성 호출 수(scriptRules 회차 판정용)
  const reviewed = new Map<number, number>();
  const generated = new Map<number, number>();
  const plan = (job: Job) => {
    if (!job.sourceSnapshot) throw new Error("Fixture snapshot missing");
    const imageCount =
      job.automation?.policy.mode === "creative" ? (job.automation.policy.imageCount ?? 3) : 3;
    const angles = ["problem_solution", "usage_context", "objection_answer"] as const;
    return CreativePlanSchema.parse({
      sourceDigest: job.sourceSnapshot.digest,
      // 타겟·조각이 없는 예전 형식 기획이라 1판 자료 범위로 검증된다.
      sourceCoverage: evidencePack(job.sourceSnapshot, 1).coverage,
      referenceAnalyses: [],
      diversityRationale: "Three distinct contexts",
      limitations: ["Synthetic fixture only"],
      hypotheses: Array.from({ length: imageCount }, (_, index) => ({
        id: `concept-${index + 1}`,
        angle: angles[index % angles.length],
        decisionRole: "need_awareness",
        targetAudience: `Audience ${index}`,
        targetReason: `Source fact supports message for audience ${index}`,
        customerSituation: `Situation ${index}`,
        problem: `Problem ${index}`,
        message: `Message ${index}`,
        hook: `Hook ${index}`,
        difference: `Different mechanism ${index}`,
        visualMechanism: `Visual ${index}`,
        claimCitations: [{ sourceId: source.id, quote: source.content }],
        referenceSourceIds: [],
        // 카드뉴스 2장: renderScript 의 card_slide 컷이 쓸 이미지
        cardSlides: [1, 2].map((step) => ({
          headline: `Card ${step}`,
          body: source.content,
          imagePrompt: `Card ${step} prompt`,
        })),
        creative: {
          ...fixtureCreative,
          concept: `Concept ${index}`,
          imagePrompt: `Prompt ${index}`,
        },
      })),
    });
  };
  const providers: ProductionProviders = {
    strategy: async () => ({ value: fixtureStrategy, model }),
    creative: async () => ({ value: fixtureCreative, model }),
    plan: async (job) => ({ value: plan(job), model }),
    videoScript: async (job, hypothesis, number, _signal, feedback) => {
      counts.script++;
      scriptFeedback.push(feedback);
      const generation = (generated.get(number) ?? 0) + 1;
      generated.set(number, generation);
      const script = (
        options.script ?? ((job, id, n) => renderScript(n, id, videoTargetSeconds(job.id, n)))
      )(job, hypothesis.id, number);
      // 영문 문장 수(hard 위반 수)를 생성 회차에 따라 조절한다
      const latin =
        control.scriptRules === "latin-always"
          ? 1
          : control.scriptRules === "latin-fewest-second"
            ? generation === 2
              ? 1
              : 2
            : 0;
      const latinTexts = ["Hello 들어 있어요", "World 보여 드려요"];
      return {
        value:
          latin === 0
            ? script
            : {
                ...script,
                voiceover: script.voiceover.map((voice, index) =>
                  index < latin ? { ...voice, text: latinTexts[index] ?? voice.text } : voice,
                ),
              },
        model,
      };
    },
    reviewVideoScript: async (task) => {
      counts.scriptReview++;
      const reviewsOfThisVideo = reviewed.get(task.script.number) ?? 0;
      reviewed.set(task.script.number, reviewsOfThisVideo + 1);
      const revise =
        control.scriptReview === "revise" ||
        (control.scriptReview === "revise-once" && reviewsOfThisVideo === 0);
      const mismatch = control.scriptReview === "mismatch-once" && reviewsOfThisVideo === 0;
      return {
        value: mismatch
          ? {
              status: "revise" as const,
              summary: "픽스처 검토: 2번째 문장의 그림이 말과 다릅니다",
              issues: [
                {
                  sentenceIndex: 1,
                  cutIndexes: [2, 3],
                  problem: "문장이 말하는 600밀리그램이 묶인 컷 화면에 없습니다",
                  fix: "600mg 클로즈업 컷을 이 문장 범위에 넣거나 숫자를 빼세요",
                },
              ],
            }
          : revise
            ? {
                status: "revise" as const,
                summary: "픽스처 검토: 첫 문장이 메모체입니다",
                issues: [
                  {
                    sentenceIndex: 0,
                    cutIndexes: [],
                    problem: "첫 문장이 시청자에게 말을 걸지 않습니다",
                    fix: "퇴근하고 소파에 눕자마자 다리가 퉁퉁 붓는 분이라면 보세요",
                  },
                ],
              }
            : { status: "pass" as const, summary: "픽스처 검토 통과", issues: [] },
        model,
      };
    },
    image: async (_job, prompt, _signal, imageOptions) => {
      counts.image++;
      if (imageOptions?.size === "1024x1536") {
        if (/Still S\d+:/.test(prompt)) {
          counts.still++;
          log.push("still");
        } else {
          counts.startImage++;
          log.push("startImage");
        }
      }
      return { value: png, model };
    },
    review: async () => ({ value: pass, model }),
    reviewStartImage: async () => {
      counts.review++;
      return { value: pass, model };
    },
    reviewClipFrames: async () => {
      counts.review++;
      return { value: pass, model };
    },
    voice: async (task) => {
      counts.voice++;
      log.push("voice");
      const durationMs = Math.round(
        ([...task.text].length / 5.5 / task.tempo) * 1000 * control.durationScale,
      );
      return {
        value: { audio: sineWav(durationMs), durationMs, words: [] },
        model: {
          provider: "typecast",
          requestedModel: "ssfm-v30",
          effectiveModel: "ssfm-v30",
          quality: null,
        },
      };
    },
    veo: {
      create: async (task) => {
        task.signal.throwIfAborted();
        counts.veoCreate++;
        veoPrompts.push(task.prompt);
        log.push("veo.create");
        return {
          name: `operations/fixture-${counts.veoCreate}`,
          startedAt: new Date().toISOString(),
        };
      },
      await: async (task) => {
        counts.veoAwait++;
        log.push("veo.await");
        if (control.holdAwait)
          await Promise.race([
            control.holdAwait,
            new Promise<never>((_, reject) => {
              task.signal.addEventListener(
                "abort",
                () => reject(new DOMException("Cancelled", "AbortError")),
                { once: true },
              );
            }),
          ]);
        task.signal.throwIfAborted();
        if (control.awaitError) throw control.awaitError;
        return { value: clipBytes, model: { ...model, provider: "gemini" } };
      },
    },
  };
  const production = new AutomaticProduction(store, providers);
  const ffmpegCalls: string[][] = [];
  const spy: FfmpegRunner = (args, runOptions) => {
    ffmpegCalls.push([...args]);
    if (log[log.length - 1] !== "ffmpeg") log.push("ffmpeg");
    return runFfmpeg(args, runOptions);
  };
  const music = new MusicLibrary(join(root, "no-bgm"));
  const stub = { run: async () => {} };
  const deps: RenderPipelineDeps = {
    voice: new VoiceProduction(store, providers.voice),
    stills: new StillProduction(store, {
      image: providers.image,
      reviewStartImage: providers.reviewStartImage ?? (async () => ({ value: pass, model })),
    }),
    startImages: new StartImageProduction(store, {
      image: providers.image,
      reviewStartImage: providers.reviewStartImage ?? (async () => ({ value: pass, model })),
    }),
    clips: new ClipProduction(
      store,
      providers.veo,
      options.clipReview === false ? null : providers.reviewClipFrames,
    ),
    render: options.stubRender
      ? stub
      : new RenderProduction(store, library, root, music, renderProfile, spy, {
          encoder: "libx264",
          preset: "ultrafast",
        }),
    preflight: options.stubRender
      ? async () => {
          counts.preflight++;
          log.push("preflight");
          return { warnings: [], concurrencyLimit: 3 };
        }
      : async (job, number, signal) => {
          counts.preflight++;
          log.push("preflight");
          return renderPreflight(
            job,
            number,
            {
              capabilities: ffmpegCapabilities,
              resolveFont,
              music,
              subscription: async () => {
                counts.subscription++;
                return {
                  plan: "lite",
                  planCredits: 200000,
                  usedCredits: 1000,
                  concurrencyLimit: 3,
                };
              },
              credentials: () => control.credentials,
              encoder: "libx264",
            },
            signal,
          );
        },
  };
  const renderPipeline = new RenderPipeline(store, deps);
  const fresh = () =>
    store.create({ ...automationBrief, projectId: project.id, dailyBudget: null });
  return {
    root,
    store,
    library,
    project,
    production,
    providers,
    renderPipeline,
    deps,
    counts,
    log,
    veoPrompts,
    scriptFeedback,
    control,
    ffmpegCalls,
    fresh,
    close: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
export async function settle(engine: {
  tick(): Promise<void>;
  active: Map<string, { promise: Promise<void> }>;
}) {
  await engine.tick();
  await Promise.all([...engine.active.values()].map((task) => task.promise));
}
