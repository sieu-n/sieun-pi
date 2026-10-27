// Replays two ways Agent sessions on us-metal02 kept memory while no session worked from 12:57Z to 13:46Z on 10-21 (d7 read 5.07 GB at 13:41Z,
// target 5 GB): the babysitter and tiktok shop jobs, each woken by its 30 min heartbeat, kept 0.38 GB each until Prime evicted them 16 to 19
// min later, since the unload left every scheduled session alone; and 27 quota-resume wakes from 13:41:13Z parked within a second each and
// kept their workers until the 13:42:07Z sweep.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { type DaemonAnswer, ENDED_MS, IdleUnloader, parkChanges, SWEEP_EVERY_MS, unloadPlan, wokenByScan } from "../src/idle-unload.ts";
import type { UnloadReceipt } from "../src/unloaded.ts";

const MIN = 60_000;
const SESSIONS = "/home/sieun/.prime/agent/sessions";
const BABYSITTER = "01a10dbb-db73-754a-a7a3-8d398967695e";
const at = Date.parse("2026-10-21T13:41:30.000Z");

const row = (sessionId: string, extra: Partial<SessionSummary> & { isQuotaParked?: boolean } = {}): SessionSummary => ({
  id: sessionId.slice(-12), lifecycle: "live", activity: "idle", isSessionActive: false, lastActivityAt: new Date(at - 5 * MIN).toISOString(),
  runtimeKind: "top-level", rlmDepth: 0, activeSessionId: sessionId.slice(-12), sessionId, sessionName: sessionId.slice(0, 8), isStreaming: false,
  isCompacting: false, isBashRunning: false, hasRunningRlmChildren: false, isRunningTools: false, attachedClients: 0, unfinishedActionCount: 0,
  sessionActions: { queuedCount: 0, steering: [], followUps: [] }, workerState: "ready", workerPid: 2501903, cwd: "/home/sieun", messageCount: 396,
  sessionFile: `${SESSIONS}/${sessionId}.jsonl`, ...extra,
} as SessionSummary);

test("a heartbeat job in the sessions root stops ENDED_MS after its tick, where the plan before kept it until Prime's own eviction", () => {
  const babysitter = row(BABYSITTER, { hasRegisteredHeartbeat: true, hasActiveHeartbeat: true });
  const input = { attached: new Set<string>(), pool: new Set<string>(), now: at, idleMs: 15 * MIN, sessionsDir: SESSIONS };
  assert.ok(wokenByScan(babysitter, SESSIONS));
  assert.deepEqual(unloadPlan([babysitter], input).map(found => found.sessionId), [BABYSITTER]);
  const justNow = { ...babysitter, lastActivityAt: new Date(at - ENDED_MS + 1000).toISOString() };
  assert.deepEqual(unloadPlan([justNow], input), [], "a tick that ended under ENDED_MS ago keeps it");
  const cron = row(BABYSITTER, { hasRegisteredCronJob: true });
  assert.equal(unloadPlan([cron], input).length, 1, "a scheduled job the wake scan runs counts the same");
  const { sessionsDir: _root, ...unrooted } = input;
  assert.deepEqual(unloadPlan([babysitter], unrooted), [], "without the sessions root the old rule keeps it");
  const child = { ...babysitter, runtimeKind: "subagent", rlmDepth: 1, sessionFile: `/home/sieun/.prime/agent/session-artifacts/${BABYSITTER}/sub-1/child.jsonl` } as SessionSummary;
  assert.deepEqual(unloadPlan([child], input), [], "a subagent's file is outside the wake scan, so its schedule keeps it");
  assert.deepEqual(unloadPlan([{ ...babysitter, activity: "working", isSessionActive: true }], input), [], "a tick at work keeps it");
});

test("parkChanges names an idle row with Prime's park flag once, and again when its client lets go or its transcript moves", () => {
  const seen = new Map<string, string>();
  const parked = row("01a15e31-8dc9-72fc-a3d1-b542164b1a83", { isQuotaParked: true, modified: "2026-10-21T13:41:15.185Z" });
  const plain = row("01a15e34-76fc-72d5-83d3-7c76a02a9e41");
  const retrying = row("01a15c6c-8bec-71fe-b7d3-1fac79a315c9", { isQuotaParked: true, activity: "working", isSessionActive: true });
  assert.deepEqual(parkChanges(seen, [parked, plain, retrying]), [parked.sessionId]);
  assert.deepEqual(parkChanges(seen, [parked, plain, retrying]), [], "an unchanged row is not named again");
  const held = { ...parked, attachedClients: 1 };
  assert.deepEqual(parkChanges(seen, [held]), [parked.sessionId]);
  assert.deepEqual(parkChanges(seen, [parked]), [parked.sessionId], "the attach let go");
  assert.deepEqual(parkChanges(seen, [{ ...parked, modified: "2026-10-21T13:41:17.000Z" }]), [parked.sessionId]);
  const { activeSessionId: _active, ...stopped } = parked;
  assert.deepEqual(parkChanges(seen, [{ ...stopped, lifecycle: "archived" } as SessionSummary]), [], "a stopped row is gone");
});

