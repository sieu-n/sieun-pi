// From 00:54Z to 09:01Z on 11-08 pi-pool booked waiting trees a new cell on unsampled krenerd77 or claude12 every 180 s. The outbox held a
// message to such a session only until the slot its file named, then sent it into the next wait, where it sat as a queued steer, and the idle
// unload keeps a session with queued input. At 05:15Z 48 of the 59 sessions in such waits held one, and d7 read 13.66 GB with nobody working.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cellHold, fileSlotPark, messageHold } from "../src/slot-park.ts";

const at = (clock: string): number => Date.parse(`2026-11-08T${clock}Z`);
const failure = (asked: string, cell: string): string => JSON.stringify({ type: "message", timestamp: `2026-11-08T${asked}Z`, message: { role: "assistant",
  content: [], stopReason: "error", errorMessage: `token hook gave no token (credential_unavailable): pi-pool: this session waits for its slot at 2026-11-08T${cell}Z.` } });
const park = fileSlotPark([failure("09:00:06.761", "09:03:06.000")]).park;
const now = at("09:03:41");

test("a message past the slot waits while pi-pool lets the tree in at no open cell, and goes once it does", async () => {
  assert.equal(messageHold(park, "01a18928", now, null), null, "the slot passed, so the old hold let it go");
  assert.notEqual(await cellHold(park, async () => false), null, "pi-pool holds the tree at a cell on unsampled krenerd77");
  assert.equal(await cellHold(park, async () => true), null, "pi-pool admits the tree");
  assert.equal(await cellHold(park, async () => { throw new Error("pi-pool did not answer"); }), null, "a failed read holds nothing");
  assert.equal(await cellHold(fileSlotPark([JSON.stringify({ type: "message", timestamp: "2026-11-08T09:00:00Z", message: { role: "assistant", content: [], stopReason: "stop" } })]).park, async () => false), null,
    "a session whose turn ran waits on no slot");
});
