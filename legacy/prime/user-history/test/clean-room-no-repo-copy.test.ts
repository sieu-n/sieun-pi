// Owner rule c193, 2026-10-28: "Copying the repo to do the test: THIS MUST BE BANNED". Runs every clean-room scenario's prepare() with HOME at a
// folder that holds stand-in checkouts of auto-sns-agent and sieun-pi, and fails when prepare() leaves a copy of either repo anywhere under
// HOME: a file with a checkout's bytes (a git archive, git show, cp or sparse checkout), a git repo that shares a checkout's history or borrows
// its objects (a clone, fetch or alternates), or a tree the auto-sns-agent repo guard's repoCopyRoot would read as a copy. A link into the
// checkout is a read and passes. A scenario that refuses to start must say so by c193.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { repoCopyOf } from "../scripts/clean-room/repo-copy.ts";
import { SCENARIOS } from "../scripts/clean-room/scenarios.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MARK = `checkout-bytes-${process.pid}-${Date.now()}`;
const CHECKOUTS: Record<string, Record<string, string>> = {
  "Documents/Github/auto-sns-agent": {
    "package.json": JSON.stringify({ name: "auto-sns-agent", description: MARK }), "turbo.json": JSON.stringify({ note: MARK }), "AGENTS.md": MARK,
    ".agents/skills/repo/git-workflow/SKILL.md": MARK, "apps/virev-demo/overlay/src/lib/ui/AppFrame.svelte": MARK, "node_modules/.keep": "",
  },
  "src/sieun-pi": {
    "package.json": JSON.stringify({ name: "sieun-pi", description: MARK }), "node_modules/.keep": "", "components/prime-relay/index.ts": MARK,
    "legacy/prime/user-history/package.json": JSON.stringify({ name: "prime-agent-user-history", description: MARK }),
    "legacy/prime/user-history/tsconfig.json": JSON.stringify({ note: MARK }), "legacy/prime/user-history/src/a.ts": MARK,
    "legacy/prime/user-history/scripts/duties/add.ts": MARK, "legacy/prime/user-history/node_modules/.keep": "",
  },
};
const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

interface Home { home: string; roots: string[] }
function standInHome(): Home {
  const home = mkdtempSync(join(tmpdir(), "clean-room-no-copy-"));
  const roots: string[] = [];
  for (const [repo, files] of Object.entries(CHECKOUTS)) {
    const dir = join(home, repo);
    for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); }
    git(dir, "init", "-q", "-b", "dev/sieun");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", MARK);
    roots.push(git(dir, "rev-parse", "HEAD"));
  }
  return { home, roots };
}

/** Runs one scenario's prepare() in a child whose HOME is the stand-in home, so every path a scenario builds from homedir() lands there. */
function prepareIn(name: string, home: string): Promise<{ sandbox?: string; refused?: string }> {
  const code = `const { SCENARIOS } = await import(${JSON.stringify(pathToFileURL(join(ROOT, "scripts/clean-room/scenarios.ts")).href)});
try { console.log(JSON.stringify({ sandbox: SCENARIOS[process.env.PROBE_SCENARIO].prepare(process.env.PROBE_RUN) })); }
catch (error) { console.log(JSON.stringify({ refused: error instanceof Error ? error.message : String(error) })); }`;
  const run = join(home, "runs", `r-${name}`);
  mkdirSync(run, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PROBE_SCENARIO: name, PROBE_RUN: run };
  delete env.AGENT_CHAT_DATA_DIR;
  return new Promise((done, fail) => execFile(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: ROOT, env, maxBuffer: 16 << 20 },
    (error, stdout, stderr) => error ? fail(new Error(`${name}: ${stderr || error.message}`)) : done(JSON.parse(stdout.trim().split("\n").at(-1)!))));
}

/** Every copy of a stand-in checkout under `home`, outside the checkouts themselves. */
function copiesUnder({ home, roots }: Home): string[] {
  const skip = new Set(Object.keys(CHECKOUTS).map(repo => join(home, repo)));
  const found = new Set<string>();
  const walk = (dir: string): void => {
    if (skip.has(dir)) return;
    const copy = repoCopyOf(dir, home);
    if (copy) found.add(`${copy} is a copy of the repo`);
    const names = readdirSync(dir);
    if (names.includes("HEAD") && names.includes("objects")) {
      for (const root of roots) {
        try { execFileSync("git", ["--git-dir", dir, "cat-file", "-e", `${root}^{commit}`], { stdio: "ignore" }); found.add(`${dir} holds the checkout's commit ${root}`); } catch {}
      }
    }
    for (const name of names) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(path);
      else if (name === "alternates" && dir.endsWith(join("objects", "info"))) found.add(`${path} borrows another repo's objects`);
      else if (stat.isFile() && readFileSync(path).includes(MARK)) found.add(`${path} holds a checkout's bytes`);
    }
  };
  walk(home);
  return [...found];
}

const homes: string[] = [];
after(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });
const runs = Object.entries(SCENARIOS).filter(([, scenario]) => scenario.prepare).map(([name]) => {
  const home = standInHome();
  homes.push(home.home);
  return { name, home, result: prepareIn(name, home.home) };
});

test("the guard's copy test finds a sparse clone, an archive and a git show of a checkout, and passes a link", () => {
  const home = standInHome();
  homes.push(home.home);
  const auto = join(home.home, "Documents/Github/auto-sns-agent");
  git(home.home, "clone", "-q", "--shared", auto, join(home.home, "scratch/clone"));
  mkdirSync(join(home.home, "work/shown"), { recursive: true });
  writeFileSync(join(home.home, "work/shown/AGENTS.md"), git(auto, "show", "HEAD:AGENTS.md"));
  execFileSync("ln", ["-s", join(auto, "AGENTS.md"), join(home.home, "work/linked.md")]);
  const found = copiesUnder(home).join("\n");
  assert.match(found, /scratch\/clone is a copy of the repo/);
  assert.match(found, /scratch\/clone\/\.git holds the checkout's commit/);
  assert.match(found, /alternates borrows/);
  assert.match(found, /work\/shown\/AGENTS\.md holds a checkout's bytes/);
  assert.doesNotMatch(found, /linked\.md/);
});

for (const run of runs) {
  test(`${run.name}: prepare() makes no copy of auto-sns-agent or sieun-pi`, async () => {
    const result = await run.result;
    if (result.refused !== undefined) assert.match(result.refused, /c193/, `${run.name} failed for another reason: ${result.refused}`);
    else assert.equal(repoCopyOf(result.sandbox!, run.home.home), null);
    assert.deepEqual(copiesUnder(run.home), []);
  });
}
