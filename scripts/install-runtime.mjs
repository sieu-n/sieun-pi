#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDirs = [".", "components/user-history"];
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "NODE_PATH"].includes(key)));

export function run(command, args, cwd, capture = false) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", stdio: ["ignore", capture ? "pipe" : process.stderr, process.stderr] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.signal ?? result.status})`);
  return result.stdout?.trim() ?? "";
}

function inside(root, path) {
  const name = relative(root, path);
  return name === "" || (!isAbsolute(name) && name !== ".." && !name.startsWith("../"));
}

function physicalDirectory(path) {
  if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) throw new Error(`Runtime directory must not pass through a symlink: ${path}`);
}

function validateLinks(root, directory = root) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      // Data integrity: a release must remain self-contained when moved out of the staging directory.
      if (isAbsolute(readlinkSync(path)) || !inside(root, realpathSync(path))) throw new Error(`Runtime symlink escapes its release or is not relocatable: ${path}`);
    } else if (entry.isDirectory()) validateLinks(root, path);
  }
}

function validate(root, execute) {
  physicalDirectory(root);
  for (const name of ["scripts/manage.py", "install-manifest.json", "components/global-rules/index.ts", "components/user-history/extension/index.ts"]) {
    if (!lstatSync(join(root, name)).isFile()) throw new Error(`Missing runtime file: ${name}`);
  }
  const manifest = JSON.parse(readFileSync(join(root, "install-manifest.json"), "utf8"));
  for (const entry of manifest.entries) {
    if (entry.source && (!inside(root, resolve(root, entry.source)) || !existsSync(join(root, entry.source)))) throw new Error(`Missing or unsafe manifest source: ${entry.source}`);
  }
  validateLinks(root);
  for (const directory of packageDirs) {
    const cwd = join(root, directory);
    physicalDirectory(join(cwd, "node_modules"));
    JSON.parse(readFileSync(join(cwd, "package-lock.json"), "utf8"));
    execute(process.execPath, ["--input-type=module", "--eval", `
      import { existsSync, readFileSync, realpathSync } from 'node:fs';
      import { fileURLToPath } from 'node:url';
      import { isAbsolute, relative } from 'node:path';
      const root = process.argv[1];
      for (const name of Object.keys(JSON.parse(readFileSync('package.json', 'utf8')).dependencies ?? {})) {
        const path = fileURLToPath(import.meta.resolve(name));
        if (!existsSync(path)) throw new Error('Missing dependency: ' + name);
        const location = relative(root, realpathSync(path));
        if (isAbsolute(location) || location === '..' || location.startsWith('../')) throw new Error('Dependency outside runtime: ' + name);
      }
      if (existsSync('node_modules/@silvia-odwyer/photon-node')) await import('@silvia-odwyer/photon-node');
    `, root], cwd);
  }
}

function sameDependencies(installed, staged) {
  try {
    physicalDirectory(join(realpathSync(installed), "node_modules"));
    return ["package.json", "package-lock.json"].every(name => readFileSync(join(installed, name)).equals(readFileSync(join(staged, name))));
  } catch {
    return false;
  }
}

function cloneTree(source, target, execute) {
  const args = process.platform === "darwin" ? ["-c", "-R", realpathSync(source), target] : ["-a", "--reflink=auto", realpathSync(source), target];
  execute("cp", args, dirname(target));
}

function exportCommit(repo, sha, directory, execute) {
  const archive = join(dirname(directory), "source.tar");
  execute("git", ["archive", "--format=tar", "--output", archive, sha], repo);
  execute("tar", ["-xf", archive, "-C", directory], repo);
  rmSync(archive);
}

export function installRuntime({ repo = checkout, home = homedir(), ref = "HEAD", prepareOnly = false } = {}, { execute = run, archive = exportCommit } = {}) {
  repo = realpathSync(repo);
  home = realpathSync(home);
  const sha = execute("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], repo, true);
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error(`Not a committed Git ref: ${ref}`);
  const root = join(home, ".local/share/sieun-pi-runtime");
  const releases = join(root, "releases");
  mkdirSync(releases, { recursive: true });
  physicalDirectory(releases);
  const lock = join(root, ".installing");
  try { mkdirSync(lock); } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Runtime install is locked at ${lock}; inspect owner.json and remove this directory only after its process has exited.`);
    throw error;
  }
  let scratch;
  try {
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, sha, startedAt: new Date().toISOString() }) + "\n");
    const scratchRoot = join(home, "scratch");
    mkdirSync(scratchRoot, { recursive: true });
    physicalDirectory(scratchRoot);
    scratch = mkdtempSync(join(scratchRoot, "sieun-pi-runtime-"));
    const release = join(releases, sha);
    if (!existsSync(release)) {
      const staging = join(scratch, "release");
      mkdirSync(staging);
      archive(repo, sha, staging, execute);
      for (const directory of packageDirs) {
        const installed = join(root, "current", directory);
        if (sameDependencies(installed, join(staging, directory))) cloneTree(join(installed, "node_modules"), join(staging, directory, "node_modules"), execute);
        else execute("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", join(scratch, "npm-cache")], join(staging, directory));
      }
      validate(staging, execute);
      writeFileSync(join(staging, "release.json"), JSON.stringify({ sha, source: repo, builtAt: new Date().toISOString() }, null, 2) + "\n");
      renameSync(staging, release);
    }
    const metadata = JSON.parse(readFileSync(join(release, "release.json"), "utf8"));
    if (metadata.sha !== sha || metadata.source !== repo || typeof metadata.builtAt !== "string") throw new Error(`Release provenance does not match: ${release}`);
    validate(release, execute);
    if (prepareOnly) return { sha, release, prepared: true };

    const current = join(root, "current");
    if (existsSync(current) && !lstatSync(current).isSymbolicLink()) throw new Error(`Refusing to replace a non-symlink: ${current}`);
    const plan = join(scratch, "plan.json");
    const manage = (...args) => execute("python3", ["-B", join(release, "scripts/manage.py"), ...args], release, true);
    manage("plan", "--home", home, "--out", plan);
    const { id } = JSON.parse(readFileSync(plan, "utf8"));
    const receipt = join(home, ".local/state/sieun-pi/receipts", id, "receipt.json");
    const next = join(root, ".current-next");
    try {
      manage("apply", "--plan", plan);
      manage("verify", "--home", home);
      symlinkSync(join("releases", sha), next);
      renameSync(next, current);
      appendFileSync(join(root, "history.jsonl"), JSON.stringify({ sha, at: new Date().toISOString() }) + "\n");
    } catch (error) {
      rmSync(next, { force: true });
      if (existsSync(receipt)) {
        try { manage("rollback", "--receipt", receipt); } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `Runtime activation failed; recover using receipt ${receipt}`);
        }
      }
      throw error;
    }
    return { sha, release, current, receipt };
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { ref: { type: "string", default: "HEAD" }, repo: { type: "string", default: checkout }, home: { type: "string", default: homedir() }, "prepare-only": { type: "boolean", default: false }, help: { type: "boolean" } } });
    if (values.help) console.log("usage: node scripts/install-runtime.mjs [--ref <commit>] [--repo <checkout>] [--home <profile>] [--prepare-only]\nBuilds a self-contained committed runtime; activates manifest links unless --prepare-only. Use an older explicit --ref to roll back. Never restarts Prime.");
    else console.log(JSON.stringify(installRuntime({ ref: values.ref, repo: values.repo, home: values.home, prepareOnly: values["prepare-only"] }), null, 2));
  } catch (error) {
    console.error(`install-runtime: ${error.message}`);
    process.exitCode = 1;
  }
}
