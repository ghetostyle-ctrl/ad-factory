import { z } from "zod";
import { ProjectIdSchema } from "./sources";

export const PRODUCTION_ASSET_MAX_BYTES = 200 * 1024 * 1024;
export const PRODUCTION_UPLOAD_MAX_BYTES = 201 * 1024 * 1024;
export const ProductionAssetIdSchema = z.string().uuid().brand<"ProductionAssetId">();
export const ProductionAssetTargetsSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }).strict(),
  z
    .object({
      mode: z.literal("selected"),
      videoNumbers: z
        .array(z.number().int().min(1).max(10))
        .min(1)
        .max(10)
        .refine(
          (numbers) => new Set(numbers).size === numbers.length,
          "영상 번호는 중복할 수 없습니다.",
        ),
    })
    .strict(),
]);
export const ProductionAssetSettingsSchema = z
  .object({
    usage: z.enum(["required", "optional"]).default("required"),
    startSec: z.number().finite().nonnegative().default(0),
    endSec: z.number().finite().positive().nullable().default(null),
    placement: z.enum(["auto", "opening", "middle", "ending"]).default("auto"),
    targets: ProductionAssetTargetsSchema.default({ mode: "all" }),
    audio: z.enum(["keep", "mute"]).default("mute"),
    notes: z.string().max(2000).default(""),
  })
  .strict()
  .refine((settings) => settings.endSec === null || settings.endSec > settings.startSec, {
    path: ["endSec"],
    message: "종료 시간은 시작 시간보다 커야 합니다.",
  });
export type ProductionAssetSettings = z.infer<typeof ProductionAssetSettingsSchema>;
export const DEFAULT_PRODUCTION_ASSET_SETTINGS: ProductionAssetSettings =
  ProductionAssetSettingsSchema.parse({});
export const ProductionAssetSchema = z
  .object({
    id: ProductionAssetIdSchema,
    projectId: ProjectIdSchema,
    title: z.string().trim().min(1).max(240),
    filename: z.string().min(1).max(240),
    contentType: z.enum(["video/mp4", "video/quicktime", "video/webm"]),
    bytes: z.number().int().positive().max(PRODUCTION_ASSET_MAX_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    durationSec: z.number().finite().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    hasAudio: z.boolean(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    settings: ProductionAssetSettingsSchema,
  })
  .strict();
export type ProductionAsset = z.infer<typeof ProductionAssetSchema>;
export const UpdateProductionAssetSchema = z
  .object({
    title: ProductionAssetSchema.shape.title,
    settings: ProductionAssetSettingsSchema,
  })
  .strict();
export type UpdateProductionAsset = z.infer<typeof UpdateProductionAssetSchema>;
export const ProductionAssetsSchema = z.object({ assets: z.array(ProductionAssetSchema) });
