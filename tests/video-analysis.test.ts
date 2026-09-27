import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { MediaAnalyzer } from "../server/media-analysis";
import { ProjectMedia } from "../server/project-media";
import { ProjectStore } from "../server/project-store";
import { JobStore } from "../server/store";
import { CreateSourceSchema } from "../shared/sources";

test("a downloaded three-second video produces cut observations from sampled frames", async () => {
  const prefix = join(tmpdir(), "studio-video-");
  const root = await mkdtemp(prefix);
  const store = new JobStore(root);
  let visionServer: ReturnType<typeof Bun.serve> | null = null;
  try {
    const sample = join(root, "sample.mp4");
    const ffmpeg = Bun.spawnSync([
      "ffmpeg",
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=320x240:r=25:d=3",
      "-an",
      sample,
    ]);
    expect(ffmpeg.exitCode).toBe(0);
    const bytes = new Uint8Array(await Bun.file(sample).arrayBuffer());
    const library = new ProjectStore(store.db);
    const project = library.createProject({ name: "Video project", description: "" });
    const input = CreateSourceSchema.parse({
      kind: "reference",
      title: "Stored video",
      content: "Captured copy",
      url: "https://adstransparency.google.com/advertiser/AR1/creative/CR1?region=KR",
      provenance: {
        origin: "success_ai",
        externalId: "google:CR1",
        capturedAt: "2026-09-24T00:00:00.000Z",
        author: null,
      },
      referenceData: {
        platform: "google",
        brand: "Example",
        headlines: [],
        bodies: [],
        transcriptSegments: [],
        observations: [],
        media: [{ kind: "video", url: "https://www.youtube.com/watch?v=abc12345678" }],
      },
    });
    const source = library.addSource(project.id, input);
    const transport = (async (request: Request | URL | string) => {
      const url = new URL(String(request));
      if (url.pathname.endsWith("/export"))
        return Response.json({
          schemaVersion: 1,
          exportedAt: "2026-09-24T00:00:00.000Z",
          items: [input],
        });
      if (url.pathname.endsWith("/download"))
        return new Response(bytes, { headers: { "Content-Type": "video/mp4" } });
      throw new Error("Unexpected endpoint");
    }) as typeof fetch;
    const media = new ProjectMedia(store.db, root, () => {}, transport);
    media.enqueue(project.id, [source]);
    let asset = media.list(project.id, source)[0];
    for (let attempt = 0; attempt < 100 && asset?.status === "pending"; attempt++) {
      await Bun.sleep(10);
      asset = media.list(project.id, source)[0];
    }
    expect(asset?.status).toBe("ready");
    visionServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const body = (await request.json()) as {
          input: Array<{ content: Array<{ text?: string }> }>;
        };
        const prompt = body.input[0]?.content[0]?.text ?? "";
        const matched = /Sample timestamps JSON: (\[[\d.,]+\])/.exec(prompt)?.[1] ?? "[]";
        const times = z.array(z.number()).parse(JSON.parse(matched));
        const first = times[0] ?? 0;
        const last = times[times.length - 1] ?? first;
        return Response.json({
          status: "completed",
          output: [
            {
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    cuts: [
                      {
                        startSec: first,
                        endSec: last,
                        screenComposition: "빨간 정지 화면",
                        onScreenText: "",
                        messageText: "강한 시각 주목",
                      },
                    ],
                  }),
                },
              ],
            },
          ],
        });
      },
    });
    const analyzer = new MediaAnalyzer(store.db, root, media, () => {}, {
      apiKey: "fixture-key",
      baseUrl: `http://127.0.0.1:${visionServer.port}/v1/`,
    });
    analyzer.start(project.id, source, asset?.id ?? "");
    let analysis = analyzer.get(asset?.id ?? "");
    for (let attempt = 0; attempt < 300 && analysis.status === "running"; attempt++) {
      await Bun.sleep(20);
      analysis = analyzer.get(asset?.id ?? "");
    }
    expect({ status: analysis.status, error: analysis.error }).toEqual({
      status: "complete",
      error: null,
    });
    expect(analysis.report?.cuts[0]).toEqual({
      startSec: 0,
      endSec: 2.5,
      screenComposition: "빨간 정지 화면",
      onScreenText: "",
      messageText: "강한 시각 주목",
    });
    expect(analysis.report?.limitations).toContain(
      "컷 구간은 추출 샘플을 바탕으로 한 관측이며 샘플 사이의 세부 움직임은 확인하지 않았습니다.",
    );
  } finally {
    visionServer?.stop(true);
    store.close();
    if (resolve(root).startsWith(resolve(prefix))) await rm(root, { recursive: true, force: true });
  }
});
