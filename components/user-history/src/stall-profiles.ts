import { mkdir, stat, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { SLOW_READ_MS } from "./harness-slow.ts";

/**
 * CPU profiles of the chat service's own minutes in which its event loop stalled over SLOW_READ_MS, the stall that makes a Whole system (d7)
 * minute dirty. On 10-19 from 22:03Z, after user@1001.service got cpu.weight 10000, the chat's main thread waited 0.02 to 0.4 s a second for a
 * CPU and still stalled 1.1 to 2.5 s in 4 of 17 minutes, while it read 1,625 transcripts in 3 minutes on its main thread. A profile of a
 * scratch serve showed none of it, because a scratch serve attaches no session, and the live service takes no debugger (AGENTS.md), so the
 * service profiles itself through an in-process inspector session.
 * It runs only while `<dataDir>/stall-profiles` exists: make the folder to start it, remove it to stop it, read the files with Chrome DevTools.
 */
export const STALL_PROFILE_DIR = "stall-profiles";
/** One window per 20 s keeps a stall's profile small enough to save without a stall of its own and names the minute it fell in. */
const WINDOW_MS = 20_000;
/** 1 ms is V8's default sampling interval; a 1 s stall then holds about 1,000 samples. */
const SAMPLE_US = 1000;

export interface StallProfiles { stop(): Promise<void> }

const exists = (path: string): Promise<boolean> => stat(path).then(found => found.isDirectory(), () => false);

/** The name of a saved profile: the window's end and its longest stall, so a listing sorts by time and shows the worst. */
export const profileName = (end: Date, stallMs: number): string => `${end.toISOString().replace(/[:.]/g, "-")}-${Math.round(stallMs)}ms.cpuprofile`;

export function startStallProfiles(input: { dataDir: string; log: (line: string) => void; windowMs?: number }): StallProfiles {
  const dir = join(input.dataDir, STALL_PROFILE_DIR);
  const windowMs = input.windowMs ?? WINDOW_MS;
  let session: Session | null = null;
  let stopped = false;
  const loop = monitorEventLoopDelay({ resolution: 20 });
  const turn = async (): Promise<void> => {
    const on = await exists(dir);
    if (session) {
      const { profile } = await session.post("Profiler.stop");
      const stallMs = loop.max / 1e6;
      loop.reset();
      if (stallMs > SLOW_READ_MS && on) {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, profileName(new Date(), stallMs)), JSON.stringify(profile));
      }
    }
    if (!on || stopped) { if (session) { session.disconnect(); session = null; loop.disable(); input.log("stall profiles: off"); } return; }
    if (!session) {
      session = new Session();
      session.connect();
      await session.post("Profiler.enable");
      await session.post("Profiler.setSamplingInterval", { interval: SAMPLE_US });
      loop.reset(); loop.enable();
      input.log(`stall profiles: on, a window over ${SLOW_READ_MS} ms goes to ${dir}`);
    }
    await session.post("Profiler.start");
  };
  let running = Promise.resolve();
  const tick = (): void => { running = running.then(turn).catch(error => input.log(`stall profiles: ${error instanceof Error ? error.message : String(error)}`)); };
  tick();
  const timer = setInterval(tick, windowMs);
  timer.unref();
  return { stop: async () => { stopped = true; clearInterval(timer); tick(); await running; } };
}
