import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { runBrollCli } from "./broll-cli";

// `bun run broll <sheet|add> ...` — 설명은 scripts/broll-cli.ts 와 BROLL-AGENT-BRIEF.md 참고.
const port = process.env["PORT"] || "4317";
const run = (cmd: string, args: readonly string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    const child = spawn(cmd, [...args], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => done({ code: 127, stdout, stderr: `${cmd} 실행 실패: ${e.message}` }));
    child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
  });
const code = await runBrollCli(process.argv.slice(2), {
  fetch,
  baseUrl: process.env["STUDIO_URL"] || `http://127.0.0.1:${port}`,
  dataDir: resolve(process.env["DATA_DIR"] || "data"),
  run,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
process.exit(code);
