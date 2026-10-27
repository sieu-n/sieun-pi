// Guards the 10-15 21:22Z incident (25 idle workers held 20.77 GB of the 32 GB Mac) and the 10-17 21:29Z one (roots stopped and reloaded 4 times in 11 min), under c88.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { showsWork } from "../src/chat-dormancy.ts";
import { recordUnloaded, UNLOADED_FILE } from "../src/unloaded.ts";
import { type DaemonAnswer, IdleUnloader, quietWorkers, RECYCLE_OWN_BYTES, RECYCLE_QUIET_MS, recyclePlan, ENDED_MS, type UnloadRow, unloadPlan } from "../src/idle-unload.ts";

type Fixture = { takenAt: string; chats: string[]; pool: string[]; rows: SessionSummary[] };
const load = (name: string): Fixture => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")) as Fixture;
const TEN_MIN = 10 * 60_000;
const isRoot = (row: SessionSummary): boolean => (row.rlmDepth ?? 0) === 0 && row.runtimeKind !== "subagent";

// `prime-agent sessions --json` at 21:22Z on 10-15: 136 loaded sessions, 25 workers holding 20.77 GB, and the hour at 71.7% usable with 15
// harness minutes. Prime's idle sweep had not stopped idle roots: each sweep ends at the first worker that "did not stop".
const day15 = load("daemon-rows-1015-2122.json");
const at15 = Date.parse(day15.takenAt);
const plan15 = unloadPlan(day15.rows, { attached: new Set(day15.chats), pool: new Set(day15.pool), now: at15, idleMs: TEN_MIN });
/** A row with no verdict from the daemon's judge, so idleEvictionMinutes applies to it. */
const unjudged = (row: SessionSummary): SessionSummary => { const { taskState: _verdict, ...rest } = row; return rest as SessionSummary; };

test("the 10-15 rows unload the top-level jobs idle for idleEvictionMinutes with nothing running, queued or scheduled", () => {
  const roots = plan15.filter(isRoot);
  assert.ok(roots.length >= 1, `${roots.length} roots`);
  for (const row of roots) {
    assert.ok(!day15.chats.includes(row.sessionId), "never a chat the service holds attached");
    assert.ok(!day15.pool.includes(row.sessionId), "never one with a turn working or queued in pi-pool");
    assert.ok(at15 - Date.parse(row.lastActivityAt!) >= (row.taskState ? ENDED_MS : TEN_MIN));
  }
});

test("a session with a heartbeat, a client attached, a running child, a queued input or idleEvictionMinutes of quiet missing keeps its worker", () => {
  const base = unjudged(plan15.find(isRoot)!);
  const input = { attached: new Set<string>(), pool: new Set<string>(), now: at15, idleMs: TEN_MIN };
  for (const change of [{ hasRegisteredHeartbeat: true }, { hasRegisteredCronJob: true }, { attachedClients: 1 }, { hasRunningRlmChildren: true },
    { sessionActions: { queuedCount: 1, steering: [], followUps: [] } }, { activity: "working" }, { lastActivityAt: new Date(at15 - TEN_MIN + 60_000).toISOString() }] as Partial<SessionSummary>[]) {
    assert.deepEqual(unloadPlan([{ ...base, ...change } as SessionSummary], input), [], JSON.stringify(change));
  }
  assert.deepEqual(unloadPlan([base], { ...input, attached: new Set([base.sessionId]) }), [], "a chat the service holds attached stays");
  assert.deepEqual(unloadPlan([base], { ...input, idleMs: null }), [], "idle eviction off stops none");
});

// The same list at 21:33Z on 10-17: 106 resident sessions with a Python kernel each, swap at 15.3 of 16 GB, and Prime's child passivation
// sweep timing out. 57 idle subagents stayed resident inside trees that still ran, because the unload stopped only roots.
const day17 = load("daemon-rows-1017-2133.json");
const at17 = Date.parse(day17.takenAt);
const plan17 = unloadPlan(day17.rows, { attached: new Set(day17.chats), pool: new Set(day17.pool), now: at17, idleMs: TEN_MIN });
const children17 = plan17.filter(row => !isRoot(row));

