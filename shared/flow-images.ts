import { z } from "zod";
import type { Job } from "./schema";
export const FlowImageRequestSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  target: z.string().min(1).max(160),
  label: z.string().min(1).max(200),
  prompt: z.string().min(1),
  aspect: z.enum(["square", "portrait"]),
  referenceCount: z.number().int().min(0).max(20),
  digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  createdAt: z.iso.datetime(),
});
export type FlowImageRequest = Readonly<z.infer<typeof FlowImageRequestSchema>>;
export const flowImagesOf = (job: Job) => job.flowImageRequests ?? [];
export function flowImagesReady(job: Job): boolean {
  return (
    ["image", "stills", "startImages"].includes(job.automation?.phase ?? "") &&
    flowImagesOf(job).length > 0 &&
    flowImagesOf(job).every((request) => request.digest !== null)
  );
}
