// d7 at 05:57 KST on 11-26 read quiet_agent_gb_mac 5.83 GB against 5 GB. At 20:56:30Z on 11-25 the sw factory thread 4f9dad47 ("5180
// designer") held 5.32 GB while its jobs ran commit.mjs and Aside reads, but the Mac's watch rows come from the Prime daemon only, so the
// Mac read 0 sessions working and the minute counted as idle agent memory. GBS is the Mac's Agent sessions GB from 20:30:30Z to 20:57:30Z
// (browser-chat/mac-usable/2026-11-26.jsonl). The line kept no cpu_pct, so the feed below gives the thread one core in the 20:56:30Z minute
// and 0% in the rest, as its 7 idle kernels read at 21:07Z.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measure } from "../scripts/duties/whole-system.ts";
import { type Footprints, hostWatchLine, threadsAtWork, watchLine, type WatchLine } from "../src/mac-usable-watch.ts";

const MIN = 60_000;
const THREAD = "4f9dad47-ee36-446b-a689-7611335e0354";
const START = Date.parse("2026-11-25T20:30:30Z");
const GBS = [0.54, 0.54, 0.54, 0.54, 0.5, 0.51, 0.51, 0.51, 0.5, 0.5, 0.57, 0.57, 0.57, 0.57, 0.54, 0.62, 0.78, 0.82, 0.82, 0.81, 0.81, 0.82, 0.98,
  0.75, 0.76, 0.86, 5.83, 0.76];
const BUSY_AT = Date.parse("2026-11-25T20:56:30Z");
const footprints: Footprints = { workers: {}, kernels: [], swap_used_bytes: 0, pressure_level: 2, cpu_s: 0 };
const feed = (at: number, gb: number, cpuPct: number) => ({ v: 1, ts: new Date(at - 5_000).toISOString(), pressure_level: 2, swapouts_per_s: 0,
  kernel_task_cpu_pct: 30, owners: [{ owner: "browser:chrome", label: "Google Chrome", mem_gb: 16.64, cpu_pct: 20 },
    { owner: `chat:${THREAD}`, label: THREAD, mem_gb: gb, cpu_pct: cpuPct }] });

/** One us-metal02 line with the Mac's relay answer for that minute, judged as the chat service on us-metal02 judges it. */
async function lineAt(at: number, gb: number): Promise<WatchLine> {
  const mac = await hostWatchLine({ name: "mac", rows: [], read: async () => ({ usable: { platform: "darwin", feed: feed(at, gb, at === BUSY_AT ? 100 : 0) }, footprints }) },
    { now: at, chats: new Set(), title: () => null });
  return { host: "us-metal02", ...watchLine({ now: at, rows: [], footprints, queue: null, chats: new Set(), title: () => null, cpuMs: 0, usable: null }), hosts: [mac] };
}

test("a sw factory thread at work on the Mac breaks the quiet stretch, so its 5.32 GB minute is no idle agent memory", async () => {
  const watch = await Promise.all(GBS.map((gb, index) => lineAt(START + index * MIN, gb)));
  const busy = watch.find(line => Date.parse(line.at) === BUSY_AT)!.hosts![0]!.agents!;
  assert.deepEqual({ gb: busy.gb, working: busy.working, threadsWorking: busy.threadsWorking }, { gb: 5.83, working: 0, threadsWorking: 1 });
  const output = measure({ now: Date.parse("2026-11-25T20:58:00Z"), watch, log: { holds: [] }, chats: [], quietMs: 15 * MIN });
  assert.equal(output.metrics.quiet_agent_gb_mac, 0.98, "the old count read the 5.83 GB minute, as d7 did at 05:57 KST");
});

test("an idle thread's kernels still count, and a busy chat owner that is a Prime session is left to its row", () => {
  const usable = { pressureLevel: 2, swapoutsPerS: 0, kernelTaskPct: 30, busyChats: [THREAD, "01a11ba8-prime"] };
  assert.equal(threadsAtWork(usable, [{ sessionId: "01a11ba8-prime", activeSessionId: "01a11ba8-prime", lifecycle: "live", workerPid: 1 }]), 1);
  assert.equal(threadsAtWork({ pressureLevel: 2, swapoutsPerS: 0, kernelTaskPct: 30 }, []), 0);
});