test("the 10-17 rows stop each subagent idle for idleEvictionMinutes, or ENDED_MS once it replied, with nothing at work below it", () => {
  const names = new Set(children17.map(row => row.sessionName));
  for (const name of ["gap-niche-missing", "gap-secuid-missing", "grafana-c-checks", "test results in ci", "query mcp build"]) assert.ok(names.has(name), name);
  assert.ok(children17.length >= 15, `${children17.length} subagents`);
  const byId = new Map(day17.rows.map(row => [row.sessionId, row] as const));
  for (const row of children17) {
    assert.ok(at17 - Date.parse(row.lastActivityAt!) >= (row.repliedSinceTask || row.taskState ? ENDED_MS : TEN_MIN), row.sessionName);
    const below = day17.rows.filter(other => { for (let up = other.parentSessionId; up; up = byId.get(up)?.parentSessionId) if (up === row.sessionId) return true; return false; });
    assert.ok(below.every(other => other.activity === "idle"), `${row.sessionName} has a session at work below it`);
  }
});

test("a root reloaded by a message 1 to 2 minutes after it went quiet is not stopped in between", () => {
  const root = unjudged(plan15.find(isRoot)!);
  for (const quietMs of [60_000, 2 * 60_000, 4 * 60_000]) {
    assert.deepEqual(unloadPlan([{ ...root, lastActivityAt: new Date(at15 - quietMs).toISOString() }], { attached: new Set(), pool: new Set(), now: at15, idleMs: TEN_MIN }), []);
  }
});

test("a subagent with a session at work below it keeps its worker", () => {
  const child = children17[0]!;
  const input = { attached: new Set<string>(), pool: new Set<string>(), now: at17, idleMs: TEN_MIN };
  assert.equal(unloadPlan([child], input).length, 1);
  const middle = { ...child, sessionId: "below-0", activeSessionId: "below-0", parentSessionId: child.sessionId } as SessionSummary;
  const grandchild = { ...child, sessionId: "below-1", activeSessionId: "below-1", parentSessionId: "below-0", activity: "working" } as SessionSummary;
  assert.deepEqual(unloadPlan([child, middle, grandchild], input), []);
});

// `prime-agent list --json` at 23:44Z on 10-17 (sessions/2026/10/18/0844-idle-ram-unload): api portal vp, frontend bro and launch main bro sat
// detached by the service (no client) for 11.7 min, each still in its own worker, because the unload left every chat out.
test("a chat the service detached (dormant) is stopped once idle for idleEvictionMinutes, and one it holds attached is not", () => {
  const root = plan15.find(isRoot)!;
  const chat = { ...root, sessionId: "chat-0", activeSessionId: "chat-0", lastActivityAt: new Date(at15 - TEN_MIN - 42_000).toISOString() } as SessionSummary;
  const input = { attached: new Set<string>(), pool: new Set<string>(), now: at15, idleMs: TEN_MIN };
  assert.deepEqual(unloadPlan([chat], input).map(row => row.sessionId), ["chat-0"]);
  assert.deepEqual(unloadPlan([chat], { ...input, attached: new Set(["chat-0"]) }), []);
  assert.deepEqual(unloadPlan([{ ...chat, attachedClients: 1 }], input), [], "a client still attached keeps it");
});

// The daemon's rows at 00:54Z on 10-18 with each loaded worker's own footprint from src/worker-footprint.py. The AI harness VP's worker 5784
// held 1.24 GB of its own, up 5 h, while the 21 other workers held 0.32 to 0.79 GB. Two blips at 00:16Z and 00:39Z took clean_min_30 to 28.
const day18 = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "daemon-rows-1018-0054.json"), "utf8")) as Fixture & { own: Record<string, number> };
const at18 = Date.parse(day18.takenAt);
const own18 = new Map(Object.entries(day18.own).map(([pid, bytes]) => [Number(pid), bytes] as const));
const VP = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const MIN = 60_000;

