// d7 11-04: the chat's 23:48Z to 00:11Z CPU profile on us-metal02 spent 7.9 s of its main-thread runs over 300 ms in transactJsonFile, 5.0 s of
// it in structuredClone of a cached file's value. A clone of the 1.4 MB service-archives.json took 48 ms against 22 ms for a JSON.parse of its
// text, and a file read fresh was stringified once more only to compare. A transaction now parses its copy from the text and compares to the
// text, so it clones nothing and stringifies once.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cachedJsonFile, type JsonFile, transactJsonFile } from "../src/locked-json.ts";

type State = { items: Record<string, number> };
const fileAt = (path: string): JsonFile<State> => ({ path, label: "test file", initial: () => ({ items: {} }),
  parse: value => ({ items: { ...(value as State).items } }) });

test("a transaction clones nothing and stringifies the state once, cached or not, and still writes and caches what changed", async t => {
  const dir = await mkdtemp(join(tmpdir(), "locked-json-once-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = fileAt(join(dir, "big.json"));
  await writeFile(file.path, JSON.stringify({ items: Object.fromEntries(Array.from({ length: 200 }, (_, n) => [`k${n}`, n])) }));
  const clones = t.mock.method(globalThis, "structuredClone");
  const stringify = t.mock.method(JSON, "stringify");

  await transactJsonFile(file, state => { state.items.fresh = 1; });
  assert.equal(stringify.mock.callCount(), 1, "a file read fresh is stringified once, for its write");
  assert.equal((JSON.parse(await readFile(file.path, "utf8")) as State).items.fresh, 1);

  const shared = await cachedJsonFile(file);
  await transactJsonFile(file, state => { state.items.cached = 2; });
  await transactJsonFile(file, state => { state.items.again = 3; });
  assert.equal(clones.mock.callCount(), 0, "no transaction cloned the cached value");
  assert.equal(stringify.mock.callCount(), 3);
  assert.equal(shared.items.cached, undefined, "a reader's value from before the change stays as it was");
  const after = await cachedJsonFile(file);
  assert.deepEqual([after.items.fresh, after.items.cached, after.items.again], [1, 2, 3]);
  const unchanged = await readFile(file.path, "utf8");
  await transactJsonFile(file, () => {});
  assert.equal(await readFile(file.path, "utf8"), unchanged, "a change that alters nothing writes nothing");
});
