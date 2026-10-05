#!/usr/bin/env node
// Match the prime-agent SDK packages in this checkout to a Prime Agent version (default: the installed `prime-agent --version`).
// Rewrites the official R2 release URLs in the root and user-history package.json, installs, type-checks and tests user-history,
// and restores the previous package.json and lock files if any step fails. Prints one JSON object per line with --json.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const history = join(root, "components", "user-history");
const RELEASE = "https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases";
const PACKAGES = ["prime-agent", "prime-agent-ai", "prime-agent-tui"];
const URL_PATTERN = /\/releases\/v\d+\.\d+\.\d+\/(prime-agent(?:-ai|-tui)?)-\d+\.\d+\.\d+\.tgz/g;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

const args = process.argv.slice(2);
const json = args.includes("--json");
const skipChecks = args.includes("--skip-checks");
const versionFlag = args.indexOf("--version");
const npm = existsSync(join(dirname(process.execPath), "npm")) ? join(dirname(process.execPath), "npm") : "npm";

function report(step, message, extra = {}) {
  process.stdout.write(json ? JSON.stringify({ step, message, ...extra }) + "\n" : `${message}\n`);
}

function run(command, commandArgs, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, commandArgs, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, npm_config_fund: "false", npm_config_audit: "false" } });
    let tail = "";
    const keep = chunk => { tail = (tail + chunk.toString()).slice(-4000); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolveRun(tail) : reject(new Error(`${command} ${commandArgs.join(" ")} exited ${code} in ${cwd}\n${tail.trim()}`)));
  });
}

async function installedVersion() {
  const out = await run("prime-agent", ["--version"], root);
  const version = out.trim().split(/\s+/).pop();
  if (!VERSION_PATTERN.test(version ?? "")) throw new Error(`prime-agent --version printed ${JSON.stringify(out.trim())}`);
  return version;
}

function clientVersion() {
  try { return JSON.parse(readFileSync(join(history, "node_modules", "prime-agent", "package.json"), "utf8")).version; } catch { return null; }
}

async function main() {
  const target = versionFlag >= 0 ? args[versionFlag + 1] : await installedVersion();
  if (!VERSION_PATTERN.test(target ?? "")) throw new Error("Use --version X.Y.Z.");
  const current = clientVersion();
  if (current === target && !args.includes("--force")) { report("done", `The chat client already uses prime-agent ${target}.`, { target, changed: false }); return; }
  report("check", `Checking the prime-agent ${target} release packages.`, { target });
  for (const name of PACKAGES) {
    const response = await fetch(`${RELEASE}/v${target}/${name}-${target}.tgz`, { method: "HEAD" });
    if (!response.ok) throw new Error(`${name}-${target}.tgz is not published (HTTP ${response.status}).`);
  }
  const manifest = join(root, "install-manifest.json");
  const files = [join(root, "package.json"), join(root, "package-lock.json"), join(history, "package.json"), join(history, "package-lock.json"), manifest].filter(existsSync);
  const backup = new Map(files.map(file => [file, readFileSync(file, "utf8")]));
  try {
    for (const file of [join(root, "package.json"), join(history, "package.json")]) {
      const text = backup.get(file);
      const next = text.replace(URL_PATTERN, (_match, name) => `/releases/v${target}/${name}-${target}.tgz`)
        .replace(/Prime Agent \d+\.\d+\.\d+/g, `Prime Agent ${target}`);
      writeFileSync(file, next);
    }
    if (backup.has(manifest)) writeFileSync(manifest, backup.get(manifest).replace(/("host":\s*\{\s*"name":\s*"prime-agent",\s*"version":\s*")\d+\.\d+\.\d+"/, `$1${target}"`));
    report("install", "Installing the root packages.");
    await run(npm, ["install", "--ignore-scripts", "--include=dev"], root);
    report("install", "Installing the chat packages.");
    await run(npm, ["install", "--ignore-scripts", "--include=dev"], history);
    if (clientVersion() !== target) throw new Error(`After install the chat client reports prime-agent ${clientVersion()}, not ${target}.`);
    if (!skipChecks) {
      report("typecheck", "Type-checking the chat against the new SDK.");
      await run(npm, ["run", "typecheck"], history);
      report("test", "Running the chat tests.");
      await run(npm, ["test"], history);
    }
  } catch (error) {
    report("rollback", `Restoring prime-agent ${current ?? "previous"} after the failure.`);
    for (const [file, text] of backup) writeFileSync(file, text);
    try {
      await run(npm, ["ci", "--ignore-scripts", "--include=dev"], root);
      await run(npm, ["ci", "--ignore-scripts", "--include=dev"], history);
    } catch (restoreError) {
      report("rollback", `The restore install also failed: ${restoreError.message.split("\n")[0]}`);
    }
    throw error;
  }
  report("done", `The chat client now uses prime-agent ${target}. Restart the chat service to load it.`, { target, changed: true, from: current });
}

main().catch(error => {
  report("failed", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
