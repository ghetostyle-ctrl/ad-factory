import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app";
import { env } from "../server/config";
import { ProjectStore } from "../server/project-store";
import { extractSourceDraft, previewSourceUrl } from "../server/source-url-preview";
import { JobStore } from "../server/store";

const html = `<html><head><title>기본 제품</title><meta name="description" content="스테인리스 물병, 용량 500ml"></head>
<body><nav><p>장바구니 메뉴</p></nav><main><h1>스테인리스 물병</h1><p>용량 500ml</p><p>구성품: 본체, 뚜껑</p></main></body></html>`;
const publicResolver = async () => [{ address: "93.184.215.14", family: 4 }];

test("extracts observed product text from the page body without navigation or invented claims", async () => {
  const draft = await extractSourceDraft(html, "https://shop.example/product");
  expect(draft.title).toBe("스테인리스 물병");
  expect(draft.content).toContain("용량 500ml");
  expect(draft.content).toContain("구성품: 본체, 뚜껑");
  expect(draft.content).not.toContain("장바구니 메뉴");
});

test("uses product structured data when present and preserves the actual source wording", async () => {
  const draft = await extractSourceDraft(
    `<html><head><script type="application/ld+json">{"@type":"Product","name":"데일리 텀블러","description":"용량 750ml · 실리콘 손잡이"}</script></head><body></body></html>`,
    "https://shop.example/item",
  );
  expect(draft.title).toBe("데일리 텀블러");
  expect(draft.content).toBe("용량 750ml · 실리콘 손잡이");
});

test("returns a reviewable draft from a bounded public HTML fetch", async () => {
  const draft = await previewSourceUrl(
    "https://shop.example/product",
    async () => new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
    publicResolver,
  );
  expect(draft.title).toBe("스테인리스 물병");
  expect(draft.warning).toBeNull();
});

test("uses Gmarket's public global product page when the Korean page rejects the scan", async () => {
  const original = "https://item.gmarket.co.kr/Item?goodscode=4723846736&lcd=100000036";
  const requested: string[] = [];
  const globalHtml = `<html><head><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    {
      props: {
        initialState: {
          orderItemData: {
            data: {
              goods: {
                goodsCode: "4723846736",
                goodsName: "Pure Olive Oil 600mg 30 Capsules",
                brandName: "Chong Kun Dang",
              },
            },
          },
        },
      },
    },
  )}</script></head><body>Shipping policy and unrelated recommendations</body></html>`;
  const draft = await previewSourceUrl(
    original,
    async (url) => {
      requested.push(url.toString());
      return url.hostname === "item.gmarket.co.kr"
        ? new Response("blocked", { status: 403 })
        : new Response(globalHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    },
    publicResolver,
  );
  expect(requested).toEqual([original, "https://global.gmarket.co.kr/item?goodscode=4723846736"]);
  expect(draft.url).toBe(original);
  expect(draft.title).toBe("Pure Olive Oil 600mg 30 Capsules");
  expect(draft.content).toContain("Chong Kun Dang");
  expect(draft.content).not.toContain("Shipping policy");
  expect(draft.warning).toContain("글로벌");
});

test("rejects private URLs and private redirects before fetching them", async () => {
  let fetches = 0;
  const fetchPage = async () => {
    fetches++;
    return new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/private" } });
  };
  await expect(
    previewSourceUrl("http://127.0.0.1/private", fetchPage, publicResolver),
  ).rejects.toMatchObject({ code: "source_scan_url" });
  expect(fetches).toBe(0);
  await expect(
    previewSourceUrl("https://shop.example/product", fetchPage, publicResolver),
  ).rejects.toMatchObject({ code: "source_scan_url" });
  expect(fetches).toBe(1);
});

test("URL preview endpoint never saves a source when a scan is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-source-url-"));
  const store = new JobStore(root);
  try {
    const project = new ProjectStore(store.db).createProject({
      name: "Product test",
      description: "",
    });
    const origin = `http://127.0.0.1:${env.PORT}`;
    const response = await createApp(store).request(
      new Request(`${origin}/api/projects/${project.id}/source-url-preview`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ url: "http://127.0.0.1/internal" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(new ProjectStore(store.db).listSources(project.id)).toEqual([]);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
