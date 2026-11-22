import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRemind } from "../../web/src/pages/channel/remind-command.ts";

// Wed 2026-11-18 14:30 local time.
const now = new Date(2026, 10, 18, 14, 30).getTime();
const local = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const read = (args: string) => {
  const out = parseRemind(args, now);
  return out.ok ? [out.text, out.at] : out.error;
};

test("/remind me reads the text and a time in minutes, hours or days from now", () => {
  assert.deepEqual(read("me call the bank in 20 min"), ["call the bank", now + 20 * 60_000]);
  assert.deepEqual(read("me to stretch in an hour"), ["stretch", now + 3_600_000]);
  assert.deepEqual(read("check the deploy in 2h"), ["check the deploy", now + 7_200_000]);
  assert.deepEqual(read("me renew the cert in 3 days"), ["renew the cert", now + 3 * 86_400_000]);
});

test("/remind me reads tomorrow, today, a weekday and a clock time", () => {
  assert.deepEqual(read("me standup notes tomorrow 9am"), ["standup notes", local(19, 9)]);
  assert.deepEqual(read("me standup notes tomorrow"), ["standup notes", local(19, 9)]);
  assert.deepEqual(read("me pay rent tomorrow at 3:15 pm"), ["pay rent", local(19, 15, 15)]);
  assert.deepEqual(read("me ship it at 5pm"), ["ship it", local(18, 17)]);
  assert.deepEqual(read("me ship it at 9am"), ["ship it", local(19, 9)], "a clock time already past today is tomorrow");
  assert.deepEqual(read("me lunch today at noon tomorrow"), ["lunch today at noon", local(19, 9)]);
  assert.deepEqual(read("me review on monday"), ["review", local(23, 9)]);
  assert.deepEqual(read("me review wednesday 10:00"), ["review", local(25, 10)], "the same weekday is next week");
});

test("/remind without a time or text, or with a time past, says how to write it", () => {
  assert.match(read("me call the bank") as string, /Say what and when/);
  assert.match(read("me in 20 min") as string, /Say what and when/);
  assert.match(read("") as string, /Say what and when/);
  assert.match(read("me x today at 9am") as string, /passed/);
  assert.match(read("me x at 13pm") as string, /Say what and when/);
});
