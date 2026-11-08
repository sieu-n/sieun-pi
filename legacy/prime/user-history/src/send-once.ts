import { open, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { isMain } from "./main-module.ts";
import { hostExecFile } from "./spawn-host.ts";

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
 * A keyed resend whose first send still runs reads uncertain (src/daemon-write.ts WriteUncertain), and the next try sends that id again. So does
 * a worker socket that closed after the supervisor dispatched the send, since the relaunched worker may run it from its accepted input.
 */
export const isSendTimeout = (error: unknown): boolean =>
  /Timed out after \d+ms waiting for the Prime Agent daemon response to "send_message"|Timed out waiting for daemon worker response|daemon client closed before the operation completed|The previous command result is uncertain|Daemon worker socket closed/
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

/**
 * When the session wrote its newest model reply at or after `since`, else null: an assistant message with content that did not stop on an error
 * or an abort. A turn parked on pi-pool writes only empty assistant messages that stop on an error, so they are no reply.
 */
export function modelReplyAt(file: string, since: number): Promise<number | null> {
  return lineSince(file, since, line => {
    if (!line.includes('"role":"assistant"')) return null;
    try {
      const entry = JSON.parse(line) as { type?: unknown; timestamp?: unknown; message?: { role?: unknown; content?: unknown; stopReason?: unknown } };
      const reply = entry.message;
      if (entry.type !== "message" || reply?.role !== "assistant" || reply.stopReason === "error" || reply.stopReason === "aborted") return null;
      if (!(Array.isArray(reply.content) ? reply.content.length : typeof reply.content === "string" && reply.content.trim())) return null;
      const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
      return Number.isFinite(at) ? at : null;
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
/** A session's file: `sessions/<id>.jsonl` for a root, else `<id>.jsonl` in a `sub-*` folder up to three levels under session-artifacts. */
export async function sessionFileOf(sessionId: string, agentDir: string): Promise<string | null> {
  const asked = performance.now();
  const name = `${sessionId}.jsonl`;
  const root = join(agentDir, "sessions", name);
  if (await exists(root)) return root;
  const artifacts = join(agentDir, "session-artifacts");
  let index = artifactIndexes.get(artifacts);
  if (!index) artifactIndexes.set(artifacts, index = new ArtifactIndex(artifacts));
  return await index.find(name, asked);
}

const exists = (file: string): Promise<boolean> => stat(file).then(() => true, () => false);
const artifactIndexes = new Map<string, ArtifactIndex>();

/**
 * Subagent transcripts under one session-artifacts folder by file name, each found by a `find` in its own process that prints only the asked
 * names. Until 11-05 each lookup walked the folder with readdir on the chat's main thread: on us-metal02 that was 62,472 folders under 8,931
 * roots, 9.8 s and 3.2 s of CPU for one walk. Its replacement listed every transcript, 66,659 paths and 8.4 MB on 11-08, and split them on the
 * main thread at each miss: 0.2 to 0.65 s with its garbage collection, four times a minute while the outbox retried a send to a root with no
 * file, 5 s of the main thread in the 5 min of cpu-profiles pid903649, and d7 read 12:03Z on 11-08 dirty from a 1.3 s loop stall. A known name
 * answers from memory; names that miss join the next search, which starts after they asked, so a file made just before the ask is found and
 * every ask that waits meanwhile shares that one search.
 */
class ArtifactIndex {
  private files = new Map<string, string>();
  private search: { from: number; names: Set<string>; done: Promise<void> } | null = null;
  private next: { names: Set<string>; done: Promise<void> } | null = null;

  constructor(private readonly artifacts: string) {}

  async find(name: string, asked: number): Promise<string | null> {
    const known = this.files.get(name);
    if (known && await exists(known)) return known;
    this.files.delete(name);
    await this.searched(name, asked);
    const found = this.files.get(name);
    return found && await exists(found) ? found : null;
  }

  private searched(name: string, asked: number): Promise<void> {
    if (this.search && this.search.from >= asked && this.search.names.has(name)) return this.search.done;
    if (!this.search) return this.start(new Set([name]));
    if (this.next) { this.next.names.add(name); return this.next.done; }
    const names = new Set([name]);
    const done = this.search.done.then(() => { this.next = null; return this.start(names); });
    this.next = { names, done };
    return done;
  }

  private start(names: Set<string>): Promise<void> {
    const from = performance.now();
    const done: Promise<void> = findArtifacts(this.artifacts, [...names]).then(files => { for (const [name, path] of files) this.files.set(name, path); }, () => {})
      .finally(() => { if (this.search?.done === done) this.search = null; });
    this.search = { from, names, done };
    return done;
  }
}

/** A `find -name` pattern that matches `name` as written. */
const literal = (name: string): string => name.replace(/[\\*?[\]]/g, "\\$&");

/**
 * Where `names` sit as `<name>` files in `sub-*` folders one and two levels below each root folder of `artifacts`. `find` prunes every other
 * folder below a root and prints only the asked names, so the chat parses a line per hit. A folder it cannot read still leaves the rest. The
 * spawn host starts it (spawn-host.ts): at 12:02:40Z on 11-08 the chat's own spawn of the listing held its main thread 1.22 s with the box at
 * 6 runnable a core (cpu-profiles pid1039808), and d7 read 12:03Z dirty from that stall.
 */
function findArtifacts(artifacts: string, names: readonly string[]): Promise<Map<string, string>> {
  const match = names.flatMap((name, n) => [...n ? ["-o"] : [], "-name", literal(name)]);
  return new Promise(resolve => {
    hostExecFile("find", [artifacts, "-mindepth", "2", "-maxdepth", "4", "-type", "d", "!", "-name", "sub-*", "-prune", "-o", "-type", "f", "(", ...match, ")", "-print"],
      {}, (_error, stdout) => {
        const files = new Map<string, string>();
        for (const path of stdout.split("\n")) {
          const folder = dirname(path);
          if (path && basename(folder).startsWith("sub-") && dirname(folder) !== artifacts && !files.has(basename(path))) files.set(basename(path), path);
        }
        resolve(files);
      });
  });
}

/**
 * A session's file as this box can open it: the copy this box holds for another box's session, else the file the daemon lists, else the walk of
 * `sessionFileOf`. That walk reads every folder up to three levels under session-artifacts, 8,147 roots on us-metal02 on 11-03, and took 8.2
 * to 11.2 s for an id it never finds. When the Mac came back at 00:54:51Z on 11-03 the duty reruns of its chats walked it for Mac sessions,
 * whose files are not on this box: 6.7 s of the chat's main thread from 00:54:50 to 00:57:30Z, and d7 read 00:55, 00:56 and 00:57Z dirty.
 */
export async function boxSessionFile(sessionId: string, input: { agentDir: string; elsewhere: (id: string) => boolean;
  copy: (id: string) => Promise<string | null | undefined>; listed: (id: string) => Promise<string | null | undefined> }): Promise<string | null> {
  if (input.elsewhere(sessionId)) return (await input.copy(sessionId).catch(() => null)) ?? null;
  const listed = await input.listed(sessionId).catch(() => null);
  if (listed && await stat(listed).then(() => true, () => false)) return listed;
  return sessionFileOf(sessionId, input.agentDir);
}

/** The transcript files of a root session and of every subagent below it: `sessions/<id>.jsonl` and each `<sub>.jsonl` up to three `sub-*` levels under its artifacts. */
export async function treeFilesOf(rootId: string, agentDir: string): Promise<string[]> {
  const root = join(agentDir, "sessions", `${rootId}.jsonl`);
  const files = await stat(root).then(() => [root], () => [] as string[]);
  let level = [join(agentDir, "session-artifacts", rootId)];
  for (let depth = 0; depth < 3 && level.length; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      for (const entry of await readdir(dir).catch(() => [] as string[])) {
        if (entry.startsWith("sub-")) next.push(join(dir, entry));
        else if (depth > 0 && entry.endsWith(".jsonl") && entry !== "semantic-edges.jsonl") files.push(join(dir, entry));
      }
    }
    level = next;
  }
  return files;
}

/**
 * A target's worker as get_state reads it: its queued texts, whether it runs a turn, a tool or unfinished actions, and the count of messages
 * the daemon holds against its pending message limit (absent when the daemon gave none), which the agent outbox reads for room.
 */
export interface TargetState { queued: string[]; busy: boolean; unfinished?: number }

/**
 * The count a daemon holds against its pending message limit. A daemon that sends the summary's top-level `queuedLanes` (Prime load-h) counts
 * only queued input, which is the sum of its lanes. The lanes win over `sessionActions.queuedCount`, because a crc.2 supervisor over load-h
 * workers lists a row with `queuedLanes.steering` 1 and `queuedCount` 0 (load-x new-then-old, 10-27). With no lanes, `queuedCount` stands in,
 * and a crc.2 daemon, whose `queuedCount` reads the visible queue while it counts every unfinished action, is read by `unfinishedActionCount`.
 */
function limitCount(lanes: unknown, queuedCount: unknown, unfinished: number | undefined): number | undefined {
  if (typeof lanes === "object" && lanes !== null) {
    const { steering, followUp } = lanes as { steering?: unknown; followUp?: unknown };
    return (typeof steering === "number" ? steering : 0) + (typeof followUp === "number" ? followUp : 0);
  }
  return unfinished ?? (typeof queuedCount === "number" ? queuedCount : undefined);
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
if (isMain(import.meta.url)) {
  const input = JSON.parse(readFileSync(0, "utf8")) as { sessionId?: unknown; texts?: unknown; since?: unknown; agentDir?: unknown };
  const ok = typeof input.sessionId === "string" && /^[\w-]{1,128}$/.test(input.sessionId) && Array.isArray(input.texts) && typeof input.since === "number" && typeof input.agentDir === "string";
  const file = ok ? await sessionFileOf(input.sessionId as string, input.agentDir as string) : null;
  const at = file ? await landedAt(file, (input.texts as unknown[]).filter((text): text is string => typeof text === "string"), input.since as number) : null;
  process.stdout.write(`${JSON.stringify({ found: file !== null, landedAt: at })}\n`);
}
