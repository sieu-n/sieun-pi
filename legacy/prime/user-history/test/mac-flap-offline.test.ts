// Guards d7's 13:56Z and 14:29Z minutes on 10-23: Tailscale read the Mac offline on both sides of each, the relay read "fetch failed" in it,
// and d7 counted 13:56Z unknown and 14:29Z dirty from 2 handshake timeouts to the Mac, which read 28 and 29 of 30 clean minutes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measure } from "../scripts/duties/whole-system.ts";
import type { DaemonFault } from "../src/daemon-faults.ts";
import { UNREAD_AT_STOP, type WatchLine } from "../src/mac-usable-watch.ts";

const RUN = Date.parse("2026-10-23T14:53:43Z");
const box = { kind: "linux", memSomeAvg10: 0, memFullAvg10: 0, cpuSomeAvg10: 0, swapoutsPerS: 0, runnablePerCore: 0.4, allowedCpus: 80 } as const;
const mac = { pressureLevel: 1, swapoutsPerS: 0, kernelTaskPct: 25 };
type MacRead = "usable" | "no reading" | "offline" | "fetch failed" | "The operation was aborted due to timeout" | typeof UNREAD_AT_STOP | "relay mac answered 500 to /v1/watch";
const minuteAt = (minute: number): number => Math.floor(RUN / 60_000) * 60_000 - (30 - minute) * 60_000;
const line = (minute: number, read: MacRead): WatchLine => ({ host: "us-metal02",
  at: new Date(minuteAt(minute) + 30_000).toISOString(), usable: box, workers: 0, workerGb: 0, top: [], live: 0, working: 0, queue: null,
  mac: { swapGb: null, pressureLevel: null }, cpuMs: 0,
  hosts: [{ name: "mac", usable: read === "usable" ? mac : null, workers: 0, workerGb: 0, top: [], live: 0, working: 0, swapGb: null,
    ...read === "usable" || read === "no reading" ? {} : read === "offline" ? { offline: true, error: "offline, Tailscale last seen 28 min ago" } : { error: read } }] } as WatchLine);
const handshake = (minute: number) => ({ at: minuteAt(minute) + 40_000, host: "mac", session: "01a15427", what: "its resume got no answer, the handshake timed out after 10 s" });
const run = (watch: WatchLine[], daemonFaults: DaemonFault[] = [handshake(6)]) => measure({ now: RUN, watch, log: { holds: [] }, chats: [], daemonFaults });

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

// Guards d7's 20:34Z minute on 11-03: the Mac read offline to 20:33Z, usable at 20:34:30Z, "fetch failed" at 20:35:30Z and offline from 20:36Z,
// and at 20:34:48Z the wake and pin of 01a11b0b answered "Connection to the Prime Agent daemon closed", which d7 counted dirty, 29 of 30 clean.
const closed = (minute: number, what = "keeping it open failed, the daemon connection closed") => ({ at: minuteAt(minute) + 48_000, host: "mac", session: "01a11b0b", what });
const sleepAgain = (minute: number): MacRead => minute < 6 ? "offline" : minute === 6 ? "usable" : minute === 7 ? "fetch failed" : "offline";

test("a daemon call that lost its link to a box which reads offline the next minute is left out, and the offline line names it", () => {
  const out = run(Array.from({ length: 30 }, (_, minute) => line(minute, sleepAgain(minute))), [closed(6), closed(6, "a job's wake failed, the daemon connection closed")]);
  assert.equal(out.metrics.clean_min_30, 30);
  assert.equal(out.metrics.daemon_fail_min_30, 0);
  const flag = out.flagged?.find(slice => slice.kind === "offline_minutes")?.excerpt ?? "";
  assert.match(flag, new RegExp(`in 1 more minute a box read online, daemon calls lost their link to it .*\\(${new Date(minuteAt(6)).toISOString().slice(11, 16)}Z mac\\)`));
  const shaking = run(Array.from({ length: 30 }, (_, minute) => line(minute, minute < 7 ? "usable" : "offline")), [handshake(6)]);
  assert.equal(shaking.metrics.clean_min_30, 30, "a handshake timeout the minute before Tailscale reads the box offline is left out too");
});

