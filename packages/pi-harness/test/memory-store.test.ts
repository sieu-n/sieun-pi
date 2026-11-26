import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { closeMemoryStores, countMemory, getMemory, memoryRevision, memoryTerms, putMemory, searchMemory } from "../src/core/memory-store.ts";
import { migrateMemory, readState, stateFile, updateState, type HarnessEntry } from "../src/core/store.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/memory-terms.json", import.meta.url), "utf8")) as { text: string; terms: string[] }[];

const entry = (id: string, title: string, content: string, updated = "2026-11-26T00:00:00Z"): HarnessEntry => ({
  id, kind: "memory", title, content, path: "general", scope: "local", reference: {}, arguments: {}, metadata: {}, source: "agent",
  created_at: updated, updated_at: updated, version: 1,
});

function withDir(run: (dir: string) => Promise<void> | void) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-store-"));
    try {
      await run(dir);
    } finally {
      closeMemoryStores();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("memoryTerms matches the fixture the Python tokenizer also passes", () => {
  for (const { text, terms } of fixture) assert.deepEqual(memoryTerms(text), terms, text);
});

test("a local store's memory moves into memory.sqlite and the file keeps none", withDir(async dir => {
  writeFileSync(stateFile(dir), JSON.stringify({
    schema: 1, entries: { prompt: { note: { ...entry("note", "Note", "Stays in the file."), kind: "prompt" } }, memory: { old: entry("old", "Old fact", "From an older writer.") }, skill: {}, subagent: {} },
    refinements: [],
  }));
  assert.equal(await migrateMemory(dir), 1);
  const file = JSON.parse(readFileSync(stateFile(dir), "utf8"));
  assert.deepEqual(file.entries.memory, {});
  assert.ok(file.entries.prompt.note);
  assert.equal(getMemory(dir, "old")?.title, "Old fact");
  assert.equal(await migrateMemory(dir), 0);
  assert.equal(readState(dir, "local").entries.memory.old?.content, "From an older writer.");
}));

test("updateState writes only the memory entries a change touched and removes deleted ones", withDir(async dir => {
  putMemory(dir, [entry("a", "Alpha", "First."), entry("b", "Beta", "Second.")]);
  const before = memoryRevision(dir);
  await updateState(dir, "local", state => {
    state.entries.memory.a = { ...state.entries.memory.a!, content: "First, changed.", version: 2 };
    delete state.entries.memory.b;
  });
  assert.equal(getMemory(dir, "a")?.content, "First, changed.");
  assert.equal(getMemory(dir, "b"), undefined);
  assert.equal(countMemory(dir), 1);
  assert.ok(memoryRevision(dir) > before);
}));

test("search ranks the right entry first among 20,000, in mixed Korean and English, within 200 ms", withDir(dir => {
  putMemory(dir, Array.from({ length: 20_000 }, (_, n) => entry(`filler_${n}`, `Filler fact ${n}`, `Port ${7000 + n} serves service ${n} on box ${n % 7}.`)));
  putMemory(dir, [entry("owner_p125_search_places", "Owner p125: search places are one row of pills", "카테고리 pills under search, no dropdown; the Where chip merges into them.")]);
  const started = performance.now();
  const hits = searchMemory(dir, "아니 Where하고 이 카테고리하고 합쳐서, dropdown 말고 pill들로", 5);
  assert.ok(performance.now() - started < 200);
  assert.equal(hits[0]?.entry.id, "owner_p125_search_places");
}));
