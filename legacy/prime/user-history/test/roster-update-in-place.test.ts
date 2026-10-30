// Guards the 10-30 us-metal02 chat GC fix: a roster update changes the copy's row map in place instead of copying all of its rows.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { agentIdOf, applyRosterUpdate, rowKey } from "../src/session-peer.ts";

const row = (n: number, live = false): SessionSummary => ({ id: `a${n}`, sessionId: `01a18ad3-0000-7000-8000-${String(n).padStart(12, "0")}`,
  ...live ? { activeSessionId: `a${n}` } : {}, lifecycle: live ? "live" : "saved", sessionFile: `/tmp/s${n}.jsonl` }) as unknown as SessionSummary;

test("a roster update changes the given map and leaves every other row the same object", () => {
  const rows = new Map(Array.from({ length: 1000 }, (_, n) => [rowKey(row(n)), row(n)] as const));
  const before = [...rows.values()];
  const agents = new Map<string, string>();
  const unknown = applyRosterUpdate(rows, agents, { changed: [{ agentId: agentIdOf(row(5, true)), status: "running", summary: row(5, true) }] });
  assert.equal(unknown, false);
  assert.equal(rows.size, 1000);
  assert.equal(rows.get(rowKey(row(5)))?.activeSessionId, "a5");
  for (const [n, kept] of before.entries()) if (n !== 5) assert.equal(rows.get(rowKey(kept)), kept);
});

test("a removed agent's row turns saved in place, and an agent the rows cannot place asks for a catch-up", () => {
  const rows = new Map<string, SessionSummary>();
  const agents = new Map<string, string>();
  applyRosterUpdate(rows, agents, { changed: [{ agentId: agentIdOf(row(1, true)), status: "running", summary: row(1, true) }] });
  assert.equal(applyRosterUpdate(rows, agents, { removed: [agentIdOf(row(1, true))] }), false);
  assert.equal(rows.get(rowKey(row(1)))?.activeSessionId, undefined);
  assert.equal(applyRosterUpdate(rows, agents, { removed: ["nobody"] }), true);
});

test("a removed agent missing from the agent index is found by its row", () => {
  const live = row(2, true);
  const rows = new Map([[rowKey(live), live]]);
  assert.equal(applyRosterUpdate(rows, new Map(), { removed: [agentIdOf(live)] }), false);
  assert.equal(rows.get(rowKey(live))?.activeSessionId, undefined);
});
