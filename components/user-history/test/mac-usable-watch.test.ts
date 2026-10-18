import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseAgentQueue } from "../src/chat-pool.ts";
import { sharedQueueRead } from "../src/chat-turn-queue.ts";
import { type Footprints, parseFeed, PRESSURE_FEED, readFootprints, readPressureFeed, readWatch, sample, startMacUsableWatch, unusable, USABLE, watchFile, watchLine, type WatchLine } from "../src/mac-usable-watch.ts";
import { harnessSide, memoryShares } from "../scripts/duties/whole-system.ts";

// The owner, 10-14 09:15Z: "look it's you and ops guys responsibility that this machine is usable." The watch records a line a minute with ops
// guy's pressure feed and the harness numbers, and the Whole system duty judges each minute on USABLE; the worker footprint is a detail.

const NOW = Date.parse("2026-10-14T09:30:00Z");
const MIN = 60_000;
const GB = 1024 ** 3;
const row = (sessionId: string, extra: Record<string, unknown> = {}) => ({ sessionId, activeSessionId: `a-${sessionId}`, lifecycle: "live", activity: "idle",
  lastActivityAt: new Date(NOW - MIN).toISOString(), workerPid: 11, ...extra });
const ROWS = [
  row("chatA", { sessionName: "Crawler VP", activity: "working", workerPid: 11 }),
  row("jobA1", { parentSessionId: "chatA", sessionName: "census", activity: "working", lastActivityAt: new Date(NOW - 40 * MIN).toISOString() }),
  row("jobA2", { parentSessionId: "jobA1", sessionName: "deep", activity: "working", lastActivityAt: new Date(NOW - 20 * MIN).toISOString() }),
  row("jobA3", { parentSessionId: "chatA", activity: "idle", taskState: "needs_input" }),
  row("chatB", { sessionName: "VP of CI", workerPid: 22, activity: "idle", taskState: "needs_input" }),
  row("jobB1", { parentSessionId: "chatB", workerPid: 22, activity: "idle", taskState: "needs_input" }),
  row("gone", { lifecycle: "archived", workerPid: 33, activity: "working", lastActivityAt: new Date(NOW - 90 * MIN).toISOString() }),
  row("saved", { parentSessionId: "chatB", workerPid: undefined, activeSessionId: undefined, activity: "idle", taskState: "needs_input" }),
  row("passivated", { parentSessionId: "chatB", workerPid: 22, activeSessionId: undefined, activity: "idle", taskState: "needs_input" }),
];
const FOOTPRINTS: Footprints = { workers: { 11: { pids: 4, bytes: 6 * GB }, 22: { pids: 2, bytes: 1.5 * GB } }, swap_used_bytes: 41.5 * GB, pressure_level: 2, cpu_s: 0.21 };
const QUEUE = { working: [{ session: "chatA", tree: "chatA", parent: null, priority: "high" as const, kind: "slot" as const, since: NOW - 60_000 }],
  queued: [{ session: "jobB1", tree: "chatB", parent: "chatB", priority: "low" as const, basePriority: "low" as const, since: NOW - 800_000, position: 1, total: 1, waitMs: 800_000 }] };

test("watchLine: worker footprint and the top workers with their chat tree, live and working sessions, the queue, and the Mac as context", () => {
  const line = watchLine({ now: NOW, rows: ROWS, footprints: FOOTPRINTS, queue: QUEUE, chats: new Set(["chatA", "chatB"]), title: id => id === "chatB" ? "VP of CI (title)" : null, cpuMs: 4,
    usable: { pressureLevel: 2, swapoutsPerS: 16191, kernelTaskPct: 224 } });
  assert.equal(line.at, "2026-10-14T09:30:00.000Z");
  assert.deepEqual(line.usable, { pressureLevel: 2, swapoutsPerS: 16191, kernelTaskPct: 224 });
  assert.deepEqual([line.workers, line.workerGb, line.chatsLive], [2, 7.5, 2]);
  assert.deepEqual(line.top, [{ pid: 11, gb: 6, sessions: 4, root: "chatA", tree: "Crawler VP" }, { pid: 22, gb: 1.5, sessions: 2, root: "chatB", tree: "VP of CI (title)" }]);
  assert.deepEqual([line.live, line.working], [6, 3], "the archived row, the saved row with no worker and the passivated row with no active session count nowhere");
  assert.deepEqual(line.queue, { working: 1, queued: 1, oldestWaitS: 800, oldestTree: "VP of CI (title)" });
  assert.deepEqual(line.mac, { swapGb: 41.5, pressureLevel: 2 });
  assert.equal(line.cpuMs, 214, "the service's own CPU plus the helper's");
});

