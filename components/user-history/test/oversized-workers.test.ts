// Guards d7's oversized check against a chat's fan-out: at 06:21Z on 10-18 it flagged Prime worker 1811158 at 7.79 GB, VP of CI's 28 sessions,
// 20 of them jobs at work, though each session held 0.28 GB against the day's median of 0.19 GB (mac-usable/2026-10-18.jsonl on us-metal02).
import assert from "node:assert/strict";
import { test } from "node:test";
import { oversized } from "../scripts/duties/whole-system.ts";
import type { WatchLine, WorkerLine } from "../src/mac-usable-watch.ts";

const worker = (pid: number, tree: string, gb: number, sessions: number): WorkerLine => ({ pid, gb, sessions, root: tree, tree });
const line = (at: string, top: WorkerLine[]): WatchLine => ({ at: `2026-10-18T${at}Z`, host: "us-metal02", usable: null,
  workers: top.length, workerGb: top.reduce((sum, entry) => sum + entry.gb, 0), top, live: 0, working: 0, queue: null,
  mac: { swapGb: null, pressureLevel: null }, cpuMs: 0 });
// Top workers from the day's lines before the run: per session 0.12 to 0.41 GB, a median of 0.24 GB.
const DAY = [
  line("06:05:30", [worker(1948705, "Crawler VP", 6.1, 18), worker(1811158, "VP of CI", 3.76, 11), worker(2425947, "AI harness developer environment VP", 2.47, 10)]),
  line("06:08:30", [worker(1811158, "VP of CI", 4.89, 20), worker(2425947, "AI harness developer environment VP", 3.71, 9), worker(1948705, "Crawler VP", 2.73, 23)]),
  line("06:13:30", [worker(1811158, "VP of CI", 5.95, 20), worker(1948705, "Crawler VP", 2.25, 15), worker(1590926, "metal-management", 2.97, 19)]),
  line("06:18:30", [worker(3876901, "chat-a", 0.37, 2), worker(3841115, "chat-b", 0.36, 2), worker(3533221, "chat-c", 0.36, 2)]),
];

test("a chat's worker that grows with the jobs it runs is no oversized process", () => {
  const latest = line("06:21:27", [worker(1811158, "VP of CI", 7.79, 28), worker(1590926, "metal-management", 2.5, 14), worker(2425947, "AI harness developer environment VP", 2.24, 9)]);
  assert.deepEqual(oversized(latest, [...DAY, latest]), []);
});

test("a worker that holds far more than its sessions do is flagged with its footprint per session", () => {
  const latest = line("06:21:27", [worker(1811158, "VP of CI", 0.9, 1), worker(1590926, "metal-management", 2.5, 14)]);
  const found = oversized(latest, [...DAY, latest]);
  assert.equal(found.length, 1);
  assert.match(found[0]!, /^us-metal02: Prime worker 1811158 \(VP of CI\) holds 0\.9 GB for 1 sessions, 0\.90 GB each, over 3x the day's median there of 0\.\d\d GB per session$/);
});
