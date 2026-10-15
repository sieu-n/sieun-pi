import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { type Footprints, guardTrees, type RawKernel, type RawOrphan, readFootprints, readStrays, sample, STOP_RULE, TREE_SHARE, type TreeMemory, watchLine } from "../src/mac-usable-watch.ts";
import type { ChildAgent, ThreadMessage } from "../src/shared/types.ts";
import { fakeThreads, source } from "./chats-helpers.ts";

/**
 * 10-15 00:37 to 00:53Z: the VP of SEO tree grew to 16 to 25.5 GiB and the Mac swapped at up to 25,873 swapouts a second. old_analysis.py (pid
 * 77405, 30.26 GB at its peak) ran under a nohup'd runner.py that the job 'seo data memory fix' started; the chat deleted the job at about
 * 00:45Z and the runner went on. The minute series below are the shared tree guard contract's (~/.cache/virev/tree-guard-contract.md).
 */
const GB = 1024 ** 3;
const MIN = 60_000;
const RAM = 32 * GB;
const SEO = "01a11a24-a46e-77ff-adf7-671d01d462e2";
const SEO_JOB = "01a13a00-0000-7000-8000-5e0da7a00001";
const KERNEL = 4242;
const SEO_SERIES: [string, number, number][] = [["00:39", 0, 19.53], ["00:40", 25873.3, 25.51], ["00:41", 14049.7, 16.12], ["00:42", 5790.5, 16.7], ["00:43", 1149.2, 20.84],
  ["00:44", 7402.2, 14.32], ["00:45", 15955.7, 21.66], ["00:46", 8349.6, 24.02], ["00:47", 14496.5, 16.45], ["00:48", 16891.7, 25.52], ["00:49", 19797.7, 16.06],
  ["00:50", 13866.2, 21.6], ["00:51", 14079.4, 23.64]];
const STARTED = 1792024560;

/** A minute of the SEO tree: the chat's kernel (1 GiB with a 0.5 GiB vite under it), the orphaned runner.py, and old_analysis.py holding the rest. */
function seoFootprints(gb: number): Footprints {
  const kernel: RawKernel = { pid: KERNEL, root: SEO, session: SEO, pids: 2, bytes: 1 * GB,
    biggest: { pid: 5000, bytes: 0.5 * GB, started: STARTED - 3600, command: "node vite dev --port 5189" } };
  const orphan = (pid: number, bytes: number, command: string): RawOrphan => ({ pid, bytes, started: STARTED, command, root: SEO, session: SEO_JOB });
  return { workers: { 11: { pids: 6, bytes: gb * GB + 0.3 * GB } }, kernels: [kernel],
    orphans: [orphan(77400, 0.02 * GB, "python3 runner.py"), orphan(77405, (gb - 1.02) * GB, "python3 old_analysis.py --all")], swap_used_bytes: 20 * GB, pressure_level: 2, cpu_s: 0.2 };
}
const at = (clock: string) => Date.parse(`2026-10-15T${clock}:00Z`);
const rowOf = (sessionId: string, extra: Record<string, unknown> = {}) => ({ sessionId, activeSessionId: `a-${sessionId}`, lifecycle: "live", activity: "idle",
  lastActivityAt: new Date(at("00:30")).toISOString(), workerPid: 11, ...extra });

function harness(dataDir: string, root: string) {
  const sent: [string, string][] = [];
  const kills: [number, string][] = [];
  const logs: string[] = [];
  const pending: (() => void)[] = [];
  const alive = new Map<number, number>([[77405, STARTED], [77400, STARTED]]);
  const guard = { dataDir, ramBytes: RAM, log: (text: string) => { logs.push(text); },
    notify: async (chat: string, text: string) => { sent.push([chat, text]); },
    kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => { kills.push([pid, signal]); },
    processStart: async (pid: number) => alive.get(pid) ?? null,
    later: (run: () => void, ms: number) => { assert.equal(ms, STOP_RULE.killAfterMs); pending.push(run); } };
  return { sent, kills, logs, pending, alive, guard, chats: new Set([root]) };
}

