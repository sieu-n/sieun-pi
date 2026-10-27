import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { TurnHour } from "./shared/types.ts";

/** pi-pool.log, where every admit and release of the turn queue lands as one JSON line (pool/base.py `log`). PI_POOL_DIR moves it, as it moves the pool. */
export const POOL_LOG = join(process.env.PI_POOL_DIR || join(homedir(), ".config", "pi-pool"), "pi-pool.log");
const HOUR_MS = 3_600_000;
/** The chart shows the last 7 days by hour. */
export const HISTORY_HOURS = 7 * 24;
/** Owner and prod turns skip the queue, so their zero waits would hide what queued turns waited. */
const NO_WAIT_KINDS: ReadonlySet<unknown> = new Set(["owner", "prod"]);

interface Bucket { finished: number; waits: number[] }

/**
 * The hour a pi-pool.log `ts` falls in, in epoch ms, which is also the start of a local clock hour in a zone of whole hours. pi-pool writes
 * UTC with no offset ("2026-10-16T05:02:50") since 10-27, and the writer's local time before.
 */
export function hourOf(ts: unknown): number | null {
  const m = typeof ts === "string" ? /^(\d{4})-(\d\d)-(\d\d)T(\d\d):\d\d:\d\d$/.exec(ts) : null;
  if (!m) return null;
  const at = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]));
  return Number.isFinite(at) ? at : null;
}

/** Adds one log line to the hour buckets; lines that are not turn_released or a queued turn_admitted change nothing. */
export function addLine(buckets: Map<number, Bucket>, line: string): void {
  if (!line.includes('"turn_released"') && !line.includes('"turn_admitted"')) return;
  let row: unknown;
  try { row = JSON.parse(line); } catch { return; }
  if (typeof row !== "object" || row === null) return;
  const { ts, event, kind, waited_s: waited } = row as Record<string, unknown>;
  const at = hourOf(ts);
  if (at === null) return;
  const bucket = buckets.get(at) ?? { finished: 0, waits: [] };
  if (event === "turn_released") bucket.finished++;
  else if (event === "turn_admitted" && !NO_WAIT_KINDS.has(kind) && typeof waited === "number" && Number.isFinite(waited) && waited >= 0) bucket.waits.push(waited);
  else return;
  buckets.set(at, bucket);
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The hours from the first one with a line, at most HISTORY_HOURS back, to the hour `now` is in, with empty hours as zero. */
export function hours(buckets: Map<number, Bucket>, now: number): TurnHour[] {
  const last = hourOf(utcTs(now));
  if (last === null) return [];
  const floor = last - (HISTORY_HOURS - 1) * HOUR_MS;
  const kept = [...buckets.keys()].filter(at => at >= floor && at <= last);
  if (!kept.length) return [];
  const out: TurnHour[] = [];
  for (let at = Math.min(...kept); at <= last; at += HOUR_MS) {
    const bucket = buckets.get(at);
    out.push({ at, finished: bucket?.finished ?? 0, medianWaitS: bucket ? median(bucket.waits) : null });
  }
  return out;
}
/** `at` stamped as pi-pool stamps `ts`. */
const utcTs = (at: number): string => new Date(at).toISOString().slice(0, 19);

/**
 * Reads pi-pool.log by hour for the Agent queue chart. The first read scans the whole file (19 MB on 10-16, about 0.2 s); each later read
 * reads only the bytes added since, and a file that shrank (a new log) is read again from the start. Hours older than the chart are dropped.
 */
export function turnHistory(path = POOL_LOG): (now?: number) => Promise<TurnHour[]> {
  let buckets = new Map<number, Bucket>();
  let offset = 0;
  let rest = "";
  let decoder = new StringDecoder("utf8");
  let reading: Promise<void> | null = null;

  async function catchUp(): Promise<void> {
    const size = (await stat(path)).size;
    if (size < offset) { buckets = new Map(); offset = 0; rest = ""; decoder = new StringDecoder("utf8"); }
    if (size === offset) return;
    const file = await open(path, "r");
    try {
      const chunk = Buffer.alloc(Math.min(size - offset, 8 << 20));
      while (offset < size) {
        const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, size - offset), offset);
        if (!bytesRead) break;
        offset += bytesRead;
        const lines = (rest + decoder.write(chunk.subarray(0, bytesRead))).split("\n");
        rest = lines.pop() ?? "";
        for (const line of lines) addLine(buckets, line);
      }
    } finally { await file.close(); }
  }

  return async (now = Date.now()) => {
    reading ??= catchUp().finally(() => { reading = null; });
    try { await reading; } catch { return []; }
    const floor = (hourOf(utcTs(now)) ?? now) - HISTORY_HOURS * HOUR_MS;
    for (const at of buckets.keys()) if (at < floor) buckets.delete(at);
    return hours(buckets, now);
  };
}
