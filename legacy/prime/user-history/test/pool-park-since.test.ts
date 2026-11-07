// Guards d7's queue_holds_30 9 at 23:27Z on 11-07, all of them parks of pi-pool's own order misread. Its 8 MB tail of pi-pool.log began at
// about 20:40Z, so it took each park's first line in the tail as its start: pi-durable:72ba1ed2 and 8 more high trees, waiting since 20:00Z to
// 20:37Z, logged a refusal every 30 s and read as parked from 20:40Z, while 01a189cd, high and waiting since 18:52Z, asked less often, read as
// parked later, entered claude11 at 21:08Z and so passed them for 91 to 116 min. pi-pool ranks waiters by their wait start (sched.tree_rank),
// which each parked line names as `since` from 11-08. With the 14 h tail one park was left, 01a1b6e6, passed for 84.8 min by a tree that
// entered after pi-pool dropped the cell of sleeping 01a1b6e6.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measure, readSmoothness } from "../scripts/duties/whole-system.ts";

const RUN = Date.parse("2026-11-07T23:27:49Z");
const FROM = RUN - 30 * 60_000;
const at = (clock: string): number => Date.parse(`2026-11-07T${clock}Z`) / 1000;
const park = (session: string, clock: string, slot: string, priority: string, since?: string): string =>
  JSON.stringify({ ts: `2026-11-07T${clock}`, event: "parked", provider: "anthropic", session, at: at(clock), account: "claude12@slack.green", slot_at: at(slot),
    ...since ? { since: at(since) } : {}, priority, room: [] });
const enter = (session: string, clock: string, account = "claude16"): string =>
  JSON.stringify({ ts: `2026-11-07T${clock}`, event: "unparked", provider: "anthropic", session, at: at(clock), account: `${account}@slack.green` });
const holds = (lines: string[]): number => measure({ now: RUN, watch: [], log: { holds: [] }, chats: [], smooth: readSmoothness(lines, new Set(), FROM, RUN) }).metrics.queue_holds_30!;
const minutes = (lines: string[], session: string): number | undefined =>
  readSmoothness(lines, new Set(), FROM, RUN).overtaken.find(entry => entry.session === session)?.minutes;

const EARLY = "01a189cd-4f2a-7400-8f95-5ad51d000000", DURABLE = "pi-durable:72ba1ed2-0000-4000-8000-000000000000";
// The tail's first lines: the durable tree asks every 30 s, so its line comes first, and the tree that waits from earlier asks a minute later.
const cut = (since: boolean): string[] => {
  const lines: string[] = [];
  for (let s = at("20:40:05"); s < at("23:03:00"); s += 30) {
    const clock = new Date(s * 1000).toISOString().slice(11, 19);
    lines.push(park(DURABLE, clock, new Date((s + 30) * 1000).toISOString().slice(11, 19), "high", since ? "20:00:47" : undefined));
  }
  lines.splice(3, 0, park(EARLY, "20:41:30", "21:08:00", "high", since ? "18:52:46" : undefined));
  lines.push(enter(EARLY, "21:08:00", "claude11"), enter(DURABLE, "23:03:00"));
  return lines.sort((a, b) => (JSON.parse(a) as { at: number }).at - (JSON.parse(b) as { at: number }).at);
};

test("a park that began before the log tail ranks by the wait start its parked line names", () => {
  assert.equal(minutes(cut(false), DURABLE), 115, "the old lines name no wait start, so the tail's first line stands in for it");
  assert.equal(minutes(cut(true), DURABLE), 0);
  assert.equal(holds(cut(true)), 0);
});

test("a tree whose wait began after the park's and entered first still passes it", () => {
  const LATER = "01a1b84f-1560-72b2-a99b-ef5895000000";
  const lines = [...cut(true), park(LATER, "21:00:00", "21:10:00", "high", "21:00:00"), enter(LATER, "21:10:00", "claude11")]
    .sort((a, b) => (JSON.parse(a) as { at: number }).at - (JSON.parse(b) as { at: number }).at);
  assert.equal(minutes(lines, DURABLE), 113);
  assert.equal(holds(lines), 1);
});

const SLEPT = "01a1b6e6-a5a7-7374-b8f6-41af8d000000", PASSER = "01a1a3bd-e24c-7329-8570-000000000000";
const slept = [
  park(SLEPT, "16:45:33", "16:50:00", "normal"),
  park(SLEPT, "16:49:48", "16:54:00", "normal"),
  park(PASSER, "18:00:07", "18:03:30", "normal"),
  park(PASSER, "18:15:35", "18:17:00", "normal"),
  enter(PASSER, "18:17:03"),
  park(SLEPT, "19:19:45", "19:22:46", "normal"),
  park(SLEPT, "19:22:46", "19:26:00", "normal"),
  park(SLEPT, "21:54:47", "21:58:00", "normal"),
  ...Array.from({ length: 26 }, (_, i) => {
    const s = at("21:58:00") + i * 180;
    return park(SLEPT, new Date(s * 1000).toISOString().slice(11, 19), new Date((s + 180) * 1000).toISOString().slice(11, 19), "normal");
  }),
  enter(SLEPT, "23:15:30"),
];

test("a tree that entered after pi-pool dropped the cell of the park's sleeping tree did not pass it", () => {
  assert.equal(minutes(slept, SLEPT), 0);
  assert.equal(holds(slept), 0);
});

test("a tree that entered while the park's tree asked at each cell passes it", () => {
  const LATER = "01a1b532-2c96-70a1-9f5b-0391da000000";
  const lines = [...slept.slice(0, -1), park(LATER, "22:00:00", "22:10:00", "normal"), enter(LATER, "22:10:00"), slept.at(-1)!]
    .sort((a, b) => (JSON.parse(a) as { at: number }).at - (JSON.parse(b) as { at: number }).at);
  assert.equal(minutes(lines, SLEPT), 65.5);
  assert.equal(holds(lines), 1);
});
