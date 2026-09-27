import { z } from "zod";
import { SourceUrlSchema } from "./sources";

export const SourceUrlPreviewRequestSchema = z.object({ url: SourceUrlSchema }).strict();
export const SourceUrlPreviewSchema = z.object({
  url: SourceUrlSchema,
  title: z.string().max(240),
  content: z.string().max(20000),
  warning: z.string().nullable(),
});
