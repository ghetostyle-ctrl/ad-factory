import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { afterEach, test } from "node:test";
import { health, identity, inside } from "../scripts/launcher-files.mjs";
import { cleanGit, updateInstallation } from "../scripts/launcher-update.mjs";

const runs = [];
const bun = spawnSync("where.exe", ["bun"], { encoding: "utf8" }).stdout.trim().split(/\r?\n/)[0];
const sha = "1".repeat(40);
async function fixture({ badBuild = false, badBoot = false, warming = false } = {}) {
  await fs.mkdir(path.resolve("work/launcher-tests"), { recursive: true });
  const root = await fs.mkdtemp(path.resolve("work/launcher-tests/install-"));
  const release = path.join(root, ".runtime", "fixture-release");
  await fs.mkdir(path.join(root, "server"), { recursive: true });
  await fs.mkdir(path.join(root, "data"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.writeFile(path.join(root, ".env"), "PRIVATE_MARKER=keep-me");
  await fs.writeFile(path.join(root, "data", "result.mp4"), "original-result");
  await fs.writeFile(path.join(root, "dist", "index.html"), "old build");
  await fs.writeFile(path.join(root, "version.txt"), "old");
  await fs.writeFile(path.join(root, "start-local.ps1"), "fixture launcher");
  const source = `import{createHash}from'node:crypto';const installationId=createHash('sha256').update(process.cwd().split(String.fromCharCode(92)).join('/').toLowerCase()).digest('hex').slice(0,32);Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT),fetch:r=>Response.json(r.url.endsWith('/api/health')?{app:'meta-ad-studio',installationId,pid:process.pid}:{engine:{activeJobs:0},jobs:[]})});`;
  await fs.writeFile(path.join(root, "server", "index.ts"), source);
  await fs.mkdir(path.join(release, "server"), { recursive: true });
  await fs.writeFile(
    path.join(release, "server", "index.ts"),
    badBoot
      ? "process.exit(1)"
      : warming
        ? "let first=true;" +
          source.replace(
            "fetch:r=>Response.json",
            "fetch:r=>first?(first=false,new Response(String(),{status:503})):Response.json",
          )
        : source,
  );
  await fs.writeFile(path.join(release, "version.txt"), "new");
  await fs.writeFile(path.join(release, "start-local.ps1"), "new fixture launcher");
  const pkg = {
    name: "meta-ad-studio",
    scripts: {
      build: badBuild
        ? 'bun -e "process.exit(2)"'
        : "bun -e \"require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/index.html','new build')\"",
    },
  };
  await fs.writeFile(path.join(release, "package.json"), JSON.stringify(pkg));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify(pkg));
  const server = net.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Port missing");
  const port = address.port;
  await new Promise((r) => server.close(r));
  const channel = {
    latest: async () => sha,
    prepare: async (version, dest) => {
      assert.equal(version, sha);
      await fs.cp(release, dest, { recursive: true });
      return dest;
    },
  };
  const options = { root, bun, port, dataDir: path.join(root, "data"), channel, log: () => {} };
  runs.push(options);
  return options;
}

afterEach(async () => {
  for (const f of runs.splice(0)) {
    const current = await health(f.port);
    if (current && current.installationId === identity(f.root)) process.kill(current.pid);
  }
});
test("new release builds, preserves private files, starts and records exact revision", async () => {
  const f = await fixture();
  const result = await updateInstallation(f);
  assert.equal(result.kind, "updated", JSON.stringify(result));
  assert.equal(await fs.readFile(path.join(f.root, "version.txt"), "utf8"), "new");
  assert.equal(await fs.readFile(path.join(f.root, ".env"), "utf8"), "PRIVATE_MARKER=keep-me");
  assert.equal(
    await fs.readFile(path.join(f.root, "data", "result.mp4"), "utf8"),
    "original-result",
  );
  const version = JSON.parse(
    await fs.readFile(path.join(f.root, ".runtime", "installed-release.json"), "utf8"),
  );
  assert.equal(version.sha, sha);
  assert.equal((await health(f.port)).installationId, identity(f.root));
});
test("build failure keeps old code and data available", async () => {
  const f = await fixture({ badBuild: true });
  const result = await updateInstallation(f);
  assert.equal(result.kind, "fallback");
  assert.equal(await fs.readFile(path.join(f.root, "version.txt"), "utf8"), "old");
  assert.equal(await fs.readFile(path.join(f.root, ".env"), "utf8"), "PRIVATE_MARKER=keep-me");
});
test("startup failure rolls back code and starts previous version", async () => {
  const f = await fixture({ badBoot: true });
  const result = await updateInstallation(f);
  assert.equal(result.kind, "rollback", JSON.stringify(result));
  assert.equal(await fs.readFile(path.join(f.root, "version.txt"), "utf8"), "old");
  assert.equal(await fs.readFile(path.join(f.root, "dist", "index.html"), "utf8"), "old build");
  assert.ok(await health(f.port));
});
test("unavailable release service never reports latest or changes local files", async () => {
  const f = await fixture();
  f.channel.latest = async () => {
    throw Error("offline");
  };
  const result = await updateInstallation(f);
  assert.equal(result.kind, "fallback");
  assert.equal(await fs.readFile(path.join(f.root, "version.txt"), "utf8"), "old");
});
test("same revision checks online but does not download or replace files", async () => {
  const f = await fixture();
  await fs.mkdir(path.join(f.root, ".runtime"), { recursive: true });
  await fs.writeFile(path.join(f.root, ".runtime/installed-release.json"), JSON.stringify({ sha }));
  f.channel.prepare = async () => {
    throw Error("Must not download current revision");
  };
  const result = await updateInstallation(f);
  assert.equal(result.kind, "current");
  assert.equal(await fs.readFile(path.join(f.root, "version.txt"), "utf8"), "old");
});
test("running production defers updates before release download", async () => {
  const f = await fixture();
  let calls = 0;
  const server = (await import("node:http")).createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/api/health"
          ? { app: "meta-ad-studio", installationId: identity(f.root), pid: process.pid }
          : { engine: { activeJobs: 1 }, jobs: [] },
      ),
    );
  });
  await new Promise((r) => server.listen(f.port, "127.0.0.1", r));
  f.channel.latest = async () => {
    calls++;
    return sha;
  };
  try {
    const result = await updateInstallation(f);
    assert.equal(result.kind, "busy");
    assert.equal(calls, 0);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
test("modified installed code is preserved without downloading another version", async () => {
  const f = await fixture();
  await fs.mkdir(path.join(f.root, ".runtime"), { recursive: true });
  await fs.writeFile(
    path.join(f.root, ".runtime/installed-release.json"),
    JSON.stringify({ sha: "0".repeat(40), hashes: { "version.txt": "stale-hash" } }),
  );
  const result = await updateInstallation(f);
  assert.equal(result.kind, "skipped");
  assert.equal(await fs.readFile(path.join(f.root, "version.txt"), "utf8"), "old");
});
test("another installation on the requested port is never stopped", async () => {
  const f = await fixture();
  const server = (await import("node:http")).createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        app: "meta-ad-studio",
        installationId: "another-install",
        pid: process.pid,
      }),
    );
  });
  await new Promise((r) => server.listen(f.port, "127.0.0.1", r));
  try {
    const result = await updateInstallation(f);
    assert.equal(result.kind, "fallback");
    assert.equal((await health(f.port)).pid, process.pid);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
test("cold installation with queued work defers update without truncating large job records", async () => {
  const f = await fixture();
  const setup =
    'import{Database}from"bun:sqlite";const d=new Database(process.argv[1]);d.run("CREATE TABLE jobs (body TEXT)");d.run("INSERT INTO jobs VALUES (?)",[JSON.stringify({status:"queued",payload:"x".repeat(50000),automation:{status:"queued"}})]);d.close();';
  const made = spawnSync(
    bun,
    ["--no-env-file", "-e", setup, path.join(f.dataDir, "studio.sqlite")],
    { encoding: "utf8" },
  );
  assert.equal(made.status, 0, made.stderr);
  const result = await updateInstallation(f);
  assert.equal(result.kind, "busy", JSON.stringify(result));
  assert.equal(await fs.readFile(path.join(f.root, "version.txt"), "utf8"), "old");
});
test("interrupted prepared transaction restores backup before another online check", async () => {
  const f = await fixture();
  const tx = path.join(f.root, ".runtime", "updates", "interrupted");
  await fs.mkdir(path.join(tx, "code-backup", "server"), { recursive: true });
  const oldFiles = ["version.txt", "server/index.ts", "package.json", "start-local.ps1"];
  for (const rel of oldFiles)
    await fs.copyFile(path.join(f.root, rel), path.join(tx, "code-backup", rel));
  await fs.writeFile(
    path.join(tx, "journal.json"),
    JSON.stringify({
      root: f.root,
      dataDir: f.dataDir,
      previous: null,
      sha,
      files: oldFiles,
      oldFiles,
      envFiles: [],
      phase: "prepared",
    }),
  );
  await fs.writeFile(
    path.join(f.root, ".runtime", "pending-update.json"),
    JSON.stringify({ directory: path.relative(f.root, tx), gitHead: null }),
  );
  await fs.writeFile(path.join(f.root, "version.txt"), "half-installed");
  f.channel.latest = async () => {
    throw Error("Must recover before online check");
  };
  const result = await updateInstallation(f);
  assert.equal(result.kind, "rollback", JSON.stringify(result));
  assert.equal(await fs.readFile(path.join(f.root, "version.txt"), "utf8"), "old");
});
test("starting HTTP 503 is polled until the new app is ready", async () => {
  const f = await fixture({ warming: true });
  const result = await updateInstallation(f);
  assert.equal(result.kind, "updated", JSON.stringify(result));
});
test("rollback prepares previous dependencies when the old ZIP had never been started", async () => {
  const f = await fixture({ badBoot: true });
  await fs.rename(inside(f.root, "node_modules"), inside(f.root, ".runtime/unused-modules"));
  await fs.rename(inside(f.root, "dist"), inside(f.root, ".runtime/unused-dist"));
  const result = await updateInstallation(f);
  assert.equal(result.kind, "rollback", JSON.stringify(result));
  assert.equal(await fs.readFile(path.join(f.root, "version.txt"), "utf8"), "old");
  assert.ok(await health(f.port));
});
test("failed startup restores the saved job database including WAL state", async () => {
  const f = await fixture();
  const db = path.join(f.dataDir, "studio.sqlite");
  const setup =
    'import{Database}from"bun:sqlite";const d=new Database(process.argv[1]);d.run("CREATE TABLE jobs (body TEXT)");d.run("INSERT INTO jobs VALUES (?)",[JSON.stringify({status:"completed",label:"original"})]);d.close();';
  assert.equal(spawnSync(bun, ["--no-env-file", "-e", setup, db], { encoding: "utf8" }).status, 0);
  const broken =
    'import{Database}from"bun:sqlite";import{join}from"node:path";const d=new Database(join(process.env.DATA_DIR,"studio.sqlite"));d.run("PRAGMA journal_mode=WAL");d.run("UPDATE jobs SET body=?",[JSON.stringify({status:"completed",label:"changed"})]);process.exit(1);';
  await fs.writeFile(path.join(f.root, ".runtime/fixture-release/server/index.ts"), broken);
  const result = await updateInstallation(f);
  assert.equal(result.kind, "rollback", JSON.stringify(result));
  const query =
    'import{Database}from"bun:sqlite";const d=new Database(process.argv[1],{readonly:true});console.log(d.query("SELECT body FROM jobs").get().body);d.close();';
  const saved = spawnSync(bun, ["--no-env-file", "-e", query, db], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(saved.stdout), { status: "completed", label: "original" });
});
test("Git installation updates when only Windows checkout line endings changed", async () => {
  const f = await fixture();
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: f.root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  await fs.writeFile(
    path.join(f.root, ".gitignore"),
    ".env\n.runtime/\ndata/\nnode_modules/\ndist/\n",
  );
  git("init", "-b", "main");
  git("config", "user.name", "Updater QA");
  git("config", "user.email", "qa@example.invalid");
  git("config", "core.autocrlf", "true");
  await fs.writeFile(path.join(f.root, "version.txt"), "old\r\n");
  git("add", ".");
  git("commit", "-m", "old fixture");
  const old = git("rev-parse", "HEAD");
  await fs.writeFile(path.join(f.root, "version.txt"), "new\r\n");
  git("add", ".");
  git("commit", "-m", "new fixture");
  const next = git("rev-parse", "HEAD");
  git("reset", "--hard", old);
  await fs.writeFile(path.join(f.root, "version.txt"), "old\n");
  assert.equal(await cleanGit(f.root), true);
  git("merge", "--ff-only", next);
  assert.equal(git("rev-parse", "HEAD"), next);
  assert.equal(git("status", "--porcelain"), "");
  await fs.writeFile(path.join(f.root, "version.txt"), "user edited content");
  assert.equal(await cleanGit(f.root), false);
  assert.equal(git("diff", "--cached", "--name-only"), "");
  assert.equal(await fs.readFile(path.join(f.root, ".env"), "utf8"), "PRIVATE_MARKER=keep-me");
});