test("a subagent that replied to its parent stops after ENDED_MS of quiet, and an unjudged one that did not waits idleEvictionMinutes", () => {
  const replied = day18.rows.find(row => row.runtimeKind === "subagent" && row.repliedSinceTask === true && row.activeSessionId)!;
  const input = { attached: new Set<string>(), pool: new Set<string>(), now: at18, idleMs: TEN_MIN };
  const quietFor = (row: SessionSummary, ms: number): SessionSummary => ({ ...row, activity: "idle", isSessionActive: false, isStreaming: false, isRunningTools: false,
    hasRunningRlmChildren: false, isBashRunning: false, attachedClients: 0, lastActivityAt: new Date(at18 - ms).toISOString() });
  assert.equal(ENDED_MS, 2 * MIN);
  assert.deepEqual(unloadPlan([quietFor(replied, ENDED_MS - 1000)], input), [], "not before ENDED_MS");
  assert.equal(unloadPlan([quietFor(replied, ENDED_MS)], input).length, 1);
  const { taskState: _verdict, ...unjudged } = replied;
  assert.deepEqual(unloadPlan([quietFor({ ...unjudged, repliedSinceTask: false }, 5 * MIN)], input), [], "an unjudged subagent that has not replied keeps idleEvictionMinutes");
  assert.deepEqual(unloadPlan([quietFor({ ...unjudged, runtimeKind: "top-level", rlmDepth: 0, repliedSinceTask: true }, 5 * MIN)], input), [], "an unjudged root keeps idleEvictionMinutes");
});

// The daemon row at 16:41Z on 10-18 of the alert job 'alert VP of CI 19:58', loaded as a draft (0 messages) since 10:58Z with its own worker.
const draft = {
  id: "3050f9ae4d5e", lifecycle: "draft", activity: "idle", isSessionActive: false, lastActivityAt: "2026-10-18T10:58:53.998Z", runtimeKind: "top-level",
  rlmDepth: 0, activeSessionId: "3050f9ae4d5e", sessionId: "01a14ea9-f2bf-7170-aaea-2b0c0fe16637",
  sessionFile: "/home/sieun/.prime/agent/sessions/01a14ea9-f2bf-7170-aaea-2b0c0fe16637.jsonl", sessionName: "alert VP of CI 19:58", cwd: "/home/sieun",
  thinkingLevel: "high", isStreaming: false, isCompacting: false, isBashRunning: false, hasRunningRlmChildren: false, isRunningTools: false,
  attachedClients: 0, messageCount: 0, unfinishedActionCount: 0, created: "2026-10-18T10:58:43.007Z", modified: "2026-10-18T10:58:53.998Z",
  sessionActions: { queuedCount: 0, steering: [], followUps: [] }, rosterStatus: "idle", workerState: "ready", workerPid: 1712772,
} as unknown as SessionSummary;

test("a draft the daemon holds loaded with no message stops after idleEvictionMinutes, and its worker counts as quiet", () => {
  const input = { attached: new Set<string>(), pool: new Set<string>(), idleMs: TEN_MIN };
  const at = Date.parse("2026-10-18T16:41:00Z");
  assert.deepEqual(unloadPlan([draft], { ...input, now: at }).map(row => row.sessionId), [draft.sessionId]);
  assert.deepEqual(unloadPlan([draft], { ...input, now: Date.parse(draft.lastActivityAt!) + TEN_MIN - 1000 }), [], "not before idleEvictionMinutes");
  assert.deepEqual(unloadPlan([{ ...draft, lifecycle: "archived" } as SessionSummary], { ...input, now: at }), [], "an archived row is not loaded");
  assert.deepEqual(quietWorkers([draft], { chats: new Set(), pool: new Set(), now: at }).map(worker => worker.pid), [1712772]);
});

test("the 10-18 rows recycle no worker: the VP's worker is at work and every quiet worker holds under RECYCLE_OWN_BYTES of its own", () => {
  const quiet = quietWorkers(day18.rows, { chats: new Set(day18.chats), pool: new Set(day18.pool), now: at18 });
  assert.ok(quiet.length >= 5, `${quiet.length} quiet workers`);
  assert.ok(!quiet.some(worker => worker.pid === 5784), "a session at work keeps the VP's worker");
  assert.deepEqual(recyclePlan(quiet, own18), []);
  assert.ok((own18.get(5784) ?? 0) >= RECYCLE_OWN_BYTES && [...own18].filter(([pid]) => pid !== 5784).every(([, bytes]) => bytes < RECYCLE_OWN_BYTES / 1.25));
});

