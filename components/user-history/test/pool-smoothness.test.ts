// Guards d7's smoothness numbers for the owner's t86 answer on 10-21 ("just make it work smooth"): on 10-20 and 10-21 chat head runs waited
// a p90 of 139 s and 426 s in pi-pool's turn queue, and parked trees slept a p90 of 36 and 120 min after a later tree of their class got an account.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measure, readPoolLog, readSmoothness } from "../scripts/duties/whole-system.ts";

const RUN = Date.parse("2026-10-21T11:00:00Z");
const FROM = RUN - 30 * 60_000;
const at = (clock: string): number => Date.parse(`2026-10-21T${clock}Z`) / 1000;
const HEAD = "01a115e2-9544-7204-b8db-8ce4d5319048";
const admitted = (session: string, ts: string, waited: number): string =>
  JSON.stringify({ ts, event: "turn_admitted", session, tree: session, kind: "slot", waited_s: waited });
const parked = (session: string, clock: string, priority = "normal"): string =>
  JSON.stringify({ ts: "local", event: "parked", provider: "anthropic", session, at: at(clock), account: "claude5@slack.green", slot_at: at(clock) + 60, priority, room: [] });
const unparked = (session: string, clock: string): string =>
  JSON.stringify({ ts: "local", event: "unparked", provider: "anthropic", session, at: at(clock), account: "claude5@slack.green" });

test("only chat head runs admitted in the window count, and a KST stamp reads as its UTC time", () => {
  const smooth = readSmoothness([
    parked("x", "10:31:00"), unparked("x", "10:31:30"),
    admitted(HEAD, "2026-10-21T10:40:00", 300),
    admitted("job", "2026-10-21T10:41:00", 900),
    admitted(HEAD, "2026-10-21T19:45:00", 20),
    admitted(HEAD, "2026-10-21T10:20:00", 2000),
  ], new Set([HEAD]), FROM, RUN);
  assert.deepEqual(smooth.headWaits, [300, 20]);
  assert.equal(measure({ now: RUN, watch: [], log: { holds: [] }, chats: [], smooth }).metrics.head_queue_wait_p90_s, 300);
});

test("a park counts the minutes after a later tree of its priority or lower got an account, and a later high tree passes nobody", () => {
  const smooth = readSmoothness([
    parked("a", "10:00:00"), parked("hi", "10:02:00", "high"), unparked("hi", "10:35:00"),
    parked("b", "10:05:00", "low"), unparked("b", "10:40:00"),
    unparked("a", "10:50:00"),
  ], new Set(), FROM, RUN);
  assert.deepEqual(smooth.overtaken, [{ session: "hi", minutes: 0 }, { session: "b", minutes: 0 }, { session: "a", minutes: 10 }]);
  const { metrics, flagged } = measure({ now: RUN, watch: [], log: { holds: [] }, chats: [], smooth });
  assert.equal(metrics.parked_overtaken_min_p90, 10);
  assert.match(flagged?.find(slice => slice.kind === "smoothness")?.excerpt ?? "", /1 of them stayed parked .*: a 10 min\.$/);
});

test("a parked line with no backoff field waited for a cell, as pi-pool writes it since it dropped the random draw", () => {
  const line = JSON.stringify({ ts: "local", event: "parked", provider: "anthropic", session: "c", at: at("10:00:00"), slot_at: at("10:20:00"), priority: "normal", room: ["claude5@slack.green"] });
  const [hold] = readPoolLog([line], RUN);
  assert.equal(hold?.cell, true);
});
