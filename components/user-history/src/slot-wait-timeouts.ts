/**
 * A timed-out send or status read whose session was waiting for a pi-pool turn slot, for the Whole system precheck
 * (scripts/duties/whole-system.ts). On 10-18 the outbox's send_message to frontend bro on the Mac at 13:01:33.205Z timed out after 30 s, and
 * its message reached the session file at 13:02:43.704Z: the session had queued for a working slot at 13:01:27.426Z (a `pi-pool-queue` entry)
 * and its worker kept writing at 13:01:35Z, 13:02:03Z and 13:02:12Z (/home/sieun/work/mac-slowlink/RESULT.md). That worker was busy behind
 * pi-pool's queue, and a clean minute leaves queue waits to their own count, so such a timeout is booked here and not as a daemon fault. A
 * timeout with no landing and no write after it, or with no slot wait while it waited, stays a daemon fault.
 */
import type { DaemonFault } from "./daemon-faults.ts";

/**
 * How long after a timeout the message's landing or the worker's next write still shows the call went through. On 10-18 the outbox found
 * 30 sends landed after a 30 s send_message timeout, from 11:24Z to 13:03Z: its "is landed" line came 2.0 to 262 s after the timeout, with a
 * median of 7.2 s and 27 of them within 60 s; frontend bro's 13:01Z send was found at 66.9 s.
 */
export const DELIVERY_WINDOW_MS = 300_000;

/** The calls a busy worker answers late: a send and a status read. */
const CALLS = new Set(["send_message", "get_state"]);

/** What a session file says about its worker over a stretch: when it wrote, and when it waited for a pi-pool turn slot. */
export interface TranscriptMarks {
  writes: number[];
  /** From a `pi-pool-queue` entry (components/pi-pool/app/extension/index.ts) to the next assistant message; `to` is absent while it waits. */
  slotWaits: { from: number; to?: number }[];
}

export interface SlotWaitTimeout {
  fault: DaemonFault;
  /** When the call went out: the timeout's line less the time the service waited. */
  sentAt: number;
  /** When the call showed it went through: the outbox's landed line, else the worker's first write after the call went out. */
  deliveredAt: number;
  how: "landed" | "wrote";
  slotFrom: number;
}

const ISO = /"timestamp":"(\d{4}-\d\d-\d\dT[\d:.]+Z)"/;

/**
 * The marks in a session file's lines. A line can hold megabytes of images, so only its head and tail are read: a message names its time
 * before its content, and a custom entry names it last.
 */
export function transcriptMarks(lines: readonly string[]): TranscriptMarks {
  const marks: TranscriptMarks = { writes: [], slotWaits: [] };
  for (const line of lines) {
    const head = line.slice(0, 400);
    const stamp = ISO.exec(head)?.[1] ?? ISO.exec(line.slice(-200))?.[1];
    const at = stamp ? Date.parse(stamp) : NaN;
    if (!Number.isFinite(at)) continue;
    marks.writes.push(at);
    const open = marks.slotWaits.at(-1);
    if (head.includes('"customType":"pi-pool-queue"')) { if (!open || open.to !== undefined) marks.slotWaits.push({ from: at }); }
    else if (open && open.to === undefined && head.includes('"message":{"role":"assistant"')) open.to = at;
  }
  return marks;
}

const LANDED = /^(\S+Z) outbox [0-9a-f]{8}(?: on [\w.-]+)?: (m-\S+) is landed from the send at /;

/** When the outbox found each message in its target's file, from its service.log lines. */
export function outboxLandings(lines: readonly string[]): Map<string, number> {
  const landed = new Map<string, number>();
  for (const line of lines) {
    const found = LANDED.exec(line);
    if (found && !landed.has(found[2]!)) landed.set(found[2]!, Date.parse(found[1]!));
  }
  return landed;
}

/** The faults whose session file the precheck reads: timed-out sends and status reads that name a session. */
export const deliveryCandidates = (faults: readonly DaemonFault[]): DaemonFault[] =>
  faults.filter(fault => fault.session && fault.timedOut && CALLS.has(fault.timedOut.call));

/**
 * Splits `faults` into the daemon faults that stay and the timeouts booked as slot waits: a timed-out send or status read that its message's
 * landing or its worker's write followed within DELIVERY_WINDOW_MS, while a slot wait in its session's file overlapped the span from the call
 * to that landing or write.
 */
