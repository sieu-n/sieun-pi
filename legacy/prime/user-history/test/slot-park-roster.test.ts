// Replays 01a17f25 (test/fixtures/slot-park-01a17f25-1028.jsonl) through the agents panel: a parked job shows its place in pi-pool's line.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as chatAgents from "../src/chat-agents.ts";
import { cutEnd } from "../src/cut-end.ts";
import type { ChatAgent } from "../src/shared/types.ts";
import { slotParkOf } from "../src/slot-park.ts";
import { at, ID, LISTED, PARKED } from "./slot-park-replay.ts";

test("agents panel: a parked job is no cut and shows its place in pi-pool's line", () => {
  assert.equal(cutEnd(PARKED), null, "not 'stopped on a provider error'");
  const agent: ChatAgent = { key: `thread:${ID}`, sessionId: ID, name: "page writer", job: "page writer", sender: "page writer", link: "root", state: "failed", steps: ["p9"] };
  const park = slotParkOf(PARKED, ID, at("2026-10-27T21:14:00Z"), LISTED)!;
  const [shown] = chatAgents.withSlotParks([agent], new Map([[ID, park]]));
  assert.equal(shown!.state, "working");
  assert.equal(chatAgents.agentLines([shown!], at("2026-10-27T21:14:00Z"))[1], "- page writer: waits for a working slot, place 61 of 170 (p9)");
});
