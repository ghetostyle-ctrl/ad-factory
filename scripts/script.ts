import { runScriptCli } from "./script-cli";

// `bun run script <show|approve|rewrite> ...` — 설명은 scripts/script-cli.ts 와 FLOW-MODE.md 참고.
const port = process.env["PORT"] || "4317";
const code = await runScriptCli(process.argv.slice(2), {
  fetch,
  baseUrl: process.env["STUDIO_URL"] || `http://127.0.0.1:${port}`,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
process.exit(code);
