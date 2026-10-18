// Guards the minutes a chat restart left with no watch line on 10-18: 10:46Z and 10:58Z, when the stop dropped the 10:46:30Z and 10:58:30Z
// samples while they waited on the Mac's relay, and 06:00Z, when the service began to stop at about 06:00:28Z and the next one listened at 06:01:28Z.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Footprints, startMacUsableWatch, UNREAD_AT_STOP, type WatchLine, type WatchSource, watchFile } from "../src/mac-usable-watch.ts";

const FOOTPRINTS: Footprints = { workers: { 1: { pids: 1, bytes: 1024 ** 3 } }, swap_used_bytes: 0, pressure_level: null, cpu_s: 0 };
function source(dataDir: string, now: () => number, reads: { count: number }): WatchSource {
  return { dataDir, now, rows: () => [{ sessionId: "s1", lifecycle: "live", activeSessionId: "a1", workerPid: 1, activity: "working" }], chats: async () => new Set<string>(),
    title: () => null, queue: async () => ({ working: [], queued: [], workingMax: 8, treeWorkingMax: 8 }), log: line => { throw new Error(line); },
    footprints: async () => FOOTPRINTS, feed: async () => ({ kind: "linux", memSomeAvg10: 0, memFullAvg10: 0, cpuSomeAvg10: 0, swapoutsPerS: 0, runnablePerCore: 0.6, allowedCpus: 32 }),
    host: "us-metal02",
    // The Mac's relay as it was at 10:58Z: a read that has not answered when the service stops.
    remotes: () => [{ name: "mac", rows: [], read: () => { reads.count++; return new Promise(() => {}); } }] };
}
function setup(t: { after: (fn: () => void) => void }, lastAt: string): string {
  const dataDir = mkdtempSync(join(tmpdir(), "watch-restart-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  mkdirSync(join(dataDir, "mac-usable"), { recursive: true });
  writeFileSync(join(dataDir, "mac-usable", "last-sample.json"), JSON.stringify({ at: Date.parse(lastAt), sched: null }));
  return dataDir;
}
const lines = (dataDir: string, at: number): WatchLine[] => {
  try { return readFileSync(watchFile(dataDir, at), "utf8").trim().split("\n").filter(Boolean).map(raw => JSON.parse(raw) as WatchLine); } catch { return []; }
};
const settle = () => new Promise(done => setTimeout(done, 100));

test("a stop with a sample waiting on a relay writes that sample's line from this box's numbers and marks the relay unread", async (t) => {
  const dataDir = setup(t, "2026-10-18T10:57:30.002Z");
  const at = Date.parse("2026-10-18T10:58:30.000Z");
  const reads = { count: 0 };
  const stop = startMacUsableWatch(source(dataDir, () => at, reads));
  await settle();
  assert.equal(reads.count, 1, "the start sample is out on the relay");
  assert.deepEqual(lines(dataDir, at), []);
  await stop();
  const written = lines(dataDir, at);
  assert.equal(written.length, 1);
  assert.equal(written[0]!.at, "2026-10-18T10:58:30.000Z");
  assert.equal(written[0]!.workers, 1);
  assert.deepEqual(written[0]!.hosts?.map(host => [host.name, host.usable, host.error]), [["mac", null, UNREAD_AT_STOP]]);
  assert.equal(JSON.parse(readFileSync(join(dataDir, "mac-usable", "last-sample.json"), "utf8")).at, at);
});

test("a stop in a minute with no line yet writes one, and a stop in a minute with a line writes none", async (t) => {
  const dataDir = setup(t, "2026-10-18T05:59:30.000Z");
  let at = Date.parse("2026-10-18T05:59:50.000Z");
  const reads = { count: 0 };
  const stop = startMacUsableWatch(source(dataDir, () => at, reads));
  await settle();
  assert.equal(reads.count, 0, "05:59Z already has its line, so the start takes no sample");
  at = Date.parse("2026-10-18T06:00:27.000Z");
  await stop();
  const written = lines(dataDir, at);
  assert.deepEqual(written.map(line => [line.at, line.hosts?.[0]?.error]), [["2026-10-18T06:00:27.000Z", UNREAD_AT_STOP]]);

  const again = startMacUsableWatch(source(dataDir, () => at, reads));
  await settle();
  await again();
  assert.equal(lines(dataDir, at).length, 1, "06:00Z has its line from the last stop, so neither the start nor the stop adds one");
});