test("SEO 10-15: the tree is over the share from 00:39, its root is asked once at 00:39, and at 00:44 old_analysis.py (pid 77405) gets SIGTERM, then SIGKILL 10 s on; never the kernel", async () => {
  assert.equal(TREE_SHARE, 0.25);
  assert.deepEqual(STOP_RULE, { hits: 3, of: 5, killAfterMs: 10_000 });
  const dir = await mkdtemp(join(tmpdir(), "tree-guard-seo-"));
  const memory = join(dir, "virev", "tree-memory.json");
  const run = harness(dir, SEO);
  const stops: [string, number][] = [];
  for (const [clock, swapouts, gb] of SEO_SERIES) {
    const line = await sample({ ...run.guard, rows: () => [rowOf(SEO, { sessionName: "VP of SEO" })], chats: async () => run.chats, title: () => null,
      queue: async () => ({ working: [], queued: [] }), footprints: async () => seoFootprints(gb), now: () => at(clock), treeMemoryFile: memory,
      feed: async () => ({ pressureLevel: 2, swapoutsPerS: swapouts, kernelTaskPct: 50 }) });
    assert.deepEqual(line!.trees![0]!.root, SEO);
    assert.equal(line!.trees![0]!.gb, gb, `${clock}: the kernel's subtree plus both orphans`);
    assert.equal(line!.trees![0]!.biggest!.pid, 77405);
    for (const stop of line!.stops ?? []) stops.push([clock, stop.pid]);
    const file = JSON.parse(await readFile(memory, "utf8")) as TreeMemory;
    assert.deepEqual([file.v, file.ts, file.ram_gb, file.share, file.over.map(tree => [tree.root, tree.tree, tree.gb, tree.pid])],
      [1, new Date(at(clock)).toISOString(), 32, 0.25, [[SEO, "VP of SEO", gb, 77405]]]);
    if (clock === "00:39") assert.equal(run.sent.length, 1, "asked at 00:39: over the share with the feed at warn");
    if (clock === "00:43") assert.deepEqual(run.kills, [], "2 of the last 5 minutes so far");
    if (clock === "00:44") {
      assert.deepEqual(run.kills, [[77405, "SIGTERM"]], "00:40, 00:41 and 00:44");
      run.pending.splice(0).forEach(next => next());
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(run.kills, [[77405, "SIGTERM"], [77405, "SIGKILL"]], "same start time 10 s on: SIGKILL");
    }
  }
  assert.deepEqual(stops, [["00:44", 77405]], "stopped once, and the line records it");
  assert.ok(!run.kills.some(([pid]) => pid === KERNEL || pid === 77400), "never the kernel, never a smaller process");
  assert.equal(run.sent.length, 2, "one ask per (root, biggest pid) and one stop line");
  assert.match(run.sent[0]![1], /^\[job\] The VP of SEO tree holds 19\.5 GiB, over the 8\.0 GiB .*level 2, 0 swapouts .* pid 77405 `python3 old_analysis\.py --all` at 18\.5 GiB\. Stop it or run it in chunks/);
  assert.match(run.sent[1]![1], /^\[job\] The service stopped pid 77405 `python3 old_analysis\.py --all` \(13\.3 GiB\) in the VP of SEO tree: .* 3 of the last 5 minutes\. A runner that started it may start more/);
  assert.ok(run.logs.some(text => /SIGTERM pid 77405/.test(text)) && run.logs.some(text => /SIGKILL pid 77405/.test(text)), run.logs.join("\n"));
});

test("SEO 10-15: a pid whose start time changed is not signalled, and a process gone after SIGTERM gets no SIGKILL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tree-guard-reuse-"));
  const run = harness(dir, SEO);
  const lineAt = (clock: string, swapouts: number, gb: number) => watchLine({ now: at(clock), rows: [rowOf(SEO, { sessionName: "VP of SEO" })], footprints: seoFootprints(gb),
    queue: null, chats: run.chats, title: () => null, cpuMs: 0, usable: { pressureLevel: 2, swapoutsPerS: swapouts, kernelTaskPct: 50 } });
  run.alive.set(77405, STARTED + 1);
  for (const [clock, swapouts, gb] of SEO_SERIES.slice(0, 6)) await guardTrees(run.guard, lineAt(clock, swapouts, gb), run.chats, at(clock));
  assert.deepEqual(run.kills, [], "the pid now names another process");
  const again = await mkdtemp(join(tmpdir(), "tree-guard-gone-"));
  const next = harness(again, SEO);
  for (const [clock, swapouts, gb] of SEO_SERIES.slice(0, 6)) await guardTrees(next.guard, lineAt(clock, swapouts, gb), next.chats, at(clock));
  next.alive.delete(77405);
  next.pending.splice(0).forEach(go => go());
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(next.kills, [[77405, "SIGTERM"]]);
});

test("09:11 KST 10-15: search visits grow SEO guy's tree is asked once and nothing is stopped (1 of 5 minutes over the share with 6,000 swapouts)", async () => {
  const root = "01a13ce0-9f35-763b-a2c8-fe74c2e7fde4";
  const series: [string, number, number][] = [["00:10", 0, 2.27], ["00:11", 11823.7, 9.29], ["00:12", 481, 8.09], ["00:13", 0, 2.16], ["00:14", 0, 9.07], ["00:15", 0, 3.03]];
  const dir = await mkdtemp(join(tmpdir(), "tree-guard-0911-"));
  const run = harness(dir, root);
  const overs: number[] = [];
  for (const [clock, swapouts, gb] of series) {
    const footprints: Footprints = { workers: { 11: { pids: 3, bytes: gb * GB } }, swap_used_bytes: 10 * GB, pressure_level: 2, cpu_s: 0.1,
      kernels: [{ pid: 700, root, session: root, pids: 2, bytes: gb * GB, biggest: { pid: 77405, bytes: (gb - 0.2) * GB, started: STARTED, command: "python3 visits.py" } }] };
    const line = await sample({ ...run.guard, rows: () => [rowOf(root, { sessionName: "search visits grow SEO guy" })], chats: async () => run.chats, title: () => null,
      queue: async () => ({ working: [], queued: [] }), footprints: async () => footprints, now: () => at(clock), treeMemoryFile: join(dir, "tree-memory.json"),
      feed: async () => ({ pressureLevel: 2, swapoutsPerS: swapouts, kernelTaskPct: 20 }) });
    overs.push((JSON.parse(await readFile(join(dir, "tree-memory.json"), "utf8")) as TreeMemory).over.length);
    assert.equal(line!.stops, undefined);
  }
  assert.deepEqual(overs, [0, 1, 1, 0, 1, 0], "8.09 GiB is over 8; 2.27 is not");
  assert.deepEqual(run.kills, []);
  assert.equal(run.sent.length, 1);
  assert.match(run.sent[0]![1], /^\[job\] The search visits grow SEO guy tree holds 9\.3 GiB, .* 11824 swapouts a second\)\. Its biggest process is pid 77405/);
});

