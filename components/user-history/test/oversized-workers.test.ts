// Guards d7's oversized check against a chat's fan-out: at 06:21Z on 10-18 it flagged Prime worker 1811158 at 7.79 GB, VP of CI's 28 sessions,
// 20 of them jobs at work, though each session held 0.28 GB against the day's median of 0.19 GB (mac-usable/2026-10-18.jsonl on us-metal02).
import assert from "node:assert/strict";
import { test } from "node:test";
import { oversized } from "../scripts/duties/whole-system.ts";
import { type Footprints, type WatchLine, watchLine, type WorkerLine } from "../src/mac-usable-watch.ts";

const worker = (pid: number, tree: string, gb: number, sessions: number, workGb?: number): WorkerLine => ({ pid, gb, sessions, root: tree, tree, ...workGb === undefined ? {} : { workGb } });
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
  assert.match(found[0]!, /^us-metal02: Prime worker 1811158 \(VP of CI\) holds 0\.9 GB for 1 sessions, 0\.90 GB each of its own, over 3x the day's median there of 0\.\d\d GB per session$/);
});

// At 07:30Z on 10-18 d7 flagged two workers whose memory was their sessions' work (mac-usable/2026-10-18.jsonl on us-metal02): 852974 held
// 1.7 GB for 'd7 cut job resume', 1.19 GB of it a release's svelte-check, and Mac worker 4111 held 3.91 GB for 'meta ads', 3.6 GB of it a
// job's kernel at work.
test("a worker whose memory is its sessions' work is no oversized process", () => {
  const latest = line("07:30:30", [worker(852974, "d7 cut job resume", 1.7, 1, 1.3), worker(1590926, "metal-management", 2.5, 14, 0.4)]);
  assert.deepEqual(oversized(latest, [...DAY, latest]), []);
});

test("a flagged worker names how much of it is work", () => {
  const latest = line("07:30:30", [worker(852974, "d7 cut job resume", 1.7, 1, 0.2)]);
  assert.deepEqual(oversized(latest, [...DAY, latest]), ["us-metal02: Prime worker 852974 (d7 cut job resume) holds 1.7 GB for 1 sessions, 0.2 GB of it their work, 1.50 GB each of its own, over 3x the day's median there of 0.24 GB per session"]);
});

test("the watch counts the commands every kernel runs and the whole kernel of a session at work as the worker's work", () => {
  const GB = 1024 ** 3;
  const raw = (id: string, worker: number, fields: Record<string, unknown> = {}) => ({ sessionId: id, activeSessionId: id, lifecycle: "live", activity: "idle",
    isSessionActive: false, workerPid: worker, lastActivityAt: "2026-10-18T07:30:16.447Z", ...fields });
  const rows = [raw("resume", 852974), raw("ads", 4111), raw("snap", 4111, { parentSessionId: "ads", activity: "working", isSessionActive: true })];
  const kernel = (pid: number, session: string, bytes: number, own?: number) => ({ pid, root: session, session, pids: 3, bytes: bytes * GB, ...own === undefined ? {} : { own: own * GB }, biggest: null });
  const footprints: Footprints = { workers: { 852974: { pids: 9, bytes: 1.7 * GB, own: 0.3 * GB }, 4111: { pids: 6, bytes: 3.91 * GB, own: 0.48 * GB } },
    kernels: [kernel(10, "resume", 1.3, 0.11), kernel(20, "ads", 0.09), kernel(30, "snap", 3.6, 3.45)], swap_used_bytes: null, pressure_level: null, cpu_s: 0 };
  const top = watchLine({ now: Date.parse("2026-10-18T07:30:30Z"), rows, footprints, queue: null, chats: new Set(), title: () => null, cpuMs: 0 }).top;
  assert.deepEqual(top.map(entry => [entry.pid, entry.sessions, entry.workGb]), [[4111, 2, 3.6], [852974, 1, 1.19]]);
});
