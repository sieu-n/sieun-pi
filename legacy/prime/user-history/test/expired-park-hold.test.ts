// On 10-29 the outbox held a message to designer bro on the Mac at 23:04Z "while the target waits for its pi-pool slot at 19:30:01Z": the Mac
// went offline at 18:39Z, its last catalog row kept Prime's credentialPark, and a labelled park counted as open long after its resumeAt.
// Ending such parks in poolPark itself made the chat's first projections after a restart wait on the offline Mac, so only the outbox does.
import assert from "node:assert/strict";
import { test } from "node:test";
import { messageHold, poolPark, primePark } from "../src/slot-park.ts";

const ID = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";
const EMPTY = { queued: new Map(), working: new Set<string>() };
/** designer bro's row in the Mac's catalog copy saved at 18:43Z on 10-29. */
const row = { sessionId: ID, taskState: "waiting", summary: "Waiting for its pi-pool slot at 19:30:01Z",
  credentialPark: { waitingFor: "its pi-pool slot at 19:30:01Z", waitingSince: "2026-10-29T17:47:33.530Z", resumeAt: "2026-10-29T19:30:01.000Z" } };
const before = Date.parse("2026-10-29T18:40:00Z");
const after = Date.parse("2026-10-29T23:04:36Z");

test("a message waits for Prime's park until its resumeAt and goes after it when the pool lists the session nowhere", () => {
  const park = primePark(row)!;
  assert.deepEqual(messageHold(park, ID, before, EMPTY), park);
  assert.equal(messageHold(park, ID, after, EMPTY), null);
});

test("a message still waits on an expired park the pool queues or runs", () => {
  const queued = { queued: new Map([[ID, { position: 3, total: 9 }]]), working: new Set<string>() };
  assert.equal(messageHold(primePark(row)!, ID, after, queued)?.place, 3);
  assert.equal(messageHold(primePark(row)!, ID, after, { queued: new Map(), working: new Set([ID]) })?.starting, true);
});

test("poolPark keeps Prime's labelled park for the catalog and the check-in, as before", () => {
  assert.deepEqual(poolPark(primePark(row)!, ID, after, EMPTY), primePark(row));
});
