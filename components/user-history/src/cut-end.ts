import { open } from "node:fs/promises";
import { clockTime } from "./checkin-settings.ts";
import { poolSlot } from "./shared/chat-feed.ts";
import { turnError } from "./shared/credential-wait.ts";
import { turnErrorCause } from "./turn-error.ts";

/**
 * How a job's last turn ended when it was cut and nothing came after it, read from its transcript. On 10-16 at 00:19:57Z queued jobs (local agents
 * checks, local agents recovery) each wrote `archived`, then an empty aborted reply, did no work and sent no report, while the agents panel and the
 * Whole system duty read them as done. The words name only what the transcript shows: duty fix opener wrote the same pair at 04:14:29Z when a chat
 * stopped it with the supervisor alive, so an archive and abort never proves the daemon went down.
 */
export type CutCause = "archived" | "error" | "length" | "mid-tool";
/**
 * `archivedAt` is when the session was archived at or after its cut. An archive by itself says nothing about why: on 10-16 lost agent resumes
 * traced all 6 cut jobs the Whole system duty listed at 07:50Z to a parent's rlm.delete_subagent (4) or the parker ending the job above them (2),
 * and only 1 of 40 archive cuts fell inside a supervisor restart. The duty counts an archived cut only with proof of an interruption.
 */
export interface Cut { at: number; cause: CutCause; archivedAt?: number;
  /**
   * The slot pi-pool gave a provider error (`poolSlot`): the session waits in pi-pool's queue until then and Prime's retry starts it at the slot.
   * On 10-18 from 09:05Z to 10:43Z 13 jobs on such errors read 11 to 15 min cut holds each, every check-in restart before the slot got the same
   * refusal ("waits for its slot at 10:43:30"), and each job started within a minute of its slot.
   */
  slotAt?: number;
  /** A provider error's cause in plain words (`turnErrorCause`), so the agents panel names it instead of "a provider error". */
  error?: string }

/** An archive writes `archived` and then the aborted reply within milliseconds; a Stop that does not archive writes the abort alone. */
export const ARCHIVE_ABORT_MS = 5_000;
/**
 * `readCut` reads this tail first, then CUT_CONFIRM_BYTES when the tail ends cut, since a report before the tail clears the cut. Measured 10-16
 * on 6,615 job transcripts against a 4 MB tail: 128 KB alone misread 50 of them as cut, 512 KB 10, and a cold pass took 88 s against 176 s.
 */
export const CUT_TAIL_BYTES = 128_000;
export const CUT_CONFIRM_BYTES = 4_000_000;

const CUT_WORDS: Record<CutCause, string> = {
  archived: "aborted and archived", error: "stopped on a provider error", length: "stopped at the length limit", "mid-tool": "stopped mid-tool",
};

/** What the transcript shows, in words for a sentence, "<name> was <words> at 09:19". */
export const cutWords = (cause: CutCause): string => CUT_WORDS[cause];

/** The line the agents panel shows for a cut job, with the owner's local clock. */
export const cutActivity = (cut: Cut): string =>
  `${cutWords(cut.cause)} at ${clockTime(cut.at)}${cut.error ? ` (${cut.error})` : ""}, no report since`;

/**
 * How a session's last turn ended when it was cut and nothing came after it, from its transcript lines: an abort written right after the session
 * was archived, a provider error, the length limit, or a tool result the model never answered. Null when the
 * turn ended well, an owner's Stop aborted it, an input or a pi-pool queue place came after the end, or the job reported to its parent in that
 * turn. A last tool call is left out, since its tool may still run.
 */
export function cutEnd(lines: readonly string[]): Cut | null {
  const end = lastCut(lines);
  if (!end || reportedBefore(lines, end.index)) return null;
  const { index: _, ...cut } = end;
  return cut;
}

/** A cut and the input that ended it, if one came since: `resumedAt` is that input's time. */
export interface CutSpan extends Cut { resumedAt?: number }

/** Whether a transcript line is an input to the session: a message to it, a user turn, or a pi-pool queue place. */
const isInput = (line: string): boolean =>
  line.includes('"customType":"agent_message"') || line.includes('"customType":"pi-pool-queue"') || line.includes('"role":"user"');

/**
 * Every cut in the lines (`cutEnd`), each with the input that ended it, and last the cut the lines end on, if any. A cut ended by a later input
 * was a real wait all the same: census writer speed was stopped mid-tool at 06:46:13Z on 10-18 and got its next message only at 07:15:10Z,
 * and d7 at 07:25Z and 07:30Z read no hold, because the job no longer ended cut.
 */
