// A CPU minute CI's guests led is CI's, and its flag names CI's cores and their ramp. At 00:08Z on 11-01 the chat's event loop stalled 1.4 s
// on us-metal02 while CI rose from 2.48 cores at 00:05Z to 43.3 as guests cig-22, cig-37 and cig-29 started; d7 named only the harness's
// 23.32 cores, 12.99 of them in job rigs, and booked the minute on the app or owner side.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CpuSides, LinuxUsable } from "../../../../components/prime-relay/host-stats.ts";
import { ciWords, hostViews, measure, minuteSide } from "../scripts/duties/whole-system.ts";
import type { WatchLine } from "../src/mac-usable-watch.ts";

const RUN = Date.parse("2026-11-01T00:13:51.647Z");
const START = Date.parse("2026-10-31T23:43:00Z");
const fast = { readMs: 80, read: "api/agent/siblings", loopMs: 330 };
const sides = (cores: Partial<CpuSides>): CpuSides => ({ harness: 38, apps: 17, owner: 0, ci: 4, system: 2, ...cores });
const box = (cores: CpuSides, runnablePerCore: number): LinuxUsable => ({ kind: "linux", memSomeAvg10: 0, memFullAvg10: 0, cpuSomeAvg10: 58.56,
  swapoutsPerS: 0, runnablePerCore, allowedCpus: 80, cpuCores: cores });
const line = (minute: number, cores: CpuSides, runnablePerCore: number, chat: NonNullable<WatchLine["chat"]> = fast): WatchLine => ({
  at: new Date(START + minute * 60_000 + 30_000).toISOString(), host: "us-metal02", usable: box(cores, runnablePerCore),
  workers: 22, workerGb: 39.39, top: [], live: 20, working: 15, queue: null, mac: { swapGb: 0, pressureLevel: null }, cpuMs: 0, chat });

// The us-metal02 lines from 00:05:30Z to 00:09:30Z on 11-01, minutes 22 to 26 of the window.
const ramp: [number, Partial<CpuSides>, number][] = [
  [22, { harness: 43.06, apps: 19.52, ci: 2.48 }, 1.21], [23, { harness: 38.04, apps: 17.37, ci: 11.55 }, 1.26],
  [24, { harness: 24.84, apps: 10.02, ci: 41 }, 2.51], [25, { harness: 23.32, apps: 8.65, ci: 43.3 }, 2.78], [26, { harness: 24.22, apps: 9.62, ci: 43.67 }, 3.47]];
const watch = (): WatchLine[] => Array.from({ length: 30 }, (_, minute) => {
  const read = ramp.find(([at]) => at === minute);
  const chat = minute === 25 ? { readMs: 82, read: "api/agent/siblings", loopMs: 1396, gcMs: 125, gc: "minor" as const } : fast;
  return line(minute, sides(read?.[1] ?? {}), read?.[2] ?? 1.1, chat);
});

test("the 00:08Z stall under CI's ramp goes to CI's side and names CI's cores and the low they rose from", () => {
  const { metrics, flagged } = measure({ now: RUN, watch: watch(), log: { holds: [] }, chats: [] });
  assert.equal(metrics.clean_min_30, 29);
  assert.equal(metrics.ci_unusable_min_30, 1);
  assert.equal(metrics.other_unusable_min_30, 0, "the apps used 8.65 cores that minute");
  assert.equal(metrics.harness_unusable_min_30, 0);
  const dirty = flagged?.find(slice => slice.kind === "dirty_minutes")?.excerpt ?? "";
  assert.match(dirty, /00:08Z us-metal02 unusable \(cpu: the chat's event loop stalled 1\.4 s; CI 43\.3 of 80 cores, up from 2\.48 at 00:05Z\)/);
  assert.match(flagged?.find(slice => slice.kind === "minutes")?.excerpt ?? "", /0 unusable minutes on the harness side, 1 on CI's side, 0 on the app or owner side/);
});

test("CI's words leave out a ramp when CI's cores did not double, and only CI leading makes a minute CI's", () => {
  const lines = watch();
  const view = (watched: WatchLine) => hostViews(watched)[0]!;
  assert.equal(ciWords(lines)(lines[26]!, view(lines[26]!)), "; CI 43.67 of 80 cores, up from 2.48 at 00:05Z");
  assert.equal(ciWords(lines.slice(24))(lines[26]!, view(lines[26]!)), "; CI 43.67 of 80 cores", "41 cores at 00:07Z is no doubling");
  const read = (cores: Partial<CpuSides>) => minuteSide(view(line(25, sides(cores), 2.5)));
  assert.equal(read({ harness: 23.32, apps: 8.65, ci: 43.3 }), "ci");
  assert.equal(read({ harness: 20, apps: 30, ci: 25 }), "other");
  assert.equal(read({ harness: 41, apps: 10, ci: 25 }), "harness");
});

test("a slow chat read under CI's lead goes to the harness and its flag still names CI's cores", () => {
  // 22:38Z on 11-02: api/agent/siblings answered in 1.5 s with CI at 41.23 cores and the harness at 28.94.
  const lines = watch().map((watched, minute) => minute === 25 ? { ...watched, chat: { readMs: 1530, read: "api/agent/siblings", loopMs: 1636 } } : watched);
  const { metrics, flagged } = measure({ now: RUN, watch: lines, log: { holds: [] }, chats: [] });
  assert.equal(metrics.harness_unusable_min_30, 1);
  assert.equal(metrics.ci_unusable_min_30, 0);
  assert.match(flagged?.find(slice => slice.kind === "dirty_minutes")?.excerpt ?? "", /00:08Z us-metal02 unusable \(cpu: the chat answered api\/agent\/siblings in 1\.5 s[^)]*; CI 43\.3 of 80 cores, up from 2\.48 at 00:05Z/);
});
