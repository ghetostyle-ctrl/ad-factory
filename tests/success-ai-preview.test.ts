import { expect, test } from "bun:test";
import ky from "ky";
import { previewSuccessAi } from "../server/success-ai";
import { SuccessAiPreviewSchema } from "../shared/sources";

const query = SuccessAiPreviewSchema.parse({ platform: "meta", keyword: "Brand" });
const exported = {
  schemaVersion: 1,
  exportedAt: "2026-09-24T00:00:00.000Z",
  items: [
    {
      kind: "reference",
      title: "Saved ad",
      content: "Actual headline",
      url: null,
      provenance: { origin: "success_ai", externalId: "meta:123" },
    },
  ],
};

test("rejects arbitrary connector origins when preview input is parsed", () => {
  const supplied = { platform: "meta", keyword: "Brand", url: "http://attacker.test" };
  const result = SuccessAiPreviewSchema.safeParse(supplied);
  expect(result.success).toBe(false);
});

test("connector request stays on fixed loopback when a keyword contains URL syntax", async () => {
  const requested: Request[] = [];
  const transport = ky.create({
    fetch: async (input) => {
      requested.push(input instanceof Request ? input : new Request(input));
      return Response.json(exported);
    },
  });
  await previewSuccessAi(
    SuccessAiPreviewSchema.parse({ platform: "meta", keyword: "http://attacker.test/?token=x" }),
    transport,
  );
  const observed = requested[0];
  expect(observed).toBeDefined();
  if (!observed) return;
  expect(new URL(observed.url).origin).toBe("http://localhost:3000");
  expect(new URL(observed.url).searchParams.get("keyword")).toBe("http://attacker.test/?token=x");
  expect(observed.redirect).toBe("error");
});

test("blocks large responses when the loopback exporter advertises an oversized body", async () => {
  const transport = ky.create({
    fetch: async () => new Response("{}", { headers: { "content-length": "2000001" } }),
  });
  await expect(previewSuccessAi(query, transport)).rejects.toMatchObject({
    code: "reference_size",
  });
});

test("blocks large streamed responses when the exporter omits content length", async () => {
  const transport = ky.create({ fetch: async () => new Response(new Uint8Array(2000001)) });
  await expect(previewSuccessAi(query, transport)).rejects.toMatchObject({
    code: "reference_size",
  });
});

test("rejects claimed product facts when Success AI returns a competitor reference", async () => {
  const transport = ky.create({
    fetch: async () =>
      Response.json({
        ...exported,
        items: [
          {
            kind: "product_fact",
            title: "False authority",
            content: "Claimed fact",
            provenance: { origin: "success_ai", externalId: "meta:123" },
          },
        ],
      }),
  });
  await expect(previewSuccessAi(query, transport)).rejects.toMatchObject({
    code: "reference_format",
  });
});

test("reports a missing saved brand when Success AI has no export match", async () => {
  const transport = ky.create({ fetch: async () => new Response("{}", { status: 404 }) });
  await expect(previewSuccessAi(query, transport)).rejects.toMatchObject({
    code: "reference_missing",
  });
});

test("reports connection failure without returning fabricated ad evidence", async () => {
  const transport = ky.create({
    fetch: async () => {
      throw new TypeError("Connection refused");
    },
  });
  await expect(previewSuccessAi(query, transport)).rejects.toMatchObject({
    code: "reference_unavailable",
  });
});
