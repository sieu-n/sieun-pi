// Guards the 10-18 projection latency at the live rate: a scratch serve's catalog projection awaited a spawned-subagent count for each of about 1,000 agents, and the folder reads of the counts that had expired held it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SPAWNED_MS, SpawnedCounts } from "../src/chat-catalog.ts";

test("a spawned count answers at once from the last read and reads the folders again in the background", async t => {
  const dir = mkdtempSync(join(tmpdir(), "spawned-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const spawn = (path: string) => { mkdirSync(path, { recursive: true }); writeFileSync(join(path, "rlm-subagent.json"), "{}"); };
  spawn(join(dir, "sub-a"));
  spawn(join(dir, "sub-a", "sub-b"));
  let changes = 0;
  let changed = (): void => {};
  const counts = new SpawnedCounts(() => { changes++; changed(); });
  const now = Date.parse("2026-10-18T13:00:00Z");
  const read = () => new Promise<void>(resolve => { changed = resolve; });
  let landed = read();
  assert.equal(counts.of(dir, now), 0, "nothing is known before the first read ends");
  await landed;
  assert.equal(counts.of(dir, now + 1000), 2);
  spawn(join(dir, "sub-c"));
  assert.equal(counts.of(dir, now + 2000), 2, "a count under SPAWNED_MS old is not read again");
  landed = read();
  assert.equal(counts.of(dir, now + SPAWNED_MS), 2, "an old count answers while it is read again");
  await landed;
  assert.equal(counts.of(dir, now + SPAWNED_MS + 1), 3);
  assert.equal(changes, 2);
});
