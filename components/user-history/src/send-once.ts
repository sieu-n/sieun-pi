import { open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

/*
 * One agent message per send, though the daemon times out. The daemon gives the target's worker 30 s to confirm a send_message and then
 * raises, but the worker still queues the message and delivers it when it is free (p334). The chat service read that timeout as a failure,
 * kept the wake or alert and sent it again on the next tick. 10-16 06:38, 06:47 and 06:57Z one board.wake reached the "spawn brief lost fix"
 * job 3 times, and at 06:17:05 to 06:17:10Z one Grafana alert reached its owner 11 times, once for each send that had timed out while the
 * owner was busy. From 10-15 00:00Z to 10-16 07:50Z the session files hold 137 extra wake copies, 25 extra server notices and 50 extra agent
 * messages. So a send that timed out is recorded, and the next send of the same text to the same session first looks for the first copy:
 * landed in the target's session file, or still queued in its worker. It goes out again only when it is in neither place.
 */

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z/g;
const DUPLICATE_PREFIX = /^\(possible duplicate\)\s*/i;
/** The daemon prefixes a queued agent message's preview with this (prime-agent AGENT_MESSAGE_RECEIVED_PREVIEW_LABEL). */
export const QUEUED_PREFIX = "Agent message received: ";

/** The text as one send: without its ISO times, which a wake or brief rewrites on each try, and a "(possible duplicate)" opener. */
export function sendKey(session: string, text: string): string {
  return session + "\n" + text.trim().replace(DUPLICATE_PREFIX, "").replace(ISO, "").replace(/\s+/g, " ").trim();
}

export const isSendTimeout = (error: unknown): boolean => /Timed out after \d+ms waiting for the Prime Agent daemon response to "send_message"|Timed out waiting for daemon worker response/
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
export async function landedAt(file: string, texts: readonly string[], since: number): Promise<number | null> {
  const wanted = new Set(texts.map(text => text.trim()));
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return null;
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
        const found = agentMessage(line);
        if (found && found.at >= since - 1_000 && wanted.has(found.text.trim())) return found.at;
        const at = lineTime(line);
        if (Number.isFinite(at) && at < since - 60_000) return null;
      }
      end = start;
    }
    if (carry) { const found = agentMessage(carry); if (found && found.at >= since - 1_000 && wanted.has(found.text.trim())) return found.at; }
    return null;
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

/** Where an earlier copy is: written in the target's file, waiting in its worker's queue, gone from both, or not readable now. */
export type CopyState = "landed" | "queued" | "absent" | "unknown";

export interface SendOnceDeps {
  /** One send_message; "gone" when the daemon knows no such session. Throws on a timeout or any other failure. */
  send: (session: string, text: string) => Promise<"sent" | "gone">;
  /** The texts queued in the session's worker (steering and follow-ups), [] when it has no worker, null when the daemon did not answer. */
  queued: (session: string) => Promise<string[] | null>;
  /** The session's file, or null. */
  fileOf: (session: string) => Promise<string | null>;
  /** The record of sends that timed out, kept across service restarts. */
  file: string;
  now?: () => number;
  log: (line: string) => void;
}

interface Unconfirmed { since: number; texts: string[] }

/** `deliver` with the timed-out-send check; one instance per service, shared by the wakes, the brief keeper and the alert bridge. */
export class SendOnce {
  private record: Promise<Map<string, Unconfirmed>> | null = null;
  private readonly now: () => number;
  private readonly deps: SendOnceDeps;
  constructor(deps: SendOnceDeps) { this.deps = deps; this.now = deps.now ?? Date.now; }

  /**
   * Sends `text` to `session`, or resolves "sent" without a send when an earlier send of it that timed out landed. Throws, so its caller keeps
   * its wake or alert for the next tick, when the send times out or an earlier copy is still queued or cannot be looked at.
   */
  async deliver(session: string, text: string): Promise<"sent" | "gone"> {
    const key = sendKey(session, text);
    const record = await this.load();
    const earlier = record.get(key);
    if (earlier) {
      const state = await this.copyState(session, earlier);
      if (state === "landed") {
        await this.settle(key);
        this.deps.log(`send once: ${session.slice(0, 8)} already has the send that timed out at ${new Date(earlier.since).toISOString()}; not sent again`);
        return "sent";
      }
      if (state !== "absent") throw new Error(`the send that timed out at ${new Date(earlier.since).toISOString()} is ${state === "queued" ? "still queued in its worker" : "not readable now"}; not sent again`);
    }
    const since = earlier?.since ?? this.now();
    try {
      const result = await this.deps.send(session, text);
      await this.settle(key);
      return result;
    } catch (error) {
      if (!isSendTimeout(error)) throw error;
      const texts = [...new Set([...earlier?.texts ?? [], text.trim()])];
      await this.save(record => record.set(key, { since, texts }));
      const file = await this.deps.fileOf(session).catch(() => null);
      if (file && await landedAt(file, texts, since)) { await this.settle(key); return "sent"; }
      throw error;
    }
  }

  private async copyState(session: string, earlier: Unconfirmed): Promise<CopyState> {
    const file = await this.deps.fileOf(session).catch(() => null);
    if (file && await landedAt(file, earlier.texts, earlier.since)) return "landed";
    const queue = await this.deps.queued(session).catch(() => null);
    if (queue === null) return "unknown";
    const held = queue.some(item => earlier.texts.some(text => item === text || item === QUEUED_PREFIX + text || item.includes(text)));
    if (held) return "queued";
    // The worker may have written it between the file read and the queue read.
    return file && await landedAt(file, earlier.texts, earlier.since) ? "landed" : "absent";
  }

  private load(): Promise<Map<string, Unconfirmed>> {
    this.record ??= readFile(this.deps.file, "utf8").then(text => {
      const value = JSON.parse(text) as Record<string, Unconfirmed>;
      return new Map(Object.entries(value).filter(([, entry]) => typeof entry?.since === "number" && Array.isArray(entry.texts)));
    }).catch(() => new Map<string, Unconfirmed>());
    return this.record;
  }

  private async settle(key: string): Promise<void> {
    if ((await this.load()).has(key)) await this.save(record => record.delete(key));
  }

  private async save(change: (record: Map<string, Unconfirmed>) => void): Promise<void> {
    const record = await this.load();
    change(record);
    const tmp = `${this.deps.file}.tmp`;
    await writeFile(tmp, JSON.stringify(Object.fromEntries(record)), { mode: 0o600 });
    await rename(tmp, this.deps.file);
  }
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
