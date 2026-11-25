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

test("a row parked on a refused password is not on hand, since no code logs it in again (prod 24, 280 and 282 to 294, 10-28 to 11-25)", () => {
  const accounts: Account[] = [
    { id: 15, status: "active" },
    { id: 24, status: "parked", reason: "relogin_bad_password: phase refused" },
    { id: 282, status: "parked", reason: "bad_password from a burst of new-IP intake logins; stored password matches the vendor file (rule 4)" },
    { id: 21, status: "parked", reason: "valid jar, no live route: account_authority_changed" },
  ];
  assert.deepEqual(onHandOf(accounts).map(account => account.id), [15, 21]);
});
