import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  copyFiles,
  copyPrivate,
  exists,
  hashes,
  health,
  inside,
  inventory,
  run,
  safeState,
  startInstalled,
  stopOwned,
  transferDirectory,
} from "./launcher-files.mjs";

const repo = "ghetostyle-ctrl/ad-factory";
const revisionPattern = /^[a-f0-9]{40}$/;
const channel = {
  async latest() {
    const res = await fetch(`https://api.github.com/repos/${repo}/commits/main`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "AD-FACTORY-Launcher" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Version check failed (HTTP ${res.status})`);
    const body = await res.json();
    if (!revisionPattern.test(body.sha)) throw new Error("Release revision is invalid");
    return body.sha;
  },
  async prepare(sha, directory) {
    await fs.mkdir(directory, { recursive: true });
    const archive = inside(directory, "release.zip");
    const res = await fetch(`https://github.com/${repo}/archive/${sha}.zip`, {
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`Release download failed (HTTP ${res.status})`);
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > 536870912) throw new Error("Release archive is too large");
    await fs.writeFile(archive, new Uint8Array(bytes));
    const unpack = inside(directory, "unpack");
    const script = inside(directory, "unpack.ps1");
    await fs.writeFile(
      script,
      `param([string]$Archive,[string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = [IO.Path]::GetFullPath($Destination) + [IO.Path]::DirectorySeparatorChar
$zip = [IO.Compression.ZipFile]::OpenRead($Archive)
try {
 foreach ($entry in $zip.Entries) {
  $target = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $entry.FullName))
  if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path is outside destination' }
  if ((($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960) { throw 'Archive links are not allowed' }
 }
} finally { $zip.Dispose() }
Expand-Archive -LiteralPath $Archive -DestinationPath $Destination
`,
    );
    await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-Archive",
        archive,
        "-Destination",
        unpack,
      ],
      directory,
    );
    const roots = await fs.readdir(unpack, { withFileTypes: true });
    if (roots.length !== 1 || !roots[0].isDirectory())
      throw new Error("Unexpected release archive layout");
    return inside(unpack, roots[0].name);
  },
};
async function cleanGit(root) {
  try {
    await run("git", ["diff", "--no-ext-diff", "--quiet"], root);
    await run("git", ["diff", "--cached", "--no-ext-diff", "--quiet"], root);
    return (await run("git", ["ls-files", "--others", "--exclude-standard"], root)) === "";
  } catch {
    return false;
  }
}
async function json(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}
async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + ".tmp";
  await fs.writeFile(temp, JSON.stringify(value, null, 2));
  await fs.rename(temp, file);
}
async function restore(root, tx, bun, port, dataDir, gitHead) {
  const journal = await json(inside(tx, "journal.json"));
  if (journal.root !== root || journal.dataDir !== dataDir)
    throw new Error("Backup belongs to another installation");
  if (await health(port)) {
    const state = await safeState(root, port, bun, dataDir);
    if (state.busy)
      throw new Error("Production started; recovery requires the task to finish first");
    if (state.current) await stopOwned(root, port, state.current);
  }
  if (gitHead && journal.previous) {
    const actual = await run("git", ["rev-parse", "HEAD"], root);
    if (![journal.previous, journal.sha].includes(actual))
      throw new Error("Git changed during update; backup preserved");
    await run("git", ["reset", "--hard", journal.previous], root);
  }
  for (const rel of journal.files)
    if (!journal.oldFiles.includes(rel)) {
      const file = inside(root, rel);
      if (await exists(file)) await fs.unlink(file);
    }
  await copyFiles(inside(tx, "code-backup"), root, journal.oldFiles);
  for (const name of ["node_modules", "dist"]) {
    const target = inside(root, name),
      backup = inside(tx, "old-" + name);
    if (await exists(backup)) {
      if (await exists(target))
        await fs.rename(target, inside(tx, "failed-" + name + "-" + randomUUID()));
      await fs.rename(backup, target);
    } else if (journal.originalDirs?.[name] === false && (await exists(target))) {
      await fs.rename(target, inside(tx, "failed-" + name + "-" + randomUUID()));
    }
  }
  for (const name of ["studio.sqlite", "studio.sqlite-wal", "studio.sqlite-shm"]) {
    const file = inside(dataDir, name);
    if (await exists(file)) await fs.unlink(file);
  }
  await copyPrivate(inside(tx, "data-backup"), dataDir);
  for (const name of journal.envFiles)
    await fs.copyFile(inside(tx, "env-backup/" + name), inside(root, name));
  if (journal.originalDirs?.node_modules === false)
    await run(bun, ["install", "--frozen-lockfile"], root);
  if (journal.originalDirs?.dist === false) await run(bun, ["run", "build"], root);
  const versionFile = inside(root, ".runtime/installed-release.json");
  if (journal.installed) await atomicJson(versionFile, journal.installed);
  else if (await exists(versionFile)) await fs.unlink(versionFile);
  const status = await startInstalled(root, port, bun, dataDir);
  await atomicJson(inside(tx, "journal.json"), { ...journal, phase: "rolled-back" });
  await fs.unlink(inside(root, ".runtime/pending-update.json"));
  return status;
}

