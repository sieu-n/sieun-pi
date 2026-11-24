#!/usr/bin/env node
/**
 * Runs apps/chat server tests or Playwright specs on the live release's clean build, with only the files you name taken from the checkout.
 * About 20 jobs edit the one checkout at once, and a run there loads every job's half-done edits.
 *
 *   node apps/chat/scripts/spec-clean.mjs [--files a.ts,b.ts] [--release <dir>] [--keep] -- node --test test/server/x.test.ts
 *   node apps/chat/scripts/spec-clean.mjs [--files web/src/App.svelte,test/shell/nav.spec.ts] -- playwright test test/shell/nav.spec.ts
 *
 * The run pins the folder ~/.local/share/sieun-pi-apps-chat/current points at when it starts (or --release), a clean build of one main commit
 * that scripts/release-apps-chat.mjs made, and runs everything with that folder as its working directory, so a release's prune keeps it.
 * It writes nothing into that folder and copies no checkout. The overlay, the files whose source replaces the release's, is:
 * 1. every apps/chat file that differs between the release's commit and HEAD, read from HEAD as committed (git diff <release sha> HEAD);
 * 2. then each --files entry, a path relative to apps/chat read from the checkout's working tree as it is now, or path=/absolute/source.
 * Other sessions' uncommitted edits stay out unless you name their file in --files, so name only files whose working-tree state is yours.
 * Server code and node --test files load through a Node module hook (spec-clean/overlay.mjs). A Playwright run serves the release's web/dist,
 * or, when the overlay has a web/ file, a vite build of the release's web with those files swapped in, made in the run's own folder.
 * A test file only the overlay has runs from its source path; a new spec runs in an extra project "chrome-added" with the "chrome" project's
 * settings, so a new spec that must run one at a time or on the dev server waits for a release that lists it in playwright.config.ts.
 * The run's folder sits under TMPDIR, which must be short (Chrome refuses long socket paths), and is deleted after a run that passed.
 * SPEC_CLEAN_REPO names the checkout, for a test that runs a script the release leaves out with that script's own node_modules, such as
 * duty-set.test.ts with legacy/prime/user-history/scripts/duties/add.ts.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const here = import.meta.dirname;
const repo = resolve(here, "../../..");
const usage = "usage: node apps/chat/scripts/spec-clean.mjs [--files a.ts,b.ts] [--release <dir>] [--keep] -- node --test <files> | playwright test <args>";

function parse(argv) {
  const split = argv.indexOf("--");
  if (split < 0) throw new Error(usage);
  const options = { files: [], release: join(homedir(), ".local/share/sieun-pi-apps-chat/current"), keep: false, runner: argv.slice(split + 1) };
  const own = argv.slice(0, split);
  for (let i = 0; i < own.length; i++) {
    if (own[i] === "--files") options.files.push(...own[++i].split(",").filter(Boolean));
    else if (own[i] === "--release") options.release = own[++i];
    else if (own[i] === "--keep") options.keep = true;
    else throw new Error(`unknown option ${own[i]}\n${usage}`);
  }
  if (options.runner[0] === "npx") options.runner.shift();
  if (!["node", "playwright"].includes(options.runner[0])) throw new Error(`the command after -- starts with node or playwright\n${usage}`);
  return options;
}

const git = args => {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout;
};

/** The overlay as path relative to apps/chat -> source file: HEAD's committed changes since the release, then the --files entries. */
function overlay(sha, files, runDir) {
  const map = new Map();
  const changed = git(["diff", "--name-only", "--no-renames", "--diff-filter=AMT", sha, "HEAD", "--", "apps/chat"]).split("\n").filter(Boolean);
  for (const file of changed) {
    const path = file.slice("apps/chat/".length);
    const copy = join(runDir, "head", path);
    mkdirSync(dirname(copy), { recursive: true });
    writeFileSync(copy, git(["show", `HEAD:${file}`]));
    map.set(path, copy);
  }
  // Playwright reads a test file's module type from the package.json above it.
  if (changed.length) writeFileSync(join(runDir, "head/package.json"), '{ "type": "module" }\n');
  for (const entry of files) {
    const [path, source = join(repo, "apps/chat", path)] = entry.split("=");
    if (isAbsolute(path) || path.startsWith("..")) throw new Error(`--files takes paths relative to apps/chat: ${path}`);
    if (!existsSync(source)) throw new Error(`--files ${entry}: ${source} does not exist`);
    map.set(path, resolve(source));
  }
  return map;
}