export function splitSlotWaits(faults: readonly DaemonFault[], landed: ReadonlyMap<string, number>,
  marksOf: (fault: DaemonFault) => TranscriptMarks | undefined): { faults: DaemonFault[]; slotWaits: SlotWaitTimeout[] } {
  const kept: DaemonFault[] = [];
  const slotWaits: SlotWaitTimeout[] = [];
  for (const fault of faults) {
    const marks = fault.session && fault.timedOut && CALLS.has(fault.timedOut.call) ? marksOf(fault) : undefined;
    const sentAt = fault.at - (fault.timedOut?.ms ?? 0);
    const by = fault.at + DELIVERY_WINDOW_MS;
    const landing = fault.message ? landed.get(fault.message) : undefined;
    const wrote = marks?.writes.find(at => at > sentAt && at <= by);
    const deliveredAt = landing !== undefined && landing > fault.at && landing <= by ? landing : wrote;
    const slot = deliveredAt === undefined ? undefined : marks?.slotWaits.find(wait => wait.from <= deliveredAt && (wait.to ?? Infinity) >= sentAt);
    if (deliveredAt === undefined || !slot) { kept.push(fault); continue; }
    slotWaits.push({ fault, sentAt, deliveredAt, how: deliveredAt === landing ? "landed" : "wrote", slotFrom: slot.from });
  }
  return { faults: kept, slotWaits };
}

/**
 * The lines of a session file from about `since` on, read from its end in growing pieces so a 131 MB file (frontend bro's on 10-18) costs a
 * few megabytes. `read` gives the bytes from an offset to the end; `size` is the file's length.
 */
export async function linesSince(size: number, since: number, read: (from: number) => Promise<Buffer>): Promise<string[]> {
  let piece = 4 << 20;
  for (;;) {
    const from = Math.max(0, size - piece);
    const lines = (await read(from)).toString("utf8").split("\n");
    if (from > 0) lines.shift();
    const first = lines.find(line => ISO.test(line.slice(0, 400)));
    const firstAt = first ? Date.parse(ISO.exec(first.slice(0, 400))![1]!) : Infinity;
    if (from === 0 || firstAt < since) return lines.filter(line => line.length > 0);
    piece *= 4;
  }
}

/**
 * The marks of each session that a candidate timeout names, keyed by its short id. A session on this box is read from its file; one on
 * another box from this box's copy of its file (src/host-catalogs.ts `mirrorPath`) when that copy was written after the window it needs, else
 * through the box's relay, else from the copy as it is. Only the sessions with a timeout are read.
 */
export async function readSessionMarks(candidates: readonly DaemonFault[], fileOf: (short: string) => string | undefined, local: string,
  now: number): Promise<Map<string, TranscriptMarks>> {
  const { open, stat } = await import("node:fs/promises");
  const readLocal = async (path: string, since: number): Promise<string[]> => {
    const handle = await open(path, "r");
    try {
      const { size } = await handle.stat();
      return await linesSince(size, since, async from => { const bytes = Buffer.alloc(size - from); await handle.read(bytes, 0, bytes.length, from); return bytes; });
    } finally { await handle.close(); }
  };
  const bySession = new Map<string, DaemonFault[]>();
  for (const fault of candidates) { const short = fault.session!.slice(0, 8); bySession.set(short, [...bySession.get(short) ?? [], fault]); }
  const marks = new Map<string, TranscriptMarks>();
  await Promise.all([...bySession].map(async ([short, faults]) => {
    const path = fileOf(short);
    if (!path) return;
    const host = faults[0]!.host;
    const since = Math.min(...faults.map(fault => fault.at - (fault.timedOut?.ms ?? 0))) - 30 * 60_000;
    const needed = Math.min(now, Math.max(...faults.map(fault => fault.at)) + DELIVERY_WINDOW_MS);
    try {
      if (host === local) { marks.set(short, transcriptMarks(await readLocal(path, since))); return; }
      const { mirrorPath } = await import("./host-catalogs.ts");
      const copy = mirrorPath({ name: host }, path);
      const copied = await stat(copy).then(info => info.mtimeMs, () => undefined);
      if (copied !== undefined && copied >= needed) { marks.set(short, transcriptMarks(await readLocal(copy, since))); return; }
      try {
        const { hostNamed, loadHosts, readHostFile } = await import("./hosts.ts");
        const box = hostNamed(await loadHosts(), host);
        const { size } = await readHostFile(box, path, { from: Number.MAX_SAFE_INTEGER });
        marks.set(short, transcriptMarks(await linesSince(size, since, async from => (await readHostFile(box, path, { from })).bytes)));
      } catch (error) {
        if (copied === undefined) throw error;
        marks.set(short, transcriptMarks(await readLocal(copy, since)));
      }
    } catch { /* An unread file shows no delivery, so its timeouts stay daemon faults. */ }
  }));
  return marks;
}
