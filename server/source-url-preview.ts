import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { StudioError } from "./errors";

const maxHtmlBytes = 2_000_000;
const maxContentCharacters = 12_000;
const gmarketProductSchema = z.object({
  props: z.object({
    initialState: z.object({
      orderItemData: z.object({
        data: z.object({
          goods: z.object({
            goodsCode: z.string(),
            goodsName: z.string().min(1),
            brandName: z.string().nullish(),
          }),
        }),
      }),
    }),
  }),
});

function gmarketGlobalUrl(url: URL): URL | null {
  if (url.hostname !== "item.gmarket.co.kr" || url.pathname.toLowerCase() !== "/item") return null;
  const code = url.searchParams.get("goodscode");
  return code && /^\d+$/.test(code)
    ? new URL(`https://global.gmarket.co.kr/item?goodscode=${code}`)
    : null;
}

function extractGmarketDraft(html: string, original: string, code: string) {
  const match =
    /<script\s+id=["']__NEXT_DATA__["']\s+type=["']application\/json["']>([\s\S]*?)<\/script>/i.exec(
      html,
    );
  let parsed: z.infer<typeof gmarketProductSchema> | null = null;
  if (match?.[1]) {
    try {
      const result = gmarketProductSchema.safeParse(JSON.parse(match[1]));
      if (result.success) parsed = result.data;
    } catch (cause) {
      if (!(cause instanceof SyntaxError)) throw cause;
    }
  }
  const goods = parsed?.props.initialState.orderItemData.data.goods;
  if (!goods || goods.goodsCode !== code)
    throw new StudioError(
      "source_scan_empty",
      "지마켓의 대체 상품 페이지에서 이 상품의 정보를 확인하지 못했습니다. 상세페이지 이미지나 본문을 넣어 주세요.",
      400,
    );
  const title = readableText(goods.goodsName).slice(0, 240);
  const brand = readableText(goods.brandName ?? "");
  return {
    url: original,
    title,
    content: [`상품명: ${title}`, brand ? `브랜드: ${brand}` : ""].filter(Boolean).join("\n"),
    warning:
      "지마켓 글로벌 상품 페이지에서 상품명과 브랜드를 가져왔습니다. 상세 정보는 이미지나 본문을 함께 넣고 확인해 주세요.",
  };
}

function readableText(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(
      /&#(?:x([0-9a-f]+)|([0-9]+));?/gi,
      (_match, hex: string | undefined, decimal: string | undefined) => {
        const code = Number.parseInt(hex ?? decimal ?? "", hex ? 16 : 10);
        return Number.isInteger(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : "";
      },
    )
    .replace(
      /&(amp|quot|apos|lt|gt|nbsp);/gi,
      (_match, name: string) =>
        ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " })[
          name.toLowerCase() as "amp" | "quot" | "apos" | "lt" | "gt" | "nbsp"
        ],
    )
    .replace(/\s+/g, " ")
    .trim();
}

function productEntries(value: unknown): { name: string; description: string }[] {
  if (Array.isArray(value)) return value.flatMap(productEntries);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const type = record["@type"];
  const { name, description } = record;
  const types = Array.isArray(type) ? type : [type];
  const own = types.some((item) => typeof item === "string" && item.toLowerCase() === "product")
    ? [
        {
          name: typeof name === "string" ? name : "",
          description: typeof description === "string" ? description : "",
        },
      ]
    : [];
  return [...own, ...productEntries(record["@graph"])];
}

export async function extractSourceDraft(html: string, url: string) {
  let pageTitle = "";
  let heading = "";
  let openGraphTitle = "";
  let description = "";
  let openGraphDescription = "";
  let structured: { name: string; description: string } | null = null;
  const bodyLines: string[] = [];
  const mainLines: string[] = [];
  let preferredDepth = 0;
  let currentText = "";
  let currentScript = "";
  let currentPreferred = false;
  const rewriter = new HTMLRewriter()
    .on("main, article", {
      element(element) {
        preferredDepth++;
        element.onEndTag(() => {
          preferredDepth--;
        });
      },
    })
    .on("meta[name='description']", {
      element(element) {
        description = element.getAttribute("content") ?? "";
      },
    })
    .on("meta[property='og:description']", {
      element(element) {
        openGraphDescription = element.getAttribute("content") ?? "";
      },
    })
    .on("meta[property='og:title']", {
      element(element) {
        openGraphTitle = element.getAttribute("content") ?? "";
      },
    })
    .on("title", {
      element(element) {
        currentText = "";
        element.onEndTag(() => {
          pageTitle = readableText(currentText);
        });
      },
      text(text) {
        currentText += text.text;
      },
    })
    .on("h1, h2, h3, p, li, dt, dd", {
      element(element) {
        currentText = "";
        currentPreferred = preferredDepth > 0;
        const tag = element.tagName;
        element.onEndTag(() => {
          const line = readableText(currentText);
          if (tag === "h1" && !heading) heading = line;
          if (line.length >= 3 && line.length <= 1000) {
            bodyLines.push(line);
            if (currentPreferred) mainLines.push(line);
          }
        });
      },
      text(text) {
        currentText += text.text;
      },
    })
    .on("script[type='application/ld+json']", {
      element(element) {
        currentScript = "";
        element.onEndTag(() => {
          if (currentScript.length > 100_000 || structured) return;
          try {
            structured = productEntries(JSON.parse(currentScript))[0] ?? null;
          } catch {
            /* Invalid publisher metadata is ignored. */
          }
        });
      },
      text(text) {
        currentScript += text.text;
      },
    });
  await rewriter
    .transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }))
    .text();
  const product = structured as { name: string; description: string } | null;
  const title = readableText(product?.name || heading || openGraphTitle || pageTitle).slice(0, 240);
  const lines = [
    product?.description ?? "",
    openGraphDescription,
    description,
    ...(mainLines.length ? mainLines : bodyLines),
  ]
    .map(readableText)
    .filter((line) => line.length >= 3);
  const unique = [...new Set(lines)];
  const content = unique.join("\n").slice(0, maxContentCharacters).trim();
  if (!title && !content)
    throw new StudioError(
      "source_scan_empty",
      "이 페이지에서 읽을 수 있는 제목이나 본문을 찾지 못했습니다. 화면 캡처나 텍스트를 직접 넣어 주세요.",
      400,
    );
  return {
    url,
    title,
    content,
    warning: content ? null : "제목만 읽었습니다. 자료 내용을 직접 확인해 입력해 주세요.",
  };
}