const freePort = () => new Promise((done, fail) => {
  const server = createServer().once("error", fail).listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => done(port));
  });
});

function run(command, args, options) {
  return new Promise(done => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    const forward = signal => child.kill(signal);
    process.on("SIGINT", forward).on("SIGTERM", forward);
    child.on("exit", (code, signal) => {
      process.off("SIGINT", forward).off("SIGTERM", forward);
      done(code ?? (signal ? 1 : 0));
    });
  });
}

async function main() {
  const options = parse(process.argv.slice(2));
  const root = realpathSync(options.release);
  const release = join(root, "apps/chat");
  const { sha } = JSON.parse(readFileSync(join(root, "release.json"), "utf8"));
  const runDir = mkdtempSync(join(tmpdir(), "sc-"));
  const files = overlay(sha, options.files, runDir);
  console.error(`spec-clean: release ${root} (${sha.slice(0, 7)}), run folder ${runDir}`);
  for (const [path, source] of files) console.error(`spec-clean: ${path} <- ${source}`);

  const env = {
    ...process.env,
    SPEC_CLEAN_RELEASE: release,
    SPEC_CLEAN_OVERLAY: JSON.stringify(Object.fromEntries(files)),
    SPEC_CLEAN_RUN_DIR: runDir,
    SPEC_CLEAN_REPO: repo,
    NODE_OPTIONS: `--import ${join(here, "spec-clean/register.mjs")} ${process.env.NODE_OPTIONS ?? ""}`.trim(),
  };
  let code;
  if (options.runner[0] === "node") {
    // A test file only the overlay has runs from its source path; the hook resolves its imports as if it sat at its release path.
    const args = options.runner.slice(1).map(arg => (files.has(arg) && !existsSync(join(release, arg)) ? files.get(arg) : arg));
    code = await run(process.execPath, args.includes("tsx") ? args : ["--import", "tsx", ...args], { cwd: release, env: { ...env, SPEC_CLEAN_MODE: "source" } });
  } else {
    const web = [...files.keys()].some(path => path.startsWith("web/"));
    const webDir = web ? join(runDir, "web") : join(release, "web/dist");
    if (web) {
      code = await run(process.execPath, [join(here, "spec-clean/vite.mjs"), "build", webDir, join(runDir, "vite-cache")], { cwd: join(release, "web"), env: { ...env, SPEC_CLEAN_MODE: "source" } });
      if (code !== 0) throw new Error(`the web build with the overlay failed (exit ${code}); the run folder ${runDir} stays`);
    }
    const serverUrl = process.env.CHAT_SERVER_URL ?? `http://127.0.0.1:${await freePort()}`;
    const args = options.runner.slice(1);
    if (args[0] !== "test") throw new Error(`the command after -- is playwright test <args>\n${usage}`);
    const added = [...files].filter(([path]) => path.endsWith(".spec.ts") && !existsSync(join(release, path))).map(([, source]) => source);
    const pwEnv = { ...env, SPEC_CLEAN_MODE: "redirect", SPEC_CLEAN_WEB_DIR: webDir, SPEC_CLEAN_ADDED_SPECS: JSON.stringify(added), CHAT_SERVER_URL: serverUrl, CHAT_WEB_PORT: process.env.CHAT_WEB_PORT ?? String(await freePort()), CHAT_PW_OUTPUT: join(runDir, "pw") };
    delete pwEnv.CHAT_WEB_DEV;
    // Playwright matches a file argument against the path it loads, which for a spec only the overlay has is its source path.
    const testArgs = args.slice(1).map(arg => (files.has(arg) && added.includes(files.get(arg)) ? files.get(arg) : arg));
    code = await run(join(release, "node_modules/.bin/playwright"), ["test", "-c", join(here, "spec-clean/playwright.config.ts"), ...testArgs], { cwd: release, env: pwEnv });
  }
  if (code === 0 && !options.keep) rmSync(runDir, { recursive: true, force: true });
  else console.error(`spec-clean: exit ${code}; the run folder ${runDir} stays`);
  process.exit(code);
}

main().catch(error => {
  console.error(`spec-clean: ${error.message}`);
  process.exit(2);
});
