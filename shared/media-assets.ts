import { z } from "zod";

export const MediaAssetSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  kind: z.enum(["image", "video"]),
  sourceUrl: z.url(),
  status: z.enum(["pending", "ready", "error"]),
  contentType: z.string().nullable(),
  bytes: z.number().int().nonnegative().nullable(),
  sha256: z.string().nullable(),
  error: z.string().nullable(),
});
export type MediaAsset = z.infer<typeof MediaAssetSchema>;
export const MediaAssetsSchema = z.object({ assets: z.array(MediaAssetSchema) });
