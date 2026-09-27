import { z } from "zod";

export const SourceImageReadingSchema = z.strictObject({
  title: z.string().max(240),
  lines: z.array(z.string().min(1).max(500)).max(40),
});

export const SourceImagePreviewSchema = SourceImageReadingSchema.extend({
  model: z.string().nullable(),
});

export function mergeSourceContent(current: string, incoming: string): string {
  const existing = current.trim();
  const lines = new Set(
    existing
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const additions = incoming
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !lines.has(line));
  return [existing, ...additions].filter(Boolean).join("\n").slice(0, 20_000);
}
