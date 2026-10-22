// Guards d7's clean_min_30 on us-metal02 on 10-20: an exiting clickhouse thread stalled RCU from 11:22Z to 13:08Z, a cgroup cpu.stat read of the
// usable watch hung behind it, every tick skipped while that sample ran, and the watch wrote no line from 11:44:30Z to 13:08:29Z and from
// 13:11:30Z to 13:16:30Z, so d7 read all 30 minutes of its 13:08Z run with no watch line.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { kernelFile } from "../../prime-relay/kernel-read.ts";
import { linuxUsable, userSlice } from "../../prime-relay/host-stats.ts";
import { sample, startMacUsableWatch, type WatchLine, type WatchSource, watchFile } from "../src/mac-usable-watch.ts";

const READING = { kind: "linux", memSomeAvg10: 0, memFullAvg10: 0, cpuSomeAvg10: 0, swapoutsPerS: 0, runnablePerCore: 0.6, allowedCpus: 32 } as const;
/** A read that answers only when the test lets it, so the next test does not join it (kernel-read.ts `bounded` joins a read still out). */
function hang<T>(t: { after: (fn: () => void) => void }, value: T): { read: () => Promise<T>; release: () => void } {
  let release = () => {};
  const promise = new Promise<T>(done => { release = () => done(value); });
  t.after(() => release());
  return { read: () => promise, release: () => release() };
}
const FOOTPRINTS = { workers: {}, swap_used_bytes: null, pressure_level: null, cpu_s: 0 };
const within = <T>(promise: Promise<T>, ms: number): Promise<T | "still out"> => Promise.race([promise, new Promise<"still out">(done => setTimeout(() => done("still out"), ms))]);

test("a sample whose footprint read never returns writes its minute's line by the next tick, and so does the next minute's", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "watch-hung-read-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  let at = Date.parse("2026-10-20T11:45:29.800Z");
  let helpers = 0;
  const helper = hang(t, FOOTPRINTS);
  const source: WatchSource = { dataDir, now: () => at, rows: () => [{ sessionId: "s1", lifecycle: "live", activeSessionId: "a1", workerPid: 1, activity: "working" }],
    chats: async () => new Set<string>(), title: () => null, queue: async () => ({ working: [], queued: [], workingMax: 8, treeWorkingMax: 8 }), log: () => {},
    footprints: () => { helpers++; return helper.read(); }, feed: async () => READING, memory: async () => ({ groups: null }), services: async () => [], host: "us-metal02" };
  const first = await within(sample(source), 3_000);
  assert.notEqual(first, "still out", "the sample answered by the next tick");
  at = Date.parse("2026-10-20T11:46:29.800Z");
  const second = await within(sample(source), 3_000);
  assert.notEqual(second, "still out");
  const lines = readFileSync(watchFile(dataDir, at), "utf8").trim().split("\n").map(raw => JSON.parse(raw) as WatchLine);
  assert.deepEqual(lines.map(line => [line.at, line.unread, (line.usable as { kind?: string } | null | undefined)?.kind]), [["2026-10-20T11:45:29.800Z", ["footprints"], "linux"], ["2026-10-20T11:46:29.800Z", ["footprints"], "linux"]]);
  assert.equal(helpers, 1, "the next minute joins the helper still out instead of starting another");
});

test("a tick that comes while a cut sample still writes its line runs after it, instead of skipping", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "watch-hung-tick-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const base = Date.parse("2026-10-20T14:11:29.900Z"), started = Date.now();
  const helper = hang(t, FOOTPRINTS);
  const now = () => base + Date.now() - started;
  const stop = startMacUsableWatch({ dataDir, now, rows: () => [{ sessionId: "s1", lifecycle: "live", activeSessionId: "a1", workerPid: 1, activity: "working" }],
    chats: async () => new Set<string>(), title: () => null, queue: async () => ({ working: [], queued: [], workingMax: 8, treeWorkingMax: 8 }), log: () => {},
    footprints: helper.read, feed: async () => READING, memory: async () => ({ groups: null }), services: async () => [], host: "us-metal02" }, 60_000);
  await new Promise(done => setTimeout(done, 1_000));
  helper.release();
  await stop();
  const lines = readFileSync(watchFile(dataDir, now()), "utf8").trim().split("\n").map(raw => JSON.parse(raw) as WatchLine);
  assert.equal(lines.length, 2, "the start sample's line and the 14:11:30Z tick's line");
  assert.ok(lines[1]!.at >= "2026-10-20T14:11:30.000Z", lines[1]!.at);
});

test("a stop lets this box's own reads answer, so the stop's line carries them", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "watch-hung-stop-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const at = Date.parse("2026-10-20T14:30:03.432Z");
  const stop = startMacUsableWatch({ dataDir, now: () => at, rows: () => [{ sessionId: "s1", lifecycle: "live", activeSessionId: "a1", workerPid: 1, activity: "working" }],
    chats: async () => new Set<string>(), title: () => null, queue: async () => ({ working: [], queued: [], workingMax: 8, treeWorkingMax: 8 }), log: () => {},
    footprints: () => new Promise(done => setTimeout(() => done({ workers: { 1: { pids: 1, bytes: 1024 ** 3 } }, swap_used_bytes: 0, pressure_level: null, cpu_s: 0 }), 200)),
    feed: async () => READING, memory: async () => ({ groups: null }), services: async () => [], host: "us-metal02" }, 60_000);
  await stop();
  const lines = readFileSync(watchFile(dataDir, at), "utf8").trim().split("\n").map(raw => JSON.parse(raw) as WatchLine);
  assert.deepEqual(lines.map(line => [line.at, line.unread, line.workers]), [["2026-10-20T14:30:03.432Z", undefined, 1]]);
});

test("a hung cgroup file leaves the reading its memory and run queue, holds one read, and the next call reads the cgroups again once it returns",
  { skip: process.platform !== "linux" || !userSlice(readFileSync("/proc/self/cgroup", "utf8")) }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "watch-hung-cgroup-"));
  const fifo = join(dir, "cgroup");
  execFileSync("mkfifo", [fifo]);
  // The test holds the FIFO's only writer, opened read-write so this open never blocks. A read opens at once and then blocks in the thread
  // pool as the 10-20 cpu.stat read did, and the path puts it in the cgroup lane. The release build of 49cfa599 hung 14 min on 10-22: the
  // old release() opened a write end with openSync, which blocks the main thread until a read opens the FIFO, and the read still waited in the
  // lane behind this module's /proc/<pid>/cgroup reads, which need the main thread to move on.
  const writer = openSync(fifo, "r+");
  let released = false;
  // A regular file takes the FIFO's path before the writer closes, so a read that opens after the release finds it instead of a FIFO with no writer.
  const release = () => {
    if (released) return;
    released = true;
    writeFileSync(join(dir, "file"), "");
    renameSync(join(dir, "file"), fifo);
    closeSync(writer);
  };
  t.after(() => { release(); rmSync(dir, { recursive: true, force: true }); });
  const hung = kernelFile(fifo);
  for (let call = 0; call < 2; call++) {
    const unread: string[] = [];
    const reading = await linuxUsable(Date.now(), new Promise(done => setTimeout(done, 300)), unread);
    assert.equal(reading?.kind, "linux", "the /proc lane still reads");
    assert.equal(reading?.cpuCores, undefined);
    assert.deepEqual(unread, ["cgroups", "rigs"]);
  }
  release();
  await hung;
  const unread: string[] = [];
  await linuxUsable(Date.now(), new Promise(done => setTimeout(done, 30_000)), unread);
  assert.deepEqual(unread, []);
});
