// Guards d7's 14:28Z to 14:35Z minutes on 10-27: the provider dropped both of us-metal02's address blocks from 14:27:30Z to 14:42:30Z, its
// Tailscale still read the Mac online, and 12 to 22 handshake timeouts a minute to the Mac made d7 read 20 of 30 though the chat and both
// daemons ran.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { measure } from "../scripts/duties/whole-system.ts";
import { sample, type WatchLine } from "../src/mac-usable-watch.ts";
import { UPLINK_FRESH_MS, uplinkDark } from "../src/uplink-dark.ts";

const RUN = Date.parse("2026-10-27T14:36:12Z");
const box = { kind: "linux", memSomeAvg10: 0, memFullAvg10: 0, cpuSomeAvg10: 0, swapoutsPerS: 0, runnablePerCore: 0.4, allowedCpus: 80 } as const;
const mac = { pressureLevel: 1, swapoutsPerS: 0, kernelTaskPct: 25 };
const minuteAt = (minute: number): number => Math.floor(RUN / 60_000) * 60_000 - (30 - minute) * 60_000;
const line = (minute: number, dark: boolean): WatchLine => ({ host: "us-metal02",
  at: new Date(minuteAt(minute) + 30_000).toISOString(), usable: box, workers: 0, workerGb: 0, top: [], live: 0, working: 0, queue: null,
  mac: { swapGb: null, pressureLevel: null }, cpuMs: 0, ...dark ? { uplinkDark: true } : {},
  hosts: [{ name: "mac", usable: dark ? null : mac, workers: 0, workerGb: 0, top: [], live: 0, working: 0, swapGb: null, ...dark ? { error: "fetch failed" } : {} }] } as WatchLine);
const handshake = (minute: number) => ({ at: minuteAt(minute) + 40_000, host: "mac", session: "01a11ba8", what: "opening it failed, the handshake timed out after 3 s" });

test("a minute whose box read both gateways down is offline for every box, and its daemon calls are left out", () => {
  const dark = (minute: number) => minute >= 22;
  const out = measure({ now: RUN, watch: Array.from({ length: 30 }, (_, minute) => line(minute, dark(minute))), log: { holds: [] }, chats: [],
    daemonFaults: Array.from({ length: 8 }, (_, index) => handshake(22 + index)) });
  assert.equal(out.metrics.clean_min_30, 30);
  assert.equal(out.metrics.daemon_fail_min_30, 0);
  assert.equal(out.metrics.offline_min_30, 8);
  assert.equal(out.metrics.offline_min_30_mac, 8);
  assert.equal(out.metrics.offline_min_30_us_metal02, 8);
  assert.match(out.flagged?.find(slice => slice.kind === "offline_minutes")?.excerpt ?? "", /8 of these the watch's box read both its gateways down/);
  const lit = measure({ now: RUN, watch: Array.from({ length: 30 }, (_, minute) => line(minute, false)), log: { holds: [] }, chats: [], daemonFaults: [handshake(22)] });
  assert.equal(lit.metrics.clean_min_30, 29, "a handshake timeout while the uplink answers stays dirty");
});

test("the uplink reads dark only from a fresh round with both gateways down", () => {
  const now = Date.parse("2026-10-27T14:30:00Z");
  const file = (primary: number, alt: number, ranAt = now) => `# HELP x\nmetal_uplink_gateway_up{gateway="primary"} ${primary}\nmetal_uplink_gateway_up{gateway="alt"} ${alt}\n` +
    `metal_uplink_route_alt 0\nmetal_uplink_run_timestamp_seconds ${Math.floor(ranAt / 1000)}\n`;
  assert.equal(uplinkDark(file(0, 0), now), true);
  assert.equal(uplinkDark(file(1, 0), now), false);
  assert.equal(uplinkDark(file(0, 1), now), false);
  assert.equal(uplinkDark(file(0, 0, now - UPLINK_FRESH_MS - 1000), now), false, "a failover that stopped writing");
  assert.equal(uplinkDark("", now), false, "a box with no failover");
});

test("the watch line carries uplinkDark when the box reads its uplink dark, and leaves it out otherwise", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "uplink-watch-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const row = { sessionId: "01a11ba8-0000-7000-8000-000000000001", lifecycle: "live", workerPid: 2000, workerState: "ready" };
  const read = (dark: boolean) => sample({ dataDir, rows: () => [row], chats: async () => new Set<string>(), title: () => null,
    queue: async () => { throw new Error("no queue"); }, log: () => {}, now: () => RUN, feed: async () => null,
    footprints: async () => ({ workers: {}, swap_used_bytes: 0, pressure_level: null, cpu_s: 0 }), memory: async () => ({ groups: null }),
    services: async () => [], uplink: async () => dark });
  assert.equal((await read(true))?.uplinkDark, true);
  assert.equal((await read(false))?.uplinkDark, undefined);
});
