import { open, readdir, readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context, Sample } from "../otlp.ts";
import { chatLines, NUDGE_PREFIX, OWNER_RETRY_MARK, serverNote, unreadCount } from "../../user-history/src/shared/chat-feed.ts";
import type { ThreadMessage } from "../../user-history/src/shared/types.ts";

/*
 * Message delivery on the chat host: the chat service's two disk outboxes (components/user-history/src/outbox.ts), the daemon queues the
 * thread's queue chips show (client/QueueChips.svelte), and the outside sends log (components/global-rules/send-log.ts). Every label names
 * the receiving tree's chat by its name, never by a session id.
 *
 * An outbox entry is written whole on each change and never changes again once it has `doneAt` (Outbox.finish, then only prune's unlink), so
 * a done entry is read once and kept; only waiting and new entries are read each round. The session lists are the chat service's own copies
 * of every box's daemon list (session-copy.json for this box, ~/.cache/sieun-pi/hosts/<box>.sessions.json for the others), 14 MB and 39 MB on
 * 10-19. A full JSON.parse of both took 0.5 to 0.7 s of CPU, so the reader finds the few rows it needs with Buffer.indexOf and parses only
 * those rows.
 *
 * The chats' own transcripts give the sidebar's unread counts and the job messages and reports (chats.json lists the chats, read-state.json
 * holds the read markers, and a Mac chat's transcript is the chat service's mirror of it under ~/.cache/sieun-pi/hosts/<box>/). A transcript
 * is read from the end once, then only its new lines each round. The Slack row reads slack.json and the chat's own GET api/slack answer.
 */

/** Which outbox: "agent" holds what the service sends to sessions (src/agent-outbox.ts), "owner" the owner's composer sends (src/owner-outbox.ts). */
type OutboxName = "agent" | "owner";
type State = "queued" | "sending" | "delivered" | "failed" | "obsolete";

/** One outbox entry as this reader keeps it. */
interface Entry { threadId: string; root?: string; at: number; doneAt?: number; state: State; attempts: number; kind: string }

/** A session row of a daemon list copy, only the fields read here. */
interface Row {
  sessionId: string; sessionName?: string; sessionFile?: string; parentSessionId?: string; runtimeKind?: string; lifecycle?: string;
  unfinishedActionCount?: number; sessionActions?: { queuedCount?: number; steering?: unknown[]; followUps?: unknown[] };
}

/** The receiving tree of a target session: its root chat and whether the target is that chat or a job under it. */
interface Tree { root: string; target: "chat" | "job" }

const WINDOW_MS = 30 * 60_000;
const DAY_MS = 24 * 3_600_000;
/** How many of the oldest waiting messages go out one by one with a rank label. */
const TOP = 5;
/** The pending message limit of prime-agent 0.9.8's send_message (src/agent-outbox.ts DAEMON_PENDING_LIMIT). */
const DAEMON_PENDING_LIMIT = 20;
/** A cached chat name is looked up again after this, so a rename shows within the hour. */
const NAME_TTL_MS = 3_600_000;

/**
 * What a message is, from the opener its sender writes (src/agent-outbox.ts queuedText, wakeOf, cross-host-message.ts crossHostText,
 * subagent-relay.ts relayNote, alert-bridge.ts, messageParts), since the stored `kind` (wake, retry, message) folds most of these into "message".
 */
