// Guards d1's on-hand count. On 2026-10-19 at 15:06Z the capacity line read 170 prod accounts on hand and 165 healthy, so the heal goal p168 read
// 5 that could not read. 3 of them (23, 27 and 28) were rows auto-sns-agent's engage_world_move.py export parked on 10-18 at 16:54:47Z when it moved
// them to staging, where they read on as 245 and 246 (244 waits on a re-login). Only 73 and 75, parked by hand on 10-12, were on hand and unable to read.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Account, MOVED_PREFIX, onHandOf } from "../scripts/duties/engage-reads.ts";

const MOVE = `${MOVED_PREFIX}prod->staging@2026-10-18T16:54:47.557871+00:00`;
const HAND_PARK = "fleet canary: never served a page; keep first contact out of the 1000/day canary";

test("a row parked by a world move is not on hand, and a hand-parked or active one is", () => {
  const accounts: Account[] = [
    ...Array.from({ length: 165 }, (_, i) => ({ id: 100 + i, status: "active" })),
    { id: 23, status: "parked", reason: MOVE }, { id: 27, status: "parked", reason: MOVE }, { id: 28, status: "parked", reason: MOVE },
    { id: 73, status: "parked", reason: HAND_PARK }, { id: 75, status: "parked", reason: HAND_PARK },
    { id: 62, status: "challenged", reason: "jar check 03:0xZ 10-18: HTTP 400 checkpoint_required" },
  ];
  const onHand = onHandOf(accounts);
  assert.equal(onHand.length, 167);
  assert.equal(onHand.length - 165, 2, "prod 10-19: 2 on hand that cannot read, 73 and 75");
  assert.deepEqual(onHand.filter(account => account.status === "parked").map(account => account.id), [73, 75]);
});
