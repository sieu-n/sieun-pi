import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

/*
 * How to tell whether a send that timed out still reached its target. The daemon gives the target's worker 30 s to confirm a send_message
 * and then raises, but the worker still queues the message and delivers it when it is free (p334). 10-15 00:00Z to 10-16 07:50Z resends after
 * such timeouts left 137 extra wake copies, 25 extra server notices and 50 extra agent messages in the session files. The outboxes
 * (src/agent-outbox.ts, src/owner-outbox.ts) look for the first copy with these reads before they send again.
 */

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z/g;
const DUPLICATE_PREFIX = /^\(possible duplicate\)\s*/i;
/** The daemon prefixes a queued agent message's preview with this (prime-agent AGENT_MESSAGE_RECEIVED_PREVIEW_LABEL). */
export const QUEUED_PREFIX = "Agent message received: ";

/** The text as one send: without its ISO times, which a wake or brief rewrites on each try, and a "(possible duplicate)" opener. */
export function sendKey(session: string, text: string): string {
  return session + "\n" + text.trim().replace(DUPLICATE_PREFIX, "").replace(ISO, "").replace(/\s+/g, " ").trim();
}

/**
 * A send failure after which the daemon may still deliver: its 30 s timeout, or its client closing mid-send. 10-17 22:11Z a wake to 01a14be9
 * failed with "daemon client closed before the operation completed", landed at 22:11:57Z anyway, and its resend landed again at 22:14:32Z.
 * A keyed resend whose first send still runs reads uncertain (src/daemon-write.ts WriteUncertain), and the next try sends that id again.
 */
export const isSendTimeout = (error: unknown): boolean =>
  /Timed out after \d+ms waiting for the Prime Agent daemon response to "send_message"|Timed out waiting for daemon worker response|daemon client closed before the operation completed|The previous command result is uncertain/
    .test(error instanceof Error ? error.message : String(error));

/** One agent message line of a session file: the text it carried and when it was written. */
function agentMessage(line: string): { text: string; at: number } | null {
  if (!line.includes('"agent_message"')) return null;
  try {
    const entry = JSON.parse(line) as { customType?: unknown; timestamp?: unknown; details?: { message?: unknown } };
    if (entry.customType !== "agent_message" || typeof entry.details?.message !== "string") return null;
    const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    return Number.isFinite(at) ? { text: entry.details.message, at } : null;
  } catch { return null; }
}

/** A line's write time, for the stop of the backward read: an entry's own "timestamp" is its last key. */
function lineTime(line: string): number {
  const at = line.lastIndexOf('"timestamp":"');
  return at < 0 ? NaN : Date.parse(line.slice(at + 13, line.indexOf('"', at + 13)));
}

/**
 * When one of `texts` landed in the session file at or after `since`, else null. It reads the file backward in 1 MiB steps and stops at the
 * first line written over a minute before `since`, so a 150 MB transcript costs only its recent tail.
 */
export function landedAt(file: string, texts: readonly string[], since: number): Promise<number | null> {
  const wanted = new Set(texts.map(text => text.trim()));
  return messageAt(file, since, text => wanted.has(text.trim()));
}

/** When the newest agent message whose text `match` accepts landed in the session file at or after `since`, else null. */
export function messageAt(file: string, since: number, match: (text: string) => boolean): Promise<number | null> {
  return lineSince(file, since, line => { const found = agentMessage(line); return found && match(found.text) ? found.at : null; });
}