// Guards d7's 20:43Z minute on 11-03: Tailscale read the Mac offline to 20:42Z, the relay answered at 20:43:30Z with no reading of it (usable
// null, no error), timed out at 20:44:30Z and Tailscale read it offline from 20:45Z; two calls lost their link at 20:43Z and d7 read 27 of 30.
test("a lost link in a minute the relay answered with no reading, before the box sleeps, is left out", () => {
  const read = (minute: number): MacRead => minute < 6 ? "offline" : minute === 6 ? "no reading" : minute === 7 ? "The operation was aborted due to timeout" : "offline";
  const out = run(Array.from({ length: 30 }, (_, minute) => line(minute, read(minute))),
    [handshake(6), closed(6, "its wake failed, the daemon connection closed")]);
  assert.equal(out.metrics.clean_min_30, 30);
  assert.equal(out.metrics.daemon_fail_min_30, 0);
  const awake = run(Array.from({ length: 30 }, (_, minute) => line(minute, minute === 6 ? "no reading" : "usable")), [handshake(6)]);
  assert.equal(awake.metrics.daemon_fail_min_30, 1, "a lost link to a box that stays online keeps the fault");
  assert.equal(awake.metrics.unknown_min_30, 0);
});

test("a closed connection to a box that reads online the next minute, or a slow call before it sleeps, stays dirty", () => {
  const online = run(Array.from({ length: 30 }, (_, minute) => line(minute, minute < 6 ? "offline" : "usable")), [closed(6)]);
  assert.equal(online.metrics.clean_min_30, 29);
  assert.equal(online.metrics.daemon_fail_min_30, 1);
  const later = run(Array.from({ length: 30 }, (_, minute) => line(minute, minute < 9 ? "usable" : "offline")), [closed(6)]);
  assert.equal(later.metrics.clean_min_30, 29, "a box that sleeps 3 minutes later was awake when the call lost its link");
  const slow = run(Array.from({ length: 30 }, (_, minute) => line(minute, sleepAgain(minute))), [closed(6, "opening it took 45 s")]);
  assert.equal(slow.metrics.daemon_fail_min_30, 1, "a call the box answered late is no lost link");
  const unread = run(Array.from({ length: 30 }, (_, minute) => line(minute, minute < 9 ? "fetch failed" : "offline")), [closed(5)]);
  assert.equal(unread.metrics.daemon_fail_min_30, 1, "a minute the relay could not read is offlineAround's, three lines from an offline read");
});

// Guards d7's 01:06Z and 01:10Z minutes on 11-04: Tailscale read the Mac offline 00:43Z to 01:05Z and 01:07Z to 01:09Z, a resume begun at
// 00:51:31Z answered in 893.6 s at 01:06:25Z, and a get_state begun at 01:09:54Z timed out at 01:10:24Z; d7 read 26 of 30 clean.
test("a daemon call begun while its box read offline and ended as the box came back is left out", () => {
  const back = Array.from({ length: 30 }, (_, minute) => line(minute, minute < 6 ? "offline" : "usable"));
  const resume = { at: minuteAt(6) + 25_000, from: minuteAt(6) + 25_000 - 893_600, host: "mac", session: "01a11b0b", what: "its resume was answered in 893.6 s" };
  const out = run(back, [resume]);
  assert.equal(out.metrics.clean_min_30, 30);
  assert.equal(out.metrics.daemon_fail_min_30, 0);
  const timedOut = { at: minuteAt(6) + 24_000, from: minuteAt(6) - 6_000, host: "mac", what: "an idle check failed, get_state timed out after 29.999 s", timedOut: { call: "get_state", ms: 29_999 } };
  assert.equal(run(back, [timedOut]).metrics.clean_min_30, 30);
  const lateAfterWake = run(back, [{ ...resume, at: minuteAt(6) + 45_000 }]);
  assert.equal(lateAfterWake.metrics.daemon_fail_min_30, 1, "a call the box answered over 30 s after it read back stays a fault");
  const awake = run(back, [{ ...resume, at: minuteAt(8) + 25_000, from: minuteAt(7) }]);
  assert.equal(awake.metrics.daemon_fail_min_30, 1, "a slow call begun while the box read online stays a fault");
  const { from: _from, ...noFrom } = resume;
  const noStart = run(back, [noFrom]);
  assert.equal(noStart.metrics.daemon_fail_min_30, 1, "a fault whose line gives no start stays a fault");
});
