import { open, type FileHandle } from "node:fs/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "prime-agent";
// From the package Prime serves to extensions as a virtual module: a value import from "prime-agent" made the extension's loader read the
// whole prime-agent package from node_modules, about 350 ms of each Mac worker start on 10-20, before a new thread's first turn.
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";

/**
 * How much of a session file the server holds for an open thread. The feed draws every message the hub holds and the chat's own logic reads
 * them (job notices, agent rows, unread counts). Frontend bro's 64 MB transcript had 10 compactions across 10,854 feed messages, about 1,000 per
 * compaction, so 1,000 messages is one compaction's worth of the busiest chat. 8 MiB caps the bytes when the messages are large: the VP chat
 * averages 19 KB per message, and 64 MB took 1.28 s to parse.
 */
export const TAIL_MESSAGES = 1000;
export const TAIL_BYTES = 8 * 1024 * 1024;
/**
 * The messages a thread feed's first frame carries. The owner's Mac in Korea reads this box at about 370 KB/s (10-18), and the 1,000 messages a
 * snapshot carried before were 150 to 250 KB deflated, 0.5 to 0.8 s on the wire. In the 7 biggest chats on 10-18 the newest 100 messages were
 * 66 to 87 KB of JSON and 22 to 30 KB deflated (about 60 to 80 ms at 370 KB/s), 1 to 18 chat feed items; the page asks for more as he scrolls.
 */
export const FIRST_PAGE_MESSAGES = 100;
/** The messages of each older page: 200 were 135 to 168 KB of JSON and 43 to 57 KB deflated in the same chats, so a scroll back takes few round trips. */
export const PAGE_MESSAGES = 200;
const CHUNK = 1024 * 1024;
const HEADER_BYTES = 64 * 1024;

/**
 * Display messages for stored branch entries, in file order: messages, custom messages (agent replies and notices), branch summaries, and a
 * compaction marker where each compaction happened.
 */
export function historyMessages(entries: readonly SessionEntry[]): AgentMessage[] {
  return entries.flatMap((entry): AgentMessage[] => {
    const timestamp = new Date(entry.timestamp).getTime();
    switch (entry.type) {
      case "message": return [entry.message];
      case "custom_message": return [{ role: "custom", customType: entry.customType, content: entry.content, display: entry.display, details: entry.details, timestamp }];
      case "branch_summary": return entry.summary ? [{ role: "branchSummary", summary: entry.summary, fromId: entry.fromId, timestamp }] : [];
      case "compaction": return [{ role: "compactionSummary", summary: entry.summary, tokensBefore: entry.tokensBefore, timestamp }];
      default: return [];
    }
  });
}

/** Whether the feed shows the message: the roles the projection draws (chat-projection.ts `Projector.message`), and custom ones marked for display. */
export function shownMessage(message: AgentMessage): boolean {
  switch (message.role) {
    case "user": case "assistant": case "toolResult": case "bashExecution": case "branchSummary": case "compactionSummary": return true;
    case "custom": return Boolean(message.display);
    default: return false;
  }
}

/** The message the feed shows for one branch entry, if any. */
function shown(entry: SessionEntry): AgentMessage | undefined {
  const [message] = historyMessages([entry]);
  return message && shownMessage(message) ? message : undefined;
}

/** A place in a session file's branch: the next entry back is `id`, and its line ends at or before byte `end`. */
export interface FilePlace { end: number; id: string }

export interface BranchTail {
  sessionId: string;
  /** The entries read, oldest first. */
  entries: SessionEntry[];
  /** The tail reached the first entry, so nothing older is left in the file. */
  whole: boolean;
}

export interface BranchPage extends BranchTail {
  /** Where the entries before these start; null when the page reached the first entry. */
  before: FilePlace | null;
  /** The bytes this read took from the file. */
  bytesRead: number;
  /** Per shown message timestamp, the line of the newest message with it, the place `findMessage` starts from when a page names it. */
  places: Map<number, FilePlace>;
}

/** One line of the current branch, newest first: its entry's ids from the start of the line, and its bytes. */
interface BranchLine { id: string; parentId: string | null; time: number; start: number; end: number; bytes: Buffer }

