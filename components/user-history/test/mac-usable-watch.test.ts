import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseAgentQueue } from "../src/chat-pool.ts";
import { sharedQueueRead } from "../src/chat-turn-queue.ts";
import { askWaiters, type Footprints, misses, parseFeed, PRESSURE_FEED, readFootprints, readPressureFeed, readWatch, sample, TARGET, unusable, USABLE, watchFile, watchLine, type WatchLine } from "../src/mac-usable-watch.ts";
import { parseDutyInput } from "../src/shared/chat-duties.ts";
import { longestOffStreak, measure, OFF_STREAK_ALERT } from "../scripts/duties/mac-stays-usable.ts";

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
const QUEUE = { working: [{ session: "chatA", tree: "chatA", parent: null, priority: "high" as const, since: NOW - 60_000 }],
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
  assert.deepEqual(metrics, { usable_pct_1h: 75, usable_pct_24h: 73.7, unusable_streak_max_1h: 14, idle_miss_min_1h: 12, queue_miss_min_1h: 0, kernel_waiters_1h: 0 },
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
  assert.deepEqual(measure([], NOW), { metrics: { unusable_streak_max_1h: 0, idle_miss_min_1h: 0, queue_miss_min_1h: 0, kernel_waiters_1h: 0 },
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

test("waiters: the helper's pattern takes both 10-14 kernel waits and not plain commands; the line names each one's job and chat; each chat is asked once per pid, a thread never, and the duty lists both", async () => {
  const helper = join(import.meta.dirname, "../src/worker-footprint.py");
  const matched = execFileSync("/usr/bin/python3", ["-B", "-c", `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("wf", sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps([bool(m.WAITER.search(c)) for c in json.loads(sys.argv[2])]))`, helper, JSON.stringify([...WAITERS.map(waiter => waiter.command), "sleep 600", "sleep 5",
    "/bin/sh ci-run-status.sh 38579579684", "gh run view 38589314491 --json conclusion", "gh pr checks 12 --watch"])], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(matched), [true, true, true, false, false, false, true]);
  const line = watchLine({ now: NOW, rows: WAITER_ROWS, footprints: { ...FOOTPRINTS, waiters: WAITERS }, queue: null, chats: new Set(["lmb"]), title: () => null, cpuMs: 0 });
  assert.deepEqual(line.waiters!.map(waiter => [waiter.pid, waiter.tree, waiter.job, waiter.ageMin]),
    [[12634, "***launch main bro***", "watch read errors", 6], [25528, "**** main dev thread ***", "wp-engage-crawl", 71]]);
  const dir = await mkdtemp(join(tmpdir(), "mac-usable-waiters-"));
  await mkdir(join(dir, "mac-usable"), { recursive: true });
  const sent: [string, string][] = [];
  const source = { dataDir: dir, log: () => {}, notify: async (chat: string, text: string) => { sent.push([chat, text]); } };
  assert.deepEqual(await askWaiters(source, line.waiters!, new Set(["lmb"]), NOW), ["64730"], "with no thread sender only launch main bro is asked, keyed by the kernel");
  assert.match(sent[0]![1], /^\[job\] watch read errors \(session 01a13918\) holds its kernel and worker in `.*gh run watch 38589314491 --interval 180` \(pid 12634\) for 6 min\. .*board\.wake/);
  assert.deepEqual(await askWaiters(source, line.waiters!, new Set(["lmb"]), NOW + MIN), [], "asked once per kernel");
  const nextRound = line.waiters!.map(waiter => ({ ...waiter, pid: waiter.pid + 1 }));
  assert.deepEqual(await askWaiters(source, nextRound, new Set(["lmb"]), NOW + 2 * MIN), [], "a loop's next sleep in the same kernel is not asked again");
  assert.deepEqual(await askWaiters(source, [], new Set(["lmb"]), NOW + 63 * MIN), []);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "mac-usable", "waiters-asked.json"), "utf8")), {}, "a kernel with no waiter for an hour leaves the record");
  const { metrics, flagged } = measure([watch(59, { waiters: line.waiters! })], NOW);
  assert.equal(metrics.kernel_waiters_1h, 2);
  assert.deepEqual(flagged!.filter(item => item.kind === "kernel_waiter").map(item => item.item), ["12634", "25528"]);
});