export async function updateInstallation({
  root,
  bun,
  port,
  dataDir,
  channel: release = channel,
  log = console.log,
}) {
  root = path.resolve(root);
  dataDir = path.resolve(root, dataDir || "data");
  let staging = null;
  let tx = null,
    gitHead = null,
    changed = false;
  const marker = inside(root, ".runtime/installed-release.json");
  const pending = inside(root, ".runtime/pending-update.json");
  try {
    if (
      (await exists(inside(root, ".runtime"))) &&
      (await fs.lstat(inside(root, ".runtime"))).isSymbolicLink()
    )
      throw new Error("Runtime directory cannot be a link");
    if (
      root === dataDir ||
      path.parse(dataDir).root === dataDir ||
      root.startsWith(dataDir + path.sep)
    )
      throw new Error("Data directory cannot contain the installation");
    if ((await json(inside(root, "package.json"))).name !== "meta-ad-studio")
      throw new Error("Not an AD FACTORY installation");
    if (await exists(pending)) {
      const prior = await json(pending);
      tx = inside(root, prior.directory);
      gitHead = prior.gitHead;
      try {
        await restore(root, tx, bun, port, dataDir, gitHead);
        return {
          kind: "rollback",
          message: "Interrupted update recovered. Previous version is running.",
        };
      } catch (error) {
        return {
          kind: "fatal",
          message: "Interrupted update recovery needs attention. Backup: " + tx,
          error: String(error),
        };
      }
    }
    const state = await safeState(root, port, bun, dataDir);
    if (state.busy)
      return {
        kind: "busy",
        message: "Production is active. Update deferred; opening the current app.",
      };
    if (await exists(inside(root, ".git"))) {
      if (!(await run("git", ["remote"], root)).split(String.fromCharCode(10)).includes("origin"))
        return {
          kind: "skipped",
          message: "Development checkout: automatic replacement is disabled.",
        };
      const remote = await run("git", ["remote", "get-url", "origin"], root);
      if (
        !/^https:\/\/github[.]com\/ghetostyle-ctrl\/ad-factory(?:[.]git)?\/?$|^git@github[.]com:ghetostyle-ctrl\/ad-factory[.]git$/.test(
          remote,
        )
      )
        return {
          kind: "skipped",
          message: "Development checkout: automatic replacement is disabled.",
        };
      if (
        (await run("git", ["branch", "--show-current"], root)) !== "main" ||
        !(await cleanGit(root))
      )
        return {
          kind: "skipped",
          message: "Local code changes or another branch: update skipped.",
        };
      gitHead = await run("git", ["rev-parse", "HEAD"], root);
    }
    const installed = (await exists(marker)) ? await json(marker) : null;
    if (!gitHead && installed?.hashes) {
      const current = await hashes(root, Object.keys(installed.hashes));
      if (Object.keys(current).some((file) => current[file] !== installed.hashes[file]))
        return {
          kind: "skipped",
          message: "Local code was edited. Update skipped to preserve changes.",
        };
    }
    log("Checking the latest AD FACTORY release...");
    const sha = await release.latest();
    if (!revisionPattern.test(sha)) throw new Error("Invalid release revision");
    const previous = gitHead || installed?.sha || null;
    if (previous === sha) return { kind: "current", sha, message: "Already up to date." };
    tx = inside(root, ".runtime/updates/" + Date.now() + "-" + randomUUID());
    await fs.mkdir(tx, { recursive: true });
    log("Downloading and building " + sha.slice(0, 7) + " in a separate folder...");
    staging = await fs.mkdtemp(path.join(tmpdir(), "ad-update-"));
    const stage = await release.prepare(sha, staging);
    if (
      (await json(path.join(stage, "package.json"))).name !== "meta-ad-studio" ||
      !(await exists(path.join(stage, "server/index.ts"))) ||
      !(await exists(path.join(stage, "start-local.ps1")))
    )
      throw new Error("Release is missing required application files");
    await run(bun, ["install", "--frozen-lockfile"], stage);
    await run(bun, ["run", "build"], stage);
    if (!(await exists(path.join(stage, "dist/index.html"))))
      throw new Error("Release build did not produce a dashboard");
    if (gitHead) {
      await run("git", ["fetch", "origin", sha], root);
      await run("git", ["merge-base", "--is-ancestor", gitHead, sha], root);
      if (!(await cleanGit(root))) throw new Error("Local files changed during download");
    }
    const finalState = await safeState(root, port, bun, dataDir);
    if (finalState.busy)
      return {
        kind: "busy",
        message: "Production started. Update deferred; current app kept running.",
      };
    if (finalState.current) await stopOwned(root, port, finalState.current);
    const files = await inventory(stage),
      oldFiles = await inventory(root);
    log("Backing up code, API settings and work data...");
    await copyFiles(root, inside(tx, "code-backup"), oldFiles);
    await copyPrivate(dataDir, inside(tx, "data-backup"));
    const envFiles = (await fs.readdir(root)).filter(
      (name) => name === ".env" || name.startsWith(".env."),
    );
    for (const name of envFiles)
      await copyPrivate(inside(root, name), inside(tx, "env-backup/" + name));
    await atomicJson(inside(tx, "journal.json"), {
      root,
      dataDir,
      previous,
      sha,
      files,
      oldFiles,
      envFiles,
      installed,
      originalDirs: {
        node_modules: await exists(inside(root, "node_modules")),
        dist: await exists(inside(root, "dist")),
      },
      phase: "prepared",
    });
    await atomicJson(pending, { directory: path.relative(root, tx), gitHead });
    changed = true;
    if (gitHead) await run("git", ["merge", "--ff-only", sha], root);
    else if (installed?.hashes)
      for (const rel of Object.keys(installed.hashes))
        if (!files.includes(rel) && (await exists(inside(root, rel))))
          await fs.unlink(inside(root, rel));
    if (!gitHead) await copyFiles(stage, root, files);
    for (const name of ["node_modules", "dist"]) {
      if (await exists(inside(root, name)))
        await fs.rename(inside(root, name), inside(tx, "old-" + name));
      if (await exists(path.join(stage, name)))
        await transferDirectory(path.join(stage, name), inside(root, name));
    }
    const status = await startInstalled(root, port, bun, dataDir);
    await atomicJson(marker, {
      sha,
      installedAt: new Date().toISOString(),
      hashes: await hashes(root, files),
    });
    await fs.unlink(pending);
    return {
      kind: "updated",
      sha,
      pid: status.pid,
      message: "Updated to " + sha.slice(0, 7) + ". App is ready.",
      backup: tx,
    };
  } catch (error) {
    if (changed && tx) {
      try {
        await restore(root, tx, bun, port, dataDir, gitHead);
        return {
          kind: "rollback",
          message: "Update failed; the previous version has been restored.",
          backup: tx,
        };
      } catch (recoveryError) {
        return {
          kind: "fatal",
          message: "Update recovery needs attention. Keep the backup: " + tx,
          error: String(recoveryError),
        };
      }
    }
    return {
      kind: "fallback",
      message: "Update check/install failed. Using the existing version.",
      error: String(error),
    };
  } finally {
    if (staging && !(await exists(pending))) {
      const base = path.resolve(tmpdir()) + path.sep;
      if (
        path.resolve(staging).startsWith(base) &&
        path.basename(staging).startsWith("ad-update-")
      ) {
        try {
          await fs.rm(staging, { recursive: true, force: true });
        } catch {
          log("Temporary update files remain at " + staging);
        }
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      bun: { type: "string" },
      port: { type: "string" },
      data: { type: "string" },
    },
  });
  if (
    !values.root ||
    !values.bun ||
    !Number.isInteger(Number(values.port)) ||
    Number(values.port) < 1024 ||
    Number(values.port) > 65535
  )
    throw new Error("Invalid launcher arguments");
  const result = await updateInstallation({
    root: values.root,
    bun: values.bun,
    port: Number(values.port),
    dataDir: values.data,
  });
  if (result.kind === "fatal") process.exitCode = 2;
  console.log(result.message);
  await atomicJson(inside(values.root, ".runtime/update-status.json"), {
    ...result,
    checkedAt: new Date().toISOString(),
  });
}
