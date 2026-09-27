import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MediaAnalyzer } from "../server/media-analysis";
import { ProjectMedia } from "../server/project-media";
import { ProjectStore } from "../server/project-store";
import { JobStore } from "../server/store";
import { CreateSourceSchema } from "../shared/sources";
import { fixturePng } from "./automation-http-fixture";

test("imports the actual stored image into its own project and keeps its source link", async () => {
  const prefix = join(tmpdir(), "studio-media-");
  const root = await mkdtemp(prefix);
  const store = new JobStore(root);
  let visionServer: ReturnType<typeof Bun.serve> | null = null;
  try {
    const library = new ProjectStore(store.db);
    const project = library.createProject({ name: "Media project", description: "" });
    const imageUrl = "https://scontent.example.fbcdn.net/ad.png";
    const input = CreateSourceSchema.parse({
      kind: "reference",
      title: "Stored ad",
      content: "Captured ad copy",
      url: "https://www.facebook.com/ads/library/?id=123",
      provenance: {
        origin: "success_ai",
        externalId: "meta:123",
        capturedAt: "2026-09-24T00:00:00.000Z",
        author: null,
      },
      referenceData: {
        platform: "meta",
        brand: "Example",
        headlines: [],
        bodies: [],
        transcriptSegments: [],
        observations: [],
        media: [{ kind: "image", url: imageUrl }],
      },
    });
    const source = library.addSource(project.id, input);
    const bytes = Uint8Array.from(Buffer.from(fixturePng, "base64"));
    const transport = (async (request: Request | URL | string) => {
      const url = new URL(String(request));
      if (url.pathname.endsWith("/export"))
        return Response.json({
          schemaVersion: 1,
          exportedAt: "2026-09-24T00:00:00.000Z",
          items: [input],
        });
      if (url.pathname.endsWith("/media"))
        return new Response(bytes, { headers: { "Content-Type": "image/png" } });
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
    expect(asset?.sourceUrl).toBe(imageUrl);
    expect(asset?.bytes).toBe(bytes.length);
    expect(asset?.sha256).toMatch(/^[a-f0-9]{64}$/);
    const file = media.file(project.id, source.id, asset?.id ?? "");
    expect(new Uint8Array(await Bun.file(file.path).arrayBuffer())).toEqual(bytes);
    expect(media.list("00000000-0000-0000-0000-000000000000", source)).toEqual([]);
    visionServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const body = (await request.json()) as {
          input: Array<{ content: Array<{ type: string }> }>;
        };
        expect(body.input[0]?.content.some((part) => part.type === "input_image")).toBe(true);
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
                        startSec: 0,
                        endSec: 0,
                        screenComposition: "제품 이미지",
                        onScreenText: "",
                        messageText: "상품 인지",
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
    for (let attempt = 0; attempt < 100 && analysis.status === "running"; attempt++) {
      await Bun.sleep(10);
      analysis = analyzer.get(asset?.id ?? "");
    }
    expect(analysis.status).toBe("complete");
    expect(analysis.report?.cuts[0]?.screenComposition).toBe("제품 이미지");
  } finally {
    visionServer?.stop(true);
    store.close();
    if (resolve(root).startsWith(resolve(prefix))) await rm(root, { recursive: true, force: true });
  }
});
