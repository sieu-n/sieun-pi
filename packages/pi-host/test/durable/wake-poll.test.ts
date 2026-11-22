/**
 * Held children read their wakes out of step (children.ts `wakeSleepMs`): the first sleep is a random part of the poll interval and every
 * later one the whole interval, so children held at the same moment spread their reads over the interval and keep that spread.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { wakeSleepMs } from "../../src/durable/children.ts";

test("two children held together first read their wakes at different points of the interval, then once per interval", () => {
  const poll = 30_000;
  const firsts = Array.from({ length: 200 }, () => wakeSleepMs(true, poll));
  for (const ms of firsts) assert.ok(ms >= 0 && ms < poll, `a first sleep of ${ms} ms stays inside one interval`);
  assert.ok(Math.min(...firsts) < poll / 10 && Math.max(...firsts) > (poll * 9) / 10, "first sleeps spread over the whole interval");
  const [a, b] = [wakeSleepMs(true, poll, () => 0.1), wakeSleepMs(true, poll, () => 0.7)];
  assert.equal(b - a, 18_000, "two children 0.1 and 0.7 of the way in read 18 s apart");
  assert.equal(wakeSleepMs(false, poll), poll, "a later sleep is the whole interval, so the two stay 18 s apart");
});
