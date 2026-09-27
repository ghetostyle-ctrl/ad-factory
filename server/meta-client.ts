import ky from "ky";
import { z } from "zod";
import { type Account, AccountSchema } from "../shared/schema";
import { credentials, env } from "./config";
import { BlockedError, MissingConnectionError, StudioError } from "./errors";

const DirectorySchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      currency: z.string(),
      business: z.object({ id: z.string(), name: z.string() }).optional(),
    }),
  ),
  paging: z
    .object({
      cursors: z.object({ after: z.string().optional() }).optional(),
      next: z.string().optional(),
    })
    .optional(),
});
export class MetaClient {
  readonly http;
  constructor(
    token = credentials.meta,
    base = `https://graph.facebook.com/${env.META_API_VERSION}/`,
    timeout = 60000,
  ) {
    if (!token)
      throw new MissingConnectionError(
        "Meta 액세스 토큰이 없습니다. 연결 설정에서 토큰을 입력하세요.",
      );
    this.http = ky.create({
      prefixUrl: base,
      headers: { Authorization: `Bearer ${token}` },
      timeout,
      retry: 0,
    });
  }
  get(path: string, params: Readonly<Record<string, string>>): Promise<unknown> {
    return this.http
      .get(path, { searchParams: params, retry: { limit: 2, methods: ["get"] } })
      .json();
  }
  post(path: string, data: Readonly<Record<string, unknown>>): Promise<unknown> {
    return this.http.post(path, { json: data }).json();
  }
  async accounts(): Promise<Account[]> {
    const accounts: Account[] = [];
    let after: string | undefined;
    for (let page = 0; page < 50; page++) {
      const result = DirectorySchema.parse(
        await this.get("me/adaccounts", {
          fields: "id,name,currency,business{id,name}",
          limit: "100",
          ...(after ? { after } : {}),
        }),
      );
      accounts.push(
        ...result.data.map((item) =>
          AccountSchema.parse({
            id: item.id,
            name: item.name,
            currency: item.currency,
            businessId: item.business?.id ?? "",
            businessName: item.business?.name ?? "",
          }),
        ),
      );
      after = result.paging?.next ? result.paging.cursors?.after : undefined;
      if (!after) return accounts;
    }
    throw new StudioError(
      "directory_limit",
      "계정 목록이 너무 큽니다. 권한이 제한된 토큰을 사용하세요.",
    );
  }
}
export function budgetMinorUnits(amount: number, currency: string): number {
  const multiplier = currency === "KRW" || currency === "JPY" ? 1 : 100;
  if (!["KRW", "JPY", "USD", "EUR", "GBP"].includes(currency))
    throw new BlockedError("이 통화의 예산 단위는 아직 지원하지 않습니다.");
  const scaled = amount * multiplier;
  const value = Math.round(scaled);
  if (!Number.isSafeInteger(value) || Math.abs(value - scaled) > 0.000001)
    throw new BlockedError("통화 최소 단위에 맞는 예산을 입력하세요.");
  return value;
}
