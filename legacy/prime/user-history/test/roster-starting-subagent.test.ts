// Guards the 10-18 owner report on us-metal02: the chat page threw each_key_duplicate about every 3 s while a chat's new job was listed twice.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { agentIdOf, applyRosterUpdate, rosterMerge, rowKey } from "../src/session-peer.ts";

/**
 * On 10-18 from 06:59Z the metal-management chat's row listed "daemon reload recovery" and "stop lane extras" twice each under the keys
 * child:sub-54809f40 and child:sub-809723b5. The daemon's first roster entry for a starting subagent names its child id as its session id
 * and has no session file, and this box's copy kept that row beside the real one until its next full list.
 */
const parent = "01a14d31-6ec0-7005-bbe8-c38b7ae73cfb";
const parentSessionPath = `/home/sieun/.prime/agent/sessions/${parent}.jsonl`;
const starting = { id: "sub-54809f40", sessionId: "sub-54809f40", rlmChildId: "sub-54809f40", runtimeKind: "subagent", parentSessionId: parent, parentSessionPath,
  sessionName: "daemon reload recovery", lifecycle: "live" } as unknown as SessionSummary;
const real = { ...starting, id: "633f5db76b55", sessionId: "01a14dce-3425-7478-9b5f-a1a7a116b6c7", activeSessionId: "633f5db76b55",
  sessionFile: `/home/sieun/.prime/agent/session-artifacts/${parent}/sub-54809f40/01a14dce-3425-7478-9b5f-a1a7a116b6c7.jsonl` } as unknown as SessionSummary;
const other = { ...starting, parentSessionId: "01a14dd5-e9d3-705d-bd63-245c21b2eee2", parentSessionPath: "/x/01a14dd5.jsonl" } as unknown as SessionSummary;
const children = (rows: ReadonlyMap<string, SessionSummary>) => [...rows.values()].filter(row => row.rlmChildId === "sub-54809f40").map(row => row.sessionId);

test("a starting subagent's roster row gives way to its real row in a roster update", () => {
  const agents = new Map<string, string>();
  const rows = new Map<string, SessionSummary>();
  applyRosterUpdate(rows, agents, { changed: [{ agentId: agentIdOf(starting), status: "running", summary: starting }] });
  assert.deepEqual(children(rows), ["sub-54809f40"]);
  applyRosterUpdate(rows, agents, { changed: [{ agentId: agentIdOf(real), status: "running", summary: real }] });
  assert.deepEqual(children(rows), ["01a14dce-3425-7478-9b5f-a1a7a116b6c7"]);
});

test("a roster list drops the starting row its real row replaces, and keeps another parent's starting row with the same child id", () => {
  const rows = new Map([[rowKey(starting), starting]]);
  assert.deepEqual(children(rosterMerge(rows, [real])), ["01a14dce-3425-7478-9b5f-a1a7a116b6c7"]);
  const elsewhere = new Map([[rowKey(other), other]]);
  assert.deepEqual(children(rosterMerge(elsewhere, [real])).sort(), ["01a14dce-3425-7478-9b5f-a1a7a116b6c7", "sub-54809f40"]);
});