test("once every session on the VP's worker is quiet for RECYCLE_QUIET_MS, the chat detaches first, then every session stops, deepest first", () => {
  const on = day18.rows.filter(row => row.workerPid === 5784 && row.activeSessionId);
  assert.ok(on.length >= 5);
  const rest = (ms: number, attached: (row: SessionSummary) => number) => on.map(row => ({ ...row, activity: "idle", isSessionActive: false, isStreaming: false,
    isRunningTools: false, hasRunningRlmChildren: false, isBashRunning: false, unfinishedActionCount: 0, attachedClients: attached(row),
    lastActivityAt: new Date(at18 - ms).toISOString() }) as SessionSummary);
  const input = { chats: new Set(day18.chats), pool: new Set<string>(), now: at18 };
  const service = (row: SessionSummary) => row.sessionId === VP ? 1 : 0;
  assert.deepEqual(recyclePlan(quietWorkers(rest(RECYCLE_QUIET_MS - MIN, service), input), own18), [], "not before RECYCLE_QUIET_MS");
  const first = recyclePlan(quietWorkers(rest(RECYCLE_QUIET_MS, service), input), own18);
  assert.equal(first.length, 1);
  assert.deepEqual(first[0]!.attached, [VP], "the service's attach to the chat is detached first");
  const second = recyclePlan(quietWorkers(rest(RECYCLE_QUIET_MS, () => 0), input), own18)[0]!;
  assert.deepEqual(second.attached, []);
  assert.equal(second.stop.length, on.length, "every loaded session on the worker stops, so the worker exits");
  assert.equal(second.stop.at(-1)!.sessionId, VP, "the root stops last");
  assert.deepEqual(recyclePlan(quietWorkers(rest(RECYCLE_QUIET_MS, () => 0), input), new Map([[5784, RECYCLE_OWN_BYTES - 1]])), [], "a worker under RECYCLE_OWN_BYTES stays");
  const other = (row: SessionSummary) => row.sessionId === VP ? 0 : 1;
  assert.deepEqual(recyclePlan(quietWorkers(rest(RECYCLE_QUIET_MS, other), input), own18), [], "a client on a session that is no chat keeps the worker");
  const working = rest(RECYCLE_QUIET_MS, () => 0).map((row, at) => at === 1 ? { ...row, activity: "working" } as SessionSummary : row);
  assert.deepEqual(recyclePlan(quietWorkers(working, input), own18), [], "one session at work keeps the worker");
  assert.deepEqual(recyclePlan(quietWorkers(rest(RECYCLE_QUIET_MS, () => 0), { ...input, pool: new Set([on[0]!.sessionId]) }), own18), [], "a turn in pi-pool keeps the worker");
});

// The daemon's rows at 01:16Z on 10-18, swap at 12.56 GB of 13.31: 53 Python kernels, and 17 idle sessions that were no chat, had no client and
// nothing at work below them. 14 had ended their task (a verdict, a reply to the parent, or a board.wake pending) and sat quiet 0.3 to 8.4 min.
const day18b = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "daemon-rows-1018-0116.json"), "utf8")) as Fixture & { waking: string[] };
const at18b = Date.parse(day18b.takenAt);

