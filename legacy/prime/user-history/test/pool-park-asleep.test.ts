// Guards d7's queue_holds_30 1 at 09:32Z on 11-01: SEO guy (01a11a24), a low chat on us-metal02, missed claude16's 09:14:00Z cell by asking at
// 09:14:40Z, was given the 09:15:30Z cell, and asked pi-pool nothing until 09:25:42Z. 01a19659, low and parked at 09:03:09Z, entered the
// 09:14:30Z cell at 09:14:31Z, so d7 read SEO guy as passed for 11.2 min. pi-pool admits only a tree that asks, and nobody took the 09:15:30Z
// cell, so the 10.4 min after its cells came due were the tree's own wait. The lines below are pi-pool.log's for the three low trees.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measure, readSmoothness } from "../scripts/duties/whole-system.ts";

const RUN = Date.parse("2026-11-01T09:32:00Z");
const FROM = RUN - 30 * 60_000;
const SEO = "01a11a24-a46e-77ff-adf7-671d01d462e2", LATER = "01a19659-11bd-70be-9c9d-db53e1f84008", AHEAD = "01a1963d-9f8f-7674-b82b-caf22b7c1c19";
const at = (clock: string): number => Date.parse(`2026-11-01T${clock}Z`) / 1000;
const park = (session: string, clock: string, account: string, slot: string): string =>
  JSON.stringify({ ts: `2026-11-01T${clock}`, event: "parked", provider: "anthropic", session, at: at(clock), account: `${account}@slack.green`, slot_at: at(slot), priority: "low", room: [] });
const enter = (session: string, clock: string): string =>
  JSON.stringify({ ts: `2026-11-01T${clock}`, event: "unparked", provider: "anthropic", session, at: at(clock), account: "claude16@slack.green" });
const served = (session: string, clock: string, vend: string): string =>
  JSON.stringify({ ts: `2026-11-01T${clock}`, event: "wait", provider: "anthropic", session, account: `${vend}@slack.green`, slot_at: "x", priority: "low", vend: `${vend}@slack.green`, left: "limited" });
const limited = (session: string, clock: string, account: string): string =>
  JSON.stringify({ ts: `2026-11-01T${clock}`, event: "limited", provider: "anthropic", account: `${account}@slack.green`, session, until: "x", next: null });
const low = (session: string, clock: string): string => JSON.stringify({ ts: `2026-11-01T${clock}`, event: "priority", session, priority: "low", previous: "normal" });
const pool = [
  low(AHEAD, "08:33:08"),
  park(AHEAD, "08:33:09", "claude16", "09:07:30"),
  park(SEO, "08:34:22", "claude-virev18", "09:08:00"),
  served(SEO, "08:34:22", "claude-virev18"),
  park(SEO, "08:34:23", "claude-virev18", "09:08:00"),
  limited(SEO, "08:34:23", "claude-virev18"),
  low(LATER, "09:03:08"),
  park(LATER, "09:03:09", "claude16", "09:10:00"),
  park(AHEAD, "09:07:32", "claude16", "09:10:30"),
  park(SEO, "09:08:02", "claude16", "09:11:00"),
  park(LATER, "09:10:00", "claude16", "09:11:30"),
  park(LATER, "09:11:30", "claude16", "09:12:00"),
  park(AHEAD, "09:11:32", "claude16", "09:12:30"),
  park(SEO, "09:11:32", "claude16", "09:13:00"),
  park(LATER, "09:12:00", "claude16", "09:13:30"),
  park(AHEAD, "09:12:04", "claude16", "09:13:30"),
  park(SEO, "09:12:32", "claude-virev18", "09:14:00"),
  park(AHEAD, "09:12:32", "claude16", "09:13:30"),
  park(LATER, "09:13:32", "claude16", "09:14:00"),
  park(AHEAD, "09:13:42", "claude-virev18", "09:14:00"),
  park(SEO, "09:13:42", "claude16", "09:14:00"),
  park(LATER, "09:14:05", "claude16", "09:14:30"),
  enter(LATER, "09:14:31"),
  park(AHEAD, "09:14:40", "claude16", "09:15:00"),
  park(SEO, "09:14:40", "claude16", "09:15:30"),
  enter(AHEAD, "09:15:09"),
  enter(SEO, "09:25:42"),
];

test("a park whose tree asked nothing after its own cell came due counts none of that time as passed", () => {
  const smooth = readSmoothness(pool, new Set(), FROM, RUN);
  assert.deepEqual(smooth.overtaken.find(entry => entry.session === SEO), { session: SEO, minutes: 0.8, asleep: 10.4 });
  const { metrics, flagged } = measure({ now: RUN, watch: [], log: { holds: [] }, chats: [], smooth });
  assert.equal(metrics.parked_overtaken_over_10min, 0);
  assert.equal(metrics.queue_holds_30, 0);
  assert.match(flagged?.find(slice => slice.kind === "smoothness")?.excerpt ?? "", /Left out as their tree asked pi-pool nothing after its own cell came due: 01a11a24 10\.4 min\./);
});

test("a park whose tree asked at each cell and was refused is still passed", () => {
  const asked = [...pool.slice(0, -1), park(SEO, "09:15:31", "claude16", "09:20:00"), park(SEO, "09:20:01", "claude16", "09:25:30"), park(SEO, "09:25:31", "claude16", "09:26:00"), enter(SEO, "09:25:42")];
  const smooth = readSmoothness(asked, new Set(), FROM, RUN);
  assert.deepEqual(smooth.overtaken.find(entry => entry.session === SEO), { session: SEO, minutes: 11, asleep: 0.2 });
  assert.equal(measure({ now: RUN, watch: [], log: { holds: [] }, chats: [], smooth }).metrics.queue_holds_30, 1);
});
