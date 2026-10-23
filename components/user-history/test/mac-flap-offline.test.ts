// Guards d7's 13:56Z and 14:29Z minutes on 10-23: Tailscale read the Mac offline on both sides of each, the relay read "fetch failed" in it,
// and d7 counted 13:56Z unknown and 14:29Z dirty from 2 handshake timeouts to the Mac, which read 28 and 29 of 30 clean minutes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measure } from "../scripts/duties/whole-system.ts";
import type { WatchLine } from "../src/mac-usable-watch.ts";

const RUN = Date.parse("2026-10-23T14:53:43Z");
const box = { kind: "linux", memSomeAvg10: 0, memFullAvg10: 0, cpuSomeAvg10: 0, swapoutsPerS: 0, runnablePerCore: 0.4, allowedCpus: 80 } as const;
const mac = { pressureLevel: 1, swapoutsPerS: 0, kernelTaskPct: 25 };
type MacRead = "usable" | "offline" | "fetch failed" | "relay mac answered 500 to /v1/watch";
const minuteAt = (minute: number): number => Math.floor(RUN / 60_000) * 60_000 - (30 - minute) * 60_000;
const line = (minute: number, read: MacRead): WatchLine => ({ host: "us-metal02",
  at: new Date(minuteAt(minute) + 30_000).toISOString(), usable: box, workers: 0, workerGb: 0, top: [], live: 0, working: 0, queue: null,
  mac: { swapGb: null, pressureLevel: null }, cpuMs: 0,
  hosts: [{ name: "mac", usable: read === "usable" ? mac : null, workers: 0, workerGb: 0, top: [], live: 0, working: 0, swapGb: null,
    ...read === "usable" ? {} : read === "offline" ? { offline: true, error: "offline, Tailscale last seen 28 min ago" } : { error: read } }] } as WatchLine);
const handshake = (minute: number) => ({ at: minuteAt(minute) + 40_000, host: "mac", session: "01a15427", what: "its resume got no answer, the handshake timed out after 10 s" });
const run = (watch: WatchLine[], daemonFaults = [handshake(6)]) => measure({ now: RUN, watch, log: { holds: [] }, chats: [], daemonFaults });

test("a Mac minute the relay could not reach between two minutes Tailscale read offline is offline, and its daemon calls are left out", () => {
  const out = run(Array.from({ length: 30 }, (_, minute) => line(minute, minute === 6 ? "fetch failed" : "offline")));
  assert.equal(out.metrics.clean_min_30, 30);
  assert.equal(out.metrics.offline_min_30_mac, 30);
  assert.equal(out.metrics.unknown_min_30, 0);
  assert.equal(out.metrics.daemon_fail_min_30, 0);
});

test("an unreached Mac minute at either edge of an offline stretch is offline too", () => {
  const waking = Array.from({ length: 30 }, (_, minute) => line(minute, minute < 6 ? "offline" : minute === 6 ? "fetch failed" : "usable"));
  assert.equal(run(waking, []).metrics.clean_min_30, 30);
  const sleeping = Array.from({ length: 30 }, (_, minute) => line(minute, minute < 6 ? "usable" : minute === 6 ? "fetch failed" : "offline"));
  assert.equal(run(sleeping, []).metrics.clean_min_30, 30);
});

test("an unreached Mac minute with no offline minute beside it, or a relay that answered, stays unknown", () => {
  const alone = Array.from({ length: 30 }, (_, minute) => line(minute, minute === 6 ? "fetch failed" : minute === 4 || minute === 8 ? "offline" : "usable"));
  assert.equal(run(alone, []).metrics.unknown_min_30, 1);
  const answered = Array.from({ length: 30 }, (_, minute) => line(minute, minute === 6 ? "relay mac answered 500 to /v1/watch" : "offline"));
  const out = run(answered);
  assert.equal(out.metrics.clean_min_30, 29);
  assert.equal(out.metrics.daemon_fail_min_30, 1);
});
