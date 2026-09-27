import { z } from "zod";

export const SourceFileSchema = z.strictObject({
  id: z.string(),
  sourceId: z.string(),
  kind: z.enum(["image"]),
  filename: z.string(),
  contentType: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
});
export type SourceFile = z.infer<typeof SourceFileSchema>;

export const SourceFilesSchema = z.strictObject({
  files: z.array(SourceFileSchema),
});
