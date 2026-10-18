import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { quietWorkers, RECYCLE_OWN_BYTES, RECYCLE_QUIET_MS, recyclePlan, REPLIED_MS, unloadPlan } from "../src/idle-unload.ts";

type Fixture = { takenAt: string; chats: string[]; pool: string[]; rows: SessionSummary[] };
const load = (name: string): Fixture => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")) as Fixture;
const TEN_MIN = 10 * 60_000;
const isRoot = (row: SessionSummary): boolean => (row.rlmDepth ?? 0) === 0 && row.runtimeKind !== "subagent";

// `prime-agent sessions --json` at 21:22Z on 10-15: 136 loaded sessions, 25 workers holding 20.77 GB, and the hour at 71.7% usable with 15
// harness minutes. Prime's idle sweep had not stopped idle roots: each sweep ends at the first worker that "did not stop".
const day15 = load("daemon-rows-1015-2122.json");
const at15 = Date.parse(day15.takenAt);
const plan15 = unloadPlan(day15.rows, { attached: new Set(day15.chats), pool: new Set(day15.pool), now: at15, idleMs: TEN_MIN });

test("the 10-15 rows unload the top-level jobs idle for idleEvictionMinutes with nothing running, queued or scheduled", () => {
  const roots = plan15.filter(isRoot);
  assert.ok(roots.length >= 1, `${roots.length} roots`);
  for (const row of roots) {
    assert.ok(!day15.chats.includes(row.sessionId), "never a chat the service holds attached");
    assert.ok(!day15.pool.includes(row.sessionId), "never one with a turn working or queued in pi-pool");
    assert.ok(at15 - Date.parse(row.lastActivityAt!) >= TEN_MIN);
  }
});

test("a session with a heartbeat, a client attached, a running child, a queued input or idleEvictionMinutes of quiet missing keeps its worker", () => {
  const base = plan15.find(isRoot)!;
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

test("the 10-17 rows stop each subagent idle for idleEvictionMinutes, or REPLIED_MS once it replied, with nothing at work below it", () => {
  const names = new Set(children17.map(row => row.sessionName));
  for (const name of ["gap-niche-missing", "gap-secuid-missing", "grafana-c-checks", "test results in ci", "query mcp build"]) assert.ok(names.has(name), name);
  assert.ok(children17.length >= 15, `${children17.length} subagents`);
  const byId = new Map(day17.rows.map(row => [row.sessionId, row] as const));
  for (const row of children17) {
    assert.ok(at17 - Date.parse(row.lastActivityAt!) >= (row.repliedSinceTask ? REPLIED_MS : TEN_MIN), row.sessionName);
    const below = day17.rows.filter(other => { for (let up = other.parentSessionId; up; up = byId.get(up)?.parentSessionId) if (up === row.sessionId) return true; return false; });
    assert.ok(below.every(other => other.activity === "idle"), `${row.sessionName} has a session at work below it`);
  }
});

test("a root reloaded by a message 1 to 2 minutes after it went quiet is not stopped in between", () => {
  const root = plan15.find(isRoot)!;
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

test("a subagent that replied to its parent stops after REPLIED_MS of quiet, and one that did not waits idleEvictionMinutes", () => {
  const replied = day18.rows.find(row => row.runtimeKind === "subagent" && row.repliedSinceTask === true && row.activeSessionId)!;
  const input = { attached: new Set<string>(), pool: new Set<string>(), now: at18, idleMs: TEN_MIN };
  const quietFor = (row: SessionSummary, ms: number): SessionSummary => ({ ...row, activity: "idle", isSessionActive: false, isStreaming: false, isRunningTools: false,
    hasRunningRlmChildren: false, isBashRunning: false, attachedClients: 0, lastActivityAt: new Date(at18 - ms).toISOString() });
  assert.equal(REPLIED_MS, 2 * MIN);
  assert.deepEqual(unloadPlan([quietFor(replied, REPLIED_MS - 1000)], input), [], "not before REPLIED_MS");
  assert.equal(unloadPlan([quietFor(replied, REPLIED_MS)], input).length, 1);
  assert.deepEqual(unloadPlan([quietFor({ ...replied, repliedSinceTask: false }, 5 * MIN)], input), [], "a subagent that has not replied keeps idleEvictionMinutes");
  assert.deepEqual(unloadPlan([quietFor({ ...replied, runtimeKind: "top-level", rlmDepth: 0, repliedSinceTask: true }, 5 * MIN)], input), [], "a root keeps idleEvictionMinutes");
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
