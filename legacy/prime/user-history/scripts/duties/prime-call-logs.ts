/**
 * Two Prime numbers d7 keeps from the call logs the daemon writes under ~/.prime/agent/logs: how long a session rename takes (p1373) and how
 * many worker event-loop stalls of 5 s or more a day there are (p1360). The supervisor writes one line per client call to
 * daemon.sock.<id>.calls.jsonl (one `.old` generation), and each worker writes its stalls to worker-<id>.sock.<id>.calls.jsonl.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** The window of the stall count, a day as the goal counts them. */
export const PRIME_CALLS_WINDOW_MS = 24 * 3_600_000;
/**
 * The window of the rename p90: renames ran about 5 an hour on us-metal02 on 11-03 (30 from 13:36Z to 19:22Z), so 6 h holds about 30, and a fix
 * shows in the reading within 6 h instead of a day.
 */
export const RENAME_WINDOW_MS = 6 * 3_600_000;
/** A stall this long is one the goal counts: from 11-02 to 11-03 workers averaged 5.75 a day before the fixes, and the target is 0. */
export const STALL_MS = 5_000;
/**
 * Stalls in this many workers within BURST_MS are box-wide load, not one worker's code: at 22:38:12Z on 11-02, 9 workers stalled 5.0 to 9.9 s
 * in the same 3 s while the box ran at full CPU.
 */
export const BURST_WORKERS = 3;
export const BURST_MS = 10_000;

export interface PrimeCallsReading {
  /** The p90 of successful renames in the last RENAME_WINDOW_MS in seconds; absent with no rename. */
  renameP90S?: number;
  renames: number;
  renameMaxS?: number;
  /** Worker stalls of STALL_MS or more in the window, outside bursts. */
  workerStalls: number;
  /** Worker stalls in bursts of BURST_WORKERS or more workers, left out of workerStalls. */
  burstStalls: number;
  supervisorStalls: number;
  /** The newest counted worker stall, ms. */
  lastStallAt?: number;
  /** One line per counted stall: when, which file and how long. */
  stallLines: string[];
}

interface Stall { at: number; source: string; ms: number }

const p90 = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.round(0.9 * (sorted.length - 1)))]!;
};

/** Reads the call log lines of each file (`files` maps a file's name to its lines) over the window ending at `now`. */
export function readPrimeCalls(files: ReadonlyMap<string, readonly string[]>, now: number): PrimeCallsReading {
  const from = now - PRIME_CALLS_WINDOW_MS;
  const renames: number[] = [];
  const worker: Stall[] = [];
  let supervisorStalls = 0;
  for (const [name, lines] of files) {
    const source = name.replace(/\.calls\.jsonl(\.old)?$/, "");
    for (const line of lines) {
      const rename = line.includes('"method":"rename"');
      if (!rename && !line.includes('"event_loop_stall"')) continue;
      let entry: { ts?: unknown; src?: unknown; method?: unknown; event?: unknown; ms?: unknown; outcome?: unknown };
      try {
        entry = JSON.parse(line) as typeof entry;
      } catch {
        continue;
      }
      const at = typeof entry.ts === "string" ? Date.parse(entry.ts) : NaN;
      if (!(at >= from && at <= now) || typeof entry.ms !== "number") continue;
      if (entry.method === "rename" && entry.outcome === "ok") {
        if (at >= now - RENAME_WINDOW_MS) renames.push(entry.ms / 1000);
      }
      else if (entry.event === "event_loop_stall" && entry.ms >= STALL_MS) {
        if (entry.src === "worker") worker.push({ at, source, ms: entry.ms });
        else supervisorStalls++;
      }
    }
  }
  worker.sort((a, b) => a.at - b.at);
  const inBurst = (stall: Stall) =>
    new Set(worker.filter(other => Math.abs(other.at - stall.at) <= BURST_MS).map(other => other.source)).size >= BURST_WORKERS;
  const counted = worker.filter(stall => !inBurst(stall));
  return {
    ...renames.length ? { renameP90S: Math.round(p90(renames) * 1000) / 1000, renameMaxS: Math.max(...renames) } : {},
    renames: renames.length,
    workerStalls: counted.length,
    burstStalls: worker.length - counted.length,
    supervisorStalls,
    ...counted.length ? { lastStallAt: counted.at(-1)!.at } : {},
    stallLines: counted.map(stall => `${new Date(stall.at).toISOString().slice(0, 19)}Z ${stall.source} ${(stall.ms / 1000).toFixed(1)} s`),
  };
}

/** The lines of every call log in `logs` written within the window. */
export async function readCallLogs(logs: string, now: number): Promise<Map<string, string[]>> {
  const names = (await readdir(logs).catch(() => [] as string[])).filter(name => /\.calls\.jsonl(\.old)?$/.test(name));
  const files = new Map<string, string[]>();
  await Promise.all(names.map(async name => {
    const file = join(logs, name);
    const info = await stat(file).catch(() => null);
    if (!info || info.mtimeMs < now - PRIME_CALLS_WINDOW_MS) return;
    files.set(name, (await readFile(file, "utf8").catch(() => "")).split("\n"));
  }));
  return files;
}
