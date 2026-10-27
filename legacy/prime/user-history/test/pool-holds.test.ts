// Guards the 10-18 case where pi-pool refused 01a14eaf at 15:55Z on a backoff draw for 16:45Z while claude12, krenerd77 and claude3 took its
// class, it got no account until 16:38Z, and the Whole system duty (d7) read queue_holds_30 and queued_free_slot_min_30 as 0.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measure, readPoolLog } from "../scripts/duties/whole-system.ts";
import type { WatchLine } from "../src/mac-usable-watch.ts";

const RUN = Date.parse("2026-10-18T16:40:10Z");
const at = (clock: string): number => Date.parse(`2026-10-18T${clock}Z`) / 1000;
const parked = (session: string, clock: string, room: string[], slot = "16:45:26"): string =>
  JSON.stringify({ ts: "local", event: "parked", provider: "anthropic", session, at: at(clock), account: "sieun@virev.ai (Virev)", slot_at: at(slot), backoff: true, priority: "high", room });
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

test("a tree given a cell 2 min ahead that asks no more is held only to that cell, as 01a14fff was at 17:11Z on 10-18", () => {
  const [hold] = readPoolLog([parked("d", "16:20:00", ["krenerd77@naver.com"], "16:21:42")], RUN);
  assert.equal(hold!.to - hold!.from, 102_000);
  assert.equal(measure({ now: RUN, watch, log: { holds: [] }, chats: [], pool: [hold!] }).metrics.queue_holds_30, 0);
});

test("a tree refused again and again on short cells while accounts have room stays one hold to its last cell", () => {
  const lines = ["16:10:00", "16:12:00", "16:14:00", "16:16:00", "16:18:00", "16:20:00", "16:22:00"].map((clock, i, all) => parked("e", clock, ["claude3@slack.green"], all[i + 1] ?? "16:24:00"));
  const [hold] = readPoolLog([...lines, unparked("e", "16:24:00")], RUN);
  assert.deepEqual([hold!.from, hold!.to], [at("16:10:00") * 1000, at("16:24:00") * 1000]);
  assert.equal(measure({ now: RUN, watch, log: { holds: [] }, chats: [], pool: [hold!] }).metrics.queue_holds_30, 1);
});

test("a low tree whose every refusal waited for a cell is R4's pace with no slot free: a cell hold, out of queue_holds_30 and with its minutes clean, as 01a15005 was from 17:18Z on 10-18 and 8 duty fix subagents were at 14:52Z on 10-19", () => {
  const cellWait = (clock: string, slot: string): string => JSON.stringify({ ts: "local", event: "parked", provider: "anthropic", session: "f", at: at(clock), account: "krenerd77@naver.com",
    slot_at: at(slot), backoff: false, priority: "low", room: ["krenerd77@naver.com", "claude11@slack.green"] });
  const lines = ["16:10:00", "16:11:00", "16:13:00", "16:15:00", "16:18:00", "16:21:00", "16:25:00"].map((clock, i, all) => cellWait(clock, all[i + 1] ?? "16:30:00"));
  const pool = readPoolLog([...lines, unparked("f", "16:30:00")], RUN);
  assert.deepEqual(pool.map(hold => hold.cell), [true]);
  const { metrics, flagged } = measure({ now: RUN, watch, log: { holds: [] }, chats: [], pool });
  assert.equal(metrics.queue_holds_30, 0);
  assert.equal(metrics.cell_holds_30, 1);
  assert.equal(metrics.queued_free_slot_min_30, 0);
  assert.equal(metrics.cell_wait_min_30, 11);
  assert.equal(metrics.clean_min_30, 30);
  assert.match(flagged?.find(slice => slice.kind === "queue_hold")?.excerpt ?? "", /waiting for a cell of krenerd77@naver\.com, claude11@slack\.green at R4's pace/);
});
