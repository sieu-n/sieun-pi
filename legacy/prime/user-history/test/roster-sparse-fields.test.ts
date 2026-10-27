// Guards d7's quiet_agent_gb on us-metal02 from 10-27: slot holders read as waiting, so their trees counted as quiet.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { agentState } from "../src/agent-states.ts";
import { agentIdOf, applyRosterUpdate, rosterMerge, rowKey } from "../src/session-peer.ts";

/**
 * Prime's daemon row names `waitingFor` only while pi-pool's context step holds the model call, and `directAttachedClients` only above 0.
 * At 04:24Z on 10-27 `prime-agent list` named 12 sessions working, each on a pi-pool slot, while the chat's watch line counted 1.
 */
const base = { id: "a1", sessionId: "01a17acc-82fa-7095-9a6b-1bf196c98562", activeSessionId: "a1", lifecycle: "live", activity: "working",
  isSessionActive: true, isStreaming: true, isCompacting: false, isRunningTools: false, attachedClients: 0, workerPid: 249340,
  sessionFile: "/home/sieun/.prime/agent/sessions/01a17acc-82fa-7095-9a6b-1bf196c98562.jsonl" } as unknown as SessionSummary;
const queued = { ...base, waitingFor: "a turn, place 2 of 58", waitingSince: "2026-10-27T03:30:00.000Z", directAttachedClients: 1,
  holdsDetachedProcesses: true } as unknown as SessionSummary;
const row = (rows: ReadonlyMap<string, SessionSummary>) => rows.get(rowKey(base)) as SessionSummary & Record<string, unknown>;

test("a roster update without waitingFor clears the wait, so the run that got its slot reads working", () => {
  const agents = new Map<string, string>();
  const first = applyRosterUpdate(new Map(), agents, { changed: [{ agentId: agentIdOf(queued), status: "running", summary: queued }] }).rows;
  assert.equal(agentState(row(first)), "retry");
  const next = applyRosterUpdate(first, agents, { changed: [{ agentId: agentIdOf(base), status: "running", summary: base }] }).rows;
  assert.equal(agentState(row(next)), "working");
  for (const field of ["waitingFor", "waitingSince", "directAttachedClients", "holdsDetachedProcesses"]) assert.equal(field in row(next), false, field);
});

test("a roster list without waitingFor clears it too", () => {
  const next = rosterMerge(new Map([[rowKey(queued), queued]]), [base]);
  assert.equal(agentState(row(next)), "working");
  assert.equal(row(next).directAttachedClients, undefined);
});
