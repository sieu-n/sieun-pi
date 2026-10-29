/**
 * The move from today's thread-shaped chats to agents and DM rooms (apps/chat/docs/agent-model.md, section 5): one agent per root chat with a
 * name (an untitled one stays a solo chat), its root jobs as aliases, the last `days` of its DM copied in as room posts, the feed cursor set after the newest entry read, its boards folder
 * copied and its read mark moved. It only reads pi-host (`threads`, `entries`) and writes through `agent-store.ts`, so it runs while the old
 * server runs, and a second run writes nothing, because an agent's record is written last and every post has its `h:` requestId.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import { join, relative } from "node:path";
import type { AgentId, Item, Ms, Principal } from "../web/src/lib/api/types.ts";
import { AgentStore, freeSlug, isUntitled, type AgentRecord, type FeedCursor, type RoomId, type RoomPost } from "./agent-store.ts";
import type { DurableThread, EntryRecord, Host } from "./host/types.ts";
import { ownerText } from "./rooms.ts";
import { readJson, writeJson, type StateFile, type Store } from "./store.ts";
import { buildItems, firstSendIn, isInput, sentMessage, sentMessages, TURN_KINDS, type TimelineContext } from "./timeline.ts";

const DAY_MS = 86_400_000;
const PAGE = 500;
const CONVERSATION = 1;

export type PostDraft = Omit<RoomPost, "id" | "seq" | "room">;

export interface AgentMigration {
  id: AgentId;
  name: string;
  thread: string;
  room: RoomId;
  /** False when the agent already had its record, so this run left it alone. */
  created: boolean;
  /** The posts this run writes (or would write), oldest first. */
  posts: PostDraft[];
  cursor?: FeedCursor;
  /** Files copied from `boards/<thread>/` to `agents/<id>/`, relative to the boards folder. */
  copied: string[];
  readSeq?: number;
  entriesRead: number;
}

export interface MigrationReport {
  apply: boolean;
  since: Ms;
  agents: AgentMigration[];
  /** Aliases this run adds: thread id to agent id. */
  aliases: Record<string, AgentId>;
  /** Untitled root chats left as solo chats. */
  skipped: { thread: string; name: string }[];
  ms: number;
}

export interface MigrateOptions {
  apply: boolean;
  days?: number;
  log?: (line: string) => void;
  /** The live server's own store and state, so it and the migration write through one object each; absent, the migration opens its own. */
  store?: AgentStore;
  state?: Store;
  /** The box the agents run on, `config.box`. */
  box?: string;
  now?: () => Ms;
}

