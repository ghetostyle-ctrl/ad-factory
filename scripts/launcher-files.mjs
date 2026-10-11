import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const excluded = new Set([
  ".git",
  ".runtime",
  "node_modules",
  "data",
  "logs",
  "cache",
  "tmp",
  "dist",
  ".next",
  "generated",
  "coverage",
  "test-results",
  "playwright-report",
  "work",
]);
export const exists = async (p) => {
  try {
    await fs.access(p);
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
};
export function inside(root, name) {
  const full = path.resolve(root, name);
  if (!full.startsWith(path.resolve(root) + path.sep))
    throw new Error("Path leaves update directory");
  return full;
}
export async function inventory(root, relative = "") {
  const out = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    if (
      excluded.has(entry.name) ||
      /^\.env(?:\.|$)|\.(?:db|sqlite)(?:-.*)?$|\.log$|^server\.pid$/.test(entry.name)
    )
      continue;
    const rel = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Code contains a link; automatic update skipped");
    if (entry.isDirectory()) out.push(...(await inventory(root, rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}
export async function copyFiles(from, to, files) {
  for (const rel of files) {
    const dest = inside(to, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(inside(from, rel), dest);
  }
}
export async function hashes(root, files) {
  return Object.fromEntries(
    await Promise.all(
      files.map(async (rel) => [
        rel,
        createHash("sha256")
          .update(await fs.readFile(inside(root, rel)))
          .digest("hex"),
      ]),
    ),
  );
}
export async function copyPrivate(from, to) {
  if (!(await exists(from))) return;
  const stat = await fs.lstat(from);
  if (stat.isSymbolicLink()) throw new Error("Data contains a link; backup requires manual review");
  if (stat.isDirectory()) {
    await fs.mkdir(to, { recursive: true });
    for (const item of await fs.readdir(from))
      await copyPrivate(path.join(from, item), path.join(to, item));
  } else {
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
  }
}
export function run(file, args, cwd, { timeout = 300000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Update command timed out"));
    }, timeout);
    child.stdout.on("data", (data) => {
      stdout = (stdout + data).slice(-16000);
    });
    child.stderr.on("data", (data) => {
      stderr = (stderr + data).slice(-16000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Update command failed (${code}): ${stderr.slice(-1200)}`));
    });
  });
}
export const identity = (root) =>
  createHash("sha256")
    .update(path.resolve(root).split(path.sep).join("/").toLowerCase())
    .digest("hex")
    .slice(0, 32);
export async function health(port, starting = false) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Connection: "close" },
      signal: AbortSignal.timeout(2000),
    });
    if (starting && res.status === 503) return null;
    if (!res.ok) throw new Error("App health unavailable (HTTP " + res.status + ")");
    return await res.json();
  } catch (e) {
    if (e.cause?.code === "ECONNREFUSED") return null;
    throw e;
  }
}
export function active(state) {
  if (!Number.isInteger(state.engine?.activeJobs) || !Array.isArray(state.jobs))
    throw new Error("Production state unavailable");
  return (
    state.engine.activeJobs > 0 ||
    state.jobs.some(
      (j) =>
        ["running", "queued"].includes(j.status) ||
        ["running", "queued"].includes(j.automation?.status) ||
        j.automation?.videoOperation ||
        j.hasPendingClip ||
        j.renders?.some((render) =>
          Object.values(render.clips ?? {}).some((clip) => clip?.operation || clip?.pendingSince),
        ) ||
        j.staged?.pendingOperation,
    )
  );
}
export async function safeState(root, port, bun, dataDir) {
  const current = await health(port);
  if (current) {
    if (
      current.app !== "meta-ad-studio" ||
      current.installationId !== identity(root) ||
      !Number.isInteger(current.pid) ||
      current.pid < 1
    )
      throw new Error("Another installation is using this port");
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error("Production state check failed");
    return { current, busy: active(await res.json()) };
  }
  const db = path.join(dataDir, "studio.sqlite");
  if (!(await exists(db))) return { current: null, busy: false };
  const query =
    'import {Database} from "bun:sqlite";const db=new Database(process.argv[1],{readonly:true});const jobs=db.query("SELECT body FROM jobs").all().map(r=>JSON.parse(r.body));console.log(JSON.stringify({engine:{activeJobs:0},jobs:jobs.map(j=>({status:j.status,hasPendingClip:j.renders?.some(r=>Object.values(r.clips||{}).some(c=>c?.operation||c?.pendingSince)),automation:j.automation?{status:j.automation.status,videoOperation:j.automation.videoOperation}:null,staged:j.staged?{pendingOperation:j.staged.pendingOperation}:null}))}));db.close();';
  return {
    current: null,
    busy: active(JSON.parse(await run(bun, ["--no-env-file", "-e", query, db], root))),
  };
}
export async function stopOwned(root, port, expected) {
  const check = await health(port);
  if (!check || check.pid !== expected.pid || check.installationId !== identity(root))
    throw new Error("Server changed before update");
  process.kill(check.pid);
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    try {
      process.kill(check.pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Server did not stop");
}
export async function startInstalled(root, port, bun, dataDir) {
  const logs = path.join(root, ".runtime", "updates");
  await fs.mkdir(logs, { recursive: true });
  const log = await fs.open(path.join(logs, "server-" + Date.now() + ".log"), "a");
  const child = spawn(bun, ["run", "server/index.ts"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    windowsHide: true,
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
  });
  let spawnError;
  child.once("error", (error) => {
    spawnError = error;
  });
  child.unref();
  await log.close();
  const end = Date.now() + 30000;
  try {
    while (Date.now() < end) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error("Updated app exited before readiness");
      const status = await health(port, true);
      if (
        status?.pid === child.pid &&
        status.installationId === identity(root) &&
        status.app === "meta-ad-studio"
      ) {
        return status;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("Updated app readiness timed out");
  } catch (cause) {
    if (child.pid && child.exitCode === null) {
      try {
        process.kill(child.pid);
      } catch (error) {
        if (error.code !== "ESRCH")
          throw new AggregateError([cause, error], "Failed app could not be stopped");
      }
      const stoppedBy = Date.now() + 5000;
      while (Date.now() < stoppedBy) {
        try {
          process.kill(child.pid, 0);
        } catch (error) {
          if (error.code === "ESRCH") break;
          throw new AggregateError([cause, error], "Failed app shutdown could not be verified");
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw cause;
  }
}

export async function transferDirectory(from, to) {
  try {
    await fs.rename(from, to);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false });
  }
}
