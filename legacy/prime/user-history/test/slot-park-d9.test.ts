// Replays 01a17f25 (test/fixtures/slot-park-01a17f25-1028.jsonl) through d9's step owner read: a job parked on a slot owns its steps.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as wholeSystem from "../scripts/duties/whole-system.ts";
import { agentDir, at, CHAT, DROPPED, EMPTY, ID, LISTED, PARKED } from "./slot-park-replay.ts";

test("d9: a step owner parked on a slot is a live owner, and one whose park Prime dropped is not", async () => {
  const board = { v: 2 as const, rev: 1, updatedAt: "", todos: [], plan: [{ id: "p9", text: "Write the page", status: "doing" as const, sessionId: ID, children: [] }] };
  const boards = new Map([[CHAT, board]]);
  const now = at("2026-10-27T21:14:00Z");
  assert.deepEqual([...await wholeSystem.poolWaitingOwners(await agentDir(PARKED), boards, new Map(), async () => LISTED, now)], [ID]);
  assert.deepEqual([...await wholeSystem.poolWaitingOwners(await agentDir(DROPPED), boards, new Map(), async () => EMPTY, at("2026-10-27T21:18:00Z"))], []);
});
