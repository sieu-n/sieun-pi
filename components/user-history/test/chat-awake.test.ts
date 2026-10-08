import assert from "node:assert/strict";
import { test } from "node:test";
import { AWAKE_RELEASE_MS, awakeAction, IdleSleepHold, type Hold } from "../src/chat-awake.ts";

test("awake action: hold while a chat or job works, let go 2 min after the last work, never two holds", () => {
  assert.equal(AWAKE_RELEASE_MS, 120_000);
  assert.equal(awakeAction({ working: true, holding: false, lastWorkAt: 0, now: 0 }), "start");
  assert.equal(awakeAction({ working: true, holding: true, lastWorkAt: 0, now: 0 }), null, "one hold at most");
  assert.equal(awakeAction({ working: false, holding: true, lastWorkAt: 0, now: 119_999 }), null);
  assert.equal(awakeAction({ working: false, holding: true, lastWorkAt: 0, now: 120_000 }), "stop");
  assert.equal(awakeAction({ working: false, holding: false, lastWorkAt: 0, now: 999_999 }), null);
  assert.equal(awakeAction({ working: false, holding: false, lastWorkAt: null, now: 0 }), null);
});

test("idle sleep hold: one caffeinate child while work runs, killed 2 min after it stops and at close; restarted if it dies; a no-op off macOS", () => {
  let now = 0;
  const events: string[] = [];
  const exits: (() => void)[] = [];
  const start = (): Hold => { const n = events.filter(event => event === "start").length + 1; events.push("start");
    return { kill: () => events.push(`kill ${n}`), exited: listener => { exits[n] = listener; } }; };
  const hold = new IdleSleepHold(() => {}, { platform: "darwin", now: () => now, start });
  hold.update(false);
  assert.deepEqual(events, []);
  hold.update(true);
  now += 30_000; hold.update(true);
  assert.deepEqual(events, ["start"], "one child while work goes on");
  now += 90_000; hold.update(false);
  assert.equal(hold.holding, true, "90 s after the last work: still held");
  now += 30_000; hold.update(false);
  assert.deepEqual(events, ["start", "kill 1"], "2 min after the last work: released");
  hold.update(true);
  exits[2]!();
  assert.equal(hold.holding, false, "caffeinate died");
  hold.update(true);
  assert.deepEqual(events, ["start", "kill 1", "start", "start"]);
  hold.close();
  assert.deepEqual(events.at(-1), "kill 3", "close kills it");
  hold.update(true);
  assert.equal(events.length, 5, "nothing after close");

  const linux = new IdleSleepHold(() => {}, { platform: "linux", now: () => now, start });
  linux.update(true);
  assert.equal(linux.holding, false);
  assert.equal(events.length, 5);
});
