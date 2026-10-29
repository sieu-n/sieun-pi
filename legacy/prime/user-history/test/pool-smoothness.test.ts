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

test("a park reads its tree's priority at the time a later tree got in, since a chat moves its jobs between low and normal", () => {
  // 10-22: 01a1642b asked as normal at 19:56Z, as low from 20:04Z to 01:08Z and as normal again at 03:01Z; 01a164b6, normal, entered
  // claude19 at 20:13Z, and the reader that took the last refusal's priority counted 427 min passed.
  const smooth = readSmoothness([
    parked("a", "10:00:00"), parked("a", "10:04:00", "low"), parked("b", "10:05:00"), unparked("b", "10:13:00"),
    parked("c", "10:06:00", "low"), unparked("c", "10:31:00"), parked("a", "10:40:00"), unparked("a", "10:52:00"),
  ], new Set(), FROM, RUN);
  assert.deepEqual(smooth.overtaken, [{ session: "c", minutes: 0 }, { session: "a", minutes: 21 }]);
});

test("a chat head's or an owner's turn starts first by design, so its tree passes no parked job tree", () => {
  // 10-23 13:52Z: 01a166c3, parked since 11:15Z, read as passed for 28.5 min by 01a1301d, a chat head that parked at 11:21Z and entered
  // krenerd77 at 13:06Z, and 01a16657 by 01a168dd, an owner turn that entered claude3 at 13:07Z.
  const owner = JSON.stringify({ ts: "2026-10-21T10:20:00", event: "turn_admitted", session: "o", tree: "o", kind: "owner", waited_s: 0 });
  const smooth = readSmoothness([
    parked("a", "10:00:00"), parked(HEAD, "10:05:00"), admitted(HEAD, "2026-10-21T10:10:00", 0), unparked(HEAD, "10:10:00"),
    parked("o", "10:15:00"), owner, unparked("o", "10:20:00"), unparked("a", "10:45:00"),
    parked("b", "10:46:00"), parked("j", "10:47:00"), admitted("j", "2026-10-21T10:48:00", 0), unparked("j", "10:48:00"), unparked("b", "10:59:00"),
  ], new Set([HEAD]), FROM, RUN);
  assert.deepEqual(smooth.overtaken.filter(park => park.minutes > 0), [{ session: "b", minutes: 11 }]);
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

// 10-24 on us-metal02: the ops guy chat 01a11af8 parked at 00:59:37Z for claude-virev7 at 01:00Z, and the wait line named vend claude20, so its
// head's two requests went out on claude20 and its turn ended at 00:59:57Z. Its tree asked again only at 01:12:26Z, a job run that left the
// turn queue after 1,114 s, while 01a1692f, parked at 01:00Z, entered claude12 at 01:06:46Z; d7's 01:31Z run read 01a11af8 as passed for 12.5 min.
test("a park whose wait vends the tree's own account meanwhile is served, and a 429 on that account makes it a hold again", () => {
  const OPS = "01a11af8-962e-773d-a19a-ee4104011987", LATER = "01a1692f-c189-716e-8951-d0eb45e758e3";
  const day = (clock: string): number => Date.parse(`2026-10-24T${clock}Z`) / 1000;
  const park = (session: string, clock: string, account: string): string =>
    JSON.stringify({ ts: `2026-10-24T${clock}`, event: "parked", provider: "anthropic", session, at: day(clock), account, slot_at: day("01:00:00"), priority: "normal", room: [account] });
  const wait = (session: string, clock: string, account: string, vend: string | null): string =>
    JSON.stringify({ ts: `2026-10-24T${clock}`, event: "wait", provider: "anthropic", session, account, slot_at: "2026-10-24T01:00:00", priority: "normal", vend, left: vend ? "budget_overrun" : null });
  const enter = (session: string, clock: string, account: string): string =>
    JSON.stringify({ ts: `2026-10-24T${clock}`, event: "unparked", provider: "anthropic", session, at: day(clock), account });
  const limited = (session: string, clock: string): string =>
    JSON.stringify({ ts: `2026-10-24T${clock}`, event: "limited", provider: "anthropic", account: "claude20@slack.green", session, until: "2026-10-24T03:00:00", next: null });
  const lines = (extra: string[]) => [
    park(OPS, "00:59:37", "claude-virev7@slack.green"), wait(OPS, "00:59:37", "claude-virev7@slack.green", "claude20@slack.green"),
    park(OPS, "00:59:54", "claude-virev7@slack.green"), ...extra,
    park(LATER, "01:00:10", "claude12@slack.green"), wait(LATER, "01:00:10", "claude12@slack.green", null), enter(LATER, "01:06:46", "claude12@slack.green"),
    enter(OPS, "01:12:27", "claude-virev7@slack.green")];
  const window = [Date.parse("2026-10-24T01:01:00Z"), Date.parse("2026-10-24T01:31:00Z")] as const;
  const served = readSmoothness(lines([]), new Set(), ...window);
  assert.deepEqual(served.overtaken, [{ session: LATER, minutes: 0 }, { session: OPS, minutes: 0 }]);
  const refused = readSmoothness(lines([limited(OPS, "00:59:58")]), new Set(), ...window);
  assert.deepEqual(refused.overtaken, [{ session: LATER, minutes: 0 }, { session: OPS, minutes: 5.7 }]);
});


// 10-28 on us-metal02: 01a18453 waited as high from 21:12:18Z for claude-virev5, its chat moved it to normal at 21:23:27Z, and 01a17edb, a high
// tree that parked at 21:14:30Z, entered claude-virev5 at 21:24:00Z. pi-pool ranks a waiter by its priority now, so a high tree went first; d7's
// 00:21Z run on 10-29 read 01a18453 as passed for 163.5 min because its parked lines up to then said high.
test("a park reads the priority line its chat wrote while it waited", () => {
  const priority = (session: string, ts: string, value: string, previous: string): string =>
    JSON.stringify({ ts, event: "priority", session, priority: value, previous });
  const smooth = readSmoothness([
    parked("a", "10:00:00", "high"), parked("hi", "10:05:00", "high"), priority("a", "2026-10-21T10:09:00", "normal", "high"),
    unparked("hi", "10:10:00"), unparked("a", "10:52:00"),
  ], new Set(), FROM, RUN);
  assert.deepEqual(smooth.overtaken, [{ session: "a", minutes: 0 }]);
});

// 10-28 on us-metal02: 01a11d25 parked at 21:12:02Z for claude-virev5's 21:20Z cell with vend claude5, its turn ran on claude5 and ended at
// 21:12:12Z, and it asked nothing until 00:19:29Z, when claude5 refused it and it entered krenerd77 38 s later. d7's 00:21Z run on 10-29 read it
// as passed for 186.1 min by 01a14210, which entered claude-virev5 at 21:14:01Z while 01a11d25 ran on claude5.
test("a park that ran on its own account is held only from the 429 on that account", () => {
  const wait = (session: string, clock: string, vend: string): string =>
    JSON.stringify({ ts: `2026-10-21T${clock}`, event: "wait", provider: "anthropic", session, account: "claude5@slack.green", slot_at: "x", priority: "normal", vend, left: "depleted" });
  const limited = (session: string, clock: string): string =>
    JSON.stringify({ ts: `2026-10-21T${clock}`, event: "limited", provider: "anthropic", account: "claude21@slack.green", session, until: "x", next: null });
  const idle = readSmoothness([
    parked("a", "10:00:00"), wait("a", "10:00:00", "claude21@slack.green"),
    parked("b", "10:02:00"), unparked("b", "10:05:00"),
    parked("a", "10:40:00"), wait("a", "10:40:00", "claude21@slack.green"), limited("a", "10:40:00"), unparked("a", "10:41:00"),
  ], new Set(), FROM, RUN).overtaken;
  assert.deepEqual(idle, [{ session: "a", minutes: 0 }]);
  // A tree that parked later and got in after the 429 still passes it.
  const passed = readSmoothness([
    parked("a", "10:00:00"), wait("a", "10:00:00", "claude21@slack.green"), parked("c", "10:03:00"),
    parked("a", "10:20:00"), wait("a", "10:20:00", "claude21@slack.green"), limited("a", "10:20:00"),
    unparked("c", "10:30:00"), unparked("a", "10:45:00"),
  ], new Set(), FROM, RUN).overtaken;
  assert.deepEqual(passed, [{ session: "c", minutes: 0 }, { session: "a", minutes: 15 }]);
});
