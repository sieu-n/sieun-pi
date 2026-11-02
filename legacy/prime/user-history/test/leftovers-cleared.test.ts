// Guards the sweep of deleted jobs reading every deleted job's transcript again at each chat service start: in the CPU profile of the run
// started at 01:33:46Z on 11-02, openedWikiSessions held the main thread 6.6 s in its first 4 minutes (job-leftovers.ts clearedTranscripts).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clearedTranscripts } from "../src/job-leftovers.ts";

test("a transcript cleared before a restart is not read again after it", async t => {
  const dir = mkdtempSync(join(tmpdir(), "leftovers-cleared-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "state", "leftovers-cleared.json");
  const before = clearedTranscripts(file);
  assert.deepEqual(await before.fresh("copies", ["/a.jsonl", "/b.jsonl"]), ["/a.jsonl", "/b.jsonl"]);
  assert.deepEqual(await before.fresh("copies", ["/a.jsonl", "/b.jsonl"]), []);
  const after = clearedTranscripts(file);
  assert.deepEqual(await after.fresh("copies", ["/a.jsonl", "/b.jsonl", "/c.jsonl"]), ["/c.jsonl"]);
  assert.deepEqual(await after.fresh("artifacts", ["/a.jsonl"]), ["/a.jsonl"], "each kind keeps its own list");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { copies: ["/a.jsonl", "/b.jsonl", "/c.jsonl"], artifacts: ["/a.jsonl"] });
});

test("an unreadable file reads as nothing cleared", async t => {
  const dir = mkdtempSync(join(tmpdir(), "leftovers-cleared-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "leftovers-cleared.json");
  writeFileSync(file, "{not json");
  assert.deepEqual(await clearedTranscripts(file).fresh("artifacts", ["/a.jsonl"]), ["/a.jsonl"]);
});