// 10-14 10:21Z: ops guy's feed read warn with 16,191 swapouts a second and kernel_task at 224% while the Mac thrashed; 20:23Z: warn, 0 swapouts
// and kernel_task 17.7% with the Mac usable.
const FEED = { v: 1, ts: new Date(NOW - 5_000).toISOString(), interval_s: 10, pressure: "warn", pressure_level: 2, swapouts_per_s: 0.0, kernel_task_cpu_pct: 17.7, load: [6.95, 7.46, 7.45] };

test("usable: a minute is unusable at pressure critical, 6,000 swapouts a second or kernel_task at one core; a stale or broken feed reads null", async () => {
  assert.deepEqual(USABLE, { pressureLevel: 4, swapoutsPerS: 6000, kernelTaskPct: 100 });
  const reading = parseFeed(FEED, NOW)!;
  assert.deepEqual(reading, { pressureLevel: 2, swapoutsPerS: 0, kernelTaskPct: 17.7 });
  assert.deepEqual(unusable(reading), [], "warn alone is usable");
  assert.deepEqual(unusable({ pressureLevel: 2, swapoutsPerS: 16191, kernelTaskPct: 224 }), ["swapouts", "kernel_task"]);
  assert.deepEqual(unusable({ ...reading, swapoutsPerS: 5999 }), []);
  assert.deepEqual(unusable({ ...reading, swapoutsPerS: 6000 }), ["swapouts"]);
  assert.deepEqual(unusable({ ...reading, kernelTaskPct: 99.9 }), []);
  assert.deepEqual(unusable({ ...reading, kernelTaskPct: 100 }), ["kernel_task"]);
  assert.deepEqual(unusable({ ...reading, pressureLevel: 4 }), ["pressure"]);
  assert.equal(parseFeed({ ...FEED, ts: new Date(NOW - 30_000).toISOString() }, NOW), null, "three missed writes make the feed stale");
  assert.equal(parseFeed({ ...FEED, v: 2 }, NOW), null);
  assert.equal(parseFeed({ ...FEED, swapouts_per_s: null }, NOW), null);
  const dir = await mkdtemp(join(tmpdir(), "mac-usable-feed-"));
  await writeFile(join(dir, "feed.json"), JSON.stringify(FEED));
  assert.deepEqual(await readPressureFeed(NOW, join(dir, "feed.json")), reading);
  assert.equal(await readPressureFeed(NOW, join(dir, "missing.json")), null);
  assert.match(PRESSURE_FEED, /\/\.cache\/virev\/mac-pressure\.json$/);
});


test("startMacUsableWatch: writes its first line as soon as the catalog holds rows after a start, not a minute later", async () => {
  // 10-17 22:12Z to 22:41Z: 8 chat releases restarted the service, the first tick came a full minute after each start, and 4 minutes had no line.
  const dir = await mkdtemp(join(tmpdir(), "mac-usable-start-"));
  let listed = false;
  setTimeout(() => { listed = true; }, 30);
  const stop = startMacUsableWatch({ dataDir: dir, rows: () => listed ? ROWS : [], chats: async () => new Set(["chatA", "chatB"]), title: () => null, queue: async () => QUEUE,
    log: () => {}, footprints: async () => FOOTPRINTS, feed: async now => parseFeed(FEED, now) }, MIN, 10);
  try {
    let lines: WatchLine[] = [];
    for (let waited = 0; waited < 2_000 && !lines.length; waited += 20) {
      await new Promise(resolve => setTimeout(resolve, 20));
      lines = await readWatch(dir, Date.now() - MIN, Date.now());
    }
    assert.equal(lines.length, 1, "one line within 2 s of the start, from the first tick that saw rows");
  } finally { stop(); }
});