/** When a user message with `text` and `imageCount` images landed in the session file at or after `since`, else null (an owner send, src/owner-outbox.ts). */
export function userMessageAt(file: string, text: string, imageCount: number, since: number): Promise<number | null> {
  return lineSince(file, since, line => {
    if (!line.includes('"role":"user"')) return null;
    try {
      const entry = JSON.parse(line) as { type?: unknown; timestamp?: unknown; message?: { role?: unknown; content?: unknown } };
      if (entry.type !== "message" || entry.message?.role !== "user") return null;
      const content = entry.message.content;
      const parts = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content as { type?: unknown; text?: unknown }[] : [];
      const said = parts.flatMap(part => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("").trim();
      const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
      return said === text.trim() && parts.filter(part => part.type === "image").length === imageCount && Number.isFinite(at) ? at : null;
    } catch { return null; }
  });
}

/** The time `match` gives the newest line written at or after `since` that it matches, reading the file backward as `landedAt` says. */
async function lineSince(file: string, since: number, match: (line: string) => number | null): Promise<number | null> {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return null;
  const found = (line: string) => { const at = match(line); return at !== null && at >= since - 1_000 ? at : null; };
  try {
    let end = (await handle.stat()).size;
    let carry = "";
    const step = 1 << 20;
    while (end > 0) {
      const start = Math.max(0, end - step);
      const buffer = Buffer.alloc(end - start);
      await handle.read(buffer, 0, buffer.length, start);
      const lines = (buffer.toString("utf8") + carry).split("\n");
      carry = start > 0 ? lines.shift() ?? "" : "";
      for (const line of lines.reverse()) {
        const at = found(line);
        if (at !== null) return at;
        const written = lineTime(line);
        if (Number.isFinite(written) && written < since - 60_000) return null;
      }
      end = start;
    }
    return carry ? found(carry) : null;
  } finally { await handle.close(); }
}

/** A session's file: `sessions/<id>.jsonl` for a root, else `<id>.jsonl` in a `sub-*` folder up to three levels under session-artifacts. */
export async function sessionFileOf(sessionId: string, agentDir: string): Promise<string | null> {
  const name = `${sessionId}.jsonl`;
  const root = join(agentDir, "sessions", name);
  if (await stat(root).then(() => true, () => false)) return root;
  const artifacts = join(agentDir, "session-artifacts");
  let level = (await readdir(artifacts).catch(() => [] as string[])).map(entry => join(artifacts, entry));
  for (let depth = 0; depth < 3 && level.length; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      const entries = await readdir(dir).catch(() => [] as string[]);
      if (depth > 0 && entries.includes(name)) return join(dir, name);
      for (const entry of entries) if (entry.startsWith("sub-")) next.push(join(dir, entry));
    }
    level = next;
  }
  return null;
}

/**
 * A target's worker as get_state reads it: its queued texts, whether it runs a turn, a tool or unfinished actions, and the count of messages
 * the daemon holds against its pending message limit (absent when the daemon gave none), which the agent outbox reads for room.
 */
export interface TargetState { queued: string[]; busy: boolean; unfinished?: number }

/**
 * The count a daemon holds against its pending message limit. A daemon that sends the summary's top-level `queuedLanes` (Prime load-h) counts
 * only queued input: its `sessionActions.queuedCount`, or the sum of the lanes on a roster row that carries no `sessionActions`. An older daemon
 * sends no lanes and counts every unfinished action, while its `queuedCount` reads the visible queue only, so `unfinishedActionCount` stands in.
 */
function limitCount(lanes: unknown, queuedCount: unknown, unfinished: number | undefined): number | undefined {
  if (typeof lanes !== "object" || lanes === null) return unfinished;
  if (typeof queuedCount === "number") return queuedCount;
  const { steering, followUp } = lanes as { steering?: unknown; followUp?: unknown };
  return (typeof steering === "number" ? steering : 0) + (typeof followUp === "number" ? followUp : 0);
}

/** The TargetState in get_state's `data`, or in a list or roster row, which share the SessionSummary fields it reads. */
export function targetStateOf(data: unknown): TargetState {
  const state = (typeof data === "object" && data !== null ? data : {}) as { sessionActions?: { steering?: unknown; followUps?: unknown; queuedCount?: unknown };
    queuedLanes?: unknown; isStreaming?: unknown; isCompacting?: unknown; isRunningTools?: unknown; unfinishedActionCount?: unknown };
  const actions = state.sessionActions;
  const unfinished = typeof state.unfinishedActionCount === "number" ? state.unfinishedActionCount : undefined;
  const limited = limitCount(state.queuedLanes, actions?.queuedCount, unfinished);
  return { queued: [actions?.steering, actions?.followUps].flatMap(list => Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []),
    busy: state.isStreaming === true || state.isCompacting === true || state.isRunningTools === true || (unfinished ?? 0) > 0, ...limited === undefined ? {} : { unfinished: limited } };
}

/**
 * `node send-once.ts` reads {sessionId, texts, since, agentDir} on stdin and prints {"landedAt": number | null}, for the agent_message
 * wrapper in a session's Python kernel (message-limit-check.py).
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = JSON.parse(readFileSync(0, "utf8")) as { sessionId?: unknown; texts?: unknown; since?: unknown; agentDir?: unknown };
  const ok = typeof input.sessionId === "string" && /^[\w-]{1,128}$/.test(input.sessionId) && Array.isArray(input.texts) && typeof input.since === "number" && typeof input.agentDir === "string";
  const file = ok ? await sessionFileOf(input.sessionId as string, input.agentDir as string) : null;
  const at = file ? await landedAt(file, (input.texts as unknown[]).filter((text): text is string => typeof text === "string"), input.since as number) : null;
  process.stdout.write(`${JSON.stringify({ found: file !== null, landedAt: at })}\n`);
}
