// Guards the 10-18 projection latency at the live rate: a scratch serve's catalog projection awaited a spawned-subagent count for each of about 1,000 agents, and the folder reads of the counts that had expired held it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import childProcess from "node:child_process";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
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

test("an idle agent's count is read once after it settles and kept until it runs again (11-03 10:49Z)", async t => {
  const dir = mkdtempSync(join(tmpdir(), "spawned-idle-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const spawn = (path: string) => { mkdirSync(path, { recursive: true }); writeFileSync(join(path, "rlm-subagent.json"), "{}"); };
  spawn(join(dir, "sub-a"));
  let changed = (): void => {};
  const counts = new SpawnedCounts(() => changed());
  const read = () => new Promise<void>(resolve => { changed = resolve; });
  const now = Date.parse("2026-11-03T10:49:00Z");
  let landed = read();
  counts.of(dir, now, false);
  await landed;
  spawn(join(dir, "sub-b"));
  landed = read();
  counts.of(dir, now + SPAWNED_MS, true);
  await landed;
  assert.equal(counts.of(dir, now + SPAWNED_MS + 1, true), 2, "the read after the agent settles takes its last spawns");
  let reads = 0;
  changed = () => { reads++; };
  spawn(join(dir, "sub-c"));
  assert.equal(counts.of(dir, now + 5 * SPAWNED_MS, true), 2, "a settled agent's folders are not read again");
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(reads, 0);
  landed = read();
  counts.of(dir, now + 6 * SPAWNED_MS, false);
  await landed;
  assert.equal(counts.of(dir, now + 6 * SPAWNED_MS + 1, false), 3, "a running agent's count is read again");
});

// 11-08 us-metal02: each working agent's count listed every sub-* folder of its tree with readdir at once, 1,241 to 2,526 in a VP's tree, and
// at 12:02Z the chat's other file reads waited 2.8 s for a thread-pool thread behind them (d7 clean_min_30). A find forked from the chat's
// own process held its main thread 1.22 s at 12:02:40Z, so the spawn host starts it.
test("a count lists no folder on the chat's thread pool and forks nothing from the chat, and counts only spawned sub-* folders below the agent's own", async t => {
  const dir = mkdtempSync(join(tmpdir(), "spawned-pool-[x]-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const spawn = (path: string) => { mkdirSync(path, { recursive: true }); writeFileSync(join(path, "rlm-subagent.json"), "{}"); };
  spawn(dir);
  for (let n = 0; n < 40; n++) spawn(join(dir, `sub-${n}`, "sub-deep"));
  mkdirSync(join(dir, "sub-plain", "sub-x"), { recursive: true });
  spawn(join(dir, "work", "sub-y"));
  writeFileSync(join(dir, "work", "rlm-subagent.json"), "{}");
  const readdir = t.mock.method(fsp, "readdir");
  const spawned = t.mock.method(childProcess, "spawn");
  syncBuiltinESMExports();
  t.after(() => { readdir.mock.restore(); spawned.mock.restore(); syncBuiltinESMExports(); });
  let changed = (): void => {};
  const landed = new Promise<void>(resolve => { changed = resolve; });
  const counts = new SpawnedCounts(() => changed());
  const now = Date.parse("2026-11-08T12:02:00Z");
  counts.of(dir, now);
  await landed;
  assert.equal(counts.of(dir, now + 1), 40, "the 40 deep spawns, not the agent's own file, a folder with no json or one outside sub-* folders");
  assert.equal(readdir.mock.callCount(), 0, "the count listed folders through the chat's thread pool");
  assert.equal(spawned.mock.calls.filter(call => call.arguments[0] === "find").length, 0, "the chat forked find from its own process");
});