const HEAD = /^\{"type":"[^"]*","id":"([^"]*)","parentId":(?:null|"([^"]*)"),"timestamp":"([^"]*)"/;

function lineHead(bytes: Buffer): { id: string; parentId: string | null; time: number } | undefined {
  const match = HEAD.exec(bytes.toString("utf8", 0, Math.min(bytes.length, 400)));
  if (match) return { id: match[1]!, parentId: match[2] ?? null, time: Date.parse(match[3]!) };
  try {
    const entry = JSON.parse(bytes.toString("utf8")) as { id?: unknown; parentId?: unknown; timestamp?: unknown };
    if (typeof entry.id !== "string") return undefined;
    return { id: entry.id, parentId: typeof entry.parentId === "string" ? entry.parentId : null, time: typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN };
  } catch { return undefined; }
}

function parse(line: BranchLine): SessionEntry | undefined {
  try { return JSON.parse(line.bytes.toString("utf8")) as SessionEntry; } catch { return undefined; }
}

/** An open session file at the current version: its id and where its entries start. Undefined for a file a full open must migrate. */
async function header(handle: FileHandle, size: number): Promise<{ sessionId: string; first: number } | undefined> {
  const head = Buffer.alloc(Math.min(size, HEADER_BYTES));
  await handle.read(head, 0, head.length, 0);
  const headerEnd = head.indexOf(0x0a);
  if (headerEnd < 0) return undefined;
  const parsed = JSON.parse(head.subarray(0, headerEnd).toString("utf8")) as { type?: unknown; id?: unknown; version?: unknown };
  if (parsed.type !== "session" || typeof parsed.id !== "string" || parsed.version !== CURRENT_SESSION_VERSION) return undefined;
  return { sessionId: parsed.id, first: headerEnd + 1 };
}

/**
 * The current branch backwards from `from` (from the leaf, the last complete line, when null), in 1 MiB chunks read from the end towards the
 * start. A parent is always written before its child, so the walk keeps one id and parses no line off the branch. A line still being written
 * (no newline yet) is not an entry. `read.bytes` counts what it read. `read.more` false before a chunk ends the walk there, and `read.stopped`
 * names where it would go on: a branch whose next entry is not in the file (the VP of CI chat's points at a parent its file lacks) would
 * otherwise read on to the start, 136 MB.
 */
async function* branchLines(handle: FileHandle, first: number, size: number, from: FilePlace | null, read: { bytes: number; more?: () => boolean; stopped?: FilePlace }): AsyncGenerator<BranchLine> {
  let cursor: string | null | undefined = from ? from.id : undefined;
  let pos = from ? Math.min(from.end, size) : size;
  let tail = Buffer.alloc(0);
  // A cursor from before the file was rewritten smaller (scripts/session-compact.ts) can end inside a line, so the first chunk always drops a
  // partial line; a cursor at a line end loses nothing.
  let trimmed = false;
  while (pos > first && cursor !== null) {
    if (cursor !== undefined && read.more && !read.more()) { read.stopped = { end: pos + tail.length, id: cursor }; return; }
    const start = Math.max(first, pos - CHUNK);
    const chunk = Buffer.alloc(pos - start);
    await handle.read(chunk, 0, chunk.length, start);
    read.bytes += chunk.length;
    pos = start;
    let data = tail.length ? Buffer.concat([chunk, tail]) : chunk;
    tail = Buffer.alloc(0);
    if (!trimmed) {
      const last = data.lastIndexOf(0x0a);
      if (last < 0) continue;
      data = data.subarray(0, last + 1);
      trimmed = true;
    }
    let end = data.length;
    while (end > 0) {
      const newline = end >= 2 ? data.lastIndexOf(0x0a, end - 2) : -1;
      if (newline < 0 && start > first) { tail = data.subarray(0, end); break; }
      const lineStart = newline + 1;
      const bytes = data.subarray(lineStart, data[end - 1] === 0x0a ? end - 1 : end);
      const lineEnd = end;
      end = lineStart;
      if (!bytes.length) continue;
      const head = lineHead(bytes);
      if (!head) continue;
      if (cursor === undefined) cursor = head.id;
      if (head.id !== cursor) continue;
      yield { ...head, start: start + lineStart, end: start + lineEnd, bytes };
      cursor = head.parentId;
      if (cursor === null) return;
    }
  }
}

/**
 * A page of the current branch, newest entries back from `from` (the leaf when null), oldest first. Reading stops once `limits.messages` feed
 * messages are in, or `limits.bytes` were read with at least one in, but never between two shown messages with the same timestamp: a message
 * is named by its timestamp and its place among those that share it (src/shared/message-key.ts), so a page holds all of them or none.
 * Undefined for a file a full open must migrate (another version) or whose header does not fit 64 KiB.
 */
export async function readBranchPage(file: string, from: FilePlace | null, limits = { messages: PAGE_MESSAGES, bytes: TAIL_BYTES }): Promise<BranchPage | undefined> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const head = await header(handle, size);
    if (!head) return undefined;
    let found = 0;
    const read: { bytes: number; more: () => boolean; stopped?: FilePlace } = { bytes: 0, more: () => read.bytes < limits.bytes || found === 0 };
    const entries: SessionEntry[] = [];
    const places = new Map<number, FilePlace>();
    let lastStamp: number | undefined;
    let before: FilePlace | null = null;
    for await (const line of branchLines(handle, head.first, size, from, read)) {
      const entry = parse(line);
      if (!entry) break;
      const message = shown(entry);
      // An entry the feed does not show may end a page that ran out of bytes, so long runs of them (the VP of CI chat holds 130 MB of entries
      // around 529 messages) do not read on to the start of the file.
      const full = read.bytes >= limits.bytes && found > 0;
      if (message ? (found >= limits.messages || full) && message.timestamp !== lastStamp : full) { before = { end: line.end, id: line.id }; break; }
      entries.push(entry);
      if (message) {
        found++; lastStamp = message.timestamp;
        if (!places.has(message.timestamp)) places.set(message.timestamp, { end: line.end, id: line.id });
      }
    }
    before ??= read.stopped ?? null;
    return { sessionId: head.sessionId, entries: entries.reverse(), before, whole: before === null, bytesRead: read.bytes, places };
  } finally { await handle.close(); }
}

/** The end of a session's current branch: `readBranchPage` from the leaf, sized for what the hub holds by default. */
export async function readBranchTail(file: string, limits = { messages: TAIL_MESSAGES, bytes: TAIL_BYTES }): Promise<BranchTail | undefined> {
  const page = await readBranchPage(file, null, limits);
  return page && { sessionId: page.sessionId, entries: page.entries, whole: page.whole };
}

/**
 * The current branch back to the start of the model's context, oldest first: every entry after the newest compaction, the compaction, and the
 * entries it kept from its `firstKeptEntryId` on, which is all Prime's buildSessionContext reads (a branch with no compaction reads back to the
 * first entry). `bytes` caps the read as in `readBranchTail`. On frontend bro's 82 MB file the 48 MiB tail parsed 12,836 entries in 0.6 to 1.3 s.
 */
export async function readContextTail(file: string, bytes: number): Promise<BranchTail | undefined> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const head = await header(handle, size);
    if (!head) return undefined;
    const read: { bytes: number; more: () => boolean; stopped?: FilePlace } = { bytes: 0, more: () => read.bytes < bytes };
    const entries: SessionEntry[] = [];
    let kept: string | undefined;
    let whole = true;
    for await (const line of branchLines(handle, head.first, size, null, read)) {
      const entry = parse(line);
      if (!entry) { whole = false; break; }
      entries.push(entry);
      if (kept === undefined && entry.type === "compaction") kept = entry.firstKeptEntryId || entry.id;
      if (entry.id === kept) { whole = entry.parentId === null; break; }
    }
    return { sessionId: head.sessionId, entries: entries.reverse(), whole: whole && read.stopped === undefined };
  } finally { await handle.close(); }
}

