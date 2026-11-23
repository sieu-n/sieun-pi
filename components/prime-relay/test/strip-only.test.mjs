// pi-host-relay.service runs components/prime-relay/agents/main.ts with plain node, which only strips types. On 11-23 at 23:23Z the relay
// imported apps/chat/server/usage-store.ts through ops.ts and the chat server's config.ts, refused its parameter property
// (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX) on every start, and the chat read us-metal02 as away for 12 min. This walks every repo file main.ts
// reaches through relative imports and strips each with node's own stripper, which refuses parameter properties, enums, namespaces and every
// other syntax strip-only mode lacks. pi-host and the chat server run under tsx, so their own files may use that syntax.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const relayMain = join(repo, "components/prime-relay/agents/main.ts");
const SPECIFIER = /(?:^|[\s;}])(?:import|export)\s*(?:[^'"`;]*?\sfrom\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

const resolveImport = (from, specifier) => {
  const base = resolve(dirname(from), specifier);
  return [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, join(base, "index.ts")].find(path => existsSync(path) && statSync(path).isFile());
};

/** Every repo file `entry` reaches through relative imports, with the files plain node refuses and the imports that resolve to no file. */
export function stripGraph(entry, read = path => readFileSync(path, "utf8")) {
  const files = new Set();
  const refused = [];
  const visit = file => {
    if (files.has(file)) return;
    files.add(file);
    let code = read(file);
    if (/\.[cm]?ts$/.test(file)) {
      try { code = stripTypeScriptTypes(code, { mode: "strip" }); } catch (error) { refused.push(`${relative(repo, file)}: ${error.message.split("\n")[0]}`); return; }
    }
    for (const match of code.matchAll(SPECIFIER)) {
      const specifier = match[1] ?? match[2];
      if (!specifier.startsWith(".")) continue;
      const next = resolveImport(file, specifier);
      if (next) visit(next); else refused.push(`${relative(repo, file)}: ${specifier} resolves to no file`);
    }
  };
  visit(entry);
  return { files: [...files].map(file => relative(repo, file)), refused };
}

test("every file the agent relay loads takes plain node's type stripping", () => {
  const { files, refused } = stripGraph(relayMain);
  assert.ok(files.includes("apps/chat/server/agent-folder.ts"), `the walk missed apps/chat/server/agent-folder.ts: ${files.join(", ")}`);
  assert.deepEqual(refused, []);
});

test("a parameter property in an apps/chat file the relay imports fails the walk", () => {
  const target = join(repo, "apps/chat/server/agent-folder.ts");
  const read = path => path === target ? `${readFileSync(path, "utf8")}\nexport class Held { constructor(private readonly at: number) {} }\n` : readFileSync(path, "utf8");
  assert.deepEqual(stripGraph(relayMain, read).refused, ["apps/chat/server/agent-folder.ts: TypeScript parameter property is not supported in strip-only mode"]);
});

test("plain node links the relay's whole module graph", () => {
  execFileSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", `await import(${JSON.stringify(relayMain)})`], { cwd: repo, stdio: "pipe" });
});
