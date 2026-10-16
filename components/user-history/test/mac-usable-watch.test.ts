import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseAgentQueue } from "../src/chat-pool.ts";
import { sharedQueueRead } from "../src/chat-turn-queue.ts";
import { advanceMotion, type Footprints, MOTION, parseNettop, openCall, quietFiles, misses, parseFeed, PRESSURE_FEED, readFootprints, readPressureFeed, readWatch, sample, TARGET, unusable, USABLE, watchFile, watchLine, type WatchLine } from "../src/mac-usable-watch.ts";
import { parseDutyInput } from "../src/shared/chat-duties.ts";
import { HARNESS_GB, HARNESS_TURNS, longestOffStreak, measure, OFF_STREAK_ALERT } from "../scripts/duties/mac-stays-usable.ts";

// The owner, 10-14 09:15Z: "look it's you and ops guys responsibility that this machine is usable." The watch records a line a minute with ops
// guy's pressure feed and the harness numbers, and the hourly Mac stays usable duty judges each minute on USABLE; the worker footprint is a detail.

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
  queued: [{ session: "jobB1", tree: "chatB", parent: "chatB", priority: "low" as const, basePriority: "low" as const, since: NOW - 800_000, position: 1, total: 1, waitMs: 800_000 }], governor: { level: "high", held: 2 } };

