// AI harness 10-27 (p1152, p1153): after the box's 16:46Z reboot the daemon started listening at 16:48:55Z and d7 read quiet_agent_gb 0 GB at
// 16:49Z, since no worker can read quiet until the quiet window after it loads, while 124 runs filled pi-pool's queue by 16:54Z. A reading
// within RESTART_SETTLE_MS after a daemon start is void. At 14:40Z the same day d9 asked to replace p1127, whose Prime build with
// ctx.waitForCredential was never installed, so pi-pool's park could not fire and quiet_agent_gb could not move: a blocked fix step is no fix
// that fails to move.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { MemoryGroup } from "../../prime-relay/host-stats.ts";
import { fixNotMoving, type RedDuty } from "../scripts/duties/chat-system.ts";
import { measure, RESTART_SETTLE_MS, readDaemonStarts } from "../scripts/duties/whole-system.ts";
import { type Footprints, watchLine, type WatchLine } from "../src/mac-usable-watch.ts";
import type { MetricStreak } from "../src/shared/duty-streak.ts";

const GB = 1024 ** 3;
const MIN = 60_000;
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/daemon-rows-1019-2029.json"), "utf8")) as
  { rows: Record<string, unknown>[]; workers: Footprints["workers"] };
const footprints: Footprints = { workers: fixture.workers, kernels: [], swap_used_bytes: 0, pressure_level: null, cpu_s: 0 };
const memory = { groups: [{ id: "agents", label: "Agent sessions", bytes: 58.12 * GB, swapBytes: 0, top: [] }] satisfies MemoryGroup[], cacheBytes: 0 };
const RUN = Date.parse("2026-10-19T20:30:08Z");
const watch: WatchLine[] = Array.from({ length: 30 }, (_, index) => Date.parse("2026-10-19T20:00:30Z") + index * MIN).map(at => ({ host: "us-metal02",
  ...watchLine({ now: at, rows: fixture.rows, footprints, queue: null, chats: new Set(), title: () => null, cpuMs: 0, usable: null, memory }) }));

test("only the box's own supervisor starts count, not a rig's daemon logging to the same folder", () => {
  const lines = [
    "[2026-10-27T16:48:55.673Z] supervisor: Prime Agent daemon supervisor e382dda7-f94e-418b-be9c-61ffe707afb3 listening on /tmp/prime-agent-1001/daemon.sock",
    "[2026-10-27T16:53:15.471Z] supervisor: Prime Agent daemon supervisor b5cb3cef-8ee4-4b91-8130-7b2499210435 listening on /home/sieun/scratch/x/probe/t/prime-agent-1001/daemon.sock",
    "[2026-10-27T17:06:51.073Z] supervisor: Prime Agent daemon supervisor bb0d2ad7-9dc0-491a-a19d-736cc40531fb listening on /tmp/svh-r01/prime-agent-1001/daemon.sock",
    "[2026-10-27T16:49:03.000Z] supervisor: Session worker d1c9269e9e34 stderr: Prime Agent daemon listening on /tmp/prime-agent-1001/worker-ee92e1d8c39e-d1c9269e9e34.sock",
  ];
  assert.deepEqual(readDaemonStarts(lines), [Date.parse("2026-10-27T16:48:55.673Z")]);
});

test("quiet_agent_gb gives no reading within the settle window after a daemon start, and reads as before past it", () => {
  const base = { now: RUN, watch, log: { holds: [] }, chats: [], quietMs: 15 * MIN };
  assert.equal(measure(base).metrics.quiet_agent_gb, 5.79);
  const fresh = measure({ ...base, daemonStarts: [{ host: "us-metal02", at: Date.parse("2026-10-19T20:00:00Z") }] });
  assert.equal(fresh.metrics.quiet_agent_gb, undefined);
  assert.equal(fresh.metrics.quiet_agent_gb_us_metal02, undefined);
  assert.match(fresh.flagged?.find(slice => slice.kind === "gap")?.excerpt ?? "", /^us-metal02 read quiet memory only within 30 min after its daemon started \(us-metal02 20:00Z\)/);
  const settled = measure({ ...base, daemonStarts: [{ host: "us-metal02", at: RUN - RESTART_SETTLE_MS - 31 * MIN }] });
  assert.equal(settled.metrics.quiet_agent_gb, 5.79);
  assert.equal(measure({ ...base, daemonStarts: [{ host: "mac", at: Date.parse("2026-10-19T20:00:00Z") }] }).metrics.quiet_agent_gb, 5.79, "another box's start voids nothing here");
});

test("d9 asks to replace no fix whose step is blocked, since that fix is not in place", () => {
  const metric: MetricStreak = { key: "quiet_agent_gb", misses: 3, moved: false, since: Date.parse("2026-10-27T13:36:00Z"), value: 11.87, target: 5, op: "<=",
    stuck: true, fix: { step: "p1127", job: "prime build installs", live: true } };
  const red: RedDuty = { chat: "01a1164b-4a2d-742d-b27a-82f086ed0200", duty: "d7", name: "Whole system", green: false, misses: 3, stuck: false, metric,
    fix: "p1127", underFix: { misses: 3, moved: false } };
  assert.equal(fixNotMoving([red], () => "AI harness").length, 1);
  assert.equal(fixNotMoving([{ ...red, fixBlocked: true }], () => "AI harness").length, 0);
});