function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family === 6)
    return /^[23][0-9a-f]{3}:/i.test(address) && !address.toLowerCase().startsWith("2001:db8:");
  return false;
}

type HostResolver = (hostname: string) => Promise<{ address: string; family: number }[]>;
type FetchPage = (url: URL, init: RequestInit) => Promise<Response>;

async function safeUrl(raw: string, resolveHost: HostResolver): Promise<URL> {
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !["", "80", "443"].includes(url.port) ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname.endsWith(".local")
  ) {
    throw new StudioError(
      "source_scan_url",
      "공개 웹페이지의 HTTP 또는 HTTPS 주소를 입력해 주세요.",
      400,
    );
  }
  if (isIP(url.hostname)) {
    if (!publicAddress(url.hostname))
      throw new StudioError("source_scan_url", "내부 네트워크 주소는 스캔할 수 없습니다.", 400);
  } else {
    let records: { address: string; family: number }[];
    try {
      records = await resolveHost(url.hostname);
    } catch {
      throw new StudioError(
        "source_scan_dns",
        "출처 주소를 찾지 못했습니다. URL을 확인해 주세요.",
        400,
      );
    }
    if (!records.length || records.some((record) => !publicAddress(record.address)))
      throw new StudioError("source_scan_url", "내부 네트워크 주소는 스캔할 수 없습니다.", 400);
  }
  return url;
}

export async function previewSourceUrl(
  raw: string,
  fetchPage: FetchPage = (url, init) => fetch(url, init),
  resolveHost: HostResolver = (hostname) => lookup(hostname, { all: true }),
) {
  let current = raw;
  let gmarketCode: string | null = null;
  for (let redirect = 0; redirect < 4; redirect++) {
    const url = await safeUrl(current, resolveHost);
    let response: Response;
    try {
      response = await fetchPage(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(12_000),
        headers: {
          Accept: "text/html",
          "User-Agent": "Mozilla/5.0 (compatible; AdFactorySourcePreview/1.0)",
        },
      });
    } catch {
      throw new StudioError(
        "source_scan_unavailable",
        "페이지를 열지 못했습니다. 접근이 막힌 페이지라면 캡처나 본문을 직접 넣어 주세요.",
        503,
      );
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) break;
      current = new URL(location, url).toString();
      continue;
    }
    const globalUrl: URL | null =
      response.status === 403 && !gmarketCode ? gmarketGlobalUrl(url) : null;
    if (globalUrl) {
      gmarketCode = globalUrl.searchParams.get("goodscode");
      current = globalUrl.toString();
      continue;
    }
    if (!response.ok)
      throw new StudioError(
        "source_scan_unavailable",
        `페이지를 읽지 못했습니다. (HTTP ${response.status}) 캡처나 본문을 직접 넣어 주세요.`,
        503,
      );
    if (!response.headers.get("content-type")?.toLowerCase().includes("text/html"))
      throw new StudioError(
        "source_scan_type",
        "HTML 페이지 주소를 넣어 주세요. 이미지나 PDF는 파일 첨부를 사용해 주세요.",
        400,
      );
    if (Number(response.headers.get("content-length")) > maxHtmlBytes)
      throw new StudioError(
        "source_scan_size",
        "페이지가 너무 큽니다. 캡처나 본문을 직접 넣어 주세요.",
        413,
      );
    const reader = response.body?.getReader();
    if (!reader) throw new StudioError("source_scan_empty", "페이지 본문이 비어 있습니다.", 400);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > maxHtmlBytes)
          throw new StudioError(
            "source_scan_size",
            "페이지가 너무 큽니다. 캡처나 본문을 직접 넣어 주세요.",
            413,
          );
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const charset =
      /charset=([^;\s]+)/i.exec(response.headers.get("content-type") ?? "")?.[1] ?? "utf-8";
    let decoder: TextDecoder;
    try {
      decoder = new TextDecoder(charset);
    } catch {
      decoder = new TextDecoder();
    }
    const html = decoder.decode(Buffer.concat(chunks));
    if (gmarketCode) return extractGmarketDraft(html, raw, gmarketCode);
    return extractSourceDraft(html, url.toString());
  }
  throw new StudioError(
    "source_scan_redirect",
    "페이지 이동이 너무 많습니다. 최종 상세페이지 주소를 넣어 주세요.",
    400,
  );
}
