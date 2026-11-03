/**
 * The Prime events that make a d7 minute dirty, from the call logs the daemon writes under ~/.prime/agent/logs: an event-loop stall of 5 s or
 * more in a worker or the supervisor (p1360, p1354) and a session rename over 1 s (p1373). The supervisor writes one line per client call and its
 * own stalls to daemon.sock.<id>.calls.jsonl (one `.old` generation), and each worker writes its stalls to worker-<id>.sock.<id>.calls.jsonl.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** A stall this long dirties its minute: from 11-02 to 11-03 workers averaged 5.75 a day of them, and the owner feels each one as a hang. */
export const STALL_MS = 5_000;
/** A rename slower than this dirties its minute: p1373's target, since the owner waits on a rename in the chat's sidebar. */
export const SLOW_RENAME_MS = 1_000;

export type PrimeEvent =
  | { kind: "stall"; src: "worker" | "supervisor"; source: string; from: number; to: number; ms: number }
  | { kind: "rename"; source: string; target?: string; from: number; to: number; ms: number };

/** The short name of a call log: a worker's id (`worker-<daemon>-<worker>.sock...`) or `supervisor`. */
const sourceOf = (file: string): string => /^worker-[0-9a-f]+-([0-9a-f]+)\.sock/.exec(file)?.[1] ?? "supervisor";

/** The stalls and slow renames in the call logs (`files` maps a file's name to its lines) that overlap `from` to `to`. */
export function readPrimeEvents(files: ReadonlyMap<string, readonly string[]>, from: number, to: number): PrimeEvent[] {
  const events: PrimeEvent[] = [];
  for (const [name, lines] of files) {
    const source = sourceOf(name);
    for (const line of lines) {
      const rename = line.includes('"method":"rename"');
      if (!rename && !line.includes('"event_loop_stall"')) continue;
      let entry: { ts?: unknown; src?: unknown; method?: unknown; event?: unknown; ms?: unknown; since?: unknown; target?: unknown };
      try {
        entry = JSON.parse(line) as typeof entry;
      } catch {
        continue;
      }
      const end = typeof entry.ts === "string" ? Date.parse(entry.ts) : NaN;
      if (!Number.isFinite(end) || typeof entry.ms !== "number") continue;
      const since = typeof entry.since === "string" ? Date.parse(entry.since) : NaN;
      const start = Number.isFinite(since) ? since : end - entry.ms;
      if (start >= to || end < from) continue;
      if (entry.method === "rename" && entry.ms > SLOW_RENAME_MS)
        events.push({ kind: "rename", source, ...typeof entry.target === "string" ? { target: entry.target } : {}, from: start, to: end, ms: entry.ms });
      else if (entry.event === "event_loop_stall" && entry.ms >= STALL_MS)
        events.push({ kind: "stall", src: entry.src === "worker" ? "worker" : "supervisor", source, from: start, to: end, ms: entry.ms });
    }
  }
  return events.sort((a, b) => a.from - b.from);
}

/** The dirty-line words for the Prime events of one minute, at most `most` named. */
export function primeWords(events: readonly PrimeEvent[], most = 3): string {
  const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const stalls = events.filter(event => event.kind === "stall");
  const renames = events.filter(event => event.kind === "rename");
  const named = <T>(list: readonly T[], word: (item: T) => string) =>
    list.slice(0, most).map(word).join(", ") + (list.length > most ? ` and ${list.length - most} more` : "");
  return [
    stalls.length ? `Prime event loops stalled 5 s or more (${named(stalls, stall => `${stall.src === "worker" ? `worker ${stall.source}` : "supervisor"} ${secs(stall.ms)}`)})` : "",
    renames.length ? `Prime session renames took over 1 s (${named(renames, rename => `${rename.target ?? "a session"} ${secs(rename.ms)}`)})` : "",
  ].filter(Boolean).join(", ");
}

/** The lines of every call log in `logs` written since `since`. */
export async function readCallLogs(logs: string, since: number): Promise<Map<string, string[]>> {
  const names = (await readdir(logs).catch(() => [] as string[])).filter(name => /\.calls\.jsonl(\.old)?$/.test(name));
  const files = new Map<string, string[]>();
  await Promise.all(names.map(async name => {
    const file = join(logs, name);
    const info = await stat(file).catch(() => null);
    if (!info || info.mtimeMs < since) return;
    files.set(name, (await readFile(file, "utf8").catch(() => "")).split("\n"));
  }));
  return files;
}
