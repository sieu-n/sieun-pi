// Replays d7's 03:17Z minute on us-metal02 on 11-13: the idle unload sent the kills of 01a14c02 and 01a14b76 on the Mac at 03:17:47.6Z, the
// Mac's idle-reaper sent SIGTERM to both workers at 03:17:48.39Z while each was closing its session for that kill ("close in flight:
// c22eed7576ba (idle_unload)"), and both kills answered "Daemon worker socket closed", which d7 booked as a failed idle check. The check now
// reads the session once more and, when the daemon no longer holds it, takes the session as stopped.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { type DaemonAnswer, IdleUnloader } from "../src/idle-unload.ts";

const MIN = 60_000;
const now = Date.parse("2026-11-13T03:17:47.300Z");
const SESSION = "01a14c02-b593-70aa-b656-bf01fcedc020";
const row = {
  id: "c22eed7576ba", lifecycle: "live", activity: "idle", isSessionActive: false, lastActivityAt: new Date(now - 20 * MIN).toISOString(),
  runtimeKind: "top-level", rlmDepth: 0, activeSessionId: "c22eed7576ba", sessionId: SESSION, sessionName: "flow-mapper", isStreaming: false,
  isCompacting: false, isBashRunning: false, hasRunningRlmChildren: false, isRunningTools: false, attachedClients: 0, unfinishedActionCount: 0,
  sessionActions: { queuedCount: 0, steering: [], followUps: [] }, workerState: "ready", sessionFile: `/sessions/${SESSION}.jsonl`,
} as unknown as SessionSummary;
const idle: DaemonAnswer = { success: true, data: { activity: "idle", isSessionActive: false, isStreaming: false, isCompacting: false, isBashRunning: false, isRunningTools: false } };
const closed: DaemonAnswer = { success: false, error: "Daemon worker socket closed" };
const unknown: DaemonAnswer = { success: false, error: "Unknown active session: c22eed7576ba" };

async function sweep(answers: Record<"get_state" | "kill", DaemonAnswer[]>) {
  const calls: string[] = [], lines: string[] = [], stopped: string[] = [], receipts: string[] = [];
  const unloader = new IdleUnloader({
    rows: () => [row], localRows: () => [row], idleMs: () => 15 * MIN, chats: async () => new Set(), dormant: () => false, pool: async () => new Set(),
    waking: async () => new Set(), held: async () => new Map(), release: async () => true, own: async () => new Map(), restNow: async () => false,
    title: () => null, stopped: async target => { stopped.push(target.sessionId); }, receipt: async entry => { receipts.push(entry.phase); },
    log: line => lines.push(line), now: () => now,
    request: async (_target, type) => { calls.push(type); const queue = answers[type as "get_state" | "kill"]; return queue.length > 1 ? queue.shift()! : queue[0]!; },
  });
  await unloader.sweep();
  await unloader.settled();
  return { calls, lines: lines.join("\n"), stopped, receipts };
}

test("a kill whose worker exited under it, with the session gone, counts as a stop and logs no failure", async () => {
  const { calls, lines, stopped, receipts } = await sweep({ get_state: [idle, unknown], kill: [closed] });
  assert.deepEqual(calls, ["get_state", "kill", "get_state"]);
  assert.doesNotMatch(lines, /: Daemon worker socket closed/);
  assert.match(lines, /its worker exited with it while the kill was out; nothing left to stop/);
  assert.match(lines, /stopped 1 idle sessions: flow-mapper/);
  assert.deepEqual(stopped, [SESSION]);
  assert.deepEqual(receipts, ["sent", "stopped"]);
});

test("a kill whose worker exited under it while the daemon still holds the session stays a failure", async () => {
  const { lines, stopped, receipts } = await sweep({ get_state: [idle, idle], kill: [closed] });
  assert.match(lines, /: Daemon worker socket closed/);
  assert.deepEqual(stopped, []);
  assert.deepEqual(receipts, ["sent", "failed"]);
});

test("a state read whose worker exited under it, with the session gone, sends no kill and logs no failure", async () => {
  const { calls, lines } = await sweep({ get_state: [closed, unknown], kill: [{ success: true }] });
  assert.deepEqual(calls, ["get_state", "get_state"]);
  assert.doesNotMatch(lines, /: Daemon worker socket closed/);
  assert.match(lines, /its worker exited with it while this check waited; nothing left to stop/);
});
