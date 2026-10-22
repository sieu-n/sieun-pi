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
const queued = (session: string, ts: string): string => JSON.stringify({ ts, event: "turn_queued", session, tree: session, working: 12, queued: 100 });
const parked = (session: string, clock: string, priority = "normal"): string =>
  JSON.stringify({ ts: "local", event: "parked", provider: "anthropic", session, at: at(clock), account: "claude5@slack.green", slot_at: at(clock) + 60, priority, room: [] });
const unparked = (session: string, clock: string): string =>
  JSON.stringify({ ts: "local", event: "unparked", provider: "anthropic", session, at: at(clock), account: "claude5@slack.green" });

test("only chat head runs admitted in the window count, and a KST stamp reads as its UTC time", () => {
  const smooth = readSmoothness([
    parked("x", "10:31:00"), unparked("x", "10:31:30"),
    queued(HEAD, "2026-10-21T10:35:00"),
    admitted("job", "2026-10-21T10:38:00", 900),
    admitted(HEAD, "2026-10-21T10:40:00", 300),
    admitted("job", "2026-10-21T10:41:00", 900),
    admitted(HEAD, "2026-10-21T19:45:00", 20),
    admitted(HEAD, "2026-10-21T10:20:00", 2000),
  ], new Set([HEAD]), FROM, RUN);
  assert.deepEqual(smooth.headWaits.map(run => run.waitedS), [300, 20]);
  const { metrics } = measure({ now: RUN, watch: [], log: { holds: [] }, chats: [], smooth });
  assert.equal(metrics.head_queue_wait_p90_s, 300);
  // The 300 s run is over HEAD_WAIT_S and a job run started at 10:38 while it waited, so it counts as a hold; the 20 s run does not.
  assert.equal(metrics.head_waits_over_30s, 1);
  assert.equal(metrics.queue_holds_30, 1);
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
  // a waited exactly 10 min past b, which is not over HOLD_MS.
  assert.equal(metrics.parked_overtaken_over_10min, 0);
  assert.equal(metrics.queue_holds_30, 0);
  assert.match(flagged?.find(slice => slice.kind === "smoothness")?.excerpt ?? "", /0 of them stayed parked over 10 min .*, p90 10 min\.$/);
});

test("a park passed by a later tree for over 10 min is a hold in queue_holds_30", () => {
  const smooth = readSmoothness([parked("a", "10:00:00"), parked("b", "10:05:00"), unparked("b", "10:31:00"), unparked("a", "10:52:00")], new Set(), FROM, RUN);
  const { metrics, flagged } = measure({ now: RUN, watch: [], log: { holds: [] }, chats: [], smooth });
  assert.equal(metrics.parked_overtaken_over_10min, 1);
  assert.equal(metrics.queue_holds_30, 1);
  assert.match(flagged?.find(slice => slice.kind === "smoothness")?.excerpt ?? "", /\(a 21 min\)/);
});

test("a parked line with no backoff field waited for a cell, as pi-pool writes it since it dropped the random draw", () => {
  const line = JSON.stringify({ ts: "local", event: "parked", provider: "anthropic", session: "c", at: at("10:00:00"), slot_at: at("10:20:00"), priority: "normal", room: ["claude5@slack.green"] });
  const [hold] = readPoolLog([line], RUN);
  assert.equal(hold?.cell, true);
});

test("a chat head that waited for a free slot while no job run started ahead of it is the box's slot count, not a hold, as at 03:27Z on 10-22", () => {
  const smooth = readSmoothness([
    JSON.stringify({ ts: "2026-10-21T10:39:00", event: "turn_admitted", session: "owner-run", tree: "owner-run", kind: "owner", waited_s: 0 }),
    admitted(HEAD, "2026-10-21T10:40:00", 195),
  ], new Set([HEAD]), FROM, RUN);
  assert.deepEqual(smooth.headWaits, [{ session: HEAD, waitedS: 195, passed: false }]);
  const { metrics, flagged } = measure({ now: RUN, watch: [], log: { holds: [] }, chats: [], smooth });
  assert.equal(metrics.head_waits_over_30s, 0);
  assert.equal(metrics.head_waits_full_box, 1);
  assert.equal(metrics.queue_holds_30, 0);
  assert.match(flagged?.find(slice => slice.kind === "smoothness")?.excerpt ?? "", /0 of them passed by a job run and the rest waited for a free slot/);
});