test("an orphan with the SEO env counts against the SEO tree: a real detached process the helper finds under no worker, and the watch line adds it to VP of SEO", async () => {
  const job = `01a1ffff-0000-7000-8000-${String(process.pid).padStart(12, "0")}`;
  const state = join(homedir(), ".prime", "agent", "session-artifacts", SEO, "sub-test", "session-artifacts", job, "harness");
  const shell = spawn("/bin/sh", ["-c", `"$0" -e "setTimeout(() => {}, 6000)" & exit 0`, process.execPath], { env: { ...process.env, RLM_HARNESS_STATE_DIR: state }, stdio: "ignore" });
  await new Promise(resolve => shell.once("exit", resolve));
  const measured = await readFootprints([process.pid]);
  const orphan = measured.orphans!.find(entry => entry.session === job);
  assert.ok(orphan, JSON.stringify(measured.orphans));
  assert.equal(orphan.root, SEO);
  assert.equal(orphan.command, `${process.execPath} -e setTimeout(() => {}, 6000)`);
  assert.ok(orphan.started! > Date.now() / 1000 - 60);
  assert.ok(measured.cpu_s < 1, `the helper costs ${measured.cpu_s} s of CPU`);
  const strays = await readStrays(job);
  assert.deepEqual(strays.map(stray => stray.pid), [orphan.pid], "the delete notice's reader finds it by its session");
  const footprints: Footprints = { ...seoFootprints(20), orphans: [{ ...orphan, bytes: 12 * GB }] };
  const line = watchLine({ now: at("00:45"), rows: [rowOf(SEO, { sessionName: "VP of SEO" }), rowOf("other", { sessionName: "ops guy" })], footprints, queue: null,
    chats: new Set([SEO]), title: () => null, cpuMs: 0 });
  assert.deepEqual(line.trees, [{ root: SEO, tree: "VP of SEO", gb: 13, biggest: { pid: orphan.pid, gb: 12, started: orphan.started, command: orphan.command } }],
    "the deleted job's session is no row, so its env root names the tree");
});

test("a deleted job's notice names the processes its kernel started detached, with pid, command and GiB, and kills nothing", async () => {
  const NOW = Date.parse("2026-10-15T00:45:00Z");
  const dir = await mkdtemp(join(tmpdir(), "tree-guard-delete-"));
  const calls: string[] = [];
  const lines: string[] = [];
  const asked: string[] = [];
  const threads = fakeThreads(calls);
  const done: ChildAgent = { id: "sub-1", label: "seo data memory fix", sessionName: "seo data memory fix", sessionId: SEO_JOB, status: "done", repliedSinceTask: true, lastActivityAt: NOW - MIN };
  threads.transcripts.set(SEO, [{ role: "custom", customType: "agent_message", content: "[agent-message from child:seo data memory fix]\nDone, runner started.", display: true,
    timestamp: NOW - MIN } as ThreadMessage]);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add(SEO);
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, {}, () => NOW), strays: async session => { asked.push(session); return [{ pid: 77400, bytes: 0.02 * GB, started: STARTED, command: "python3 runner.py" },
      { pid: 77405, bytes: 27 * GB, started: STARTED, command: "python3 old_analysis.py --all" }]; } }, line => lines.push(line));
  await chats.adopt();
  threads.fire().live(SEO, [{ ...done, status: "running", activity: { kind: "executing", toolName: "ipython" } }]);
  threads.fire().children(SEO, [done]);
  await chats.settled();
  assert.deepEqual(asked, [SEO_JOB], "read once, for the job's session, before the delete");
  assert.deepEqual(calls.filter(call => call.startsWith("delete")), [`delete ${SEO} sub-1`]);
  const notice = calls.find(call => call.startsWith(`notice ${SEO}`));
  assert.equal(notice, `notice ${SEO} [job] seo data memory fix was deleted. Processes its kernel started detached still run: pid 77400 \`python3 runner.py\` (0.0 GiB), ` +
    "pid 77405 `python3 old_analysis.py --all` (27.0 GiB). Stop them if its work is done.");
  assert.ok(lines.some(line => line.includes("left detached processes running: 77400, 77405")), lines.join("\n"));
  chats.close();
});