test("quieted stops a session that just parked without the minute sweep, and recycles no worker", async () => {
  const id = "01a15e31-8dc9-72fc-a3d1-b542164b1a83";
  const parked = row(id, { isQuotaParked: true, lastActivityAt: new Date(at - 1000).toISOString() });
  const other = row("01a15e34-76fc-72d5-83d3-7c76a02a9e41", { lastActivityAt: new Date(at - 30 * MIN).toISOString() });
  const rows = [parked, other];
  const calls: string[] = [], receipts: UnloadReceipt[] = [], lines: string[] = [];
  const idle: DaemonAnswer = { success: true, data: { activity: "idle", isSessionActive: false, isStreaming: false, isCompacting: false, isBashRunning: false, isRunningTools: false } };
  const unloader = new IdleUnloader({
    rows: () => rows, localRows: () => rows, idleMs: () => 15 * MIN, sessionsDir: SESSIONS, chats: async () => new Set(), dormant: () => false,
    pool: async () => { calls.push("pool"); return new Set(); }, waking: async () => { calls.push("wakes"); return new Set(); }, held: async () => new Map(),
    parked: async candidates => new Map(candidates.filter(found => found.sessionId === id).map(found => [found.sessionId, at + 108 * MIN] as const)),
    release: async () => true, own: async pids => { calls.push(`own ${pids.join(",")}`); return new Map(); }, restNow: async () => false, title: () => null,
    request: async (target, type) => { calls.push(`${type} ${target.sessionId}`); return type === "get_state" ? idle : { success: true }; },
    stopped: async () => {}, receipt: async receipt => { receipts.push(receipt); }, log: line => lines.push(line), now: () => at,
  });
  await unloader.quieted([id]);
  await unloader.settled();
  assert.deepEqual(calls, [`get_state ${id}`, `kill ${id}`], "only the named session, with no pool, wake or recycle read");
  assert.deepEqual(receipts.filter(receipt => receipt.phase === "stopped").map(receipt => receipt.why), ["quota park"]);
  assert.match(lines.join("\n"), /parked on its provider quota until 15:29Z/);
  await unloader.quieted([]);
  assert.equal(calls.length, 2, "an empty call plans nothing");
});

test("a sweep that runs past SWEEP_EVERY_MS names the read that held it", async () => {
  let clock = at;
  const lines: string[] = [];
  const unloader = new IdleUnloader({
    rows: () => [], localRows: () => [], idleMs: () => 15 * MIN, chats: async () => new Set(), dormant: () => false,
    pool: async () => { clock += 318_000; return new Set(); }, waking: async () => new Set(), held: async () => new Map(), parked: async () => new Map(),
    release: async () => true, own: async () => new Map(), restNow: async () => false, title: () => null, request: async () => ({ success: true }),
    stopped: async () => {}, log: line => lines.push(line), now: () => clock,
  });
  await unloader.sweep();
  assert.deepEqual(lines, ["idle unload: the sweep took 318 s (chats 0 s, pool 318 s, wakes 0 s, pool waits 0 s, parks 0 s, recycle 0 s)"]);
  assert.ok(318_000 > SWEEP_EVERY_MS);
  clock = at;
  lines.length = 0;
  const quick = new IdleUnloader({
    rows: () => [], localRows: () => [], idleMs: () => 15 * MIN, chats: async () => new Set(), dormant: () => false,
    pool: async () => { clock += 318_000; return new Set(); }, waking: async () => new Set(), held: async () => new Map(), parked: async () => new Map(),
    release: async () => true, own: async () => new Map(), restNow: async () => false, title: () => null, request: async () => ({ success: true }),
    stopped: async () => {}, log: line => lines.push(line), now: () => clock,
  });
  await quick.quieted(["01a15e31-8dc9-72fc-a3d1-b542164b1a83"]);
  assert.equal(clock, at, "a park plan never waits on the pool read");
});
