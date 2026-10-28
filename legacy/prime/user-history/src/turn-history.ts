import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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

/** The file in the chat's data dir a stop saves the read hours to (`TurnHistory.save`). */
export const TURN_HISTORY_FILE = "turn-history.json";
/** What `TurnHistory.save` writes: the hour buckets and the byte offset of the first line not read yet, in the file with inode `ino`. */
type SavedHistory = { ino: number; offset: number; buckets: [number, Bucket][] };
const SLICE_BYTES = 1 << 20;

export interface TurnHistory {
  (now?: number): Promise<TurnHour[]>;
  /** Writes what was read to the `saved` file, for the next start; nothing before the first read, so a saved file nobody took stays. */
  save(): Promise<void>;
}

/**
 * Reads pi-pool.log by hour for the Agent queue chart. The first read scans the whole file; each later read reads only the bytes added since,
 * and a file that shrank or was replaced (a new log) is read again from the start. Hours older than the chart are dropped. The log was 19 MB
 * on 10-16 (about 0.2 s) and 137 MB on 10-28, when each chat service start scanned it again: 1.5 to 1.7 s of the main thread in 8 MB slices
 * (CPU profiles of the 18:02Z and 18:14Z starts), and the first ran beside an api/threads/<id>/older read that took 1.02 s (d7 counted 18:05Z
 * dirty). So a stop saves the buckets and offset to `saved` (`save`), the next start's first read takes them and reads only what came since,
 * and a scan yields to the loop after each SLICE_BYTES.
 */
export function turnHistory(path = POOL_LOG, saved: string | null = null): TurnHistory {
  let buckets = new Map<number, Bucket>();
  let offset = 0;
  let ino: number | null = null;
  let taken = saved === null;
  let reading: Promise<void> | null = null;

  async function take(): Promise<void> {
    taken = true;
    let text: string;
    try { text = await readFile(saved!, "utf8"); } catch { return; }
    await unlink(saved!).catch(() => {});
    try {
      const value = JSON.parse(text) as Partial<SavedHistory>;
      if (typeof value.ino !== "number" || typeof value.offset !== "number" || !Array.isArray(value.buckets)) return;
      buckets = new Map(value.buckets.filter(([at, bucket]) => typeof at === "number" && typeof bucket?.finished === "number" && Array.isArray(bucket.waits)));
      ino = value.ino;
      offset = value.offset;
    } catch {}
  }

  async function catchUp(): Promise<void> {
    if (!taken) await take();
    const info = await stat(path);
    if (info.size < offset || (ino !== null && info.ino !== ino)) { buckets = new Map(); offset = 0; }
    ino = info.ino;
    if (info.size === offset) return;
    const file = await open(path, "r");
    try {
      const chunk = Buffer.alloc(Math.min(info.size - offset, SLICE_BYTES));
      let carry = 0;
      while (offset + carry < info.size) {
        const { bytesRead } = await file.read(chunk, carry, Math.min(chunk.length - carry, info.size - offset - carry), offset + carry);
        if (!bytesRead) break;
        const filled = carry + bytesRead;
        // Only whole lines are read: a newline byte never sits inside a UTF-8 character, so the cut never splits one.
        const end = chunk.lastIndexOf(0x0a, filled - 1) + 1;
        if (end === 0 && filled === chunk.length) { offset += filled; carry = 0; continue; }
        for (const line of chunk.toString("utf8", 0, end).split("\n")) addLine(buckets, line);
        offset += end;
        carry = filled - end;
        chunk.copy(chunk, 0, end, filled);
        if (offset + carry < info.size) await new Promise<void>(resolve => { setImmediate(resolve); });
      }
    } finally { await file.close(); }
  }

  const read = async (now = Date.now()): Promise<TurnHour[]> => {
    reading ??= catchUp().finally(() => { reading = null; });
    try { await reading; } catch { return []; }
    const floor = (hourOf(utcTs(now)) ?? now) - HISTORY_HOURS * HOUR_MS;
    for (const at of buckets.keys()) if (at < floor) buckets.delete(at);
    return hours(buckets, now);
  };
  return Object.assign(read, {
    async save(): Promise<void> {
      if (saved === null || !taken || ino === null) return;
      await reading?.catch(() => {});
      const temp = `${saved}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify({ ino, offset, buckets: [...buckets] } satisfies SavedHistory), { mode: 0o600 });
      await rename(temp, saved);
    },
  });
}
