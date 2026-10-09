import { z } from "zod";

export const ActionSyncSchema = z.strictObject({
  clipId: z.enum(["I1", "I2", "I3"]),
  beatId: z.string().trim().min(1).max(40),
});
