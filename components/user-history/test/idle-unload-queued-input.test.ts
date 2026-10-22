// Guards the 15:26:35Z stop on us-metal02 on 10-22: the idle unload stopped metal box owner (01a11d24-ac9b-757d-ac51-9b2b7598782f) while it waited
// in a pi-pool account wait, and the 5 steers queued in its worker were gone when it reopened (~/work/messaging-audit/FINDINGS.md).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { type DaemonAnswer, IdleUnloader, queuedInputs } from "../src/idle-unload.ts";

const at = Date.parse("2026-10-22T15:26:35Z");
const MIN = 60_000;
const OWNER = "01a11d24-ac9b-757d-ac51-9b2b7598782f";

/** A loaded session the daemon lists the way it listed metal box owner: an open turn asleep in its retry, and queuedCount 0, as every list row reads. */
const row = (sessionId: string, activity: "working" | "idle"): SessionSummary => ({
  runtimeKind: "top-level", rlmDepth: 0, activeSessionId: sessionId.slice(-12), sessionId, sessionName: sessionId.slice(0, 8), lifecycle: "live",
  workerState: "ready", workerPid: 1091110, activity, isSessionActive: activity === "working", isStreaming: false, isCompacting: false, isBashRunning: false,
  isRunningTools: false, hasRunningRlmChildren: false, attachedClients: 0, directAttachedClients: 0, unfinishedActionCount: activity === "working" ? 13 : 0,
  sessionActions: { queuedCount: 0, steering: [], followUps: [] }, lastActivityAt: new Date(at - 20 * MIN).toISOString(),
  cwd: "/home/sieun", model: { provider: "anthropic", id: "claude-fable-5" },
}) as unknown as SessionSummary;

/** `get_state` as the worker answers it: its own `sessionActions`, with the steers the list does not show. */
const state = (activity: "working" | "idle", steers: number): DaemonAnswer => ({ success: true, data: {
  activity, isSessionActive: activity === "working", isStreaming: false, isCompacting: false, isBashRunning: false, isRunningTools: false,
  sessionActions: { queuedCount: steers, steering: Array.from({ length: steers }, (_, i) => `steer ${i + 1}`), followUps: [], ...activity === "working" ? { active: { kind: "turn", phase: "running" } } : {} },
} });

function harness(rows: SessionSummary[], held: ReadonlyMap<string, number>, answer: (row: SessionSummary) => DaemonAnswer) {
  const kills: string[] = [], lines: string[] = [];
  const unloader = new IdleUnloader({
    rows: () => rows, localRows: () => [], idleMs: () => 15 * MIN, chats: async () => new Set(), dormant: () => false, pool: async () => new Set(),
    waking: async () => new Set(), held: async candidates => new Map([...held].filter(([id]) => candidates.some(candidate => candidate.sessionId === id))),
    own: async () => new Map(), restNow: async () => false, release: async () => true, title: () => null,
    request: async (target, type) => { if (type === "kill") kills.push(target.sessionId); return type === "get_state" ? answer(target) : { success: true }; },
    stopped: async () => {}, log: line => { lines.push(line); }, now: () => at,
  });
  return { unloader, kills, lines };
}

test("a session asleep in a pi-pool account wait with steers queued in its worker is kept, and one with none still stops", async () => {
  const quiet = "01a16475-0000-7000-8000-000000000001";
  const { unloader, kills, lines } = harness([row(OWNER, "working"), row(quiet, "working")], new Map([[OWNER, at + 3 * MIN], [quiet, at + 3 * MIN]]),
    target => state("working", target.sessionId === OWNER ? 5 : 0));
  await unloader.sweep();
  await unloader.settled();
  assert.deepEqual(kills, [quiet], "the stop of 15:26:35Z dropped the 5 steers");
  assert.ok(lines.some(line => line.includes(`${OWNER}: holds 5 queued inputs that a stop would drop; kept`)), lines.join("\n"));
});

test("an idle session whose list row reads no queued input but whose worker holds a follow-up is kept", async () => {
  const id = "01a16475-0000-7000-8000-000000000002";
  const followUp: DaemonAnswer = { success: true, data: { activity: "idle", isSessionActive: false, isStreaming: false, isCompacting: false, isBashRunning: false,
    isRunningTools: false, sessionActions: { queuedCount: 1, steering: [], followUps: ["<provider_quota_resumed>"] } } };
  const { unloader, kills } = harness([row(id, "idle")], new Map(), () => followUp);
  await unloader.sweep();
  await unloader.settled();
  assert.deepEqual(kills, []);
});

test("queuedInputs reads get_state's sessionActions and treats an answer without it as none", () => {
  assert.equal(queuedInputs(state("working", 3).success ? (state("working", 3) as { data: unknown }).data : null), 3);
  assert.equal(queuedInputs({ activity: "idle" }), 0);
  assert.equal(queuedInputs(undefined), 0);
});
