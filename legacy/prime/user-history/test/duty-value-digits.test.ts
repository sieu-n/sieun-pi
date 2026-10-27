// Guards the digits of a red duty's value. At 22:57Z on 10-27 d9 listed metal-management d3 as "profiles_p95_s 0.4 against <= 0.4", a red
// that read as met, since one decimal printed its 0.44 equal to the 0.4 target.
import assert from "node:assert/strict";
import { test } from "node:test";
import { judge, shownValue } from "../src/shared/chat-duties.ts";

test("a value one decimal would print equal to its target gets the places that tell them apart", () => {
  assert.equal(shownValue(0.44, 0.4), "0.44");
  assert.equal(shownValue(0.401, 0.4), "0.401");
  assert.equal(shownValue(13.24, 10), "13.2");
  assert.equal(shownValue(0.4, 0.4), "0.4");
  assert.equal(shownValue(5.24), "5.2");
});

test("the run summary prints metal d3's 0.44 so it reads off target", () => {
  const judged = judge([{ key: "profiles_p95_s", label: "Profile reads", op: "<=", target: 0.4, unit: " s", headline: true }], { metrics: { profiles_p95_s: 0.44 } }, { now: 0, runs: [] });
  assert.match(judged.summary, /profiles_p95_s 0\.44 s \(target at most 0\.4 s\)/);
});
