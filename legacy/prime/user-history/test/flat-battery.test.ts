// Guards d7's 14:05Z and 14:06Z minutes on 11-02: the MacBook Pro ran on battery down to 4% at 14:01:13Z and 2% at 14:07:39Z, when it took AC,
// both its Prime workers' event loops stalled 5 to 38 s with no span from 14:01:51Z to 14:07:26Z, and opens to designer bro and demo sandbox
// works frontend bro took 50 to 57 s, so d7 read 28 of 30 though no harness code was slow.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePmsetBatt } from "../../../../components/prime-relay/host-stats.ts";
import { FLAT_BATTERY_PCT, flatBattery, measure } from "../scripts/duties/whole-system.ts";
import { parseUsableRaw, type UsableReading, type WatchLine } from "../src/mac-usable-watch.ts";

const RUN = Date.parse("2026-11-02T14:10:03Z");
const box = { kind: "linux", memSomeAvg10: 0, memFullAvg10: 0, cpuSomeAvg10: 0, swapoutsPerS: 0, runnablePerCore: 0.4, allowedCpus: 80 } as const;
const minuteAt = (minute: number): number => Math.floor(RUN / 60_000) * 60_000 - (30 - minute) * 60_000;
const mac = (battery?: UsableReading["battery"]): UsableReading => ({ pressureLevel: 1, swapoutsPerS: 0, kernelTaskPct: 18, ...battery ? { battery } : {} });
const line = (minute: number, battery?: UsableReading["battery"]): WatchLine => ({ host: "us-metal02",
  at: new Date(minuteAt(minute) + 30_000).toISOString(), usable: box, workers: 0, workerGb: 0, top: [], live: 0, working: 0, queue: null,
  mac: { swapGb: null, pressureLevel: null }, cpuMs: 0,
  hosts: [{ name: "mac", usable: mac(battery), workers: 0, workerGb: 0, top: [], live: 0, working: 0, swapGb: null }] } as WatchLine);
const slowOpen = (minute: number) => ({ at: minuteAt(minute) + 50_000, host: "mac", session: "01a11ba8", what: "opening it failed, attach timed out after 30 s" });
const run = (battery: (minute: number) => UsableReading["battery"]) => measure({ now: RUN, log: { holds: [] }, chats: [],
  watch: Array.from({ length: 30 }, (_, minute) => line(minute, battery(minute))), daemonFaults: [slowOpen(25), slowOpen(26)] });

test("a Mac on battery at FLAT_BATTERY_PCT or less is offline that minute, and its daemon calls are left out", () => {
  const out = run(minute => minute < 21 ? { pct: 50 - 2 * minute, ac: false } : { pct: Math.max(2, 25 - minute), ac: minute > 27 });
  assert.equal(out.metrics.clean_min_30, 30);
  assert.equal(out.metrics.daemon_fail_min_30, 0);
  assert.equal(out.metrics.offline_min_30_mac, 7);
  assert.match(out.flagged?.find(slice => slice.kind === "offline_minutes")?.excerpt ?? "", /7 of these a Mac ran on battery at 4% or less, which stalls its workers \(14:01Z mac at 4%, /);
});

test("the same slow opens stay dirty on a charged battery, on AC at 2% and with no battery read", () => {
  assert.equal(run(() => ({ pct: FLAT_BATTERY_PCT + 1, ac: false })).metrics.clean_min_30, 28);
  assert.equal(run(() => ({ pct: 2, ac: true })).metrics.clean_min_30, 28);
  assert.equal(run(() => undefined).metrics.clean_min_30, 28);
  assert.equal(flatBattery(box), undefined, "a Linux box has no battery");
});

test("a Mac unreached right after a flat battery read is offline, not unknown, before Tailscale reads it offline (11-08 16:40Z)", () => {
  const watch = Array.from({ length: 30 }, (_, minute) => line(minute, { pct: minute < 22 ? 2 : 1, ac: false }));
  const down = watch.at(-1)!;
  down.hosts![0] = { ...down.hosts![0], usable: null, error: "The operation was aborted due to timeout" };
  const out = measure({ now: RUN, log: { holds: [] }, chats: [], watch, daemonFaults: [] });
  assert.equal(out.metrics.clean_min_30, 30);
  assert.equal(out.metrics.offline_min_30_mac, 30);
  const charged = watch.map((entry, minute) => minute < 29 ? line(minute, { pct: 60, ac: false }) : entry);
  assert.equal(measure({ now: RUN, log: { holds: [] }, chats: [], watch: charged, daemonFaults: [] }).metrics.clean_min_30, 29, "a charged Mac that stops answering stays unknown");
});

test("pmset's battery output parses to a charge and a power source, and a Mac with no battery reads none", () => {
  assert.deepEqual(parsePmsetBatt("Now drawing from 'AC Power'\n -InternalBattery-0 (id=22610019)\t11%; charging; 1:57 remaining present: true\n"), { pct: 11, ac: true });
  assert.deepEqual(parsePmsetBatt("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=22610019)\t4%; discharging; 0:05 remaining present: true\n"), { pct: 4, ac: false });
  assert.equal(parsePmsetBatt("Now drawing from 'AC Power'\n"), null);
  assert.equal(parsePmsetBatt(""), null);
});

test("the relay's battery reaches the Mac's reading, and a malformed one is dropped at the edge", () => {
  const feed = { v: 1, ts: new Date(RUN).toISOString(), pressure_level: 1, swapouts_per_s: 0, kernel_task_cpu_pct: 18 };
  assert.deepEqual((parseUsableRaw({ platform: "darwin", feed, battery: { pct: 3, ac: false } }, RUN) as UsableReading).battery, { pct: 3, ac: false });
  for (const battery of [null, { pct: "3", ac: false }, { pct: 3 }, { pct: 140, ac: false }, { pct: -1, ac: true }])
    assert.equal((parseUsableRaw({ platform: "darwin", feed, battery }, RUN) as UsableReading).battery, undefined);
  assert.equal(parseUsableRaw({ platform: "darwin", feed: null, battery: { pct: 3, ac: false } }, RUN), null);
});
