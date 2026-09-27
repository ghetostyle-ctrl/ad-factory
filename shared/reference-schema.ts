import { z } from "zod";

const HttpUrlSchema = z
  .url()
  .max(8_192)
  .refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
    );
  });

export const ReferenceDataSchema = z.strictObject({
  platform: z.enum(["meta", "google"]),
  brand: z.string().max(500),
  headlines: z.array(z.string().max(10_000)).max(100),
  bodies: z.array(z.string().max(50_000)).max(100),
  transcriptSegments: z
    .array(
      z
        .strictObject({
          startSec: z.number().finite().nonnegative(),
          endSec: z.number().finite().nonnegative(),
          text: z.string().max(10_000),
          provenance: z.literal("whisper"),
        })
        .refine((segment) => segment.endSec >= segment.startSec),
    )
    .max(500),
  media: z
    .array(
      z.strictObject({
        kind: z.enum(["image", "video", "preview"]),
        url: HttpUrlSchema,
      }),
    )
    .max(100),
  observations: z
    .array(
      z.strictObject({
        name: z.enum([
          "delivery_start",
          "delivery_stop",
          "first_seen",
          "last_seen",
          "creative_variant_count",
          "public_views",
          "public_likes",
          "public_comments",
          "published_at",
        ]),
        value: z.union([z.string().max(1_000), z.number().finite()]),
        observedAt: z.iso.datetime().nullable(),
        source: z.enum(["meta_ad_library", "google_ads_transparency", "youtube_public"]),
      }),
    )
    .max(100),
});

export type ReferenceData = z.infer<typeof ReferenceDataSchema>;