test("sample: appends one line to the day's file under the data dir, and readWatch reads lines across the day files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mac-usable-"));
  const asked: number[][] = [];
  const line = await sample({ dataDir: dir, rows: () => ROWS, chats: async () => new Set(["chatA", "chatB"]), title: () => null, queue: async () => QUEUE, log: () => {},
    footprints: async pids => { asked.push([...pids]); return FOOTPRINTS; }, feed: async now => parseFeed(FEED, now), now: () => NOW });
  assert.deepEqual(asked, [[11, 22]], "only live workers are measured");
  assert.deepEqual(line?.usable, { pressureLevel: 2, swapoutsPerS: 0, kernelTaskPct: 17.7 }, "the feed's reading at the sample");
  assert.ok(line && line.cpuMs >= 210);
  const file = watchFile(dir, NOW);
  assert.match(file, /mac-usable\/2026-10-1[45]\.jsonl$/);
  assert.deepEqual(JSON.parse((await readFile(file, "utf8")).trim()), line);
  assert.equal(await sample({ dataDir: dir, rows: () => [], chats: async () => new Set(), title: () => null, queue: async () => QUEUE, log: () => {} }), null, "no rows yet: no line");
  const yesterday = NOW - 20 * 60 * MIN;
  await mkdir(join(dir, "mac-usable"), { recursive: true });
  await writeFile(watchFile(dir, yesterday), JSON.stringify({ ...line, at: new Date(yesterday).toISOString() }) + "\nnot json\n", { flag: "a" });
  assert.deepEqual((await readWatch(dir, NOW - 24 * 60 * MIN, NOW)).map(entry => entry.at), [new Date(yesterday).toISOString(), line!.at]);
  assert.deepEqual((await readWatch(dir, NOW - 60 * MIN, NOW)).map(entry => entry.at), [line!.at]);
});

test("readFootprints: the helper measures this process's tree and the Mac's swap with no other process", async () => {
  const measured = await readFootprints([process.pid]);
  const own = measured.workers[String(process.pid)]!;
  assert.ok(own.pids >= 1 && own.bytes > 10 * 1024 * 1024, JSON.stringify(own));
  assert.equal(typeof measured.swap_used_bytes, "number");
  assert.ok([1, 2, 4].includes(measured.pressure_level!), String(measured.pressure_level));
  assert.ok(measured.cpu_s > 0 && measured.cpu_s < 1, String(measured.cpu_s));
});

test("sharedQueueRead: one pi-pool read serves every reader for its ttl, and a failed read is not kept", async () => {
  let reads = 0, now = 0, fail = false;
  const read = sharedQueueRead(async () => { reads++; if (fail) throw new Error("pool down"); return parseAgentQueue({ enabled: true, working_max: 30, tree_working_max: 8, working: [], queued: [] }); }, 10_000, () => now);
  await Promise.all([read(), read()]);
  now = 9_999; await read();
  assert.equal(reads, 1);
  now = 10_000; fail = true;
  await assert.rejects(read());
  fail = false; await read();
  assert.equal(reads, 3, "the failed read was retried at once");
});

const at = (minute: number) => new Date(NOW - 59 * MIN + minute * MIN).toISOString();
const watch = (minute: number, extra: Partial<WatchLine> = {}): WatchLine => ({ at: at(minute), workers: 2, workerGb: 4, top: [{ pid: 11, gb: 3, sessions: 4, root: "chatA", tree: "Crawler VP" }],
  usable: { pressureLevel: 2, swapoutsPerS: 0, kernelTaskPct: 17.7 }, chatsLive: 9, live: 10, working: 3,
  queue: { working: 3, queued: 0, oldestWaitS: 0, oldestTree: null }, mac: { swapGb: 40, pressureLevel: 2 }, cpuMs: 210, ...extra });

const thrash = { pressureLevel: 2, swapoutsPerS: 12633.8, kernelTaskPct: 124.2 };