export function messageKind(text: string): string {
  if (text.startsWith("[wake]")) return "wake";
  if (text.startsWith("[cross-host message")) return "cross-host";
  if (/^\[message from [^\]\n]*held in the chat service's outbox/.test(text)) return "held send";
  if (text.startsWith("[relay")) return "relay";
  if (text.startsWith("[alert")) return "alert";
  if (text.startsWith("[task from parent]")) return "brief";
  if (/^\[\d+ messages the chat service's outbox held/.test(text)) return "bundle";
  if (text.startsWith("[part ")) return "part";
  return "other";
}

/** The root of a subagent's tree from its session file (src/agent-outbox.ts `treeOf`). */
export function treeOfFile(file: string | undefined): string | undefined {
  return file ? /\/session-artifacts\/([0-9a-f-]{36})\//.exec(file)?.[1] : undefined;
}

/** A row's name as the sidebar shows it (src/chat-catalog.ts `sessionTitle`, its first step); null when the row has none. */
export const rowName = (row: Row | null): string | null => row?.sessionName?.replace(/\s+/g, " ").trim() || null;

export function parseEntry(raw: string, outbox: OutboxName): Entry | null {
  const value = JSON.parse(raw) as Partial<Entry> & { text?: unknown };
  if (typeof value.threadId !== "string" || typeof value.at !== "number" || typeof value.state !== "string") return null;
  const text = typeof value.text === "string" ? value.text : "";
  return { threadId: value.threadId, at: value.at, state: value.state as State, attempts: typeof value.attempts === "number" ? value.attempts : 0,
    kind: outbox === "owner" ? "owner send" : messageKind(text),
    ...typeof value.root === "string" ? { root: value.root } : {}, ...typeof value.doneAt === "number" ? { doneAt: value.doneAt } : {} };
}

/** Reads an outbox folder, reusing the done entries read in earlier rounds. */
export async function readOutbox(dir: string, outbox: OutboxName, cache: Map<string, Entry>): Promise<Entry[]> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter(name => name.endsWith(".json"));
  const seen = new Set(names);
  for (const name of [...cache.keys()]) if (!seen.has(name)) cache.delete(name);
  await Promise.all(names.map(async name => {
    const held = cache.get(name);
    if (held?.doneAt !== undefined) return;
    const raw = await readFile(join(dir, name), "utf8").catch(() => null);
    if (raw === null) { cache.delete(name); return; }
    try {
      const entry = parseEntry(raw, outbox);
      if (entry) cache.set(name, entry); else cache.delete(name);
    } catch { cache.delete(name); }
  }));
  return [...cache.values()];
}

/**
 * One daemon list copy: the box it lists, its busy rows (`busyRows`), and its bytes, read only when a lookup needs them in this round. The
 * copies are rewritten only when a row changes (none changed in a 40 s watch on 10-19), so a copy whose size and mtime held keeps its busy rows.
 */
export interface Copy { host: string; busy: Row[]; bytes: () => Buffer | null; changed?: boolean }

const ROW_START = Buffer.from(',{"id":"');
const FIRST_ROW = Buffer.from('[{"id":"');

/**
 * The row that holds byte `at` of a copy. Rows are the objects of the copy's `rows` array, each opening with its "id" key, and inside a
 * JSON string a quote is escaped, so `,{"id":"` (or `[{"id":"` for the first row) appears only where a row starts.
 */
export function rowAt(bytes: Buffer, at: number): Row | null {
  const first = bytes.indexOf(FIRST_ROW);
  if (first < 0 || first > at) return null;
  const comma = bytes.lastIndexOf(ROW_START, at);
  const start = Math.max(comma, first);
  const next = bytes.indexOf(ROW_START, at);
  const end = next < 0 ? bytes.lastIndexOf("]") : next;
  try { return JSON.parse(bytes.toString("utf8", start + 1, end)) as Row; } catch { return null; }
}

/** The row of `session` in the copies, the first copy that lists it winning. */
export function findRow(copies: readonly Copy[], session: string): Row | null {
  const key = Buffer.from(`"sessionId":"${session}"`);
  for (const copy of copies) {
    const bytes = copy.bytes();
    const at = bytes ? bytes.indexOf(key) : -1;
    if (at >= 0) return rowAt(bytes!, at);
  }
  return null;
}

/** The live rows whose daemon holds queued input or unfinished actions: the only rows the queue numbers need. */
export function busyRows(bytes: Buffer): Row[] {
  const rows = new Map<string, Row>();
  for (const key of ['"queuedCount":', '"unfinishedActionCount":']) {
    const needle = Buffer.from(key);
    for (let at = bytes.indexOf(needle); at >= 0; at = bytes.indexOf(needle, at + needle.length)) {
      const digit = bytes[at + needle.length];
      if (digit === undefined || digit < 0x31 || digit > 0x39) continue;
      const row = rowAt(bytes, at);
      if (row?.lifecycle === "live") rows.set(row.sessionId, row);
    }
  }
  return [...rows.values()];
}

/** This box's copy and every other box's, each read again only when its size or mtime moved. */
async function readCopies(ctx: Context): Promise<Copy[]> {
  const mirror = join(ctx.home, ".cache/sieun-pi/hosts");
  const others = (await readdir(mirror).catch(() => [] as string[])).filter(name => name.endsWith(".sessions.json"))
    .map(name => ({ host: name.slice(0, -".sessions.json".length), file: join(mirror, name) }));
  const files = [{ host: ctx.host, file: join(ctx.home, ".prime/agent/browser-chat/session-copy.json") }, ...others];
  const kept = state(ctx, "delivery.copies", () => new Map<string, { stamp: string; busy: Row[] }>());
  const copies = await Promise.all(files.map(async ({ host, file }): Promise<Copy | null> => {
    const info = await stat(file).catch(() => null);
    if (!info) { kept.delete(file); return null; }
    let bytes: Buffer | null | undefined;
    const load = () => bytes === undefined ? (bytes = (() => { try { return readFileSync(file); } catch { return null; } })()) : bytes;
    const stamp = `${info.size}:${info.mtimeMs}`;
    let held = kept.get(file);
    const changed = held?.stamp !== stamp;
    if (changed) {
      const read = load();
      held = { stamp, busy: read ? busyRows(read) : [] };
      kept.set(file, held);
    }
    return { host, busy: held!.busy, bytes: load, changed };
  }));
  return copies.filter((copy): copy is Copy => copy !== null);
}

/**
 * Resolves sessions to their tree and their chat's name, keeping what it found in `ctx.state` across rounds. A lookup scans the copies' bytes,
 * about 30 ms for 53 MB on 10-19, so a new session costs one lookup, and each round looks again at only the one name or unlisted session read
 * longest ago, past NAME_TTL_MS, which keeps up with renames of about 120 chats an hour.
 */
class Names {
  private readonly trees: Map<string, Tree & { at: number; found: boolean }>;
  private readonly names: Map<string, { name: string; at: number; found: boolean }>;
  /** A copy was rewritten this round, so a chat (chats.json) no copy listed before, such as a new one, is looked up again. */
  private readonly changed: boolean;
  private readonly used = new Set<string>();
  private readonly ctx: Context;
  private readonly copies: readonly Copy[];
  constructor(ctx: Context, copies: readonly Copy[]) {
    this.ctx = ctx;
    this.copies = copies;
    this.changed = copies.some(copy => copy.changed);
    this.trees = state(ctx, "delivery.trees", () => new Map<string, Tree & { at: number; found: boolean }>());
    this.names = state(ctx, "delivery.names", () => new Map<string, { name: string; at: number; found: boolean }>());
  }

  /** The target's tree; an entry's `root` says it when the sender gave one, else the target's row does. */
  tree(session: string, root?: string): Tree {
    if (root) return { root, target: root === session ? "chat" : "job" };
    this.used.add(session);
    return this.trees.get(session) ?? this.lookTree(session);
  }

  private lookTree(session: string): Tree {
    const row = findRow(this.copies, session);
    const fileRoot = treeOfFile(row?.sessionFile);
    const parent = row?.parentSessionId ? this.tree(row.parentSessionId).root : undefined;
    const tree: Tree = fileRoot ? { root: fileRoot, target: "job" } : parent ? { root: parent, target: "job" } : { root: session, target: "chat" };
    this.trees.set(session, { ...tree, at: this.ctx.now, found: row !== null });
    return tree;
  }

  /**
   * The chat's name as the sidebar shows it; a chat no copy lists reads "unknown chat". `chat` marks a chats.json chat, looked up again on each
   * copy rewrite until a copy lists it, so a new chat gets its name within a round; other unlisted roots (deleted sessions) wait for `refresh`.
   */
  name(root: string, chat = false): string {
    this.used.add(root);
    const held = this.names.get(root);
    return held && (held.found || !chat || !this.changed) ? held.name : this.lookName(root);
  }

  private lookName(root: string): string {
    const listed = rowName(findRow(this.copies, root));
    const name = listed ?? this.names.get(root)?.name ?? "unknown chat";
    this.names.set(root, { name, at: this.ctx.now, found: listed !== null });
    return name;
  }

  chatOf(session: string, root?: string): { chat: string; target: Tree["target"] } {
    const tree = this.tree(session, root);
    return { chat: this.name(tree.root), target: tree.target };
  }

  /** Forgets the sessions this round did not use, then looks again at the one name or unlisted session read longest ago. */
  refresh(): void {
    for (const map of [this.trees, this.names]) for (const key of map.keys()) if (!this.used.has(key)) map.delete(key);
    let stalest: { key: string; at: number; name: boolean } | null = null;
    for (const [key, held] of this.names) if (!stalest || held.at < stalest.at) stalest = { key, at: held.at, name: true };
    for (const [key, held] of this.trees) if (!held.found && (!stalest || held.at < stalest.at)) stalest = { key, at: held.at, name: false };
    if (!stalest || this.ctx.now - stalest.at < NAME_TTL_MS) return;
    if (stalest.name) this.lookName(stalest.key); else this.lookTree(stalest.key);
  }
}

function state<T>(ctx: Context, key: string, make: () => T): T {
  let value = ctx.state.get(key) as T | undefined;
  if (value === undefined) { value = make(); ctx.state.set(key, value); }
  return value;
}

/** Adds `by` to the gauge of these labels, so many entries sum into one sample per label set. */
class Tally {
  private readonly values = new Map<string, { labels: Record<string, string>; value: number }>();
  add(labels: Record<string, string>, by = 1): void {
    const key = JSON.stringify(labels);
    const held = this.values.get(key);
    if (held) held.value += by; else this.values.set(key, { labels, value: by });
  }
  max(labels: Record<string, string>, value: number): void {
    const key = JSON.stringify(labels);
    const held = this.values.get(key);
    if (held) held.value = Math.max(held.value, value); else this.values.set(key, { labels, value });
  }
  samples(base: Omit<Sample, "value" | "labels">): Sample[] {
    return [...this.values.values()].map(({ labels, value }) => ({ ...base, labels, value }));
  }
}

const quantile = (sorted: readonly number[], q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;

/** The outbox numbers: waiting messages, their ages, recent outcomes and delivery delays, per outbox, kind and receiving chat. */
export function outboxSamples(entries: readonly { outbox: OutboxName; entry: Entry }[], names: Pick<Names, "chatOf">, now: number): Sample[] {
  const waiting = new Tally();
  const retrying = new Tally();
  const oldest = new Tally();
  const ended = new Tally();
  const failedDay = new Tally();
  const delays = new Map<string, { labels: Record<string, string>; seconds: number[] }>();
  const queue: { age: number; labels: Record<string, string> }[] = [];
  let total = 0;
  for (const { outbox, entry } of entries) {
    const { chat, target } = names.chatOf(entry.threadId, entry.root);
    if (entry.doneAt === undefined) {
      const age = Math.max(0, now - entry.at) / 1000;
      total++;
      waiting.add({ outbox, kind: entry.kind, target, chat });
      oldest.max({ outbox, chat }, age);
      if (entry.attempts > 0) retrying.add({ outbox, chat });
      queue.push({ age, labels: { outbox, kind: entry.kind, chat } });
      continue;
    }
    if (entry.state === "failed" && now - entry.doneAt < DAY_MS) failedDay.add({ outbox, chat });
    if (now - entry.doneAt >= WINDOW_MS) continue;
    ended.add({ outbox, state: entry.state, chat });
    if (entry.state !== "delivered") continue;
    const key = `${outbox}\n${chat}`;
    const held = delays.get(key) ?? { labels: { outbox, chat }, seconds: [] };
    held.seconds.push(Math.max(0, entry.doneAt - entry.at) / 1000);
    delays.set(key, held);
  }
  const delay: Sample[] = [];
  for (const { labels, seconds } of delays.values()) {
    seconds.sort((a, b) => a - b);
    for (const [stat, value] of [["p50", quantile(seconds, 0.5)], ["p90", quantile(seconds, 0.9)], ["max", seconds.at(-1)!]] as const) {
      delay.push({ name: "harness.delivery.delay", kind: "gauge", unit: "s", value, labels: { ...labels, stat },
        help: "Time from queue to delivery of the messages delivered in the last 30 min, as p50, p90 and max per outbox and receiving chat." });
    }
  }
  queue.sort((a, b) => b.age - a.age);
  return [
    { name: "harness.delivery.waiting_all", kind: "gauge", help: "Messages in the chat service's outboxes that the daemon has not taken yet.", value: total },
    ...waiting.samples({ name: "harness.delivery.waiting", kind: "gauge", help: "Messages waiting in an outbox, by outbox, message kind, target kind and receiving chat." }),
    ...oldest.samples({ name: "harness.delivery.oldest_wait", kind: "gauge", unit: "s", help: "Age of the oldest waiting message per outbox and receiving chat." }),
    ...retrying.samples({ name: "harness.delivery.retrying", kind: "gauge", help: "Waiting messages that were tried and refused at least once, per outbox and receiving chat." }),
    ...queue.slice(0, TOP).map(({ age, labels }, index) => ({ name: "harness.delivery.top_wait", kind: "gauge" as const, unit: "s" as const, value: age,
      labels: { ...labels, rank: String(index + 1) }, help: "Ages of the five oldest waiting messages, ranked, with their receiving chat and kind." })),
    ...ended.samples({ name: "harness.delivery.ended_30m", kind: "gauge", help: "Messages that ended in the last 30 min as delivered, failed or obsolete, per outbox and receiving chat." }),
    ...failedDay.samples({ name: "harness.delivery.failed_24h", kind: "gauge", help: "Messages that failed for good in the last 24 h, per outbox and receiving chat." }),
    ...delay,
  ];
}

/** The daemon queue numbers per chat: the queued input the thread's queue chips show, and the unfinished actions against the pending limit. */
export function daemonSamples(copies: readonly Copy[], names: Pick<Names, "chatOf">, chats: readonly { host: string; chat: string }[] = []): Sample[] {
  const queued = new Tally();
  // Each chat starts at 0, so the queue panel has a line for every chat while nothing is queued.
  for (const { host, chat } of chats) queued.add({ host, chat }, 0);
  const unfinished = new Tally();
  const full = new Tally();
  for (const copy of copies) {
    for (const row of copy.busy) {
      const { chat } = names.chatOf(row.sessionId);
      const actions = row.sessionActions;
      const count = actions?.queuedCount ?? (actions?.steering?.length ?? 0) + (actions?.followUps?.length ?? 0);
      if (count > 0) queued.add({ host: copy.host, chat }, count);
      const pending = row.unfinishedActionCount ?? 0;
      if (pending > 0) unfinished.max({ host: copy.host, chat }, pending);
      if (pending >= DAEMON_PENDING_LIMIT) full.add({ host: copy.host, chat });
    }
  }
  return [
    ...queued.samples({ name: "harness.delivery.daemon_queued", kind: "gauge", help: "Steer and follow-up messages queued in the daemon, the queue chips, summed over the chat's sessions, per box." }),
    ...unfinished.samples({ name: "harness.delivery.daemon_unfinished", kind: "gauge", help: "The most unfinished actions one session of the chat holds, against the daemon's pending limit of 20." }),
    ...full.samples({ name: "harness.delivery.daemon_full", kind: "gauge", help: "Sessions of the chat at the daemon's pending limit, whose new messages the daemon refuses." }),
  ];
}

/** One outside send judgement of sends.jsonl, as kept between rounds. */
interface OutsideSend { at: number; decision: string; layer: string; chat: string | null }

/** Reads the lines appended to sends.jsonl since the last round; a shorter file than the saved offset is read again from the start. */
export async function readSends(file: string, kept: { offset: number; sends: OutsideSend[] }, now: number): Promise<OutsideSend[]> {
  const size = await stat(file).then(info => info.size, () => 0);
  if (size < kept.offset) { kept.offset = 0; kept.sends = []; }
  if (size > kept.offset) {
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(size - kept.offset);
      await handle.read(buffer, 0, buffer.length, kept.offset);
      const end = buffer.lastIndexOf(10);
      if (end >= 0) {
        for (const line of buffer.toString("utf8", 0, end).split("\n")) {
          try {
            const value = JSON.parse(line) as { at?: unknown; decision?: unknown; layer?: unknown; chat?: unknown };
            const at = typeof value.at === "string" ? Date.parse(value.at) : NaN;
            if (Number.isFinite(at)) kept.sends.push({ at, decision: String(value.decision), layer: String(value.layer), chat: typeof value.chat === "string" ? value.chat : null });
          } catch {}
        }
        kept.offset += end + 1;
      }
    } finally { await handle.close(); }
  }
  kept.sends = kept.sends.filter(send => now - send.at < DAY_MS);
  return kept.sends;
}

export function sendSamples(sends: readonly OutsideSend[], names: Pick<Names, "name">, now: number): Sample[] {
  const day = new Tally();
  const recent = new Tally();
  for (const send of sends) {
    const labels = { decision: send.decision, layer: send.layer, chat: send.chat ? names.name(send.chat) : "no chat" };
    day.add(labels);
    if (now - send.at < WINDOW_MS) recent.add(labels);
  }
  return [
    ...day.samples({ name: "harness.delivery.outside_sends_24h", kind: "gauge", help: "Outside sends the send guards judged in the last 24 h (c37), by decision, guard layer and chat." }),
    ...recent.samples({ name: "harness.delivery.outside_sends_30m", kind: "gauge", help: "Outside sends the send guards judged in the last 30 min (c37), by decision, guard layer and chat." }),
  ];
}

/** A message a job, another agent or the server sent the chat (a `job` line of chatLines): when, and who sent it. */
interface JobLine { at: number; source: string; from: string }

/**
 * One chat's transcript as the reader keeps it: the byte its next unread line starts at, the messages from the owner's last message at or
 * before his read marker on (all that unreadCount needs, since an owner message starts a fresh turn and breaks every fold), and the job lines
 * of the last 24 h.
 */
export interface Transcript { file: string; offset: number; messages: ThreadMessage[]; jobs: JobLine[]; host?: string; unread?: { since: number; count: number } }

/** The transcript's unread count, kept until its messages or the read marker change (chat-catalog.ts `unreadOf` does the same). */
export function unreadOf(transcript: Transcript, since: number): number {
  if (transcript.unread?.since !== since) transcript.unread = { since, count: unreadCount(transcript.messages, since) };
  return transcript.unread.count;
}

const TEXT_KEEP = 512;
const clip = (text: string): string => text.length > TEXT_KEEP ? text.slice(0, TEXT_KEEP) : text;
const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.flatMap(part => part?.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n\n") : "";

/**
 * A session file entry as the message the chat's hub holds (session-tail.ts `historyMessages`), cut to the fields chatLines and unreadCount
 * read: texts are clipped, images, thinking and tool arguments other than tell_owner's are dropped. Null for an entry that is no message.
 */
export function entryMessage(entry: Record<string, any>): ThreadMessage | null {
  const timestamp = new Date(entry.timestamp).getTime();
  if (entry.type === "custom_message") return { role: "custom", customType: String(entry.customType), content: clip(textOf(entry.content)), timestamp };
  if (entry.type === "compaction") return { role: "compactionSummary", summary: "", tokensBefore: Number(entry.tokensBefore) || 0, timestamp };
  if (entry.type === "branch_summary") return entry.summary ? { role: "branchSummary", summary: "", timestamp } : null;
  if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) return null;
  const message = entry.message;
  const at = typeof message.timestamp === "number" ? message.timestamp : timestamp;
  if (message.role === "user") {
    const text = textOf(message.content);
    return { role: "user", content: text.length > 2 * TEXT_KEEP ? text.slice(0, 2 * TEXT_KEEP) + (text.includes(OWNER_RETRY_MARK) ? OWNER_RETRY_MARK : "") : text, timestamp: at };
  }
  if (message.role === "assistant") {
    const content = (Array.isArray(message.content) ? message.content : []).flatMap((part: any) =>
      part?.type === "text" ? [{ type: "text", text: clip(String(part.text ?? "")) }]
      : part?.type === "toolCall" ? [{ type: "toolCall", id: String(part.id), name: String(part.name),
        arguments: part.name === "tell_owner" ? { text: clip(String(part.arguments?.text ?? "")), reply_to: part.arguments?.reply_to } : {} }] : []);
    return { role: "assistant", content, provider: "", model: "", stopReason: message.stopReason, timestamp: at,
      ...typeof message.errorMessage === "string" ? { errorMessage: clip(message.errorMessage) } : {} } as ThreadMessage;
  }
  if (message.role === "toolResult") return { role: "toolResult", toolCallId: String(message.toolCallId), toolName: String(message.toolName ?? ""),
    content: [{ type: "text", text: clip(textOf(message.content)) }], isError: message.isError === true, timestamp: at };
  if (message.role === "bashExecution") return { role: "bashExecution", command: "", output: "", cancelled: false, truncated: false, timestamp: at };
  return null;
}

/** An owner message: a user message the owner typed, or the server's restart of his unanswered one. It starts a turn the owner owns. */
export const ownerStart = (message: ThreadMessage): boolean => {
  if (message.role !== "user") return false;
  const text = textOf(message.content).trim();
  return !serverNote(text) || text.includes(OWNER_RETRY_MARK);
};

/** The message as a job line (ReportCard's and JobDrawer's `reportsFor` source), or null. `source` is "agent" for an agent message, else the server note. */
export function jobLine(message: ThreadMessage): JobLine | null {
  if (message.role !== "custom" && message.role !== "user") return null;
  const line = chatLines([message])[0];
  if (line?.kind !== "job") return null;
  const source = message.role === "custom" ? "agent" : textOf(message.content).startsWith(NUDGE_PREFIX) ? "nudge" : line.from;
  return { at: line.at, source, from: line.from };
}

const ENTRY_HEAD = /^\{"type":"[^"]*","id":"[^"]*","parentId":(?:null|"[^"]*"),"timestamp":"([^"]*)"/;
const ENTRY_TAIL = /"timestamp":"([^"]*)"\}$/;
/** An entry's own time from its line's bytes: up front for most entries, at the end for custom ones, else from a full parse. */
function entryTime(bytes: Buffer): number {
  const head = ENTRY_HEAD.exec(bytes.toString("utf8", 0, Math.min(bytes.length, 300)));
  const tail = head ? null : ENTRY_TAIL.exec(bytes.toString("utf8", Math.max(0, bytes.length - 120)));
  const stamp = head?.[1] ?? tail?.[1];
  if (stamp) return Date.parse(stamp);
  try { return Date.parse((JSON.parse(bytes.toString("utf8")) as { timestamp?: string }).timestamp ?? ""); } catch { return NaN; }
}

/** Whether a line can hold a job line: a user message or an agent message, judged from its first bytes without a parse. */
const mayBeJob = (bytes: Buffer): boolean => {
  const head = bytes.toString("utf8", 0, Math.min(bytes.length, 300));
  return head.includes('"role":"user"') || head.includes('"customType":"agent_message"');
};

function lineMessage(bytes: Buffer): ThreadMessage | null {
  try { return entryMessage(JSON.parse(bytes.toString("utf8"))); } catch { return null; }
}

const CHUNK_BYTES = 1 << 20;

/**
 * A transcript read from its end, in 1 MiB chunks, back to the owner's last message at or before `since` and past the last 24 h. Past that
 * owner message only the lines that can be job lines are parsed, so a 78 MB transcript costs the bytes of one day, once.
 */
export async function readTranscriptEnd(file: string, since: number, now: number, chunkBytes = CHUNK_BYTES): Promise<Transcript> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const messages: ThreadMessage[] = [];
    const jobs: JobLine[] = [];
    let bounded = false;
    let pos = size;
    let tail = Buffer.alloc(0);
    let end = size;
    let first = true;
    while (pos > 0) {
      const start = Math.max(0, pos - chunkBytes);
      const chunk = Buffer.alloc(pos - start);
      await handle.read(chunk, 0, chunk.length, start);
      pos = start;
      let data = tail.length ? Buffer.concat([chunk, tail]) : chunk;
      if (first) {
        // A last line with no newline is still being written; the forward read takes it once it ends.
        const last = data.lastIndexOf(0x0a);
        if (last < 0) { tail = data; continue; }
        end = start + last + 1;
        data = data.subarray(0, last + 1);
        first = false;
      }
      let stop = data.length;
      let done = false;
      while (stop > 0) {
        const newline = stop >= 2 ? data.lastIndexOf(0x0a, stop - 2) : -1;
        if (newline < 0 && start > 0) break;
        const bytes = data.subarray(newline + 1, data[stop - 1] === 0x0a ? stop - 1 : stop);
        stop = newline + 1;
        if (!bytes.length) continue;
        if (bounded) {
          const at = entryTime(bytes);
          if (Number.isFinite(at) && now - at >= DAY_MS) { done = true; break; }
          if (!mayBeJob(bytes)) continue;
        }
        const message = lineMessage(bytes);
        if (!message) continue;
        if (!bounded) messages.push(message);
        const job = jobLine(message);
        if (job && now - job.at < DAY_MS) jobs.push(job);
        if (!bounded && ownerStart(message) && message.timestamp <= since) bounded = true;
      }
      if (done) break;
      tail = data.subarray(0, stop);
    }
    return { file, offset: end, messages: messages.reverse(), jobs: jobs.reverse() };
  } finally { await handle.close(); }
}

/** Adds the lines written since the last round, keeps a line still being written for the next one, and starts over when the file shrank. */
export async function readTranscriptNew(kept: Transcript, since: number, now: number): Promise<Transcript> {
  const size = await stat(kept.file).then(info => info.size, () => -1);
  if (size < 0) return kept;
  if (size < kept.offset) return readTranscriptEnd(kept.file, since, now);
  if (size > kept.offset) {
    const handle = await open(kept.file, "r");
    try {
      const buffer = Buffer.alloc(size - kept.offset);
      await handle.read(buffer, 0, buffer.length, kept.offset);
      const last = buffer.lastIndexOf(0x0a);
      if (last >= 0) {
        for (let at = 0; at <= last;) {
          const newline = buffer.indexOf(0x0a, at);
          const message = newline > at ? lineMessage(buffer.subarray(at, newline)) : null;
          at = newline + 1;
          if (!message) continue;
          kept.messages.push(message);
          const job = jobLine(message);
          if (job) kept.jobs.push(job);
        }
        kept.offset += last + 1;
        delete kept.unread;
      }
    } finally { await handle.close(); }
  }
  const owner = kept.messages.findLastIndex(message => ownerStart(message) && message.timestamp <= since);
  if (owner > 0) { kept.messages = kept.messages.slice(owner); delete kept.unread; }
  kept.jobs = kept.jobs.filter(job => now - job.at < DAY_MS);
  return kept;
}

/** Where a chat's transcript is on this box: its own session file, else the newest mirror of another box's (src/host-mirror.ts). */
async function transcriptFile(home: string, host: string, id: string): Promise<{ file: string; host: string } | null> {
  const name = `${id}.jsonl`;
  const local = join(home, ".prime/agent/sessions", name);
  if (await stat(local).then(() => true, () => false)) return { file: local, host };
  const mirror = join(home, ".cache/sieun-pi/hosts");
  let best: { file: string; host: string; at: number } | null = null;
  for (const box of await readdir(mirror, { withFileTypes: true }).catch(() => [])) {
    if (!box.isDirectory()) continue;
    for (const top of ["Users", "home"]) {
      for (const user of await readdir(join(mirror, box.name, top)).catch(() => [] as string[])) {
        const file = join(mirror, box.name, top, user, ".prime/agent/sessions", name);
        const info = await stat(file).catch(() => null);
        if (info && (!best || info.mtimeMs > best.at)) best = { file, host: box.name, at: info.mtimeMs };
      }
    }
  }
  return best && { file: best.file, host: best.host };
}

/** The chats (chats.json `ids`) and the owner's read marker of each (read-state.json, the later of the baseline and the chat's marker). */
async function chatList(dir: string): Promise<{ id: string; since: number }[]> {
  const ids = await readFile(join(dir, "chats.json"), "utf8").then(raw => (JSON.parse(raw) as { ids?: unknown }).ids, () => []);
  const read = await readFile(join(dir, "read-state.json"), "utf8").then(raw => JSON.parse(raw) as { baseline?: number; sessions?: Record<string, { timestamp?: number }> }, () => ({}));
  const baseline = typeof read.baseline === "number" ? read.baseline : 0;
  return (Array.isArray(ids) ? ids : []).filter((id): id is string => typeof id === "string")
    .map(id => ({ id, since: Math.max(baseline, read.sessions?.[id]?.timestamp ?? 0) }));
}

/** How many jobs ranked by messages sent in the last 24 h go out one by one. Their name goes in `sender`, since Alloy's `job` label is "harness". */
const TOP_REPORTERS = 10;

/** The unread and job message numbers of the chats, per chat by name. */
export function chatSamples(chats: readonly { chat: string; since: number; transcript: Transcript }[], now: number): Sample[] {
  const unread: Sample[] = [];
  const counts: Sample[] = [];
  const reporters: { chat: string; job: string; count: number }[] = [];
  let unreadAll = 0;
  for (const { chat, since, transcript } of chats) {
    const count = unreadOf(transcript, since);
    unreadAll += count;
    unread.push({ name: "harness.delivery.unread", kind: "gauge", value: count, labels: { chat },
      help: "Feed rows of the chat the owner has not read, the sidebar's unread count (shown as 99+ past 99), 0 when he read them all." });
    const day = new Map<string, number>();
    const recent = new Map<string, number>();
    const senders = new Map<string, number>();
    let newest = -Infinity;
    for (const job of transcript.jobs) {
      day.set(job.source, (day.get(job.source) ?? 0) + 1);
      if (now - job.at < WINDOW_MS) recent.set(job.source, (recent.get(job.source) ?? 0) + 1);
      if (job.source !== "agent") continue;
      senders.set(job.from, (senders.get(job.from) ?? 0) + 1);
      newest = Math.max(newest, job.at);
    }
    for (const [source, value] of recent) counts.push({ name: "harness.delivery.job_messages_30m", kind: "gauge", value, labels: { chat, source },
      help: "Messages jobs, agents and the server sent the chat in the last 30 min, per chat and source (agent, check-in, jobs and the other server notes)." });
    for (const [source, value] of day) counts.push({ name: "harness.delivery.job_messages_24h", kind: "gauge", value, labels: { chat, source },
      help: "Messages jobs, agents and the server sent the chat in the last 24 h, per chat and source." });
    counts.push({ name: "harness.delivery.reporting_jobs_24h", kind: "gauge", value: senders.size, labels: { chat },
      help: "Jobs and agents that sent the chat at least one message in the last 24 h." });
    if (Number.isFinite(newest)) counts.push({ name: "harness.delivery.last_report_age", kind: "gauge", unit: "s", value: Math.max(0, now - newest) / 1000, labels: { chat },
      help: "Age of the newest message a job or agent sent the chat, within the last 24 h." });
    for (const [job, value] of senders) reporters.push({ chat, job, count: value });
  }
  const ranked = reporters.sort((a, b) => b.count - a.count || a.job.localeCompare(b.job)).slice(0, TOP_REPORTERS);
  return [
    { name: "harness.delivery.unread_all", kind: "gauge", help: "Unread feed rows summed over every chat.", value: unreadAll },
    ...unread,
    ...counts,
    ...ranked.map(({ chat, job, count }, index) => ({ name: "harness.delivery.top_reporters_24h", kind: "gauge" as const, value: count,
      labels: { rank: String(index + 1), chat, sender: job }, help: "The ten jobs that sent their chat the most messages in the last 24 h, ranked, by chat and sender name." })),
  ];
}

/** The part of the chat's GET api/slack answer (SlackBridge.view) that lives only in the chat's memory. */
interface SlackLive { state: string; tokenSource: string | null; at: number }

/**
 * Asks the chat for its Slack view in the background and returns the last answer. The round never waits on the chat, so a busy or stuck chat
 * leaves an old answer, whose age goes out, instead of holding up the feed.
 */
function slackLive(ctx: Context, dir: string): { last: SlackLive | null; asking: Promise<void> | null } {
  const held = state(ctx, "delivery.slack", () => ({ last: null as SlackLive | null, asking: null as Promise<void> | null }));
  if (!held.asking) {
    const asking: Promise<void> = readFile(join(dir, "instance.json"), "utf8")
      .then(raw => fetch(new URL("api/slack", (JSON.parse(raw) as { url: string }).url)))
      .then(response => response.ok ? response.json() as Promise<{ state?: unknown; tokenSource?: unknown } | null> : null)
      .then(view => { if (view && typeof view.state === "string") held.last = { state: view.state, tokenSource: typeof view.tokenSource === "string" ? view.tokenSource : null, at: Date.now() }; })
      .catch(() => {})
      .finally(() => { if (held.asking === asking) held.asking = null; });
    held.asking = asking;
  }
  return held;
}

interface SlackFile { enabled?: boolean; links?: Record<string, { archived?: boolean; posted?: string[] }> }

export function slackSamples(file: SlackFile | null, live: SlackLive | null, names: Pick<Names, "name">, now: number): Sample[] {
  const links = Object.entries(file?.links ?? {}).filter(([, link]) => !link.archived);
  const posted = new Tally();
  for (const [id, link] of links) {
    const chat = names.name(id);
    posted.add({ chat }, 0);
    for (const key of link.posted ?? []) if (now - Number(key.split(":")[0]) < DAY_MS) posted.add({ chat });
  }
  return [
    { name: "harness.delivery.slack_enabled", kind: "gauge", help: "1 when the Slack bridge is switched on in Settings > Slack.", value: file?.enabled ? 1 : 0 },
    { name: "harness.delivery.slack_synced_chats", kind: "gauge", help: "Chats synced to a Slack channel now, the Settings > Slack count.", value: links.length },
    ...posted.samples({ name: "harness.delivery.slack_posted_24h", kind: "gauge", help: "Chat replies the bridge posted to the chat's Slack channel in the last 24 h, by reply time." }),
    ...live ? [
      { name: "harness.delivery.slack_connected", kind: "gauge" as const, help: "1 when the chat's Slack socket is on, Settings > Slack's state.", value: live.state === "on" ? 1 : 0 },
      { name: "harness.delivery.slack_state", kind: "gauge" as const, help: "The Slack bridge's state (off, no-tokens, no-owner, connecting, on, problem) and where its tokens came from, as 1.",
        value: 1, labels: { state: live.state, token_source: live.tokenSource ?? "none" } },
      { name: "harness.delivery.slack_answer_age", kind: "gauge" as const, unit: "s" as const, help: "Age of the chat's last answer about its Slack state.", value: Math.max(0, now - live.at) / 1000 },
    ] : [],
  ];
}

/** Each chat's transcript, read from its end the first time and from the saved offset after; a chat that left chats.json is let go. */
async function readChats(ctx: Context, dir: string): Promise<{ id: string; host: string; since: number; transcript: Transcript }[]> {
  const kept = state(ctx, "delivery.transcripts", () => new Map<string, Transcript>());
  const chats = await chatList(dir);
  const listed = new Set(chats.map(chat => chat.id));
  for (const id of kept.keys()) if (!listed.has(id)) kept.delete(id);
  // One chat at a time: the first round reads a day of each transcript, and 19 at once held 19 sets of chunks and parses (363 MB peak on 10-19).
  const read: { id: string; host: string; since: number; transcript: Transcript }[] = [];
  for (const { id, since } of chats) {
    const held = kept.get(id);
    // A mirror found before is kept while it exists and the chat has no session file here, so a round costs two stats, not a mirror search.
    const local = join(ctx.home, ".prime/agent/sessions", `${id}.jsonl`);
    const known = held && held.file !== local && held.host && await stat(held.file).then(() => true, () => false)
      && !await stat(local).then(() => true, () => false) ? { file: held.file, host: held.host } : null;
    const where = known ?? await transcriptFile(ctx.home, ctx.host, id);
    if (!where) { kept.delete(id); continue; }
    const transcript = held?.file === where.file ? await readTranscriptNew(held, since, ctx.now) : await readTranscriptEnd(where.file, since, ctx.now);
    transcript.host = where.host;
    kept.set(id, transcript);
    read.push({ id, host: where.host, since, transcript });
  }
  return read;
}

export async function read(ctx: Context): Promise<Sample[]> {
  if (!ctx.chatHost) return [];
  const dir = join(ctx.home, ".prime/agent/browser-chat");
  const slack = slackLive(ctx, dir);
  const [agent, owner, copies, chats, slackFile] = await Promise.all([
    readOutbox(join(dir, "agent-outbox"), "agent", state(ctx, "delivery.agent", () => new Map<string, Entry>())),
    readOutbox(join(dir, "outbox"), "owner", state(ctx, "delivery.owner", () => new Map<string, Entry>())),
    readCopies(ctx),
    readChats(ctx, dir),
    readFile(join(dir, "slack.json"), "utf8").then(raw => JSON.parse(raw) as SlackFile, () => null),
  ]);
  const sends = await readSends(join(dir, "sends.jsonl"), state(ctx, "delivery.sends", () => ({ offset: 0, sends: [] as OutsideSend[] })), ctx.now);
  const names = new Names(ctx, copies);
  const named = chats.map(chat => ({ ...chat, chat: names.name(chat.id, true) }));
  const samples = [
    ...outboxSamples([...agent.map(entry => ({ outbox: "agent" as const, entry })), ...owner.map(entry => ({ outbox: "owner" as const, entry }))], names, ctx.now),
    ...daemonSamples(copies, names, named.map(({ host, chat }) => ({ host, chat }))),
    ...sendSamples(sends, names, ctx.now),
    ...chatSamples(named, ctx.now),
    ...slackSamples(slackFile, slack.last, names, ctx.now),
  ];
  names.refresh();
  return samples;
}