export async function migrateAgents(host: Host, dataDir: string, opts: MigrateOptions): Promise<MigrationReport> {
  const started = Date.now();
  const now = opts.now?.() ?? Date.now();
  const since = now - (opts.days ?? 30) * DAY_MS;
  const log = opts.log ?? (() => {});
  const store = opts.store ?? new AgentStore(dataDir);
  const state: StateFile = opts.state?.state ?? readJson<StateFile>(join(dataDir, "state.json"), { v: 1, threads: {}, reads: {} });
  const rows = (await host.threads()).filter(row => !row.archived);
  const report: MigrationReport = { apply: opts.apply, since, agents: [], aliases: {}, skipped: [], ms: 0 };
  const taken = new Set(store.agents.agents.map(a => a.slug));
  const planned: AgentRecord[] = [];

  for (const row of rows.sort((a, b) => a.createdAt - b.createdAt)) {
    if (state.threads[row.id]?.kind === "job") continue;
    const existing = store.agentOf(row.id);
    // An untitled root chat is a solo chat, not an agent: three "New thread" chats became ag_new-thread to -4 on 10-29 this way.
    if (!existing && isUntitled(row.name)) {
      report.skipped.push({ thread: row.id, name: row.name });
      continue;
    }
    if (existing) {
      report.agents.push({ id: existing.id, name: existing.name, thread: row.id, room: existing.room, created: false, posts: [], copied: [], entriesRead: 0 });
      continue;
    }
    const slug = freeSlug(row.name || "agent", taken);
    taken.add(slug);
    const record: AgentRecord = {
      id: `ag_${slug}`, slug, name: row.name || "Untitled", room: `dm_${slug}`, workThread: row.id, host: opts.box ?? hostname(), home: row.cwd,
      createdAt: row.createdAt, archived: false,
    };
    const history = await readHistory(host, row, record, since);
    const fresh = history.posts.filter(post => !store.byRequestId(record.room, post.requestId));
    const migration: AgentMigration = {
      id: record.id, name: record.name, thread: row.id, room: record.room, created: true, posts: fresh, cursor: history.cursor, copied: [], entriesRead: history.read,
    };
    const mark = state.reads[row.id];
    if (mark && !state.reads[record.room]) migration.readSeq = readSeqAt(store, record.room, history.posts, mark.at);
    migration.copied = boardFiles(dataDir, row.id).filter(file => !existsSync(join(dataDir, "agents", record.id, file)));
    report.agents.push(migration);
    planned.push(record);
    if (opts.apply) write(store, state, opts.state, dataDir, record, migration, history.posts, mark?.at, now, since);
  }

  const owners = new Map([...store.agents.agents, ...planned].map(a => [a.workThread, a.id]));
  for (const [thread, owner] of owners) if (!store.agents.aliases[thread]) report.aliases[thread] = owner;
  for (const [thread, meta] of Object.entries(state.threads)) {
    if (meta.kind !== "job" || !meta.parent || store.agents.aliases[thread]) continue;
    const owner = owners.get(meta.parent.split(":")[0]!);
    if (owner) report.aliases[thread] = owner;
  }
  if (opts.apply && Object.keys(report.aliases).length) {
    Object.assign(store.agents.aliases, report.aliases);
    store.saveAgents();
  }

  report.ms = Date.now() - started;
  for (const agent of report.agents) {
    log(agent.created
      ? `${opts.apply ? "made" : "would make"} ${agent.id} (${agent.name}): ${agent.posts.length} posts in ${agent.room} from ${agent.entriesRead} entries, cursor e${agent.cursor?.entry ?? 0}, ${agent.copied.length} board files`
      : `${agent.id} (${agent.name}) exists, left as it is`);
  }
  return report;
}

/** The read mark's seq in the room: the newest post at or before the time the owner last read the thread. */
function readSeqAt(store: AgentStore, room: RoomId, drafts: readonly PostDraft[], at: Ms): number {
  const existing = store.postsOf(room);
  const all = [...existing, ...drafts.filter(d => !existing.some(p => p.requestId === d.requestId))];
  let seq = 0;
  all.forEach((post, index) => { if (post.at <= at) seq = index + 1; });
  return seq;
}

/** The order makes a crash safe to rerun: posts dedup by requestId, and the agent record that marks the agent done is written last. */
function write(
  store: AgentStore, state: StateFile, live: Store | undefined, dataDir: string, record: AgentRecord, migration: AgentMigration,
  posts: readonly PostDraft[], readAt: Ms | undefined, now: Ms, since: Ms,
): void {
  for (const draft of migration.posts) store.append({ ...draft, room: record.room });
  if (migration.cursor) {
    const lastRequest = migration.cursor.turn?.lastPost;
    if (migration.cursor.turn && lastRequest) {
      const post = store.byRequestId(record.room, lastRequest);
      migration.cursor.turn.lastPost = post?.id;
      if (!post) delete migration.cursor.turn.lastPost;
    }
    store.rooms.feed[record.id] ??= migration.cursor;
  }
  if (!store.rooms.rooms.some(r => r.id === record.room)) store.rooms.rooms.push({ id: record.room, kind: "dm", agent: record.id, createdAt: now, archived: false });
  store.saveRooms();
  if (readAt !== undefined && !state.reads[record.room]) {
    const seq = readSeqAt(store, record.room, [], readAt);
    if (live) {
      live.state.reads[record.room] = { at: readAt, seq };
      live.saveState();
    } else {
      // A fresh read of state.json just before the write, so a change the old server made meanwhile stays.
      const file = join(dataDir, "state.json");
      const current = readJson<StateFile>(file, state);
      current.reads[record.room] ??= { at: readAt, seq };
      writeJson(file, current);
    }
    migration.readSeq = seq;
  }
  for (const file of migration.copied) {
    const target = join(dataDir, "agents", record.id, file);
    mkdirSync(join(target, ".."), { recursive: true });
    copyFileSync(join(dataDir, "boards", record.workThread, file), target);
  }
  store.agents.agents.push({ ...record, migrated: { at: now, posts: posts.length, since } });
  store.saveAgents();
}

