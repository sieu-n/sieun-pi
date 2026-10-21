// Replays the 08:36Z dirty d7 minute on us-metal02 on 10-21. The quota-park sweep chose the Crawler VP alert jobs 01a15019 and 01a14fde
// (parked on their provider quota until 09:18Z and 09:01Z) and sent their kills at 08:36:06.434Z, while the job wake check's open of each was
// attaching. Both attaches failed with "Active session ... closed during attach" at 08:36:06.7Z (unload-receipts.jsonl, agent.jsonl).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { type DaemonAnswer, IdleUnloader } from "../src/idle-unload.ts";
import type { UnloadReceipt } from "../src/unloaded.ts";

const MIN = 60_000;
const now = Date.parse("2026-10-21T08:36:06.000Z");
const JOB = "01a15019-901b-7648-95af-5f16d0d16a72";
const OTHER = "01a14fde-07c1-7479-a262-187840dfb62e";
const row = (sessionId: string, active: string): SessionSummary => ({
  id: active, lifecycle: "live", activity: "idle", isSessionActive: false, lastActivityAt: new Date(now - 40 * MIN).toISOString(),
  runtimeKind: "top-level", rlmDepth: 0, activeSessionId: active, sessionId, sessionName: sessionId.slice(0, 8), isStreaming: false,
  isCompacting: false, isBashRunning: false, hasRunningRlmChildren: false, isRunningTools: false, attachedClients: 0, unfinishedActionCount: 0,
  sessionActions: { queuedCount: 0, steering: [], followUps: [] }, workerState: "ready", sessionFile: `/sessions/${sessionId}.jsonl`,
} as unknown as SessionSummary);
const rows = [row(JOB, "50c53297d128"), row(OTHER, "e0cacd596c34")];
const idle: DaemonAnswer = { success: true, data: { activity: "idle", isSessionActive: false, isStreaming: false, isCompacting: false, isBashRunning: false, isRunningTools: false } };

function sweepWith(opening: ReadonlySet<string>) {
  const calls: string[] = [], lines: string[] = [], receipts: UnloadReceipt[] = [];
  const unloader = new IdleUnloader({
    rows: () => rows, localRows: () => rows, idleMs: () => 15 * MIN, chats: async () => new Set(), dormant: () => false, pool: async () => new Set(),
    waking: async () => new Set(), held: async () => new Map(),
    parked: async candidates => new Map(candidates.map(candidate => [candidate.sessionId, Date.parse("2026-10-21T09:18:00.000Z")] as const)),
    release: async () => true, attaching: id => opening.has(id), own: async () => new Map(), restNow: async () => false, title: () => null,
    request: async (target, type) => { calls.push(`${type} ${target.sessionId}`); return type === "get_state" ? idle : { success: true }; },
    stopped: async () => {}, receipt: async receipt => { receipts.push(receipt); }, log: line => lines.push(line), now: () => now,
  });
  return { unloader, calls, lines, receipts };
}

test("a parked job whose open is attaching is kept, and the other parked job still stops", async () => {
  const { unloader, calls, lines, receipts } = sweepWith(new Set([JOB]));
  await unloader.sweep();
  await unloader.settled();
  assert.ok(!calls.includes(`kill ${JOB}`), calls.join(", "));
  assert.ok(calls.includes(`kill ${OTHER}`), calls.join(", "));
  assert.match(lines.join("\n"), new RegExp(`${JOB}: an open is attaching to it; kept`));
  assert.deepEqual(receipts.filter(receipt => receipt.sessionId === JOB), [], "a kept session writes no sent receipt");
});

test("with no open under way both parked jobs stop, as before", async () => {
  const { unloader, calls } = sweepWith(new Set());
  await unloader.sweep();
  await unloader.settled();
  assert.ok(calls.includes(`kill ${JOB}`) && calls.includes(`kill ${OTHER}`), calls.join(", "));
});
