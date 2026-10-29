// Guards d1's death causes against the crawler's CODE_CAUSES. On 2026-10-28 the crawler's canary stop began counting only the deaths cause_of calls
// instagram (auto-sns-agent a92e4b001), and this copy lacked checkpoint_required, the jar check's verdict on prod 62, 262 and 267 on 10-18.
import assert from "node:assert/strict";
import { test } from "node:test";
import { causeOf } from "../scripts/duties/engage-reads.ts";

test("a checkpoint_required death after a served page is an Instagram kill, and before one a first-login refusal", () => {
  assert.equal(causeOf({ code: "checkpoint_required", readBefore: true }), "instagram");
  assert.equal(causeOf({ code: "checkpoint_required", readBefore: false }), "first_login");
});

test("a code the map does not hold stays unknown", () => {
  assert.equal(causeOf({ code: "login_required", readBefore: true }), "unknown");
});

// prod 163 went relogin_gone on 10-28 09:53Z after 385 pages in 24 h, and prod 24 relogin_bad_password at 12:10Z; d1 called both "cause unknown".
test("the re-login worker's verdicts carry their real causes", () => {
  assert.equal(causeOf({ code: "relogin_gone", readBefore: true }), "instagram");
  assert.equal(causeOf({ code: "relogin_gone", readBefore: false }), "first_login");
  assert.equal(causeOf({ code: "relogin_bad_password", readBefore: true }), "bad_password");
  assert.equal(causeOf({ code: "relogin_two_factor", readBefore: true }), "ours");
});