function boardFiles(dataDir: string, thread: string): string[] {
  const root = join(dataDir, "boards", thread);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out.push(relative(root, path));
    }
  };
  walk(root);
  return out.sort();
}

const at = (entry: EntryRecord): Ms | undefined => entry.model?.[0]?.timestamp;
const via = (entry: EntryRecord): string => String((entry.data as { via?: unknown } | undefined)?.via ?? "");
/** A channel post's input: channels.ts sends it as an agent.message from `#<channel name>`. */
const fromChannel = (entry: EntryRecord): boolean => entry.kind === "agent.message" && (via(entry).startsWith("#") || via(entry).startsWith("ch_"));

/**
 * Conversation 1 from its first input at or after `since`, read newest first in pages, plus the conversation's first speaking call when it lies
 * before that window, since it decides whether the window's early turns speak through their calls or their text.
 */
async function readWindow(host: Host, thread: string, since: Ms): Promise<{ entries: EntryRecord[]; firstSend?: number; newest: number }> {
  const read: EntryRecord[] = [];
  let before: number | undefined;
  let more = true;
  while (more) {
    const page = await host.entries(thread, { conversation: CONVERSATION, limit: PAGE, ...(before === undefined ? {} : { before }) });
    read.push(...page.entries);
    more = page.more && page.entries.length > 0;
    if (!page.entries.length) break;
    before = Math.min(...page.entries.map(e => e.id));
    const oldest = page.entries.find(e => e.id === before)!;
    if ((at(oldest) ?? Infinity) < since) break;
  }
  read.sort((a, b) => a.id - b.id);
  const newest = read.at(-1)?.id ?? 0;
  const start = read.findIndex(e => isInput(e) && (at(e) ?? 0) >= since);
  const entries = start < 0 ? [] : read.slice(start);
  let firstSend = firstSendIn(read);
  const early = earlyTurn(entries, firstSend);
  while (early && firstSend === firstSendIn(entries) && more && before !== undefined) {
    const page = await host.entries(thread, { conversation: CONVERSATION, limit: PAGE, before });
    if (!page.entries.length) break;
    firstSend = firstSendIn(page.entries) ?? firstSend;
    before = Math.min(...page.entries.map(e => e.id));
    more = page.more;
  }
  return { entries, newest, ...(firstSend === undefined ? {} : { firstSend }) };
}

/** Whether the window has a turn that ends before `firstSend`, whose look depends on a speaking call older than the window. */
function earlyTurn(entries: readonly EntryRecord[], firstSend: number | undefined): boolean {
  for (const turn of turnEntries(entries).values()) if (firstSend === undefined || turn[0]!.id < firstSend) return turn.at(-1)!.id < (firstSend ?? Infinity);
  return false;
}

interface History { posts: PostDraft[]; cursor: FeedCursor; read: number }

async function readHistory(host: Host, row: DurableThread, record: AgentRecord, since: Ms): Promise<History> {
  const { entries, firstSend, newest } = await readWindow(host, row.id, since);
  const agent: Principal = { id: record.id, kind: "chat", name: record.name, avatar: { initials: record.name.slice(0, 2).toUpperCase(), hue: 0 } };
  const ctx: TimelineContext = {
    thread: row.id, conversation: CONVERSATION, agent, principal: from => (from === "owner" ? { ...agent, id: "owner", kind: "owner", name: "owner" } : { ...agent, id: from, name: from }),
    tree: [], jobStatus: () => "idle", running: row.status === "running", ...(firstSend === undefined ? {} : { firstSend }),
  };
  const items = buildItems(entries, ctx);
  const byId = new Map(entries.map(e => [e.id, e]));
  const turns = turnEntries(entries);
  const posts: PostDraft[] = [];
  const cursor: FeedCursor = { entry: newest, open: {} };
  const lastTurn = items.findLast(item => item.kind === "turn");

  for (const item of items) {
    if (item.kind === "message") {
      const entry = byId.get(Number(item.id.slice(1)))!;
      const text = ownerText(entry);
      if (text === undefined) continue;
      posts.push({ author: "owner", text, images: item.images, at: item.at, requestId: `h:${row.id}:${entry.id}`, imported: true });
    } else if (item.kind === "turn") {
      const key = Number(item.id.slice(1));
      const turn = turns.get(key) ?? [];
      const input = byId.get(key);
      const channel = input !== undefined && isInput(input) && fromChannel(input);
      const made = channel ? { posts: [], open: {}, waiting: [] } : turnPosts(row.id, item, turn);
      posts.push(...made.posts);
      if (item === lastTurn) {
        cursor.turn = {
          input: input && isInput(input) ? input.id : key, channel,
          ...(made.posts.length ? { lastPost: made.posts.at(-1)!.requestId } : {}), ...(made.waiting.length ? { jobs: made.waiting } : {}),
        };
        cursor.open = made.open;
      }
    }
  }
  return { posts, cursor, read: entries.length };
}

