// Guards d7's queue_holds_30 1 at 01:22Z on 10-30: sep launch!! (01a15427), a chat on the owner's Mac, parked at 00:43:52Z in a dark wake, the
// Mac slept until 01:13:42Z, when its tree asked again and got claude-virev14, and d7 read the park as passed for 27.9 min by a later tree.
// Tailscale read the Mac offline in every watch line of that span, and tailscaled got packets from it only at 00:43:47Z, 01:00:08Z and 01:13:42Z.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measure, offlineMs, readSmoothness, treeOffline } from "../scripts/duties/whole-system.ts";
import type { WatchLine } from "../src/mac-usable-watch.ts";

const RUN = Date.parse("2026-10-30T01:22:00Z");
const FROM = RUN - 30 * 60_000;
const SEP = "01a15427-145f-751d-ba15-d27b6c30f65f";
const at = (clock: string): number => Date.parse(`2026-10-30T${clock}Z`) / 1000;
const parked = (session: string, clock: string): string =>
  JSON.stringify({ ts: "local", event: "parked", provider: "anthropic", session, at: at(clock), account: "claude-virev13@slack.green", slot_at: at(clock) + 8, priority: "high", room: [] });
const unparked = (session: string, clock: string): string =>
  JSON.stringify({ ts: "local", event: "unparked", provider: "anthropic", session, at: at(clock), account: "claude-virev14@slack.green" });
const box = { kind: "linux", memSomeAvg10: 0, memFullAvg10: 0, cpuSomeAvg10: 0, swapoutsPerS: 0, runnablePerCore: 0.4, allowedCpus: 80 } as const;
const watchLine = (clock: string, macOffline: boolean): WatchLine => ({ host: "us-metal02", at: `2026-10-30T${clock}.000Z`, usable: box, workers: 0, workerGb: 0,
  top: [], live: 0, working: 0, queue: null, mac: { swapGb: null, pressureLevel: null }, cpuMs: 0,
  hosts: [{ name: "mac", usable: macOffline ? null : { pressureLevel: 1, swapoutsPerS: 0, kernelTaskPct: 25 }, workers: 0, workerGb: 0, top: [], live: 0, working: 0, swapGb: null,
    ...macOffline ? { offline: true, error: "offline, Tailscale last seen 15 min ago" } : {} }] } as WatchLine);
const minutes = (first: string, last: string): string[] => {
  const out: string[] = [];
  for (let t = Date.parse(`2026-10-30T${first}Z`); t <= Date.parse(`2026-10-30T${last}Z`); t += 60_000) out.push(new Date(t).toISOString().slice(11, 19));
  return out;
};
const pool = [parked(SEP, "00:43:52"), parked(SEP, "00:43:56"), parked("01a18a1d-0d8c-7399-8bf1-3ce0cbb5d1d1", "00:44:20"),
  unparked("01a18a1d-0d8c-7399-8bf1-3ce0cbb5d1d1", "00:45:48"), unparked(SEP, "01:13:42")];
const hosts = new Map([[SEP, "mac"]]);

test("a park of a tree whose box Tailscale read offline the whole time it was passed counts no minutes", () => {
  const watch = minutes("00:40:30", "01:21:30").map(clock => watchLine(clock, true));
  const smooth = readSmoothness(pool, new Set(), FROM, RUN, treeOffline(watch, hosts));
  assert.deepEqual(smooth.overtaken.find(park => park.session === SEP), { session: SEP, minutes: 0, offline: 27.9 });
  const { metrics, flagged } = measure({ now: RUN, watch: [], log: { holds: [] }, chats: [], smooth });
  assert.equal(metrics.parked_overtaken_over_10min, 0);
  assert.equal(metrics.queue_holds_30, 0);
  assert.match(flagged?.find(slice => slice.kind === "smoothness")?.excerpt ?? "", /Left out as their box read offline: 01a15427 27\.9 min\./);
});

test("only the minutes the box read online count, so a park held while its box was up is still a hold", () => {
  const watch = minutes("00:40:30", "01:21:30").map(clock => watchLine(clock, clock < "00:58:00"));
  const smooth = readSmoothness(pool, new Set(), FROM, RUN, treeOffline(watch, hosts));
  const park = smooth.overtaken.find(entry => entry.session === SEP);
  // Offline from 00:45:48Z to the 00:58:30Z line, online from there to 01:13:42Z.
  assert.equal(park?.minutes, 15.2);
  assert.equal(measure({ now: RUN, watch: [], log: { holds: [] }, chats: [], smooth }).metrics.queue_holds_30, 1);
});

test("a tree on a box with no offline reading, or on no listed box, keeps its passed minutes", () => {
  const watch = minutes("00:40:30", "01:21:30").map(clock => watchLine(clock, true));
  assert.equal(readSmoothness(pool, new Set(), FROM, RUN, treeOffline(watch, new Map())).overtaken.find(park => park.session === SEP)?.minutes, 27.9);
  assert.equal(offlineMs(watch, "us-metal02", Date.parse("2026-10-30T00:45:48Z"), Date.parse("2026-10-30T01:13:42Z")), 0);
});

test("each watch line covers the time to the next, so a stopped service's extra line adds nothing", () => {
  const watch = [watchLine("01:00:30", true), watchLine("01:01:12", true), watchLine("01:01:30", true)];
  assert.equal(offlineMs(watch, "mac", Date.parse("2026-10-30T01:00:30Z"), Date.parse("2026-10-30T01:02:30Z")), 2 * 60_000);
  assert.equal(offlineMs([watchLine("01:00:30", true), watchLine("01:20:30", true)], "mac", Date.parse("2026-10-30T01:00:30Z"), Date.parse("2026-10-30T01:20:30Z")), 2 * 60_000);
});