test("the 01:16Z rows stop each session that ended its task once quiet ENDED_MS, roots with a wake or a verdict included, and never a chat", () => {
  const input = { attached: new Set(day18b.chats), pool: new Set<string>(), now: at18b, idleMs: TEN_MIN, chats: new Set(day18b.chats), waking: new Set(day18b.waking) };
  const names = unloadPlan(day18b.rows, input).map(row => row.sessionName);
  for (const name of ["github token burn", "ci-job-runtime", "facebook index gaps", "fix repo prod secrets"]) assert.ok(names.includes(name), name);
  assert.ok(!names.includes("runner reviewer") && !names.includes("babysitter"), "a root with no verdict and no wake keeps idleEvictionMinutes");
  assert.ok(!names.includes("land tooling probes"), "a root quiet under ENDED_MS stays");
  // 42260e0 stopped early only a subagent that replied: the same rows with no verdict and no wake.
  const before = unloadPlan(day18b.rows.map(unjudged), { attached: input.attached, pool: input.pool, now: at18b, idleMs: TEN_MIN });
  assert.ok(names.length >= before.length + 5, `${before.length} before, ${names.length} now`);
  const chat = day18b.rows.find(row => day18b.chats.includes(row.sessionId) && row.taskState !== undefined && row.activeSessionId)!;
  const dormant = { ...chat, attachedClients: 0, activity: "idle", hasRunningRlmChildren: false, lastActivityAt: new Date(at18b - 5 * MIN).toISOString() } as SessionSummary;
  assert.deepEqual(unloadPlan([dormant], { ...input, attached: new Set() }), [], "a dormant chat with a verdict keeps idleEvictionMinutes");
  assert.ok(!names.includes("us-metal02 setup"), "a root with its metal02-ci-slice child at work stays");
  const job = day18b.rows.find(row => row.sessionName === "runner reviewer")!;
  assert.equal(unloadPlan([job], { ...input, waking: new Set([job.sessionId]) }).length, 1, "a pending board.wake marks the job as waiting");
});

// service.log on 10-18: the sweep that stopped 'alerts-h-proxy' at 03:12:53Z was followed by one that ran through 22 kill timeouts of 30 s
// each until 03:36:49Z, then one until 03:48:24Z. Each kill waited for the one before it, the next sweep waited for the whole sweep, and the
// plan was read when the sweep started, so the 26 sessions stopped at 03:48:24Z had sat quiet 10.5 to 15.7 min.
type Call = { type: "get_state" | "kill"; session: string; at: number };
function harness(rows: SessionSummary[], answers: { kill?: (row: SessionSummary) => Promise<DaemonAnswer>; state?: (row: SessionSummary) => DaemonAnswer } = {}) {
  const calls: Call[] = [];
  const stopped: string[] = [];
  const lines: string[] = [];
  const clock = { now: at15 };
  const unloader = new IdleUnloader({
    rows: () => rows, localRows: () => [], idleMs: () => TEN_MIN, chats: async () => new Set(), dormant: () => false, pool: async () => new Set(),
    waking: async () => new Set(), held: async () => new Map(), own: async () => new Map(), restNow: async () => false, release: async () => true, title: () => null,
    request: async (row, type) => {
      calls.push({ type, session: row.sessionId, at: clock.now });
      if (type === "get_state") return answers.state?.(row) ?? { success: true, data: { isSessionActive: false, isStreaming: false, isCompacting: false, isBashRunning: false } };
      return answers.kill ? answers.kill(row) : { success: true };
    },
    stopped: async row => { stopped.push(row.sessionId); }, log: line => { lines.push(line); }, now: () => clock.now,
  });
  return { unloader, calls, stopped, lines, clock };
}
const quietRoot = (id: string, quietMs: number): SessionSummary => ({ ...unjudged(plan15.find(isRoot)!), sessionId: id, activeSessionId: id, sessionName: id,
  lastActivityAt: new Date(at15 - quietMs).toISOString() }) as SessionSummary;
const turn = () => new Promise(resolve => setImmediate(resolve));

test("a kill the daemon does not answer holds up neither the other stops of its sweep nor the next sweep", async () => {
  const rows = [quietRoot("hung", TEN_MIN + MIN), quietRoot("quick", TEN_MIN + MIN), quietRoot("later", TEN_MIN - MIN)];
  const never = new Promise<DaemonAnswer>(() => {});
  const { unloader, calls, stopped, clock } = harness(rows, { kill: async row => row.sessionId === "hung" ? never : { success: true } });
  await unloader.sweep();
  await turn();
  assert.deepEqual(stopped, ["quick"], "the stop beside the hung kill went through");
  clock.now += 2 * MIN;
  await unloader.sweep();
  await turn();
  assert.deepEqual(stopped, ["quick", "later"], "the next sweep read its plan fresh and stopped the session that went quiet since");
  assert.equal(calls.filter(call => call.type === "kill" && call.session === "hung").length, 1, "the session whose kill is still out is not asked again");
});

