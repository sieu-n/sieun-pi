// Guards d7's quiet_agent_gb on us-metal02 from 10-27: slot holders read as waiting, so their trees counted as quiet.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { agentState } from "../src/agent-states.ts";
import { agentIdOf, applyRosterUpdate, rosterMerge, rowKey } from "../src/session-peer.ts";
import { effortOffDefault } from "../scripts/duties/whole-system.ts";

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
  const rows = new Map<string, SessionSummary>();
  applyRosterUpdate(rows, agents, { changed: [{ agentId: agentIdOf(queued), status: "running", summary: queued }] });
  assert.equal(agentState(row(rows)), "retry");
  applyRosterUpdate(rows, agents, { changed: [{ agentId: agentIdOf(base), status: "running", summary: base }] });
  assert.equal(agentState(row(rows)), "working");
  for (const field of ["waitingFor", "waitingSince", "directAttachedClients", "holdsDetachedProcesses"]) assert.equal(field in row(rows), false, field);
});

test("a roster list without waitingFor clears it too", () => {
  const next = rosterMerge(new Map([[rowKey(queued), queued]]), [base]);
  assert.equal(agentState(row(next)), "working");
  assert.equal(row(next).directAttachedClients, undefined);
});

test("a session that leaves the roster loses its loaded model and effort, so d7 no longer counts it off high", () => {
  // The Mac's copy row of 01a20f99 on 11-24: loaded at thinking off, unloaded at 22:09:52Z and archived at 22:16Z, while the copy showed it
  // loaded until the full list at 22:30:52Z.
  const loaded = { ...base, sessionId: "01a20f99-ce36-74f3-80b8-1d835e261806", id: "5f3b4fa25d4a", activeSessionId: "5f3b4fa25d4a",
    sessionFile: "/Users/sieunpark/.prime/agent/sessions/01a20f99-ce36-74f3-80b8-1d835e261806.jsonl", runtimeKind: "top-level",
    model: { id: "claude-opus-5-5", provider: "anthropic" }, thinkingLevel: "off" } as unknown as SessionSummary;
  const counted = (rows: ReadonlyMap<string, SessionSummary>) => effortOffDefault([{ host: "mac", text: JSON.stringify({ version: 1, fullAt: 0, rows: [...rows.values()] }) }],
    { model: "claude-opus-5-5", thinking: "high" }, () => false).off.length;
  const agents = new Map<string, string>();
  const rows = new Map<string, SessionSummary>();
  applyRosterUpdate(rows, agents, { changed: [{ agentId: agentIdOf(loaded), status: "running", summary: loaded }] });
  assert.equal(counted(rows), 1);
  applyRosterUpdate(rows, agents, { removed: [agentIdOf(loaded)] });
  assert.equal(counted(rows), 0, "a roster_update that removed it");
  assert.equal((rows.get(rowKey(loaded)) as unknown as Record<string, unknown>).runtimeKind, "top-level", "the row keeps what a saved row lists");
  assert.equal(counted(rosterMerge(new Map([[rowKey(loaded), loaded]]), [])), 0, "a roster list that no longer has it");
});