/** How far after its message a branch entry's own time may run back (custom entries take a second clock read). */
const CLOCK_SKEW_MS = 60_000;

export interface FoundMessage { entry: SessionEntry; message: AgentMessage; before: FilePlace | null }

/**
 * The shown message with timestamp `at` that has `n` shown messages with the same timestamp before it on the branch, found by walking back from
 * the leaf; only entries that hold `"timestamp":<at>` are parsed. `before` is where the entries before it start. Null when the branch holds no
 * such message, and undefined for a file a full open must migrate, so only that file takes a caller's whole-file read: until 10-27 a message
 * not on the branch read undefined too, and at 07:36Z and 07:37Z a part read of Crawler VP held the chat's event loop 1.8 and 1.9 s on that
 * read; on a copy of the 100 MB AI harness chat file it took 846 to 876 ms against 3 to 10 ms for this walk.
 *
 * `near` is the place a page named for the message (`BranchPage.places`), and the walk starts there and reads at most a page's bytes. A place
 * the file no longer holds, after a rewrite, falls back to the walk from the leaf. That walk reads back to the message: at 18:00:30Z on 10-27
 * a part read of a message far back in the Mac chat's 110 MB copy took 4.2 s at 1.7 runnable a core, and on the 108 MB AI harness chat file
 * it read 0.56 s for a message near the start on an idle box. `read.bytes` counts what both walks read.
 */
