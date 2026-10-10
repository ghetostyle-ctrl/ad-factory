import { z } from "zod";
export const CliConnectionSchema = z.object({
  installed: z.boolean(),
  version: z.string().nullable(),
  authentication: z.enum(["ready", "login_required", "unavailable", "unknown"]),
  message: z.string(),
});
export const CliConnectionsSchema = z.object({
  codex: CliConnectionSchema,
  claudeCode: CliConnectionSchema,
  checkedAt: z.iso.datetime(),
});
export type CliConnection = Readonly<z.infer<typeof CliConnectionSchema>>;
export type CliConnections = Readonly<z.infer<typeof CliConnectionsSchema>>;
