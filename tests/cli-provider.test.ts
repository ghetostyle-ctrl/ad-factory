import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { checkCliConnection } from "../server/cli-connections";
import { type CliRunner, cliEnvironment, runCliProcess } from "../server/cli-process";
import { claudeCodeArguments, claudeCodeInput, cliText } from "../server/cli-text-provider";
import { getModelSettings, saveModelSettings, snapshotModels } from "../server/model-settings";
import { ExecutionModelsSchema } from "../shared/models";

const roots: string[] = [];
const root = () => {
  const path = mkdtempSync(join(tmpdir(), "studio-cli-"));
  roots.push(path);
  return path;
};
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
const Answer = z.object({ title: z.string() }).strict();
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
function task(provider: "codex" | "claudeCode") {
  const directory = root();
  saveModelSettings(directory, {
    ...getModelSettings(directory),
    textProvider: provider,
    codexModel: "codex-fixture",
    claudeCodeModel: "sonnet",
    scriptProvider: "anthropic",
  });
  return {
    directory,
    models: snapshotModels(directory),
    name: "test",
    prompt: "한글과 $(literal) `literal`",
    schema: Answer,
    signal: new AbortController().signal,
    images: [png, png],
  };
}
test("CLI selection pins script routing and preserves old snapshot shape", () => {
  const input = task("claudeCode");
  expect(input.models.scriptProvider).toBe("same");
  expect(input.models.claudeCodeModel).toBe("sonnet");
  const { claudeCodeModel: omitted, ...old } = input.models;
  expect(omitted).toBe("sonnet");
  expect(Object.hasOwn(ExecutionModelsSchema.parse(old), "claudeCodeModel")).toBe(false);
});
test("Claude receives all images and literal prompt without enabling tools", () => {
  const input = task("claudeCode");
  const message = JSON.parse(claudeCodeInput(input));
  expect(message.message.content).toHaveLength(3);
  expect(message.message.content[0].text).toBe(input.prompt);
  expect(message.message.content[1].source.media_type).toBe("image/png");
  const args = claudeCodeArguments("{}", "sonnet");
  expect(args[args.indexOf("--tools") + 1]).toBe("");
  expect(args).toContain("--safe-mode");
  expect(args).not.toContain("--bare");
  expect(args).not.toContain("--dangerously-skip-permissions");
});
test("Codex attaches every image and validates saved JSON", async () => {
  const input = task("codex");
  const run: CliRunner = async (call) => {
    expect(call.stdin).toBe(input.prompt);
    expect(call.args.filter((arg) => arg === "--image")).toHaveLength(2);
    const destination = call.args[call.args.indexOf("--output-last-message") + 1];
    if (!destination) throw new TypeError("missing result path");
    await Bun.write(destination, JSON.stringify({ title: "완료" }));
    return { code: 0, stdout: "", stderr: "" };
  };
  expect(await cliText(input, { run, binary: "fixture" })).toMatchObject({
    value: { title: "완료" },
    model: { provider: "codex" },
  });
});
test("Claude consumes structured output and retains provider identity", async () => {
  const run: CliRunner = async () => ({
    code: 0,
    stdout: JSON.stringify({
      type: "result",
      subtype: "success",
      structured_output: { title: "완료" },
    }),
    stderr: "",
  });
  expect(await cliText(task("claudeCode"), { run, binary: "fixture" })).toMatchObject({
    value: { title: "완료" },
    model: { provider: "claudeCode", requestedModel: "sonnet" },
  });
});
for (const response of [
  { type: "result", subtype: "error_max_turns", is_error: true },
  { type: "result", subtype: "success", structured_output: { title: 1 } },
  { type: "result", subtype: "success", result: '{"title":"unstructured"}' },
])
  test("rejects incomplete or invalid Claude responses", async () => {
    await expect(
      cliText(task("claudeCode"), {
        binary: "fixture",
        run: async () => ({ code: 0, stdout: JSON.stringify(response), stderr: "" }),
      }),
    ).rejects.toThrow();
  });
test("CLI failure never falls back to a paid API and hides raw details", async () => {
  await expect(
    cliText(task("claudeCode"), {
      binary: "fixture",
      run: async () => ({ code: 1, stdout: "", stderr: "rate limit secret-account" }),
    }),
  ).rejects.toThrow("사용량 한도");
});
test("only OS configuration is inherited by CLI", () => {
  expect(
    cliEnvironment({
      PATH: "path",
      HOME: "home",
      OPENAI_API_KEY: "secret",
      ANTHROPIC_API_KEY: "secret",
      META_ACCESS_TOKEN: "secret",
      CLAUDECODE: "1",
    }),
  ).toEqual({ PATH: "path", HOME: "home" });
});
test("auth status exposes no account data and makes no print request", async () => {
  const connection = await checkCliConnection({
    provider: "claudeCode",
    binary: "fixture",
    directory: root(),
    run: async (input) => ({
      code: 0,
      stdout:
        input.args[0] === "--version"
          ? "2.1.227"
          : JSON.stringify({ loggedIn: true, email: "private@example.com" }),
      stderr: "",
    }),
  });
  expect(connection.authentication).toBe("ready");
  expect(JSON.stringify(connection)).not.toContain("private@");
});
test("subprocess handles unicode and does not inherit API keys", async () => {
  const result = await runCliProcess({
    binary: process.execPath,
    args: ["--no-env-file", "-e", "console.log(await Bun.stdin.text())"],
    directory: root(),
    stdin: "한글 그대로",
    signal: new AbortController().signal,
  });
  expect(result.code).toBe(0);
  expect(result.stdout.trim()).toBe("한글 그대로");
});
test("subprocess timeout terminates waiting work", async () => {
  await expect(
    runCliProcess({
      binary: process.execPath,
      args: ["--no-env-file", "-e", "setInterval(()=>{},1000)"],
      directory: root(),
      stdin: "",
      signal: new AbortController().signal,
      timeoutMs: 100,
    }),
  ).rejects.toThrow("시간이 초과");
});
test("cancelled input never starts a subprocess", async () => {
  const signal = AbortSignal.abort();
  expect(() =>
    runCliProcess({ binary: "should-not-run", args: [], directory: root(), stdin: "", signal }),
  ).toThrow();
});

test("negative Codex login text cannot be mistaken for authenticated status", async () => {
  const result = await checkCliConnection({
    provider: "codex",
    binary: "fixture",
    directory: root(),
    run: async () => ({ code: 0, stdout: "Not logged in", stderr: "" }),
  });
  expect(result.authentication).toBe("login_required");
});
test("active cancellation terminates the CLI subprocess", async () => {
  const controller = new AbortController();
  const result = runCliProcess({
    binary: process.execPath,
    args: ["--no-env-file", "-e", "setInterval(()=>{},1000)"],
    directory: root(),
    stdin: "",
    signal: controller.signal,
  });
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    clearTimeout(timer);
  }
});

test("standard Windows npm wrappers launch through Node without a shell", async () => {
  const directory = root();
  const script = join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
  await Bun.write(
    script,
    'process.stdin.setEncoding("utf8");let text="";process.stdin.on("data",x=>text+=x);process.stdin.on("end",()=>console.log(text));',
  );
  const result = await runCliProcess({
    binary: join(directory, "codex.cmd"),
    args: [],
    directory,
    stdin: "wrapper 한글 $(literal)",
    signal: new AbortController().signal,
  });
  expect(result.code).toBe(0);
  expect(result.stdout.trim()).toBe("wrapper 한글 $(literal)");
});