test("a session the daemon shows at work when its stop comes is kept, so no kill lands mid-turn", async () => {
  const rows = [quietRoot("stale-row", TEN_MIN + MIN)];
  const { unloader, calls, stopped } = harness(rows, { state: () => ({ success: true, data: { isSessionActive: true, isStreaming: true } }) });
  await unloader.sweep();
  await unloader.settled();
  assert.deepEqual(stopped, []);
  assert.deepEqual(calls.map(call => call.type), ["get_state"], "no kill was sent");
});

test("a stale row whose active session the daemon does not know is not asked again until the row changes", async () => {
  const rows = [quietRoot("gone", TEN_MIN + MIN)];
  const { unloader, calls, clock } = harness(rows, { state: () => ({ success: false, error: "Unknown active session: gone" }) });
  await unloader.sweep();
  await unloader.settled();
  clock.now += MIN;
  await unloader.sweep();
  await unloader.settled();
  assert.equal(calls.length, 1, "the second sweep skipped the same stale row");
  rows[0] = { ...rows[0]!, lastActivityAt: new Date(at15 - TEN_MIN + 30_000).toISOString() };
  clock.now += 2 * MIN;
  await unloader.sweep();
  await unloader.settled();
  assert.equal(calls.length, 2, "a row that changed is planned again");
});

// Native run DU-fix at 17:51Z on 10-18 on the detached-bash fix build a59cdba2: a session that ran `nohup python3 -m http.server ... &` ended its
// turn and its row read idle, isSessionActive false, taskState needs_input and holdsDetachedProcesses true. 138 s later the sweep planned it,
// get_state read it idle, and the kill took the server from HTTP 200 to connection refused.
const service = (holds: boolean): UnloadRow => ({ ...quietRoot("nohup-server", TEN_MIN + MIN), taskState: "needs_input", workerPid: 4242,
  ...(holds ? { holdsDetachedProcesses: true } : {}) }) as UnloadRow;

test("a session holding a process it started detached is never planned, and neither is the recycle of a worker it is on", () => {
  const input = { attached: new Set<string>(), pool: new Set<string>(), now: at15, idleMs: TEN_MIN };
  assert.deepEqual(unloadPlan([service(false)], input).map(row => row.sessionId), ["nohup-server"], "the same row without the flag is planned");
  assert.deepEqual(unloadPlan([service(true)], input), []);
  const workers = { chats: new Set<string>(), pool: new Set<string>(), now: at15 };
  assert.deepEqual(quietWorkers([service(false)], workers).map(worker => worker.pid), [4242]);
  assert.deepEqual(quietWorkers([service(true)], workers), []);
  const child = { ...service(true), sessionId: "nohup-child", activeSessionId: "nohup-child", parentSessionId: "nohup-server", runtimeKind: "subagent" } as UnloadRow;
  assert.deepEqual(unloadPlan([service(false), child], input), [], "a parent whose kill would close the child's service is not planned either");
});

test("a session whose get_state shows a detached process gets no kill", async () => {
  const { unloader, calls, stopped } = harness([service(false)], { state: () => ({ success: true, data: { isSessionActive: false, isStreaming: false,
    isCompacting: false, isBashRunning: false, holdsDetachedProcesses: true } }) });
  await unloader.sweep();
  await unloader.settled();
  assert.deepEqual(calls.map(call => call.type), ["get_state"], "no kill was sent");
  assert.deepEqual(stopped, []);
});

test("a session whose detached process exited is planned and stopped on the next sweep", async () => {
  const rows: UnloadRow[] = [service(true)];
  const { unloader, calls, stopped, clock } = harness(rows);
  await unloader.sweep();
  await unloader.settled();
  assert.equal(calls.length, 0, "the row with the flag is not planned");
  rows[0] = service(false);
  clock.now += MIN;
  await unloader.sweep();
  await unloader.settled();
  assert.deepEqual(calls.map(call => call.type), ["get_state", "kill"]);
  assert.deepEqual(stopped, ["nohup-server"]);
});

// From 04:05Z on 10-18 the Mac logged 35 'idle unload: record ... ENOENT' lines: the stops of one sweep ran at once and raced on one temp file.
test("records of stops that end at once all land in unloaded.json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "unloaded-"));
  const ids = Array.from({ length: 20 }, (_, at) => `session-${at}`);
  const results = await Promise.allSettled(ids.map(id => recordUnloaded(dir, [id], Date.now())));
  assert.deepEqual(results.filter(result => result.status === "rejected"), []);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, UNLOADED_FILE), "utf8"))).sort(), [...ids].sort());
});

