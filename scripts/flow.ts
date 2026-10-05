import { resolve } from "node:path";
import { runFlowCli } from "./flow-cli";

// `bun run flow <export|import> ...` — 설명은 scripts/flow-cli.ts 와 FLOW-MODE.md 참고.
const port = process.env["PORT"] || "4317";
const code = await runFlowCli(process.argv.slice(2), {
  fetch,
  baseUrl: process.env["STUDIO_URL"] || `http://127.0.0.1:${port}`,
  dataDir: resolve(process.env["DATA_DIR"] || "data"),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
process.exit(code);
