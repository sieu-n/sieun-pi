// Guards the 10-18 case where pi-pool refused 01a14eaf at 15:55Z on a backoff draw for 16:45Z while claude12, krenerd77 and claude3 took its
// class, it got no account until 16:38Z, and the Whole system duty (d7) read queue_holds_30 and queued_free_slot_min_30 as 0.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measure, readPoolLog } from "../scripts/duties/whole-system.ts";
import type { WatchLine } from "../src/mac-usable-watch.ts";

const RUN = Date.parse("2026-10-18T16:40:10Z");
const at = (clock: string): number => Date.parse(`2026-10-18T${clock}Z`) / 1000;
const parked = (session: string, clock: string, room: string[]): string =>
  JSON.stringify({ ts: "local", event: "parked", provider: "anthropic", session, at: at(clock), account: "sieun@virev.ai (Virev)", slot_at: at("16:45:26"), backoff: true, priority: "high", room });
const unparked = (session: string, clock: string): string => JSON.stringify({ ts: "local", event: "unparked", provider: "anthropic", session, at: at(clock), account: "claude9@slack.green" });
const line = (minute: number): WatchLine => ({ at: new Date(RUN - 10_000 - (30 - minute) * 60_000 + 30_000).toISOString(), usable: { pressureLevel: 1, swapoutsPerS: 0, kernelTaskPct: 10 },
  workers: 0, workerGb: 0, top: [], live: 0, working: 0, queue: null, mac: { swapGb: null, pressureLevel: 1 }, cpuMs: 0 });
const watch = Array.from({ length: 30 }, (_, minute) => line(minute));
const D7 = "01a14eaf-4e31-75db-881f-08ce73e78a41";

test("a tree refused with room at 15:55Z and given an account at 16:38Z is one hold, and its minutes past 10 min are free-slot minutes", () => {
  const pool = readPoolLog([parked(D7, "15:55:32", ["claude12@slack.green", "krenerd77@naver.com", "claude3@slack.green"]), unparked(D7, "16:38:20")], RUN);
  assert.deepEqual(pool.map(hold => [hold.from, hold.to]), [[at("15:55:32") * 1000, at("16:38:20") * 1000]]);
  const { metrics, flagged } = measure({ now: RUN, watch, log: { holds: [] }, chats: [], pool });
  assert.equal(metrics.queue_holds_30, 1);
  // 16:10Z to 16:38Z: the window starts at 16:10Z, past the hold's first 10 min (16:05:32Z), and the hold ends in the 16:38Z minute.
  assert.equal(metrics.queued_free_slot_min_30, 29);
  assert.equal(metrics.clean_min_30, 1);
  assert.match(flagged?.find(slice => slice.kind === "queue_hold")?.excerpt ?? "", /^pi-pool refused 01a14eaf-4e31-75db-881f-08ce73e78a41 for 43 min, 15:55Z to 16:38Z, while claude12@slack\.green/);
});

test("a tree still parked with room at the run is held up to now", () => {
  const [hold] = readPoolLog([parked(D7, "16:20:00", ["claude3@slack.green"])], RUN);
  assert.equal(hold?.to, RUN);
  assert.equal(measure({ now: RUN, watch, log: { holds: [] }, chats: [], pool: [hold!] }).metrics.queue_holds_30, 1);
});

test("refusals with no room are a depleted pool waiting for rotation, and a cell wait under 10 min is pace, so neither is a hold", () => {
  const pool = readPoolLog([parked("a", "16:00:00", []), parked("a", "16:30:00", []), parked("b", "16:31:00", ["claude3@slack.green"]), unparked("b", "16:33:00"),
    parked("c", "16:10:00", ["claude4@slack.green"]), parked("c", "16:15:00", []), "{not json", ""], RUN);
  assert.deepEqual(pool.map(hold => [hold.session, (hold.to - hold.from) / 60_000]), [["b", 2], ["c", 5]]);
  const { metrics } = measure({ now: RUN, watch, log: { holds: [] }, chats: [], pool });
  assert.equal(metrics.queue_holds_30, 0);
  assert.equal(metrics.queued_free_slot_min_30, 0);
});
