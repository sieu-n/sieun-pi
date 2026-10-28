/**
 * What a chat release checks in the sieun-pi checkout before it builds: the user-history tests that reach a file changed since the live
 * release, and tsc or svelte-check only when a changed file can break them. Owner rule c193 (10-28) bans copying the repo to run a test, and
 * each release ran the whole suite of 592 files inside its release folder: on 10-28 from 02:52Z to 03:51Z four releases queued behind each
 * other, 20 to 25 min each, and every one failed on load-timing tests that had nothing to do with its diff.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, normalize, relative, resolve } from "node:path";

const SOURCE = /\.(?:ts|mts|cts|mjs|cjs|js|svelte|json)$/;
const ROOTS = ["src", "test", "scripts", "extension"];
const TEST = /^test\/[^/]+\.test\.ts$/;
const RELATIVE = /["'`](\.{1,2}\/[^"'`\s$]+)["'`]/g;
const EXTENSIONS = ["", ".ts", ".mts", ".mjs", ".js", ".svelte", "/index.ts", "/index.mjs"];
const TYPED = /\.(?:ts|mts|cts|svelte)$|^tsconfig\.json$/;

function walk(app, dir, found) {
  let names;
  try { names = readdirSync(join(app, dir)); } catch { return; }
  for (const name of names) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = `${dir}/${name}`;
    const stat = statSync(join(app, path), { throwIfNoEntry: false });
    if (stat?.isDirectory()) walk(app, path, found);
    else if (stat?.isFile() && SOURCE.test(name)) found.push(path);
  }
}

/** The app file a relative specifier in `from` names, or null: `./x.js` also finds `./x.ts`, as tsx and NodeNext resolve it. */
function target(app, from, spec, known) {
  const base = normalize(join(dirname(from), spec.split(/[?#]/)[0]));
  if (base.startsWith("..")) return null;
  for (const candidate of [base, base.replace(/\.(?:m?js)$/, ".ts"), base.replace(/\.mjs$/, ".mts")])
    for (const ending of EXTENSIONS) if (known.has(candidate + ending)) return candidate + ending;
  return null;
}

/**
 * The test files under `app` (paths relative to it) that reach one of `changed`: a changed test, a test that imports or names by relative path
 * a file that leads to a changed one through relative imports, and a test whose text names such a file by its basename, as the tests that spawn
 * a duty script do.
 */
export function testsFor(app, changed) {
  const files = [];
  for (const root of ROOTS) walk(app, root, files);
  const known = new Set(files);
  const importers = new Map();
  const texts = new Map();
  for (const file of files) {
    const text = readFileSync(join(app, file), "utf8");
    if (TEST.test(file)) texts.set(file, text);
    for (const [, spec] of text.matchAll(RELATIVE)) {
      const to = target(app, file, spec, known);
      if (!to || to === file) continue;
      if (!importers.has(to)) importers.set(to, new Set());
      importers.get(to).add(file);
    }
  }
  const reached = new Set(changed);
  for (const file of changed) for (const from of importers.get(file) ?? []) reached.add(from);
  const named = changed.filter(file => !TEST.test(file)).map(file => basename(file)).filter(name => !/^index\.[a-z]+$/.test(name));
  const tests = new Set([...reached].filter(file => TEST.test(file) && known.has(file)));
  for (const [file, text] of texts) if (!tests.has(file) && named.some(name => text.includes(name))) tests.add(file);
  return [...tests].sort();
}

/**
 * The checks for the files changed from commit `from` to `to` under `appPath` of `repo`: the tests that reach them, tsc when a changed file
 * is typed, svelte-check when one is a .svelte file. Paths outside the app change nothing the chat runs from its release.
 */
export function scopedPlan(repo, appPath, from, to) {
  const listed = spawnSync("git", ["-C", repo, "diff", "--name-only", "--no-renames", from, to, "--", appPath], { encoding: "utf8" });
  if (listed.status !== 0) throw new Error(`git diff --name-only ${from.slice(0, 7)} ${to.slice(0, 7)} failed: ${listed.stderr.trim()}`);
  const changed = listed.stdout.split("\n").filter(Boolean).map(path => relative(appPath, path));
  const app = resolve(repo, appPath);
  return {
    changed,
    tests: changed.length ? testsFor(app, changed) : [],
    tsc: changed.some(path => TYPED.test(path) && !path.startsWith("node_modules/")),
    svelte: changed.some(path => path.endsWith(".svelte")),
  };
}