test("harnessSide: an unusable minute is the harness's when agent sessions hold the largest share of memory or of its growth, by Settings > This Mac's groups", () => {
  const queue = (working: number) => ({ working, queued: 30, oldestWaitS: 60, oldestTree: null });
  const owners = [{ owner: "browser:chrome", label: "Google Chrome", gb: 6.5 }, { owner: "chat:01a1164b", label: "AI harness", gb: 2.2 }, { owner: "pm2:virev-demo", label: "virev-demo", gb: 2.1 }];
  // 01:06Z, 01:10Z and 01:24Z on 10-18 in short: browsers held the most memory each minute, while agent sessions grew by 2.2 GB into 01:10Z.
  const lines = [watch(40, { usable: { ...thrash, groups: { browsers: 19.1, agents: 13.5, dev: 2.3 } }, workerGb: 12.9, queue: queue(12) }),
    watch(41, { usable: { ...thrash, groups: { browsers: 19.2, agents: 15.7, dev: 2.1 } }, workerGb: 15.3, queue: queue(26) }),
    watch(42, { usable: { ...thrash, groups: { browsers: 20.5, agents: 15.8, dev: 2.1 } }, workerGb: 15.3, queue: queue(26) }),
    watch(43, { queue: queue(20) }),
    watch(44, { usable: { ...thrash, groups: { browsers: 6.5 } }, queue: queue(3), workerGb: 25.9 }),
    watch(45, { usable: { ...thrash, owners }, queue: queue(22) })];
  const side = harnessSide(lines);
  assert.deepEqual(lines.map(line => side(line)), [false, true, false, false, true, false],
    "41: agents grew most; 42: browsers grew most; 44: the workers' own 25.9 GB leads at 3 turns; 45: an older line with owners and no groups is never the harness's");
  assert.equal(memoryShares(lines[5]!).get("agents"), 4, "agent sessions take at least the workers' measured 4 GB");
  const feed = parseFeed({ ...FEED, mem_gb: { wired: 3.2 }, owners: [...Array.from({ length: 12 }, (_, i) => ({ owner: `other:p${i}`, label: `p${i}`, mem_gb: i, cpu_pct: 0, procs: 1 })),
    { owner: "chat:01a1164b", label: "AI harness", mem_gb: 0.5 }, { owner: "other:prime-agent-daemon", label: "prime-agent daemon", mem_gb: 2.5 }] }, NOW)!;
  assert.deepEqual(feed.owners!.map(owner => owner.gb), [11, 10, 9, 8, 7, 6, 5, 4], "the feed's 8 largest owners, largest first");
  assert.deepEqual(feed.groups, { other: 66, agents: 3, system: 3.2 }, "every owner summed by the This Mac rule table, wired memory under system");
});

// `prime-agent list --json` at 23:44Z on 10-17: frontend bro, launch main bro and api portal vp sat 11.7 min idle in their own workers, and in
// trees still at work idle subagents kept their kernels. The owner (c92): "make sure your daily duty checks whether it's seriously lazy in resource management."
test("watchLine: sleeping counts each worker whose every resident session is idle past the idle window, plus such a session's kernel in a worker that still works", () => {
  const idle = (minutes: number) => new Date(NOW - minutes * MIN).toISOString();
  const rows = [
    row("lmb", { sessionName: "launch main bro", workerPid: 31, lastActivityAt: idle(50) }),
    row("vp", { sessionName: "VP", workerPid: 32, activity: "working", lastActivityAt: idle(0) }),
    row("vpJob", { parentSessionId: "vp", workerPid: 32, lastActivityAt: idle(25), taskState: "needs_input" }),
    row("vpFresh", { parentSessionId: "vp", workerPid: 32, lastActivityAt: idle(11) }),
    row("ci", { sessionName: "VP of CI", workerPid: 33, lastActivityAt: idle(3) }),
  ];
  const footprints: Footprints = { workers: { 31: { pids: 2, bytes: 0.25 * GB }, 32: { pids: 9, bytes: 2.5 * GB }, 33: { pids: 2, bytes: 0.6 * GB } },
    kernels: [{ pid: 41, root: "lmb", session: "lmb", pids: 1, bytes: 0.1 * GB, biggest: null }, { pid: 42, root: "vp", session: "vpJob", pids: 1, bytes: 0.15 * GB, biggest: null },
      { pid: 43, root: "vp", session: "vpFresh", pids: 1, bytes: 0.2 * GB, biggest: null }],
    swap_used_bytes: 6 * GB, pressure_level: 1, cpu_s: 0.1 };
  const line = watchLine({ now: NOW, rows, footprints, queue: null, chats: new Set(["lmb", "vp", "ci"]), title: () => null, cpuMs: 0, idleMs: 10 * MIN });
  assert.deepEqual(line.sleeping, { gb: 0.4, workers: 1, kernels: 1, trees: [{ root: "lmb", tree: "launch main bro", gb: 0.25 }, { root: "vp", tree: "VP", gb: 0.15 }] },
    "a session 11 min idle is inside the 2 min slack; a kernel in a whole sleeping worker counts once, with the worker");
  assert.equal(watchLine({ now: NOW, rows, footprints, queue: null, chats: new Set(), title: () => null, cpuMs: 0, idleMs: null }).sleeping, undefined, "idle eviction off");
});