export async function findMessage(file: string, at: number, n: number, near: FilePlace | null = null, read: { bytes: number } = { bytes: 0 }): Promise<FoundMessage | null | undefined> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const head = await header(handle, size);
    if (!head) return undefined;
    if (near) {
      const page: { bytes: number; more: () => boolean; stopped?: FilePlace } = { bytes: 0, more: () => page.bytes < TAIL_BYTES };
      const found = await walkTo(handle, head.first, size, near, page, at, n);
      read.bytes += page.bytes;
      if (found && page.stopped === undefined) return found;
    }
    return await walkTo(handle, head.first, size, null, read, at, n);
  } finally { await handle.close(); }
}

async function walkTo(handle: FileHandle, first: number, size: number, from: FilePlace | null, read: { bytes: number; more?: () => boolean; stopped?: FilePlace }, at: number, n: number): Promise<FoundMessage | null> {
  const needle = Buffer.from(`"timestamp":${at}`);
  const hits: FoundMessage[] = [];
  for await (const line of branchLines(handle, first, size, from, read)) {
    if (line.time < at - CLOCK_SKEW_MS) break;
    if (!holdsStamp(line.bytes, needle)) continue;
    const entry = parse(line);
    const message = entry && shown(entry);
    if (entry && message?.timestamp === at) hits.push({ entry, message, before: entry.parentId ? { end: line.start, id: entry.parentId } : null });
  }
  return hits[hits.length - 1 - n] ?? null;
}

/** Whether `bytes` hold `needle` followed by no digit, so `"timestamp":17` does not match `"timestamp":170`. */
function holdsStamp(bytes: Buffer, needle: Buffer): boolean {
  for (let from = bytes.indexOf(needle); from >= 0; from = bytes.indexOf(needle, from + 1)) {
    const next = bytes[from + needle.length];
    if (next === undefined || next < 0x30 || next > 0x39) return true;
  }
  return false;
}

/**
 * A tool call and its result on the current branch, by the call's id, walking back from the leaf; a line is parsed only when it holds the id.
 * Undefined for a file a full open must migrate.
 */
export async function findToolCall(file: string, toolCallId: string): Promise<{ call?: AgentMessage; result?: AgentMessage } | undefined> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const head = await header(handle, size);
    if (!head) return undefined;
    const needle = Buffer.from(JSON.stringify(toolCallId));
    const found: { call?: AgentMessage; result?: AgentMessage } = {};
    for await (const line of branchLines(handle, head.first, size, null, { bytes: 0 })) {
      if (line.bytes.indexOf(needle) < 0) continue;
      const entry = parse(line);
      if (entry?.type !== "message") continue;
      const message = entry.message;
      if (message.role === "toolResult" && message.toolCallId === toolCallId) found.result = message;
      if (message.role === "assistant" && message.content.some(part => part.type === "toolCall" && part.id === toolCallId)) { found.call = message; break; }
    }
    return found;
  } finally { await handle.close(); }
}
