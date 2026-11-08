// Guards the p1485 follow-up, 11-08: the Mac bundle loaded a second Prime copy for +1.2 CPU-s per worker start.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CURRENT_SESSION_VERSION as primeSessionVersion, getAgentDir as primeAgentDir } from "prime-agent";
import { buildExtensionBundle } from "../src/build-extension-bundle.ts";
import { COMPONENT, freshBundle } from "../src/extension-bundle.ts";
import { CURRENT_SESSION_VERSION, getAgentDir } from "../src/prime-values.ts";

/**
 * Bun imports the .mjs bundle natively, outside the virtual modules through which Prime gives a .ts extension its own instances. A value
 * import of @earendil-works/pi-coding-agent in the bundle (getAgentDir and CURRENT_SESSION_VERSION) resolved to user-history's node_modules
 * and loaded zod, ajv-formats, typebox and the ACP SDK again, 1.63 CPU-s over no extensions against 0.25 for the same bundle without it.
 */
test("the extension bundle imports node builtins only, so a worker start loads no package and no second Prime", async () => {
  const { imports } = await buildExtensionBundle(COMPONENT, false);
  const prime = imports.filter(({ path }) => /^(prime-agent|@earendil-works\/)/.test(path));
  assert.deepEqual(prime, [], "a Prime package in the bundle loads a second copy of Prime");
  const statics = imports.filter(({ path, kind }) => kind !== "dynamic-import" && !path.startsWith("node:"));
  assert.deepEqual(statics, [], "a static package import in the bundle loads that package at each worker start");
});

test("the extension's own agent dir and session version are Prime's", () => {
  assert.equal(CURRENT_SESSION_VERSION, primeSessionVersion);
  const saved = process.env.PRIME_AGENT_CODING_AGENT_DIR;
  try {
    for (const value of [undefined, "", "~", "~/elsewhere/agent", "/srv/agent", "relative/agent"]) {
      if (value === undefined) delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
      else process.env.PRIME_AGENT_CODING_AGENT_DIR = value;
      assert.equal(getAgentDir(), primeAgentDir(), String(value));
    }
  } finally {
    if (saved === undefined) delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
    else process.env.PRIME_AGENT_CODING_AGENT_DIR = saved;
  }
});

test("the entry loads a bundle only while it matches the source, and a new build gets a new path", async t => {
  const dir = mkdtempSync(join(tmpdir(), "uh-bundle-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "extension"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "extension/index.ts"), 'import { word } from "../src/word.ts";\nexport default (): string => word;\n');
  const write = (word: string) => writeFileSync(join(dir, "src/word.ts"), `export const word: string = "${word}";\n`);
  write("one");
  assert.equal(freshBundle(dir), undefined, "no build yet");
  const first = await buildExtensionBundle(dir);
  assert.equal(freshBundle(dir), join(dir, first.name));
  write("two");
  assert.equal(freshBundle(dir), undefined, "an edit loads the source");
  const second = await buildExtensionBundle(dir);
  assert.notEqual(second.name, first.name);
  assert.equal(freshBundle(dir), join(dir, second.name));
  const { default: extension } = await import(freshBundle(dir)!) as { default: () => string };
  assert.equal(extension(), "two");
  write("three");
  const third = await buildExtensionBundle(dir);
  const built = readdirSync(join(dir, "src")).filter(name => name.endsWith(".bundle.mjs")).sort();
  assert.deepEqual(built, [second.name, third.name].map(name => name.slice(4)).sort(), "the build keeps the bundle the last record named");
});
