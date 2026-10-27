import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { bundleExtension, EXTENSION_BUNDLE, installRuntime, run } from "../scripts/install-runtime.mjs";
import { pathToFileURL } from "node:url";

const source = dirname(dirname(fileURLToPath(import.meta.url)));
const first = "a".repeat(40);
const second = "b".repeat(40);

function fixture(t) {
  const scratch = join(homedir(), "scratch");
  mkdirSync(scratch, { recursive: true });
  const base = realpathSync(mkdtempSync(join(scratch, "sieun-pi-runtime-test-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "Documents/repo");
  const home = join(base, "home");
  mkdirSync(repo, { recursive: true });
  mkdirSync(home);
  const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  for (const directory of [repo, join(repo, "legacy/prime/user-history")]) {
    write(join(directory, "package.json"), JSON.stringify({ name: "fixture", type: "module", dependencies: { "runtime-fixture": "1.0.0" } }));
    write(join(directory, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
  }
  write(join(repo, "scripts/manage.py"), readFileSync(join(source, "scripts/manage.py")));
  write(join(repo, "components/global-rules/index.ts"), "// fixture\n");
  write(join(repo, "legacy/prime/user-history/extension/index.ts"), "// fixture\n");
  write(join(repo, "config/settings.example.json"), "{}\n");
  write(join(repo, "install-manifest.json"), JSON.stringify({ version: 1, entries: [
    { id: "global-rules", kind: "link", scope: "home", source: "components/global-rules/index.ts", target: ".prime/agent/extensions/global-rules.ts" },
    { id: "user-history", kind: "link", scope: "home", source: "legacy/prime/user-history", target: ".prime/agent/extensions/user-history" },
    { id: "settings", kind: "generated-json", scope: "home", source: "config/settings.example.json", target: ".prime/agent/settings.json", seed_only: true },
  ] }));
  const calls = [];
  const execute = (command, args, cwd, capture) => {
    calls.push({ command, args, cwd });
    if (command === "git") return args.at(-1).startsWith(second) ? second : first;
    if (command === "npm") {
      assert.deepEqual(args.slice(0, 5), ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"]);
      assert(existsSync(join(cwd, "package-lock.json")));
      write(join(cwd, "node_modules/runtime-fixture/package.json"), JSON.stringify({ name: "runtime-fixture", type: "module", main: "index.js" }));
      write(join(cwd, "node_modules/runtime-fixture/index.js"), "export const loaded = true;\n");
      mkdirSync(join(cwd, "node_modules/.bin"));
      symlinkSync("../runtime-fixture/index.js", join(cwd, "node_modules/.bin/fixture"));
      return "";
    }
    return run(command, args, cwd, capture);
  };
  const archive = (repo, sha, directory) => {
    calls.push({ command: "archive", sha });
    cpSync(repo, directory, { recursive: true });
  };
  const options = { repo, home };
  const hooks = { execute, archive };
  return { base, repo, home, calls, write, options, hooks, root: join(home, ".local/share/sieun-pi-runtime") };
}

test("prepare exports a committed ref with physical dependencies and does not activate; completed releases are reused", t => {
  const f = fixture(t);
  const prepared = installRuntime({ ...f.options, prepareOnly: true }, f.hooks);
  assert.equal(prepared.sha, first);
  assert.equal(prepared.prepared, true);
  assert.equal(existsSync(join(f.root, "current")), false);
  assert.equal(existsSync(join(f.home, ".prime")), false);
  assert.equal(existsSync(join(f.root, ".installing")), false);
  for (const directory of [".", "legacy/prime/user-history"]) {
    assert(realpathSync(join(prepared.release, directory, "node_modules")).startsWith(prepared.release));
    assert.equal(readlinkSync(join(prepared.release, directory, "node_modules/.bin/fixture")), "../runtime-fixture/index.js");
  }
  const metadata = readFileSync(join(prepared.release, "release.json"), "utf8");
  assert.equal(JSON.parse(metadata).source, f.repo);
  assert.equal(f.calls.filter(call => call.command === "npm").length, 2);
  installRuntime({ ...f.options, prepareOnly: true }, f.hooks);
  assert.equal(f.calls.filter(call => call.command === "archive").length, 1);
  assert.equal(f.calls.filter(call => call.command === "npm").length, 2);
  assert.equal(readFileSync(join(prepared.release, "release.json"), "utf8"), metadata);
});

test("activation applies the completed release, preserves settings and credentials, and supports an explicit older ref", t => {
  const f = fixture(t);
  f.write(join(f.home, ".prime/agent/settings.json"), '{"custom":"preserved"}\n');
  f.write(join(f.home, ".prime/agent/auth.json"), "untouched credential fixture\n");
  f.write(join(f.home, ".prime/agent/sessions/fixture.jsonl"), "untouched history fixture\n");
  const initial = installRuntime(f.options, f.hooks);
  assert.equal(readlinkSync(initial.current), `releases/${first}`);
  assert.equal(realpathSync(join(f.home, ".prime/agent/extensions/user-history")), join(initial.release, "legacy/prime/user-history"));
  assert.equal(readlinkSync(join(initial.release, "components/user-history")), "../legacy/prime/user-history");
  const apply = f.calls.findIndex(call => call.command === "python3" && call.args.includes("apply"));
  assert(f.calls.slice(0, apply).filter(call => call.command === "npm").length === 2);
  assert.equal(JSON.parse(readFileSync(initial.receipt)).state, "applied");
  installRuntime({ ...f.options, ref: second }, f.hooks);
  assert.equal(readlinkSync(initial.current), `releases/${second}`);
  installRuntime({ ...f.options, ref: first }, f.hooks);
  assert.equal(readlinkSync(initial.current), `releases/${first}`);
  assert.equal(readFileSync(join(f.home, ".prime/agent/settings.json"), "utf8"), '{"custom":"preserved"}\n');
  assert.equal(readFileSync(join(f.home, ".prime/agent/auth.json"), "utf8"), "untouched credential fixture\n");
  assert.equal(readFileSync(join(f.home, ".prime/agent/sessions/fixture.jsonl"), "utf8"), "untouched history fixture\n");
});

test("a release whose lockfiles match the active one clones its dependencies, and each activation is logged", t => {
  const f = fixture(t);
  const initial = installRuntime(f.options, f.hooks);
  f.write(join(f.repo, "legacy/prime/user-history/package-lock.json"), JSON.stringify({ lockfileVersion: 3, changed: true }));
  const next = installRuntime({ ...f.options, ref: second }, f.hooks);
  assert.deepEqual(f.calls.filter(call => call.command === "npm").map(call => call.cwd.endsWith("legacy/prime/user-history")), [false, true, true]);
  assert.equal(f.calls.filter(call => call.command === "cp").length, 1);
  assert.equal(readFileSync(join(next.release, "node_modules/runtime-fixture/index.js"), "utf8"), "export const loaded = true;\n");
  assert(realpathSync(join(next.release, "node_modules")).startsWith(next.release));
  const history = readFileSync(join(f.root, "history.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(history.map(row => row.sha), [first, second]);
  assert.equal(readlinkSync(initial.current), `releases/${second}`);
});

test("a failed dependency build leaves the existing runtime and manifest links active", t => {
  const f = fixture(t);
  const initial = installRuntime(f.options, f.hooks);
  f.write(join(f.repo, "legacy/prime/user-history/package-lock.json"), JSON.stringify({ lockfileVersion: 3, changed: true }));
  const execute = (command, ...args) => {
    if (command === "npm") throw new Error("dependency install failed");
    return f.hooks.execute(command, ...args);
  };
  assert.throws(() => installRuntime({ ...f.options, ref: second }, { ...f.hooks, execute }), /dependency install failed/);
  assert.equal(readlinkSync(initial.current), `releases/${first}`);
  assert.equal(realpathSync(join(f.home, ".prime/agent/extensions/user-history")), join(initial.release, "legacy/prime/user-history"));
  assert.equal(existsSync(join(f.root, "releases", second)), false);
  assert.equal(existsSync(join(f.root, ".installing")), false);
});

test("dependency links back into the source checkout are rejected before activation", t => {
  const f = fixture(t);
  const execute = (command, args, cwd, capture) => {
    const result = f.hooks.execute(command, args, cwd, capture);
    if (command === "npm" && cwd.endsWith("legacy/prime/user-history")) symlinkSync(f.repo, join(cwd, "node_modules/source-leak"));
    return result;
  };
  assert.throws(() => installRuntime(f.options, { ...f.hooks, execute }), /symlink escapes its release/);
  assert.equal(existsSync(join(f.root, "current")), false);
  assert.equal(existsSync(join(f.home, ".prime")), false);
  assert.equal(existsSync(join(f.root, "releases", first)), false);
});

test("failed activation restores managed links through the existing installer receipt", t => {
  const f = fixture(t);
  const initial = installRuntime(f.options, f.hooks);
  const execute = (command, args, cwd, capture) => {
    if (command === "python3" && args.includes("verify")) throw new Error("injected verification failure");
    return f.hooks.execute(command, args, cwd, capture);
  };
  assert.throws(() => installRuntime({ ...f.options, ref: second }, { ...f.hooks, execute }), /injected verification failure/);
  assert.equal(readlinkSync(initial.current), `releases/${first}`);
  assert.equal(realpathSync(join(f.home, ".prime/agent/extensions/user-history")), join(initial.release, "legacy/prime/user-history"));
  assert(f.calls.some(call => call.command === "python3" && call.args.includes("rollback")));
});

test("concurrent installation refuses the existing lock without removing it", t => {
  const f = fixture(t);
  mkdirSync(join(f.root, ".installing"), { recursive: true });
  f.write(join(f.root, ".installing/owner.json"), JSON.stringify({ pid: process.pid }));
  assert.throws(() => installRuntime(f.options, f.hooks), /Runtime install is locked/);
  assert.equal(existsSync(join(f.root, ".installing/owner.json")), true);
  assert.equal(f.calls.some(call => call.command === "npm"), false);
});

test("the user-history extension is bundled into one file in src/ and package.json loads it, with the source folder resolving as before", async t => {
  const scratch = join(homedir(), "scratch");
  mkdirSync(scratch, { recursive: true });
  const root = realpathSync(mkdtempSync(join(scratch, "sieun-pi-bundle-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "legacy/prime/user-history");
  const component = join(source, "legacy/prime/user-history");
  for (const name of ["extension", "src", "package.json"]) cpSync(join(component, name), join(dir, name), { recursive: true });
  for (const name of ["prime-relay", "global-rules"]) cpSync(join(source, "components", name), join(root, "components", name), { recursive: true, filter: path => !path.includes("node_modules") });
  symlinkSync(join(component, "node_modules"), join(dir, "node_modules"));
  assert.equal(bundleExtension(dir), true);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).pi.extensions, [`./${EXTENSION_BUNDLE}`]);
  const text = readFileSync(join(dir, EXTENSION_BUNDLE), "utf8");
  assert.match(text, /import\("\.\.\/src\/chat-service\.ts"\)/, "chat-service and the server graph stay out of the bundle");
  assert.doesNotMatch(text, /esbuild-svelte/);
  const { default: extension } = await import(pathToFileURL(join(dir, EXTENSION_BUNDLE)).href);
  assert.equal(typeof extension, "function");
});

test("a folder with no esbuild keeps its source entry", t => {
  const f = fixture(t);
  const dir = join(f.repo, "legacy/prime/user-history");
  assert.equal(bundleExtension(dir, () => { throw new Error("no build without esbuild"); }), false);
  assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).pi, undefined);
});

test("a release whose package.json differs only in the bundle's pi entry still clones its dependencies", t => {
  const f = fixture(t);
  const initial = installRuntime(f.options, f.hooks);
  const installed = join(initial.release, "legacy/prime/user-history/package.json");
  writeFileSync(installed, JSON.stringify({ ...JSON.parse(readFileSync(installed, "utf8")), pi: { extensions: [`./${EXTENSION_BUNDLE}`] } }));
  installRuntime({ ...f.options, ref: second }, f.hooks);
  assert.equal(f.calls.filter(call => call.command === "npm").length, 2);
  assert.equal(f.calls.filter(call => call.command === "cp").length, 2);
});
