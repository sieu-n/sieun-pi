// Guards d7's 13:56Z and 14:29Z minutes on 10-23: Tailscale read the Mac offline on both sides of each, the relay read "fetch failed" in it,
// and d7 counted 13:56Z unknown and 14:29Z dirty from 2 handshake timeouts to the Mac, which read 28 and 29 of 30 clean minutes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measure } from "../scripts/duties/whole-system.ts";
import { UNREAD_AT_STOP, type WatchLine } from "../src/mac-usable-watch.ts";

const RUN = Date.parse("2026-10-23T14:53:43Z");
const box = { kind: "linux", memSomeAvg10: 0, memFullAvg10: 0, cpuSomeAvg10: 0, swapoutsPerS: 0, runnablePerCore: 0.4, allowedCpus: 80 } as const;
const mac = { pressureLevel: 1, swapoutsPerS: 0, kernelTaskPct: 25 };
type MacRead = "usable" | "offline" | "fetch failed" | typeof UNREAD_AT_STOP | "relay mac answered 500 to /v1/watch";
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

// Guards d7's 20:46Z minute on 10-23: a release stopped the chat service at 20:46:25Z while the Mac's relay read was out, between two offline minutes.
test("a Mac minute a service stop wrote unread between two minutes Tailscale read offline is offline", () => {
  const out = run(Array.from({ length: 30 }, (_, minute) => line(minute, minute === 6 ? UNREAD_AT_STOP : "offline")), []);
  assert.equal(out.metrics.clean_min_30, 30);
  assert.equal(out.metrics.offline_min_30_mac, 30);
  assert.equal(out.metrics.unknown_min_30, 0);
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

// Guards d7's 00:20Z minute on 10-27 (and 14:27Z on 10-26): Tailscale read the Mac offline 00:02Z to 00:19Z, and at 00:20:10.042Z two resumes
// failed on the chat service's own offline read, "mac is offline (Tailscale last seen 0 min ago)", 0.55 s before it read the Mac back.
test("a daemon call whose error is the service's offline read of its box is left out in the first minute the Mac reads online", () => {
  const back = Array.from({ length: 30 }, (_, minute) => line(minute, minute < 6 ? "offline" : "usable"));
  const offlineRead = { at: minuteAt(6) + 10_000, host: "mac", session: "01a16213", what: "its resume got no answer, mac is offline (Tailscale last seen 0 min ago)" };
  const out = run(back, [offlineRead]);
  assert.equal(out.metrics.clean_min_30, 30);
  assert.equal(out.metrics.daemon_fail_min_30, 0);
  const dirty = run(back, [handshake(6)]);
  assert.equal(dirty.metrics.clean_min_30, 29, "a handshake timeout to the Mac while it reads online stays dirty");
  assert.equal(dirty.metrics.daemon_fail_min_30, 1);
  const otherBox = run(back, [{ ...offlineRead, host: "us-metal03" }]);
  assert.equal(otherBox.metrics.clean_min_30, 29, "the error must name the call's own box");
});