export function cutSpans(lines: readonly string[]): CutSpan[] {
  const spans: CutSpan[] = [];
  const add = (end: number, resumedAt?: number) => {
    const cut = lastCut(lines, end);
    if (!cut || reportedBefore(lines, cut.index)) return;
    const { index: _, ...span } = cut;
    spans.push({ ...span, ...resumedAt === undefined ? {} : { resumedAt } });
  };
  lines.forEach((line, index) => {
    if (!isInput(line)) return;
    let at = NaN;
    try { at = Date.parse((JSON.parse(line) as { timestamp?: string }).timestamp ?? ""); } catch { return; }
    if (Number.isFinite(at)) add(index, at);
  });
  add(lines.length);
  return spans;
}

/** Whether the job sent its parent a message between its last input and the line at `index`: a cut after its report left nothing waiting. */
function reportedBefore(lines: readonly string[], index: number): boolean {
  for (let back = index - 1; back >= 0; back--) {
    const line = lines[back]!;
    if (line.includes('"customType":"agent_message"') || line.includes('"role":"user"')) return false;
    if (line.includes('"role":"assistant"') && line.includes("agent_message.send") && line.includes("parent")) return true;
  }
  return false;
}

function lastCut(lines: readonly string[], end = lines.length): (Cut & { index: number }) | null {
  let archivedAfter: number | undefined;
  for (let index = end - 1; index >= 0; index--) {
    let entry: { type?: string; customType?: string; timestamp?: string; state?: { status?: string }; message?: { role?: string; stopReason?: string; errorMessage?: string; diagnostics?: unknown } };
    try { entry = JSON.parse(lines[index]!); } catch { continue; }
    if (entry.type === "custom" && entry.customType === "pi-pool-queue") return null;
    if (entry.type === "custom_message" && entry.customType === "agent_message") return null;
    if (entry.type === "session_state" && entry.state?.status === "archived") archivedAfter ??= Date.parse(entry.timestamp ?? "");
    if (entry.type !== "message" || !entry.message) continue;
    const at = Date.parse(entry.timestamp ?? "");
    const { role, stopReason } = entry.message;
    const archived = archivedAfter === undefined ? {} : { archivedAt: archivedAfter };
    // An archive also lands just before the tool result it aborts: the owner's focus pause on 10-17 archived watchlist last fixes at
    // 23:04:28.977Z and its running tool read "Request was aborted" 29 ms later. That is an archive of the turn, so its archivedAt is set.
    if (role === "toolResult") return { at, cause: "mid-tool", index, ...archivedAfter === undefined ? archivedJustBefore(lines, index, at) : archived };
    if (role !== "assistant") return null;
    if (stopReason === "length") return { at, cause: stopReason, index, ...archived };
    if (stopReason === "error") {
      const error = turnError(entry.message);
      const slotAt = poolSlot(error ?? "");
      return { at, cause: stopReason, index, ...archived, ...slotAt === null ? {} : { slotAt }, error: turnErrorCause(error) };
    }
    if (stopReason !== "aborted") return null;
    for (let back = index - 1; back >= 0; back--) {
      let before: { type?: string; timestamp?: string; state?: { status?: string } };
      try { before = JSON.parse(lines[back]!); } catch { continue; }
      if (before.type !== "session_state") { if (before.type === "message") return null; continue; }
      const archivedAt = Date.parse(before.timestamp ?? "");
      return before.state?.status === "archived" && at - archivedAt <= ARCHIVE_ABORT_MS ? { at, cause: "archived", index, archivedAt } : null;
    }
    return null;
  }
  return null;
}

/** `{ archivedAt }` when the session was archived at most ARCHIVE_ABORT_MS before the line at `index`, with no message between, else nothing. */
function archivedJustBefore(lines: readonly string[], index: number, at: number): { archivedAt?: number } {
  for (let back = index - 1; back >= 0; back--) {
    let before: { type?: string; timestamp?: string; state?: { status?: string } };
    try { before = JSON.parse(lines[back]!); } catch { continue; }
    if (before.type === "message") return {};
    if (before.type !== "session_state" || before.state?.status !== "archived") continue;
    const archivedAt = Date.parse(before.timestamp ?? "");
    return at - archivedAt <= ARCHIVE_ABORT_MS ? { archivedAt } : {};
  }
  return {};
}

/** The last `bytes` of a file as lines, the first (partial) line dropped; none when the file is gone. */
export async function tailLines(file: string, bytes: number): Promise<string[]> {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return [];
  try {
    const { size } = await handle.stat();
    const from = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - from);
    await handle.read(buffer, 0, buffer.length, from);
    const lines = buffer.toString("utf8").split("\n");
    return from > 0 ? lines.slice(1) : lines;
  } finally { await handle.close(); }
}