test("waiters: a plain thread's waiter pins its worker too, so its root gets the line as a daemon message, once per kernel (10-14 15:38Z: pid 72541, sleep 2280 in secrets-cutover under 'api portal figure out how identity work')", async () => {
  const rows = [row("01a0f6ae-849d-76ed-9889-ffc86a5d4de1", { sessionName: "api portal figure out how identity work", workerPid: 48062 }),
    row("01a0f80d-3003-75be-8b62-f17a48d8f716", { parentSessionId: "01a0f6ae-849d-76ed-9889-ffc86a5d4de1", sessionName: "secrets-cutover", activity: "working", workerPid: 48062 })];
  const waiters = [{ pid: 72541, kernel: 9001, session: "01a0f80d-3003-75be-8b62-f17a48d8f716", command: "sleep 2280", age_s: 1260 }];
  const line = watchLine({ now: NOW, rows, footprints: { ...FOOTPRINTS, waiters }, queue: null, chats: new Set(["lmb"]), title: () => null, cpuMs: 0 });
  const dir = await mkdtemp(join(tmpdir(), "mac-usable-thread-"));
  await mkdir(join(dir, "mac-usable"), { recursive: true });
  const noticed: string[] = [];
  const messaged: [string, string][] = [];
  let fail = true;
  const logs: string[] = [];
  const source = { dataDir: dir, log: (text: string) => { logs.push(text); }, notify: async (chat: string) => { noticed.push(chat); },
    message: async (root: string, text: string) => { if (fail) throw new Error("the thread is not loaded"); messaged.push([root, text]); } };
  assert.deepEqual(await askWaiters(source, line.waiters!, new Set(["lmb"]), NOW), [], "a failed ask is not marked asked");
  assert.deepEqual(await askWaiters(source, line.waiters!, new Set(["lmb"]), NOW + MIN), []);
  assert.equal(logs.length, 1, "its failure is logged once");
  fail = false;
  assert.deepEqual(await askWaiters(source, line.waiters!, new Set(["lmb"]), NOW + 2 * MIN), ["9001"]);
  assert.deepEqual(await askWaiters(source, line.waiters!, new Set(["lmb"]), NOW + 3 * MIN), [], "asked once per kernel");
  assert.deepEqual(noticed, [], "a thread gets no chat notice");
  assert.equal(messaged.length, 1);
  assert.equal(messaged[0]![0], "01a0f6ae-849d-76ed-9889-ffc86a5d4de1");
  assert.match(messaged[0]![1], /^\[job\] secrets-cutover \(session 01a0f80d\) holds its kernel and worker in `sleep 2280` \(pid 72541\) for 21 min\. .*board\.wake/);
});

// 10-14 21:29:58Z: the job 'm2 air docker swap' under ops guy ended its turn with a 3 h sampler (pid 78004) still in a bash() handle, so the
// daemon kept it working and 20 minutes of 22:00-22:20Z missed the idle part with no ask, since no WAITER pattern took it.
test("held handles: a bash() handle of a session quiet past TARGET.idleMinutes is a waiter whose chat is asked to run it detached with board.wake; a fresh session's handle is not", async () => {
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
  const dir = await mkdtemp(join(tmpdir(), "mac-usable-held-"));
  await mkdir(join(dir, "mac-usable"), { recursive: true });
  const sent: [string, string][] = [];
  assert.deepEqual(await askWaiters({ dataDir: dir, log: () => {}, notify: async (chat, text) => { sent.push([chat, text]); } }, line.waiters!, new Set(["ops"]), NOW), ["8", "41785"]);
  assert.match(sent[1]![1], /^\[job\] m2 air docker swap \(session 01a13c3d\) ended its turn 51 min ago and still holds its kernel and worker in a bash\(\) handle running `nice -n 20 python3 evidence\/sampler\.py .*` \(pid 78004\) for 55 min\. .*nohup .*board\.wake\(at=/);
  assert.match(measure([watch(59, { waiters: line.waiters! })], NOW).flagged!.find(item => item.item === "78004")!.excerpt, /a bash\(\) handle held 51 min past its turn end; the chat was asked/);
});

test("mac-stays-usable.duty.json: a valid duty every 60 minutes whose metrics the precheck gives, with the owner's words verbatim", async () => {
  const value = JSON.parse(await readFile(join(import.meta.dirname, "../scripts/duties/mac-stays-usable.duty.json"), "utf8"));
  const duty = parseDutyInput(value, "d1", 0);
  assert.deepEqual(duty.schedule, { kind: "every", minutes: 60 });
  assert.match(duty.ownerWords, /setup a 60min cadence duty$/);
  const given = Object.keys(measure([watch(59)], NOW).metrics);
  for (const metric of duty.metrics) assert.ok(given.includes(metric.key), metric.key);
  assert.equal(duty.metrics.find(metric => metric.headline)?.key, "usable_pct_1h");
  assert.equal(duty.metrics.some(metric => /gb|footprint|budget/.test(metric.key)), false, "the worker footprint has no target");
});
