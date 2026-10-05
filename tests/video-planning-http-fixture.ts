import { rmSync } from "node:fs";
import { z } from "zod";
import { evidencePack } from "../server/evidence-pack";
import { ProjectStore } from "../server/project-store";
import { CreativePlanSchema } from "../shared/creative-plan";
import { CreateSourceSchema } from "../shared/sources";
import type { VideoCopyEditingResponse, VideoPlanningDraft } from "../shared/video-planning";
import { scriptResponseValue } from "./automation-http-fixture";
import { providerStore, response } from "./provider-fixtures";
import { sourceFact, sourcePlanResponse, sourceReference } from "./source-planning-fixture";
import { fixtureVideoPlanning } from "./video-planning-fixture";

const RequestSchema = z.object({
  model: z.string(),
  input: z.string(),
  text: z.object({
    format: z.object({
      name: z.enum(["video_planning", "video_copy_editing", "video_script", "video_script_review"]),
      strict: z.boolean(),
    }),
  }),
});
type RequestName = z.infer<typeof RequestSchema>["text"]["format"]["name"];
type CapturedRequest = {
  readonly name: RequestName;
  readonly model: string;
  readonly strict: boolean;
  readonly data: Record<string, unknown>;
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
  const draft: VideoPlanningDraft = {
    audience: planning.audience,
    concept: planning.concept,
    copy: planning.copy,
  };
  const firstLine = draft.copy.lines[0];
  if (!firstLine) throw new TypeError("Planning fixture requires copy lines");
  const changedLine = {
    text: "가방을 닫기 전에, 텀블러 크기부터 살펴보세요.",
    screenText: "가방과 크기 비교",
  };
  const replies: { editing: VideoCopyEditingResponse } = {
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
  const requests: CapturedRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const parsed = RequestSchema.parse(await request.json());
      const marker = "\nDATA:\n";
      const offset = parsed.input.lastIndexOf(marker);
      if (offset < 0) throw new TypeError("Structured DATA is missing");
      requests.push({
        name: parsed.text.format.name,
        model: parsed.model,
        strict: parsed.text.format.strict,
        data: z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(parsed.input.slice(offset + marker.length))),
      });
      const name = parsed.text.format.name;
      switch (name) {
        case "video_planning":
          return response(draft);
        case "video_copy_editing":
          return response(replies.editing);
        case "video_script": {
          const script = scriptResponseValue();
          return response({
            ...script,
            sentences: script.sentences.map((sentence, index) =>
              index === 0
                ? {
                    ...sentence,
                    text: changedLine.text,
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
    replies,
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