/**
 * `cutSpans` of a session file for the cuts that ended at or after `since` and the cut it ends on: longer tails up to CUT_CONFIRM_BYTES until
 * the lines hold an input from before `since`, so every input since then has the turn before it. Empty when the file is gone.
 */
export async function readCutSpans(file: string, since: number): Promise<CutSpan[]> {
  let lines: string[] = [];
  for (const bytes of [CUT_TAIL_BYTES, 1_000_000, CUT_CONFIRM_BYTES]) {
    lines = await tailLines(file, bytes);
    if (lines.some(line => isInput(line) && inputBefore(line, since))) break;
  }
  return cutSpans(lines).filter(span => span.resumedAt === undefined || span.resumedAt >= since);
}

const inputBefore = (line: string, since: number): boolean => {
  try { return Date.parse((JSON.parse(line) as { timestamp?: string }).timestamp ?? "") < since; } catch { return false; }
};

/** Whether the lines hold the job's last input, so `cutEnd` saw the whole turn and a longer tail cannot change its answer. */
const holdsInput = (lines: readonly string[]): boolean => lines.some(line => line.includes('"customType":"agent_message"') || line.includes('"role":"user"'));

/**
 * `cutEnd` of a session file: a short tail, then longer ones up to CUT_CONFIRM_BYTES only while the tail ends cut and holds no input yet. Most
 * cuts sit right after their input, so one short read settles them: at 06:48Z on 10-16 reading 4 MB for each of 46 cut jobs helped push the
 * Whole system precheck past its 60 s limit. Null when the file is gone.
 */
export async function readCut(file: string): Promise<Cut | null> {
  let cut: Cut | null = null;
  for (const bytes of [CUT_TAIL_BYTES, 1_000_000, CUT_CONFIRM_BYTES]) {
    const lines = await tailLines(file, bytes);
    cut = cutEnd(lines);
    if (!cut || holdsInput(lines)) return cut;
  }
  return cut;
}

/**
 * Whether a cut just seen gets the pass over interrupted jobs now. An archive is left to the job sweep, which reads its cause first (`Cut`), and
 * a provider error pi-pool holds until its slot is left to Prime's retry at that slot (`slotAt`). Every other cut waited for the next 10 min
 * sweep plus a 45 to 67 s pass: census writer speed, stopped mid-tool at 06:46:13Z on 10-18, got its next message at 07:15:10Z.
 */
export const resumesNow = (cut: Cut, now: number): boolean => cut.cause !== "archived" && !(cut.slotAt !== undefined && cut.slotAt > now);

/** A session file to check and the key that changes when the session gets a new message (the daemon row's `modified` and message count). */
export interface CutSource { file: string; key: string }

/** Files read at once by `SessionCuts.update`, so a cold start of some 2,700 sessions does not queue thousands of reads on the disk. */
const READS_AT_ONCE = 8;

/**
 * The cut ends (`cutEnd`) of the sessions the catalog lists, read in the background so a projection only looks them up. Each file is read again
 * only after its key changed: measured 10-16 on 6,607 job transcripts, a synchronous pass of 512 KB tails took 76 s cold and 3.4 s just to stat
 * them warm.
 */
export class SessionCuts {
  private readonly known = new Map<string, { key: string; cut: Cut | null }>();

  /** `seen` gets each cut that came or moved on a read, so the server can send its continue then instead of at the next job sweep. */
  constructor(private readonly seen: (cut: Cut) => void = () => {}) {}

  /** The cut last read for a session file; null when it ended well or was not read yet. */
  of(file: string | undefined): Cut | null {
    return file ? this.known.get(file)?.cut ?? null : null;
  }

  /** Reads each file whose key changed (`readCut`); true when any file's cut came, went or moved. */
  async update(sources: readonly CutSource[]): Promise<boolean> {
    const stale = sources.filter(source => this.known.get(source.file)?.key !== source.key);
    let changed = false;
    for (let index = 0; index < stale.length; index += READS_AT_ONCE) {
      await Promise.all(stale.slice(index, index + READS_AT_ONCE).map(async ({ file, key }) => {
        const cut = await readCut(file).catch(() => null);
        const before = this.known.get(file)?.cut ?? null;
        if (before?.at !== cut?.at || before?.cause !== cut?.cause) {
          changed = true;
          if (cut) this.seen(cut);
        }
        this.known.set(file, { key, cut });
      }));
    }
    return changed;
  }
}