test("watchLine: worker footprint and the top workers with their chat tree, quiet and finished sessions by tree, the queue, and the Mac as context", () => {
  const line = watchLine({ now: NOW, rows: ROWS, footprints: FOOTPRINTS, queue: QUEUE, chats: new Set(["chatA", "chatB"]), title: id => id === "chatB" ? "VP of CI (title)" : null, cpuMs: 4,
    usable: { pressureLevel: 2, swapoutsPerS: 16191, kernelTaskPct: 224 } });
  assert.equal(line.at, "2026-10-14T09:30:00.000Z");
  assert.deepEqual(line.usable, { pressureLevel: 2, swapoutsPerS: 16191, kernelTaskPct: 224 });
  assert.deepEqual([line.workers, line.workerGb, line.chatsLive], [2, 7.5, 2]);
  assert.deepEqual(line.top, [{ pid: 11, gb: 6, sessions: 4, root: "chatA", tree: "Crawler VP" }, { pid: 22, gb: 1.5, sessions: 2, root: "chatB", tree: "VP of CI (title)" }]);
  assert.deepEqual([line.live, line.working, line.idle15, line.idleOver], [6, 3, 2, 1], "the archived row, the saved row with no worker and the passivated row with no active session count nowhere");
  assert.deepEqual(line.idleTrees, [{ root: "chatA", tree: "Crawler VP", count: 1 }]);
  assert.deepEqual([line.finished, line.finishedTrees.map(tree => [tree.tree, tree.count])], [2, [["Crawler VP", 1], ["VP of CI (title)", 1]]], "a chat is no finished job");
  assert.deepEqual(line.queue, { working: 1, queued: 1, held: 2, pressure: "high", oldestWaitS: 800, oldestTree: "VP of CI (title)" });
  assert.deepEqual(line.mac, { swapGb: 41.5, pressureLevel: 2 });
  assert.equal(line.cpuMs, 214, "the service's own CPU plus the helper's");
  assert.deepEqual(misses(line), ["usable", "idle", "queue"]);
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

test("misses: a minute is on target only when every part holds; the worker footprint is never a part, and a line with no feed reading misses no usable part", () => {
  const on = { usable: { pressureLevel: 2, swapoutsPerS: 0, kernelTaskPct: 17.7 }, idleOver: 0,
    queue: { working: 3, queued: 1, held: null, pressure: null, oldestWaitS: TARGET.queueWaitS, oldestTree: null } };
  assert.deepEqual(misses(on), []);
  assert.deepEqual(misses({ ...on, usable: { ...on.usable, kernelTaskPct: 132.8 } }), ["usable"]);
  assert.deepEqual(misses({ ...on, usable: null }), []);
  assert.deepEqual(misses({ ...on, idleOver: 1 }), ["idle"]);
  assert.deepEqual(misses({ ...on, queue: { ...on.queue, oldestWaitS: TARGET.queueWaitS + 1 } }), ["queue"]);
  assert.deepEqual(misses({ ...on, queue: null }), [], "an unread queue misses no queue part");
  assert.deepEqual(TARGET, { idleMinutes: 30, queueWaitS: 706 });
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
  const read = sharedQueueRead(async () => { reads++; if (fail) throw new Error("pool down"); return parseAgentQueue({ enabled: true, mac_working_max: 30, tree_working_max: 8, working: [], queued: [] }); }, 10_000, () => now);
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
  usable: { pressureLevel: 2, swapoutsPerS: 0, kernelTaskPct: 17.7 }, chatsLive: 9, live: 10, working: 3, idle15: 0, idleOver: 0, idleTrees: [], finished: 1, finishedTrees: [{ root: "chatA", tree: "Crawler VP", count: 1 }],
  queue: { working: 3, queued: 0, held: null, pressure: null, oldestWaitS: 0, oldestTree: null }, mac: { swapGb: 40, pressureLevel: 2 }, cpuMs: 210, ...extra });

const thrash = { pressureLevel: 2, swapoutsPerS: 12633.8, kernelTaskPct: 124.2 };

test("measure: the usable share over 1 h and 24 h of the minutes with a feed reading, the minutes each part missed, and the top miss with the trees behind it", () => {
  const lines = [watch(-600, { usable: thrash }), watch(-500, { usable: null }), ...Array.from({ length: 60 }, (_, minute) => minute < 12 ? watch(minute, { idleOver: 2, idleTrees: [{ root: "chatB", tree: "VP of CI", count: 2 }] })
    : minute < 26 ? watch(minute, { usable: minute < 16 ? { ...thrash, swapoutsPerS: 0 } : thrash, workerGb: 8,
      top: [{ pid: 22, gb: 6, sessions: 9, root: "chatB", tree: "VP of CI" }, { pid: 11, gb: 2, sessions: 4, root: "chatA", tree: "Crawler VP" }] })
    : minute < 30 ? watch(minute, { usable: null }) : watch(minute))];
  const { metrics, flagged } = measure(lines, NOW);
  assert.deepEqual(metrics, { usable_pct_1h: 75, usable_pct_24h: 73.7, harness_unusable_min_1h: 0, other_unusable_min_1h: 14, unusable_streak_max_1h: 14, idle_miss_min_1h: 12,
    queue_miss_min_1h: 0, kernel_waiters_1h: 0 },
    "42 of 56 fed minutes in the hour; 42 of 57 over the day; the null lines count nowhere");
  assert.equal(flagged!.find(item => item.kind === "usable")!.excerpt,
    "The Mac was usable in 42 of the 56 minutes with a feed reading in the last hour (60 watched); unusable minutes by cause: swapouts 10, kernel_task 14.");
  assert.deepEqual(flagged!.find(item => item.kind === "top_miss"), { kind: "top_miss", item: "usable",
    excerpt: `Top miss: the Mac unusable (memory pressure critical, 6000 or more swapouts a second, or kernel_task at 100% of a core or more) in 14 of 60 minutes. Chat trees behind it, by Prime worker footprint in those minutes: VP of CI 6 GB, Crawler VP 2 GB.` });
  assert.match(flagged!.find(item => item.kind === "alert")!.excerpt, /^The Mac was unusable 14 minutes in a row, /);
  assert.match(flagged!.find(item => item.kind === "now")!.excerpt, /: pressure level 2, 0 swapouts a second, kernel_task 17\.7%\. Detail with no target: 2 Prime workers hold 4 GB .*; swap 40 GB\.$/);
});

test("measure: an alert at 10 unusable minutes in a row and none at 9; a gap in the watch ends a run; no lines or no feed reading is flagged and leaves the usable shares out", () => {
  const off = (minute: number) => watch(minute, { usable: thrash });
  assert.equal(OFF_STREAK_ALERT, 10);
  const nine = [...Array.from({ length: 9 }, (_, minute) => off(minute)), watch(9), ...Array.from({ length: 9 }, (_, minute) => off(10 + minute))];
  assert.equal(longestOffStreak(nine).minutes, 9);
  assert.equal(measure(nine, NOW).flagged!.some(item => item.kind === "alert"), false);
  assert.equal(longestOffStreak(Array.from({ length: 12 }, (_, minute) => watch(minute, { idleOver: 1 }))).minutes, 0, "a quiet session alone is no unusable minute");
  const ten = Array.from({ length: 10 }, (_, minute) => off(minute));
  assert.deepEqual(longestOffStreak(ten), { minutes: 10, from: at(0), to: at(9) });
  assert.equal(measure(ten, NOW).flagged!.filter(item => item.kind === "alert").length, 1);
  const gap = [...Array.from({ length: 5 }, (_, minute) => off(minute)), ...Array.from({ length: 5 }, (_, minute) => off(10 + minute))];
  assert.equal(longestOffStreak(gap).minutes, 5);
  assert.deepEqual(measure([], NOW), { metrics: { harness_unusable_min_1h: 0, other_unusable_min_1h: 0, unusable_streak_max_1h: 0, idle_miss_min_1h: 0, queue_miss_min_1h: 0, kernel_waiters_1h: 0 },
    flagged: [{ kind: "no_watch", excerpt: "The Mac usable watch wrote no line in the last hour: the chat service is down or runs a release without the watch." }] });
  const { usable: _, ...older } = watch(58);
  const unfed = measure([older, watch(59, { usable: null })], NOW);
  assert.equal("usable_pct_1h" in unfed.metrics || "usable_pct_24h" in unfed.metrics, false, "the run is an error that names them, not a share of nothing");
  assert.ok(unfed.flagged!.some(item => item.kind === "no_feed"));
});

// ops guy, 10-14 15:3xZ: two kernel waits pinned workers. pid 12634 in launch main bro's job 'watch read errors' and pid 25528 in the main
// dev thread's job 'wp-engage-crawl'.
const WAITER_ROWS = [
  row("lmb", { sessionName: "***launch main bro***", workerPid: 4042 }),
  row("01a13918-bc49-751b-b701-c33d1e99f838", { parentSessionId: "lmb", sessionName: "watch read errors", activity: "working", workerPid: 4042 }),
  row("dev", { sessionName: "**** main dev thread ***", workerPid: 48062 }),
  row("01a0f7cb-3ae2-71ae-8656-c20e725a3599", { parentSessionId: "dev", sessionName: "wp-engage-crawl", activity: "working", workerPid: 48062 }),
];
const WAITERS = [
  { pid: 12634, kernel: 64730, session: "01a13918-bc49-751b-b701-c33d1e99f838", command: "/bin/bash /Users/sieunpark/.local/bin/gh run watch 38589314491 --interval 180", age_s: 331 },
  { pid: 25528, kernel: 2701, session: "01a0f7cb-3ae2-71ae-8656-c20e725a3599", command: "/bin/sh /Users/sieunpark/.cache/virev/pinned/ci-cache-60542b39bbd1/scripts/dev/ci-run-status.sh 38579579684 --wait", age_s: 4288 },
];

test("waiters: the helper's pattern takes both 10-14 kernel waits and not plain commands; the line names each one's job and chat, and the duty lists both", async () => {
  const helper = join(import.meta.dirname, "../src/worker-footprint.py");
  const matched = execFileSync("/usr/bin/python3", ["-B", "-c", `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("wf", sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps([bool(m.WAITER.search(c)) for c in json.loads(sys.argv[2])]))`, helper, JSON.stringify([...WAITERS.map(waiter => waiter.command), "sleep 600", "sleep 5",
    "/bin/sh ci-run-status.sh 38579579684", "gh run view 38589314491 --json conclusion", "gh pr checks 12 --watch"])], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(matched), [true, true, true, false, false, false, true]);
  const line = watchLine({ now: NOW, rows: WAITER_ROWS, footprints: { ...FOOTPRINTS, waiters: WAITERS }, queue: null, chats: new Set(["lmb"]), title: () => null, cpuMs: 0 });
  assert.deepEqual(line.waiters!.map(waiter => [waiter.pid, waiter.tree, waiter.job, waiter.ageMin]),
    [[12634, "***launch main bro***", "watch read errors", 6], [25528, "**** main dev thread ***", "wp-engage-crawl", 71]]);
  const { metrics, flagged } = measure([watch(59, { waiters: line.waiters! })], NOW);
  assert.equal(metrics.kernel_waiters_1h, 2);
  assert.deepEqual(flagged!.filter(item => item.kind === "kernel_waiter").map(item => item.item), ["12634", "25528"]);
});

// 10-14 21:29:58Z: the job 'm2 air docker swap' under ops guy ended its turn with a 3 h sampler (pid 78004) still in a bash() handle, so the
// daemon kept it working and 20 minutes of 22:00-22:20Z missed the idle part with no ask, since no WAITER pattern took it.
test("held handles: a bash() handle of a session quiet past TARGET.idleMinutes is a waiter; a fresh session's handle is not", async () => {
  const helper = join(import.meta.dirname, "../src/worker-footprint.py");
  const sampler = "nice -n 20 python3 evidence/sampler.py evidence/cgroup-samples.jsonl 19";
  const wrapper = `exec 9>&0 8>&1 0</dev/null\nread -r _prime_agent_gate <&9 || exit 127\n{\n${sampler}\n} 8>&- 9>&-\n__prime_status=$?\n'/usr/bin/printf' '\\036prime-agent-complete:%s%s\\037' 'a' 'b' >&8`;
  const parsed = execFileSync("/usr/bin/python3", ["-B", "-c", `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("wf", sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps([(h.group(1) if (h := m.HANDLE.search(c)) else None) for c in sys.argv[2:]]))`, helper, `/bin/bash -c ${wrapper}`, "/bin/bash -c sleep 5", sampler], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(parsed), [sampler, null, null], "only Prime's bash() wrapper is a handle, read back to the command it runs");
  const job = "01a13c3d-7876-704c-ad45-90c39ca9b262";
  const rows = [row("ops", { sessionName: "ops guy (+observability)", workerPid: 96287 }),
    row(job, { parentSessionId: "ops", sessionName: "m2 air docker swap", activity: "working", workerPid: 96287, lastActivityAt: new Date(NOW - 51 * MIN).toISOString() }),
    row("fresh", { parentSessionId: "ops", sessionName: "fresh", activity: "working", workerPid: 96287, lastActivityAt: new Date(NOW - 5 * MIN).toISOString() }),
    row("waits", { parentSessionId: "ops", sessionName: "waits", activity: "working", workerPid: 96287, lastActivityAt: new Date(NOW - 40 * MIN).toISOString() })];
  const handles = [{ pid: 78004, kernel: 41785, session: job, command: sampler, age_s: 3300 }, { pid: 5, kernel: 6, session: "fresh", command: "npm run dev", age_s: 600 },
    { pid: 7, kernel: 8, session: "waits", command: "sleep 3000", age_s: 2500 }];
  const footprints = { ...FOOTPRINTS, waiters: [{ pid: 9, kernel: 8, session: "waits", command: "sleep 3000", age_s: 2500 }], handles };
  const line = watchLine({ now: NOW, rows, footprints, queue: null, chats: new Set(["ops"]), title: () => null, cpuMs: 0 });
  assert.equal(line.idleOver, 2, "the held session still counts as idle");
  assert.deepEqual(line.waiters!.map(waiter => [waiter.pid, waiter.job, waiter.quietMin]), [[9, "waits", undefined], [78004, "m2 air docker swap", 51]],
    "a fresh session's handle is no waiter, and a kernel already asked about its sleep adds no second line");
  assert.match(measure([watch(59, { waiters: line.waiters! })], NOW).flagged!.find(item => item.item === "78004")!.excerpt, /a bash\(\) handle held 51 min past its turn end\.$/);
});

// 10-15 02:23Z: wp-engage-crawl under the main dev thread sat in one ipython cell from 01:27:59Z (it pages the staging crawler API, kernel 62440 on
// worker 48062, 0.01 s of CPU a minute), and air boot daemons sat in one cell from 01:53:55Z that awaits a bash() handle. Both counted in idleOver,
// the line named only their trees, and air boot daemons was told it had ended its turn.
const DEV = "01a0e0ca-ee06-776f-b18d-cbdffca4c85c";
const CRAWL = "01a0f7cb-3ae2-71ae-8656-c20e725a3599";
const BOOT = "01a13b45-d0b1-71ef-8077-4c346a2187fc";
const entry = (id: string, at: string, message: Record<string, unknown>) => JSON.stringify({ type: "message", id, parentId: "p", timestamp: at, message });
const toolCall = (id: string, at: string, code: string) => entry(id, at, { role: "assistant", content: [{ type: "thinking", thinking: "x" },
  { type: "toolCall", id, name: "ipython", arguments: { code } }] });
const toolResult = (id: string, at: string) => entry(`r-${id}`, at, { role: "toolResult", toolCallId: id, toolName: "ipython", content: [{ type: "text", text: "x".repeat(200_000) }] });

test("quiet sessions: each line names every session quiet past TARGET.idleMinutes with the tool call its last entry left open, and the duty names them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mac-usable-quiet-"));
  await mkdir(join(dir, "mac-usable"), { recursive: true });
  const crawlFile = join(dir, "crawl.jsonl");
  await writeFile(crawlFile, [toolCall("toolu_01Gb", "2026-10-15T00:55:00.148Z", "from datetime import date"), toolResult("toolu_01Gb", "2026-10-15T01:27:48.657Z"),
    toolCall("toolu_01Pa", "2026-10-15T01:27:59.784Z", "\nasync def batch_item_ids(bid, index=None):\n    ids, cur, n = [], None, 0")].join("\n") + "\n");
  const bootFile = join(dir, "boot.jsonl");
  await writeFile(bootFile, toolCall("toolu_011c", "2026-10-15T01:53:55.285Z", "r=await bash(f'cd {Q} && bash -e step.sh')") + "\n");
  const doneFile = join(dir, "done.jsonl");
  await writeFile(doneFile, [toolCall("toolu_x", "2026-10-15T01:00:00.000Z", "print(1)"), toolResult("toolu_x", "2026-10-15T01:00:01.000Z")].join("\n") + "\n");
  assert.deepEqual(await openCall(crawlFile), { id: "toolu_01Pa", tool: "ipython", at: "2026-10-15T01:27:59.784Z", code: "async def batch_item_ids(bid, index=None):" },
    "read back from the end past a 200 KB result line");
  assert.equal(await openCall(doneFile), null, "a call with its result is no open call");
  assert.equal(await openCall(join(dir, "gone.jsonl")), null);

  const now = Date.parse("2026-10-15T02:24:10Z");
  const since = (minutes: number) => new Date(now - minutes * MIN).toISOString();
  const rows = [row(DEV, { sessionName: "**** main dev thread ***", workerPid: 48062 }),
    row(CRAWL, { parentSessionId: DEV, sessionName: "wp-engage-crawl", activity: "working", workerPid: 48062, lastActivityAt: "2026-10-15T01:27:59.784Z", sessionFile: crawlFile }),
    row(BOOT, { sessionName: "air boot daemons", activity: "working", workerPid: 88000, lastActivityAt: "2026-10-15T01:53:55.285Z", sessionFile: bootFile }),
    row("held", { parentSessionId: DEV, sessionName: "m2 air docker swap", activity: "working", workerPid: 48062, lastActivityAt: since(51), sessionFile: doneFile }),
    row("fresh", { parentSessionId: DEV, sessionName: "fresh", activity: "working", workerPid: 48062, lastActivityAt: since(5), sessionFile: crawlFile })];
  assert.deepEqual([...quietFiles(rows, now).keys()], [CRAWL, BOOT, "held"], "only sessions quiet past the target are read");
  const footprints: Footprints = { ...FOOTPRINTS, kernels: [{ pid: 62440, root: DEV, session: CRAWL, pids: 1, bytes: GB, biggest: null }, { pid: 88454, root: BOOT, session: BOOT, pids: 2, bytes: GB, biggest: null },
    { pid: 41785, root: DEV, session: "held", pids: 2, bytes: GB, biggest: null }],
    handles: [{ pid: 99165, kernel: 88454, session: BOOT, command: "cd rulefix/chk9/ && bash -e step.sh", age_s: 1800 }, { pid: 78004, kernel: 41785, session: "held", command: "python3 sampler.py", age_s: 3300 }] };
  const dataDir = join(dir, "data");
  const sent: [string, string][] = [];
  const source = { dataDir, rows: () => rows, chats: async () => new Set([DEV]), title: () => null, queue: async () => QUEUE, log: () => {}, footprints: async () => footprints,
    feed: async () => null, now: () => now, notify: async (chat: string, text: string) => { sent.push([chat, text]); }, message: async (root: string, text: string) => { sent.push([root, text]); } };
  const line = (await sample(source))!;
  assert.equal(line.idleOver, 3, "a session in one long call still counts as quiet: its kernel and worker stay pinned and pi-pool frees only its slot");
  assert.deepEqual(line.quiet, [
    { session: CRAWL, job: "wp-engage-crawl", root: DEV, tree: "**** main dev thread ***", quietMin: 56, kernel: 62440,
      call: { id: "toolu_01Pa", tool: "ipython", at: "2026-10-15T01:27:59.784Z", code: "async def batch_item_ids(bid, index=None):" } },
    { session: BOOT, job: "air boot daemons", root: BOOT, tree: "air boot daemons", quietMin: 30, kernel: 88454,
      call: { id: "toolu_011c", tool: "ipython", at: "2026-10-15T01:53:55.285Z", code: "r=await bash(f'cd {Q} && bash -e step.sh')" }, handle: "cd rulefix/chk9/ && bash -e step.sh" },
    { session: "held", job: "m2 air docker swap", root: DEV, tree: "**** main dev thread ***", quietMin: 51, kernel: 41785, call: null }]);
  assert.deepEqual(line.waiters!.map(waiter => [waiter.pid, waiter.quietMin]), [[78004, 51]], "a handle a running call awaits is no turn-end handle; the call's ask names it");
  assert.deepEqual(sent, [], "no chat or thread is asked about its call or handle");
  await sample({ ...source, now: () => now + MIN });
  await writeFile(crawlFile, toolCall("toolu_02Nx", "2026-10-15T01:58:00.000Z", "await pull(next_brand)") + "\n", { flag: "a" });
  await sample({ ...source, now: () => now + 2 * MIN });
  assert.deepEqual(sent, []);

  const { flagged } = measure(await readWatch(dataDir, now - 60 * MIN, now + 3 * MIN), now + 3 * MIN);
  const calls = flagged!.filter(item => item.kind === "open_call");
  assert.deepEqual(calls.map(item => [item.item, item.excerpt.match(/since (\d\d:\d\dZ) with no model call for (\d+) min/)?.slice(1)]),
    [[CRAWL, ["01:27Z", "57"]], [BOOT, ["01:53Z", "32"]], [CRAWL, ["01:58Z", "58"]]], "one flag per call, at its last sighting");
  assert.equal(calls[0]!.excerpt, "**** main dev thread ***, job wp-engage-crawl (session 01a0f7cb): one ipython call since 01:27Z with no model call for 57 min, " +
    "`async def batch_item_ids(bid, index=None):`.");
  assert.match(flagged!.find(item => item.kind === "top_miss")!.excerpt, /^Top miss: working sessions quiet over 30 min in 3 of 3 minutes\. .* Quiet sessions at \d\d:\d\d: wp-engage-crawl \(01a0f7cb, \*\*\*\* main dev thread \*\*\*\) quiet 58 min, open ipython call since 01:58Z; air boot daemons \(01a13b45, air boot daemons\) quiet 32 min, open ipython call since 01:53Z; m2 air docker swap \(held, \*\*\*\* main dev thread \*\*\*\) quiet 53 min, no open tool call\.$/);
  assert.match(flagged!.find(item => item.kind === "now")!.excerpt, /3 quiet over 30 min \(wp-engage-crawl \(01a0f7cb, .*\) quiet 58 min, open ipython call since 01:58Z; /);
});