test("only work moves a chat's idle clock, not a state notice or a message injected outside a turn", () => {
  for (const type of ["agent_start", "agent_end", "turn_start", "message_update", "tool_execution_start", "bash_start", "compaction_start", "auto_retry_start"])
    assert.equal(showsWork({ type }), true, type);
  assert.equal(showsWork({ type: "message_end", message: { role: "user" } }), true);
  for (const type of ["session_info_changed", "thinking_level_changed", "service_tier_changed", "session_action_update", "goal_update", "recap_update", "rlm_child_update", "rlm_progress_note", "auth_stale"])
    assert.equal(showsWork({ type }), false, type);
  assert.equal(showsWork({ type: "message_end", message: { role: "custom", customType: "harness_digest" } }), false, "launch main bro's 03:55:30Z harness_digest");
});

test("a quiet session whose worker failed after the listing is not asked again until its row changes", async () => {
  const rows = [quietRoot("failed-worker", TEN_MIN + MIN)];
  const { unloader, calls, clock } = harness(rows, { state: () => ({ success: false, error: "Session worker is failed" }) });
  await unloader.sweep();
  await unloader.settled();
  clock.now += MIN;
  await unloader.sweep();
  await unloader.settled();
  assert.equal(calls.length, 1, "the second sweep skipped the failed worker's row");
});

// d7 at 06:01Z on 10-20: the Mac's frontend bro worker 37191 held 6.03 GB for 10 sessions, 0.08 GB of it their work, from 03:39Z on, while
// only this box's workers were recycled. A box whose daemon takes kill_origin gets the same recycle; one without it is left to its own daemon.
test("a quiet oversized worker on another box is recycled when that box's daemon takes kill_origin, and left alone when it does not", async () => {
  const MAC_PID = 37191;
  const onMac = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
    ({ ...quietRoot(id, 4 * MIN), workerPid: MAC_PID, attachedClients: 0, ...extra }) as SessionSummary;
  const chat = onMac("frontend-bro", { attachedClients: 1 });
  const child = onMac("stale-root", { rlmDepth: 2 });
  const run = async (recycles: boolean, rows: SessionSummary[]) => {
    const reads: { pids: readonly number[]; host?: string }[] = [];
    const rested: string[] = [];
    const killed: string[] = [];
    const unloader = new IdleUnloader({
      rows: () => rows, localRows: () => [], remoteBoxes: () => [{ host: "mac", rows, recycles }], idleMs: () => TEN_MIN,
      chats: async () => new Set(["frontend-bro"]), dormant: () => false, pool: async () => new Set(), waking: async () => new Set(), held: async () => new Map(),
      own: async (pids, host) => { reads.push({ pids, ...host === undefined ? {} : { host } }); return new Map([[MAC_PID, 6 * RECYCLE_OWN_BYTES]]); },
      restNow: async id => { rested.push(id); return true; }, release: async () => true, title: id => id,
      request: async (row, type) => { if (type === "kill") killed.push(row.sessionId); return type === "get_state" ? { success: true, data: { isSessionActive: false } } : { success: true }; },
      stopped: async () => {}, log: () => {}, now: () => at15,
    });
    await unloader.sweep();
    await unloader.settled();
    return { reads, rested, killed };
  };
  const attached = await run(true, [chat, child]);
  assert.deepEqual(attached.reads, [{ pids: [MAC_PID], host: "mac" }], "the footprint is read from the Mac, not from this box");
  assert.deepEqual(attached.rested, ["frontend-bro"], "the attached chat is detached first");
  assert.deepEqual(attached.killed, []);
  const detached = await run(true, [{ ...chat, attachedClients: 0 } as SessionSummary, child]);
  assert.deepEqual(detached.killed, ["stale-root", "frontend-bro"], "then every session on the worker stops, deepest first");
  const old = await run(false, [{ ...chat, attachedClients: 0 } as SessionSummary, child]);
  assert.deepEqual([old.reads, old.rested, old.killed], [[], [], []], "a daemon without kill_origin keeps its sessions");
});