test("a tree that a Manual pin let in passes no parked tree, as sieunpark77's pinned trees did from 05:43Z on 10-22", () => {
  const vend = (session: string, reason: string): string => JSON.stringify({ ts: "local", event: "vend", provider: "anthropic", account: "x", reason, session });
  const smooth = readSmoothness([
    parked("a", "10:00:00"), parked("pin", "10:05:00"), unparked("pin", "10:31:00"), vend("pin", "session_pin"),
    parked("b", "10:06:00"), unparked("b", "10:35:00"), vend("b", "switch"),
    unparked("a", "10:52:00"), vend("a", "switch"),
  ], new Set(), FROM, RUN);
  assert.deepEqual(smooth.overtaken, [{ session: "b", minutes: 0 }, { session: "a", minutes: 17 }]);
});

test("a job run that took the slot a head's own run let go, before the head's next run queued, passes nobody, as at 15:16:00Z on 10-22", () => {
  const smooth = readSmoothness([
    JSON.stringify({ ts: "2026-10-21T10:39:00", event: "turn_released", session: HEAD, kind: "slot", held_s: 40 }),
    admitted("job", "2026-10-21T10:39:00", 1921),
    queued(HEAD, "2026-10-21T10:39:00"),
    admitted(HEAD, "2026-10-21T10:40:16", 76.6),
  ], new Set([HEAD]), FROM, RUN);
  assert.deepEqual(smooth.headWaits, [{ session: HEAD, waitedS: 76.6, passed: false }]);
  const { metrics } = measure({ now: RUN, watch: [], log: { holds: [] }, chats: [], smooth });
  assert.equal(metrics.head_waits_over_30s, 0);
  assert.equal(metrics.queue_holds_30, 0);
});

test("a job run the queue started while a head waited in line passes it", () => {
  const smooth = readSmoothness([queued(HEAD, "2026-10-21T10:39:00"), admitted("job", "2026-10-21T10:39:30", 900), admitted(HEAD, "2026-10-21T10:40:16", 76.6)],
    new Set([HEAD]), FROM, RUN);
  assert.deepEqual(smooth.headWaits, [{ session: HEAD, waitedS: 76.6, passed: true }]);
});

test("a tree pinned to its account neither passes nor is passed, as 01a11ba8 on claude8 from 15:19Z to 16:30Z on 10-22", () => {
  const manual = (line: string): string => JSON.stringify({ ...JSON.parse(line) as object, manual: true });
  const smooth = readSmoothness([
    manual(parked("pin", "10:00:00", "high")), parked("a", "10:01:00", "high"), unparked("a", "10:02:00"),
    parked("b", "10:03:00"), manual(parked("pin2", "10:04:00")), manual(unparked("pin2", "10:05:00")),
    unparked("b", "10:40:00"), manual(unparked("pin", "10:50:00")),
  ], new Set(), FROM, RUN);
  assert.deepEqual(smooth.overtaken, [{ session: "b", minutes: 0 }]);
});

test("a vend with no unparked line before it ends the park, as 01a15ede's claude19 vend at 16:28Z on 10-22", () => {
  const vend = (session: string): string => JSON.stringify({ ts: "local", event: "vend", provider: "anthropic", account: "x", reason: "switch", session });
  const smooth = readSmoothness([
    parked("a", "10:00:00"), vend("a"),
    parked("b", "10:05:00"), unparked("b", "10:06:00"), vend("b"),
    parked("a", "10:40:00"), unparked("a", "10:41:00"), vend("a"),
  ], new Set(), FROM, RUN);
  assert.deepEqual(smooth.overtaken, [{ session: "a", minutes: 0 }]);
});
