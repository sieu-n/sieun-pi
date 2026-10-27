// Replays the AI harness VP chat (01a1164b) on us-metal02 at 00:21Z on 10-21. With no session working, its quota-resume job woke it at
// 00:21:29Z, the probe met the same 429 at 00:21:30Z, Prime parked it until 02:03:20Z, and it kept its worker and kernel until the idle
// unload stopped it at 00:37:42Z. In that stretch 86 such wakes fired and d7 read 7.18 GB of Agent sessions (target 5 GB).
// The fixture is the chat's transcript from the wake's prompt to the park, with the pool's account name replaced.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { type DaemonAnswer, ENDED_MS, IdleUnloader, parkCandidates, quotaParkedUntil, unloadPlan } from "../src/idle-unload.ts";
import type { UnloadReceipt } from "../src/unloaded.ts";

const tail = readFileSync(join(import.meta.dirname, "fixtures", "quota-park-tail-1021-0021.jsonl"), "utf8");
const MIN = 60_000;
const parkedAt = Date.parse("2026-10-21T00:21:32.264Z");
const resumeAt = Date.parse("2026-10-21T02:03:20.052Z");
const now = parkedAt + 70_000;
const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const JOB = "01a15019-5a83-764a-b3b5-630e928eb5d1";

const parked = (sessionId: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id: sessionId.slice(0, 12), lifecycle: "live", activity: "idle", isSessionActive: false, lastActivityAt: new Date(parkedAt).toISOString(),
  runtimeKind: "top-level", rlmDepth: 0, activeSessionId: sessionId.slice(-12), sessionId, sessionName: sessionId.slice(0, 8), isStreaming: false,
  isCompacting: false, isBashRunning: false, hasRunningRlmChildren: false, isRunningTools: false, attachedClients: 0, unfinishedActionCount: 0,
  sessionActions: { queuedCount: 0, steering: [], followUps: [] }, workerState: "ready", taskState: "error", sessionFile: `/sessions/${sessionId}.jsonl`, ...extra,
} as SessionSummary);

const chatRow = parked(CHAT, { attachedClients: 1 });
const jobRow = parked(JOB);
const rows = [chatRow, jobRow];
const chats = new Set([CHAT]);
const input = { attached: chats, pool: new Set<string>(), now, idleMs: 15 * MIN, chats };

test("the VP chat's transcript reads as parked until 02:03:20Z, and a passed, resumed or answered park does not", () => {
  assert.equal(quotaParkedUntil(tail, now), resumeAt);
  assert.equal(quotaParkedUntil(tail, resumeAt + 1), null, "the park's time has passed");
  const resumed = `${tail}${JSON.stringify({ type: "custom", customType: "provider_quota_resume", data: { outcome: "wake" } })}\n`;
  assert.equal(quotaParkedUntil(resumed, now), null);
  const queued = `${tail}${JSON.stringify({ type: "custom", customType: "pi-pool-queue", data: {} })}\n`;
  assert.equal(quotaParkedUntil(queued, now), null, "a turn queued since the park is no park");
  const worked = `${tail}${JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop", content: [] } })}\n`;
  assert.equal(quotaParkedUntil(worked, now), null, "a reply since the park is no park");
});

test("a chat and a job parked on the quota 70 s ago stop at the next sweep, where the plan before waited out ENDED_MS or the quiet window", () => {
  assert.ok(now - parkedAt < ENDED_MS);
  assert.deepEqual(unloadPlan(rows, input), [], "without the park reading neither stops yet");
  const candidates = parkCandidates(rows, input);
  assert.deepEqual(candidates.map(row => row.sessionId).sort(), [CHAT, JOB].sort());
  const found = new Map(candidates.flatMap(row => { const until = quotaParkedUntil(tail, now); return until === null ? [] : [[row.sessionId, until] as const]; }));
  assert.deepEqual(unloadPlan(rows, { ...input, parked: found }).map(row => row.sessionId).sort(), [CHAT, JOB].sort());
  for (const change of [{ attachedClients: 2 }, { isBashRunning: true }, { activity: "working" }, { hasRunningRlmChildren: true },
    { sessionActions: { queuedCount: 1, steering: [], followUps: [] } }] as Partial<SessionSummary>[]) {
    assert.deepEqual(unloadPlan([{ ...chatRow, ...change }], { ...input, parked: found }), [], JSON.stringify(change));
  }
});

test("the sweep lets go of the parked chat's attach, stops both, and writes quota park receipts", async () => {
  const calls: string[] = [], lines: string[] = [], receipts: UnloadReceipt[] = [];
  const idle: DaemonAnswer = { success: true, data: { activity: "idle", isSessionActive: false, isStreaming: false, isCompacting: false, isBashRunning: false, isRunningTools: false } };
  const unloader = new IdleUnloader({
    rows: () => rows, localRows: () => rows, idleMs: () => 15 * MIN, chats: async () => chats, dormant: () => false, pool: async () => new Set(),
    waking: async () => new Set(), held: async () => new Map(),
    parked: async (candidates, at) => new Map(candidates.flatMap(row => { const until = quotaParkedUntil(tail, at); return until === null ? [] : [[row.sessionId, until] as const]; })),
    release: async id => { calls.push(`release ${id}`); return true; }, own: async () => new Map(), restNow: async () => false, title: () => null,
    request: async (row, type) => { calls.push(`${type} ${row.sessionId}`); return type === "get_state" ? idle : { success: true }; },
    stopped: async () => {}, receipt: async receipt => { receipts.push(receipt); }, log: line => lines.push(line), now: () => now,
  });
  await unloader.sweep();
  await unloader.settled();
  assert.ok(calls.indexOf(`release ${CHAT}`) < calls.indexOf(`kill ${CHAT}`), calls.join(", "));
  assert.ok(calls.includes(`kill ${JOB}`));
  assert.ok(!calls.includes(`release ${JOB}`));
  assert.deepEqual(receipts.filter(receipt => receipt.phase === "stopped").map(receipt => receipt.why), ["quota park", "quota park"]);
  assert.match(lines.join("\n"), /parked on its provider quota until 02:03Z/);
});
