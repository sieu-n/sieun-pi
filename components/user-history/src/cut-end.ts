import { open } from "node:fs/promises";
import { clockTime } from "./checkin-settings.ts";

/**
 * How a job's last turn ended when it was cut and nothing came after it, read from its transcript. On 10-16 at 00:19:57Z the Prime daemon went
 * down and archived queued jobs (local agents checks, local agents recovery): each wrote `archived`, then an empty aborted reply, did no work and
 * sent no report, while the agents panel and the Whole system duty read them as done.
 */
export type CutCause = "restart" | "error" | "length" | "mid-tool";
export interface Cut { at: number; cause: CutCause }

/** The daemon writes `archived` and then the aborted reply within milliseconds when it dies or restarts; an owner's Stop writes no archive. */
export const RESTART_ABORT_MS = 5_000;
/**
 * `readCut` reads this tail first, then CUT_CONFIRM_BYTES when the tail ends cut, since a report before the tail clears the cut. Measured 10-16
 * on 6,615 job transcripts against a 4 MB tail: 128 KB alone misread 50 of them as cut, 512 KB 10, and a cold pass took 88 s against 176 s.
 */
export const CUT_TAIL_BYTES = 128_000;
export const CUT_CONFIRM_BYTES = 4_000_000;

const CUT_WORDS: Record<CutCause, string> = {
  restart: "an abort when the Prime daemon went down", error: "a provider error", length: "the length limit", "mid-tool": "a stop mid-tool",
};

/** The cause in words for a sentence, "cut by <words>". */
export const cutWords = (cause: CutCause): string => CUT_WORDS[cause];

/** The line the agents panel shows for a cut job, with the owner's local clock. */
export const cutActivity = (cut: Cut): string => `cut by ${cutWords(cut.cause)} at ${clockTime(cut.at)} and never reported`;

/**
 * How a session's last turn ended when it was cut and nothing came after it, from its transcript lines: an abort the daemon wrote right after
 * archiving the session (it went down or restarted), a provider error, the length limit, or a tool result the model never answered. Null when the
 * turn ended well, an owner's Stop aborted it, an input or a pi-pool queue place came after the end, or the job reported to its parent in that
 * turn. A last tool call is left out, since its tool may still run.
 */
export function cutEnd(lines: readonly string[]): Cut | null {
  const end = lastCut(lines);
  return end && !reportedBefore(lines, end.index) ? { at: end.at, cause: end.cause } : null;
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

function lastCut(lines: readonly string[]): (Cut & { index: number }) | null {
  for (let index = lines.length - 1; index >= 0; index--) {
    let entry: { type?: string; customType?: string; timestamp?: string; state?: { status?: string }; message?: { role?: string; stopReason?: string } };
    try { entry = JSON.parse(lines[index]!); } catch { continue; }
    if (entry.type === "custom" && entry.customType === "pi-pool-queue") return null;
    if (entry.type === "custom_message" && entry.customType === "agent_message") return null;
    if (entry.type !== "message" || !entry.message) continue;
    const at = Date.parse(entry.timestamp ?? "");
    const { role, stopReason } = entry.message;
    if (role === "toolResult") return { at, cause: "mid-tool", index };
    if (role !== "assistant") return null;
    if (stopReason === "error" || stopReason === "length") return { at, cause: stopReason, index };
    if (stopReason !== "aborted") return null;
    for (let back = index - 1; back >= 0; back--) {
      let before: { type?: string; timestamp?: string; state?: { status?: string } };
      try { before = JSON.parse(lines[back]!); } catch { continue; }
      if (before.type !== "session_state") { if (before.type === "message") return null; continue; }
      return before.state?.status === "archived" && at - Date.parse(before.timestamp ?? "") <= RESTART_ABORT_MS ? { at, cause: "restart", index } : null;
    }
    return null;
  }
  return null;
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

/** `cutEnd` of a session file: a short tail, and a long one to confirm a cut. Null when the file is gone. */
export async function readCut(file: string): Promise<Cut | null> {
  return cutEnd(await tailLines(file, CUT_TAIL_BYTES)) && cutEnd(await tailLines(file, CUT_CONFIRM_BYTES));
}

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
        if (before?.at !== cut?.at || before?.cause !== cut?.cause) changed = true;
        this.known.set(file, { key, cut });
      }));
    }
    return changed;
  }
}
