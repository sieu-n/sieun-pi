// Replays d7's 19:46Z minute on us-metal02 on 10-21: the idle unload's check of ops guy (+observability) (01a11af8) met "Session worker is
// stopping" at 19:46:07Z and failed ("idle unload: 01a11af8-...: Session worker is stopping"). The check now waits the move out and asks again.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { type DaemonAnswer, IdleUnloader } from "../src/idle-unload.ts";

const MIN = 60_000;
const now = Date.parse("2026-10-21T19:46:07.000Z");
const CHAT = "01a11af8-962e-773d-a19a-ee4104011987";
const row = {
  id: "ee4104011987", lifecycle: "live", activity: "idle", isSessionActive: false, lastActivityAt: new Date(now - 40 * MIN).toISOString(),
  runtimeKind: "top-level", rlmDepth: 0, activeSessionId: "ee4104011987", sessionId: CHAT, sessionName: "ops guy (+observability)", isStreaming: false,
  isCompacting: false, isBashRunning: false, hasRunningRlmChildren: false, isRunningTools: false, attachedClients: 0, unfinishedActionCount: 0,
  sessionActions: { queuedCount: 0, steering: [], followUps: [] }, workerState: "ready", sessionFile: `/sessions/${CHAT}.jsonl`,
} as unknown as SessionSummary;
const idle: DaemonAnswer = { success: true, data: { activity: "idle", isSessionActive: false, isStreaming: false, isCompacting: false, isBashRunning: false, isRunningTools: false } };
const stopping: DaemonAnswer = { success: false, error: "Session worker is stopping" };

async function sweep(answers: Record<"get_state" | "kill", DaemonAnswer[]>) {
  const calls: string[] = [], lines: string[] = [];
  const unloader = new IdleUnloader({
    rows: () => [row], localRows: () => [row], idleMs: () => 15 * MIN, chats: async () => new Set(), dormant: () => false, pool: async () => new Set(),
    waking: async () => new Set(), held: async () => new Map(), release: async () => true, own: async () => new Map(), restNow: async () => false,
    title: () => null, stopped: async () => {}, log: line => lines.push(line), now: () => now,
    request: async (_target, type) => { calls.push(type); const queue = answers[type as "get_state" | "kill"]; return queue.length > 1 ? queue.shift()! : queue[0]!; },
  });
  await unloader.sweep();
  await unloader.settled();
  return { calls, lines };
}

test("an idle check that meets a stopping worker waits it out and then stops the session", async () => {
  const { calls, lines } = await sweep({ get_state: [stopping, idle], kill: [{ success: true }] });
  assert.deepEqual(calls, ["get_state", "get_state", "get_state", "kill"], calls.join(", "));
  assert.doesNotMatch(lines.join("\n"), /Session worker is stopping/);
  assert.match(lines.join("\n"), /stopped 1 idle sessions: ops guy/);
});

test("a session its stopping worker took along is left as stopped, with no failure line", async () => {
  const { calls, lines } = await sweep({ get_state: [stopping, { success: false, error: "Unknown active session: ee4104011987" }], kill: [{ success: true }] });
  assert.ok(!calls.includes("kill"));
  assert.doesNotMatch(lines.join("\n"), /Session worker is stopping|Unknown active session/);
  assert.match(lines.join("\n"), /its worker exited with it while this check waited/);
});

test("a kill that meets a starting worker waits it out and goes once more", async () => {
  const { calls } = await sweep({ get_state: [idle], kill: [{ success: false, error: "Session worker is starting" }, { success: true }] });
  assert.deepEqual(calls, ["get_state", "kill", "get_state", "kill"], calls.join(", "));
});