/** Each turn's entries by the key `buildItems` gives the turn: the input before it, or its own first entry. */
function turnEntries(entries: readonly EntryRecord[]): Map<number, EntryRecord[]> {
  const turns = new Map<number, EntryRecord[]>();
  let lastInput: number | undefined;
  let current: EntryRecord[] | undefined;
  for (const entry of entries) {
    if (isInput(entry)) {
      lastInput = entry.id;
      current = undefined;
    } else if (TURN_KINDS.has(entry.kind)) {
      if (!current) {
        current = [];
        turns.set(lastInput ?? entry.id, current);
      }
      current.push(entry);
    } else if (entry.kind === "pi.compaction") {
      lastInput = undefined;
      current = undefined;
    }
  }
  return turns;
}

const jobsOf = (thread: string, entry: EntryRecord): string[] => {
  const details = entry.model?.[0]?.role === "toolResult" ? entry.model[0].details : undefined;
  const ids = [details?.conversationId, ...(Array.isArray(details?.conversations) ? details.conversations : [])];
  return [...new Set(ids.filter((id): id is number => typeof id === "number"))].map(id => `${thread}:${id}`);
};

/**
 * A turn's posts, as the feed would have written them: each speaking call with no `to` whose result landed and sent it, or for a turn from
 * before the conversation's first call, its text as one post. A job a tool result names goes to the turn's newest post so far, else to its
 * next one. A call whose result has not landed is `open`, for the feed to post once it lands.
 */
function turnPosts(thread: string, item: Extract<Item, { kind: "turn" }>, turn: readonly EntryRecord[]): { posts: PostDraft[]; open: FeedCursor["open"]; waiting: string[] } {
  const open: FeedCursor["open"] = {};
  if (!item.sent) {
    const last = turn.findLast(e => e.model?.[0]?.role === "assistant");
    if (!item.text.trim() || item.live || !last) return { posts: [], open, waiting: [] };
    const jobs = [...new Set(turn.flatMap(e => jobsOf(thread, e)))];
    return {
      posts: [{
        author: item.author.id, text: item.text, images: [], at: item.at, requestId: `h:${thread}:t${item.id.slice(1)}`, imported: true,
        source: { thread, conversation: CONVERSATION, entry: last.id }, ...(jobs.length ? { jobs } : {}),
      }],
      open,
      waiting: [],
    };
  }
  const sent = new Set(sentMessages(turn).map(m => m.id));
  const landed = new Set(turn.flatMap(e => (e.model?.[0]?.role === "toolResult" && e.model[0].toolCallId ? [e.model[0].toolCallId] : [])));
  const posts: PostDraft[] = [];
  let waiting: string[] = [];
  for (const entry of turn) {
    const message = entry.model?.[0];
    if (message?.role === "toolResult") {
      const jobs = jobsOf(thread, entry);
      const target = posts.at(-1);
      if (target && jobs.length) target.jobs = [...new Set([...(target.jobs ?? []), ...jobs])];
      else waiting.push(...jobs);
      continue;
    }
    if (message?.role !== "assistant" || typeof message.content === "string") continue;
    for (const block of message.content) {
      const call = sentMessage(block);
      if (!call || call.to || block.type !== "toolCall") continue;
      const why = typeof block.arguments.why === "string" ? block.arguments.why : undefined;
      if (!landed.has(call.id)) {
        open[call.id] = { text: call.text, entry: entry.id, ...(why ? { why } : {}) };
        continue;
      }
      if (!sent.has(call.id)) continue;
      posts.push({
        author: item.author.id, text: call.text, images: [], at: message.timestamp ?? item.at, requestId: `h:${thread}:${call.id}`, imported: true,
        source: { thread, conversation: CONVERSATION, entry: entry.id }, ...(why ? { why } : {}), ...(waiting.length ? { jobs: [...new Set(waiting)] } : {}),
      });
      waiting = [];
    }
  }
  return { posts, open, waiting };
}