test("measure: an unusable minute with more than 14 agent turns working or 16 GB in Prime workers is the harness's, one under both names the feed's largest owners", () => {
  assert.deepEqual([HARNESS_TURNS, HARNESS_GB], [14, 16]);
  const owners = [{ owner: "browser:chrome", label: "Google Chrome", gb: 6.5 }, { owner: "chat:01a1164b", label: "AI harness", gb: 2.2 }, { owner: "pm2:virev-demo", label: "virev-demo", gb: 2.1 }];
  const queue = (working: number) => ({ working, queued: 30, held: 0, pressure: "critical", oldestWaitS: 60, oldestTree: null });
  const lines = [watch(40, { usable: { ...thrash, owners }, queue: queue(22) }), watch(41, { usable: { ...thrash, owners }, queue: queue(15) }),
    watch(42, { usable: { ...thrash, owners }, queue: queue(14) }), watch(43, { queue: queue(20) }), watch(44, { usable: thrash, queue: queue(3), workerGb: 25.9 })];
  const { metrics, flagged } = measure(lines, NOW);
  assert.equal(metrics.harness_unusable_min_1h, 3, "22 and 15 turns, and 25.9 GB of workers at 3 turns; 20 turns on a usable minute counts nowhere");
  assert.equal(metrics.other_unusable_min_1h, 1);
  assert.equal(metrics.usable_pct_1h, 20);
  assert.match(flagged!.find(item => item.kind === "harness_side")!.excerpt, /^3 unusable minutes had more than 14 agent turns working or more than 16 GB in Prime workers \(\d\d:\d\d 22 turns, pi-pool critical, 2 workers 4 GB, 10 live sessions; .*\d\d:\d\d 3 turns, pi-pool critical, 2 workers 25\.9 GB/);
  assert.equal(flagged!.find(item => item.kind === "other_side")!.excerpt,
    "1 unusable minutes had 14 or fewer agent turns working and 16 GB or less in Prime workers; the feed's largest owners then: Google Chrome 6.5 GB (app or owner), AI harness 2.2 GB (harness), virev-demo 2.1 GB (app or owner).");
  const feed = parseFeed({ ...FEED, owners: Array.from({ length: 12 }, (_, i) => ({ owner: `other:p${i}`, label: `p${i}`, mem_gb: i, cpu_pct: 0, procs: 1 })) }, NOW)!;
  assert.deepEqual(feed.owners!.map(owner => owner.gb), [11, 10, 9, 8, 7, 6, 5, 4], "the feed's 8 largest owners, largest first");
});


// 10-15: wp-engage-crawl (01a0f7cb, kernel 62440) sat in one ipython cell from 01:27:59Z to 02:26:27Z and in the next from 02:26:36Z to 03:26:08Z.
// Both were slow paging pulls, not hangs: at 03:23-03:24Z the kernel opened a new TLS connection to 64.34.205.245 every 5 s and used 22 to 27 s
// of CPU a minute, and both cells returned their results. A kernel held in a read that never returns used 2.0 ms a minute.
const PULL_CELLS = [{ id: "toolu_01Qmnyp3Gp6NjqY7sAmrtRXM", at: "2026-10-15T01:27:59.784Z", code: "async def batch_item_ids(bid, index=None):" },
  { id: "toolu_01HYopDK8S7Wjt4BHASMiU5s", at: "2026-10-15T02:26:36.327Z", code: "for t in ['lysbeautyofficial', 'houseofhur_official', 'tooq.official', 'laka.official', 'therealreal', 'erborian']:" }];
const PULL_PORTS = [56640, 56761, 56779, 56787, 56793, 56795, 56810];
const HUNG_SOCKET = "tcp4 127.0.0.1:57498<->127.0.0.1:57497,0,149";

async function crawlWatch(cell: (typeof PULL_CELLS)[number], kernelAt: (minute: number) => { cpuMs: number; sockets: string[] }) {
  const dir = await mkdtemp(join(tmpdir(), "mac-usable-motion-"));
  const file = join(dir, "crawl.jsonl");
  await writeFile(file, toolCall(cell.id, cell.at, cell.code) + "\n");
  const sent: [string, string][] = [];
  const logs: string[] = [];
  let minute = 0;
  const start = Date.parse(cell.at) + 1_000;
  const rows = () => [row(DEV, { sessionName: "**** main dev thread ***", workerPid: 48062 }),
    row(CRAWL, { parentSessionId: DEV, sessionName: "wp-engage-crawl", activity: "working", workerPid: 48062, lastActivityAt: cell.at, sessionFile: file })];
  const source = { dataDir: join(dir, "data"), rows, chats: async () => new Set([DEV]), title: () => null, queue: async () => QUEUE, log: (text: string) => { logs.push(text); },
    footprints: async (): Promise<Footprints> => ({ ...FOOTPRINTS, kernels: [{ pid: 62440, root: DEV, session: CRAWL, pids: 1, bytes: GB, biggest: null, cpu_ms: kernelAt(minute).cpuMs, members: [62440] }] }),
    sockets: async (pids: readonly number[]) => new Map(pids.map(pid => [pid, kernelAt(minute).sockets])),
    feed: async () => null, now: () => start + minute * MIN,
    notify: async (chat: string, text: string) => { sent.push([chat, text]); } };
  const lines: WatchLine[] = [];
  const run = async (until: number) => { for (; minute <= until; minute++) lines.push((await sample(source))!); };
  return { run, lines, sent, logs, dataDir: source.dataDir, at: (m: number) => start + m * MIN };
}

test("motion: a kernel moved when its CPU changed by MOTION.cpuMs, a process started or ended, or a socket moved bytes; the first or a stale reading is no baseline", () => {
  const kernel = (cpu_ms: number, members = [62440]) => [{ pid: 62440, root: DEV, session: CRAWL, pids: members.length, bytes: GB, biggest: null, cpu_ms, members }];
  const first = advanceMotion({}, kernel(1000), new Map(), NOW);
  assert.deepEqual(first[CRAWL], { kernel: 62440, at: NOW, cpuMs: 1000, members: [62440], net: null, moved: null, stillSince: NOW });
  const hung = advanceMotion(first, kernel(1002), new Map([[CRAWL, HUNG_SOCKET]]), NOW + MIN);
  assert.deepEqual([hung[CRAWL]!.moved, hung[CRAWL]!.stillSince], [false, NOW], "2.0 ms a minute, the measured hung read, is still");
  assert.equal(advanceMotion(hung, kernel(1004), new Map([[CRAWL, HUNG_SOCKET]]), NOW + 2 * MIN)[CRAWL]!.stillSince, NOW, "the same socket with the same bytes is still");
  assert.equal(advanceMotion(hung, kernel(1004), new Map([[CRAWL, HUNG_SOCKET.replace(",0,149", ",512,149")]]), NOW + 2 * MIN)[CRAWL]!.moved, true, "bytes on the socket");
  assert.equal(advanceMotion(hung, kernel(1004, [62440, 70001]), new Map(), NOW + 2 * MIN)[CRAWL]!.moved, true, "a process started");
  assert.equal(advanceMotion(first, kernel(1000 + 22_376), new Map(), NOW + MIN)[CRAWL]!.moved, true, "the 03:24Z pull's 22 s a minute");
  assert.deepEqual([3.7, 5, 17.5].map(ms => advanceMotion(first, kernel(1000 + ms), new Map(), NOW + MIN)[CRAWL]!.moved), [false, false, true],
    "the most a still kernel used in a minute on 10-15, and the least a kernel at work used");
  assert.equal(advanceMotion(first, kernel(1002), new Map(), NOW + MOTION.freshMs + 1)[CRAWL]!.moved, null, "a stale reading is no baseline");
  assert.deepEqual(advanceMotion(first, [{ ...kernel(5)[0]!, pid: 99 }], new Map(), NOW + MIN)[CRAWL]!.moved, null, "a new kernel for the session is no baseline");
  assert.deepEqual(advanceMotion(first, [{ pid: 1, root: DEV, session: CRAWL, pids: 1, bytes: GB, biggest: null }], new Map(), NOW + MIN), {}, "an older helper gives no CPU");
  assert.deepEqual(parseNettop(",bytes_in,bytes_out,\npython3.11.62440,5028,1981,\ntcp4 192.168.0.3:56640<->64.34.205.245:443,5028,1981,\nGoogle Chrome H.812,9,9,\nudp4 *:5353<->*:*,9,9,\n"),
    new Map([[62440, ["tcp4 192.168.0.3:56640<->64.34.205.245:443,5028,1981"]], [812, ["udp4 *:5353<->*:*,9,9"]]]));
});

test("slow but active: both wp-engage-crawl pulls of 10-15 count as working, not quiet, and the chat is sent nothing", async () => {
  for (const cell of PULL_CELLS) {
    const watch = await crawlWatch(cell, minute => ({ cpuMs: 1_000 + minute * 22_376, sockets: [`tcp4 192.168.0.3:${PULL_PORTS[minute % PULL_PORTS.length]}<->64.34.205.245:443,5028,1981`] }));
    await watch.run(58);
    const late = watch.lines.slice(31);
    assert.ok(late.every(line => line.idleOver === 0 && line.quiet!.length === 0 && line.active!.length === 1), "no idle minute past 30 min");
    assert.deepEqual(late.filter(line => misses(line).includes("idle")), [], "no idle miss for d6");
    assert.equal(late.at(-1)!.active![0]!.stillMin, 0);
    assert.deepEqual(watch.sent, []);
    const { flagged } = measure(await readWatch(watch.dataDir, watch.at(0), watch.at(58)), watch.at(58));
    assert.match(flagged!.find(item => item.kind === "open_call")!.excerpt, /`\.$/);
  }
  const quiet = await crawlWatch(PULL_CELLS[0]!, minute => ({ cpuMs: 1_000 + minute * 2, sockets: [HUNG_SOCKET] }));
  await quiet.run(31);
  assert.equal(quiet.lines.at(-1)!.idleOver, 1, "the same cell with a still kernel counts as quiet");
});

test("hung: a cell whose kernel used no CPU, no new process and no socket bytes for HUNG_MINUTES is quiet and named hung in the duty, and the chat is sent nothing", async () => {
  const watch = await crawlWatch(PULL_CELLS[1]!, minute => ({ cpuMs: 1_000 + minute * 2, sockets: [HUNG_SOCKET] }));
  await watch.run(29);
  assert.equal(watch.lines.at(-1)!.idleOver, 0, "under TARGET.idleMinutes: no idle minute");
  await watch.run(33);
  assert.deepEqual([watch.lines[30]!.idleOver, watch.lines[30]!.quiet![0]!.stillMin, watch.lines[30]!.quiet![0]!.quietMin], [1, 30, 30]);
  assert.deepEqual(watch.sent, []);
  const { flagged } = measure(await readWatch(watch.dataDir, watch.at(0), watch.at(33)), watch.at(33));
  assert.match(flagged!.find(item => item.kind === "open_call")!.excerpt, /; its kernel has not moved for 33 min\.$/);

  const woke = await crawlWatch(PULL_CELLS[1]!, minute => ({ cpuMs: 1_000 + minute * 2, sockets: [minute >= 31 ? HUNG_SOCKET.replace(",0,149", ",4096,149") : HUNG_SOCKET] }));
  await woke.run(32);
  assert.deepEqual([woke.lines[31]!.idleOver, woke.lines.at(-1)!.quiet![0]!.stillMin], [0, 1], "bytes at 31 count as working; still again from 31 is a new spell");
});
