/**
 * Threads, jobs and agents as the pages see them, built from pi-host's thread list and trees, and the live side: one host watch per
 * conversation a page has open, turned into item upserts and status. Nothing streams: a turn shows as each entry with text or a
 * send_message call lands.
 */
import type {
  AgentId, AgentSummary, ConversationId, ConversationSummary, Item, JobNode, LivePartial, ModelRef, Principal, RunStatus, ThinkingLevel, TimelinePage,
} from "../web/src/lib/api/types.ts";
import type { AgentEvent, DurableEvent, DurableThread, EntryRecord, Host, TreeNode } from "./host/types.ts";
import type { Store } from "./store.ts";
import { agentSummary, isAgentId, isRoomId, type Agents } from "./agents.ts";
import { buildItems, earliest, entryOf, firstSendIn, isInput, itemIdFor, sentMessages, speaks, speaksThroughSendMessage, type TimelineContext } from "./timeline.ts";

export const OWNER: Principal = { id: "owner", kind: "owner", name: "You", avatar: { initials: "Me", hue: 210 } };

export function avatarOf(name: string): Principal["avatar"] {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  const initials = ((words[0]?.[0] ?? "?") + (words[1]?.[0] ?? words[0]?.[1] ?? "")).toUpperCase();
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return { initials, hue: hash % 360 };
}

const MODEL_LABELS: Record<string, string> = {
  "claude-opus-5-5": "Opus 5.5", "claude-sonnet-5-5": "Sonnet 5.5", "claude-fable-5-1": "Fable 5.1", "gpt-6.1-sol": "GPT-6.1 sol", "gpt-6-luna": "GPT-6 luna",
};
export function modelRef(spec: string | null | undefined): ModelRef | null {
  if (!spec || !spec.includes("/")) return null;
  const [provider, ...rest] = spec.split("/");
  const id = rest.join("/");
  return { provider: provider!, id, label: MODEL_LABELS[id] ?? id };
}

export const statusOf = (status: DurableThread["status"] | TreeNode["status"]): RunStatus => (status === "running" ? "working" : status);

/** `<thread>` or `<thread>:<conversation>`. */
export function parseConversationId(id: ConversationId): { thread: string; conversation: number } {
  const match = /^(.+):(\d+)$/.exec(id);
  return match ? { thread: match[1]!, conversation: Number(match[2]) } : { thread: id, conversation: 1 };
}
export const conversationIdOf = (thread: string, conversation: number): ConversationId => (conversation === 1 ? thread : `${thread}:${conversation}`);

const PAGE = 40;
/** A turn with more entries than this is cut at a page edge instead of read whole. */
const TURN_READ_CAP = 2000;

interface LiveConversation {
  thread: string;
  conversation: number;
  /** Entries from the newest input on, oldest first. */
  recent: EntryRecord[];
  running: boolean;
  runningTools: Set<string>;
  /** Always null: the page gets no partial text (see onEvent). */
  partial: LivePartial | null;
  stop?: () => Promise<void>;
  watchers: number;
  ready: Promise<void>;
}

export interface ThreadEvents {
  agents(changed: AgentSummary[], removed: AgentId[]): void;
  conversations(changed: ConversationSummary[]): void;
  items(conversation: ConversationId, items: Item[]): void;
  partial(conversation: ConversationId, partial: LivePartial | null): void;
  status(conversation: ConversationId, status: RunStatus): void;
  jobs(thread: string, jobs: JobNode[]): void;
}

const THREADS_CACHE = "threads";
type ThreadsCache = { threads: DurableThread[]; trees: [string, { updatedAt: number; nodes: TreeNode[] }][] };

export class Threads {
  private list = new Map<string, DurableThread>();
  private trees = new Map<string, { updatedAt: number; nodes: TreeNode[] }>();
  private agentCache = new Map<AgentId, string>();
  private convCache = new Map<ConversationId, string>();
  private readonly live = new Map<ConversationId, LiveConversation>();
  /** Each conversation's first entry id, which never changes once it exists. */
  private readonly firstEntries = new Map<ConversationId, number>();
  /**
   * The earliest send_message call seen in each conversation, from every page and live entry read: a page of a conversation that talks
   * through send_message reads that way even when the page itself holds no call, such as a run of quiet turns.
   */
  private readonly firstSends = new Map<ConversationId, number>();
  private timer?: NodeJS.Timeout;
  /** Extra summaries the channel layer adds (channels), merged into conversations(). */
  channelSummaries: () => ConversationSummary[] = () => [];
  /** The agents' DM rooms (rooms.ts), merged into conversations(). */
  roomSummaries: () => ConversationSummary[] = () => [];
  /** Channels each agent is in. */
  channelsOf: (agent: AgentId) => string[] = () => [];
  /** A `doc` event from a watched thread, such as the chat writing `chat.board`. */
  onDoc: (thread: string, name: string, value: unknown) => void = () => {};
  /** Runs after each thread list read, so the DM rooms read the work threads that changed. */
  onRefresh: () => void = () => {};
  /** The agent records (agents.ts), set once the app has made them. */
  agentRecords?: Agents;
  /** A work thread's inputs that were a job's test send (rooms.ts `testSendsOf`), set once the app has made the rooms. */
  testSendsOf: (thread: string) => ReadonlyMap<number, { by: string; reason: string }> = () => new Map();

  private refreshing?: Promise<void>;
  private cached = "";

  constructor(readonly host: Host, readonly store: Store, readonly events: ThreadEvents, readonly box: string, private readonly log: (line: string) => void = () => {}) {
    const cache = store.cache<ThreadsCache>(THREADS_CACHE, { threads: [], trees: [] });
    this.list = new Map(cache.threads.map(t => [t.id, t]));
    this.trees = new Map(cache.trees);
    this.cached = JSON.stringify(cache);
  }

  /**
   * With a thread list cached from the last run, the server serves it at once and reads pi-host behind it: after a restart on 10-28,
   * pi-host took 8 to 13 s to listen, and the chat waited for it before it opened its port, so the sidebar was blank all that time.
   */
  async start(pollMs = 2000): Promise<void> {
    const first = this.poll();
    if (!this.list.size) await first;
    this.timer = setInterval(() => void this.poll(), pollMs);
  }

  /** One refresh at a time: while pi-host restarts, a read waits up to 30 s, and the 2 s poll must not stack more behind it. */
  private poll(): Promise<void> {
    this.refreshing ??= this.refresh()
      .catch(error => this.log(`thread refresh failed: ${String(error)}`))
      .finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    for (const live of this.live.values()) await live.stop?.().catch(() => undefined);
  }

  /** Reads the thread list, and the tree of every thread whose file changed, and sends what changed. */
  async refresh(): Promise<void> {
    const threads = await this.host.threads();
    const next = new Map(threads.map(t => [t.id, t]));
    for (const thread of threads) {
      const tree = this.trees.get(thread.id);
      if (thread.children > 0 && (!tree || tree.updatedAt !== thread.updatedAt || thread.status === "running")) {
        const nodes = await this.host.tree(thread.id).catch(() => tree?.nodes ?? []);
        const before = JSON.stringify(tree?.nodes ?? []);
        this.trees.set(thread.id, { updatedAt: thread.updatedAt, nodes });
        if (JSON.stringify(nodes) !== before) this.events.jobs(thread.id, this.jobs(thread.id));
      }
    }
    this.list = next;
    this.agentRecords?.follow(next);
    const cache = JSON.stringify({ threads, trees: [...this.trees] } satisfies ThreadsCache);
    if (cache !== this.cached) {
      this.cached = cache;
      this.store.saveCache(THREADS_CACHE, JSON.parse(cache));
    }
    const agents = this.agents({ archived: true });
    const changed = agents.filter(a => this.agentCache.get(a.id) !== JSON.stringify(a));
    const removed = [...this.agentCache.keys()].filter(id => !agents.some(a => a.id === id));
    this.agentCache = new Map(agents.map(a => [a.id, JSON.stringify(a)]));
    if (changed.length || removed.length) this.events.agents(changed, removed);
    const conversations = this.threadConversations();
    const convChanged = conversations.filter(c => this.convCache.get(c.id) !== JSON.stringify(c));
    this.convCache = new Map(conversations.map(c => [c.id, JSON.stringify(c)]));
    if (convChanged.length) this.events.conversations(convChanged);
    for (const live of this.live.values()) {
      const status = this.statusOfConversation(live.thread, live.conversation);
      if ((status === "working") !== live.running && !live.recent.length) {
        live.running = status === "working";
        this.events.status(conversationIdOf(live.thread, live.conversation), status);
      }
    }
    this.onRefresh();
  }

  thread(id: string): DurableThread | undefined {
    return this.list.get(id);
  }
  threadsList(): DurableThread[] {
    return [...this.list.values()];
  }
  tree(thread: string): TreeNode[] {
    return this.trees.get(thread)?.nodes ?? [];
  }
  meta(thread: string): { kind: "chat" | "job"; parent?: AgentId } {
    return this.store.state.threads[thread] ?? { kind: "chat" };
  }

  statusOfConversation(thread: string, conversation: number): RunStatus {
    const row = this.list.get(thread);
    if (!row) return "idle";
    if (conversation === 1) return statusOf(row.status);
    const node = this.tree(thread).find(n => n.id === conversation);
    return node ? statusOf(node.status) : "idle";
  }

  principal(id: string): Principal {
    if (id === "owner") return OWNER;
    const agent = this.agent(id);
    if (agent) return { id: agent.id, kind: agent.kind, name: agent.name, avatar: agent.avatar, ...(agent.parent ? { parent: agent.parent.id } : {}) };
    const record = this.agentRecords?.record(id);
    if (record) return { id: record.id, kind: "chat", name: record.name, avatar: avatarOf(record.name) };
    const byName = this.agents({ archived: true }).find(a => a.name === id);
    if (byName) return this.principal(byName.id);
    return { id, kind: "job", name: id, avatar: avatarOf(id) };
  }

  /**
   * An agent (`ag_<slug>`, or its DM room `dm_<slug>`), a job (`<thread>:<n>`, or a root job thread), or a root chat no agent holds yet. A
   * work thread's id answers its agent.
   */
  agent(id: AgentId): AgentSummary | undefined {
    if (isAgentId(id) || isRoomId(id)) {
      const record = this.agentRecords?.record(id);
      const row = record && this.list.get(record.workThread);
      if (!record) return undefined;
      return row ? this.agentsOf(row)[0] : agentSummary(record, { tree: [], jobs: [] }, { model: null, channels: this.channelsOf(record.workThread) });
    }
    const { thread, conversation } = parseConversationId(id);
    const row = this.list.get(thread);
    if (!row) return undefined;
    return this.agentsOf(row).find(a => a.conversation === conversation);
  }

  /** The pi-host conversation an id names: an agent's or a DM room's work thread, and any other id as it is. */
  conversationOf(id: string): ConversationId {
    return (isAgentId(id) || isRoomId(id)) ? this.agentRecords?.record(id)?.workThread ?? id : id;
  }

  /** The agent a root job thread belongs to, from its kind's parent, through the agent's aliases. */
  private parentOf(meta: { parent?: AgentId }): { id: AgentId; name: string } | null {
    if (!meta.parent) return null;
    const record = this.agentRecords?.record(meta.parent) ?? this.agentRecords?.record(parseConversationId(meta.parent).thread);
    if (record) return { id: record.id, name: this.list.get(record.workThread)?.name || record.name };
    return { id: meta.parent, name: this.list.get(parseConversationId(meta.parent).thread)?.name ?? meta.parent };
  }

  private agentsOf(row: DurableThread): AgentSummary[] {
    const meta = this.meta(row.id);
    const rootModel = modelRef(`${row.provider}/${row.modelId}`);
    const record = this.agentRecords?.ofWorkThread(row.id);
    const root: AgentSummary = record
      ? agentSummary(record, {
        row, tree: this.tree(row.id),
        jobs: this.agentRecords!.jobThreads(record).flatMap(id => (this.list.has(id) ? [this.list.get(id)!] : [])),
      }, { model: rootModel, channels: this.channelsOf(row.id) })
      : {
        id: row.id, kind: meta.kind, name: row.name || "Untitled", avatar: avatarOf(row.name || row.id), model: rootModel,
        thinkingLevel: (row.thinkingLevel as ThinkingLevel) ?? null, status: statusOf(row.status), parent: meta.kind === "job" ? this.parentOf(meta) : null,
        thread: row.id, conversation: 1, archived: row.archived, createdAt: row.createdAt, updatedAt: row.updatedAt,
        preview: row.preview.split("\n").find(line => line.trim()) ?? "", channels: this.channelsOf(row.id), host: this.box,
      };
    const out = [root];
    for (const node of this.tree(row.id)) {
      if (node.parent === null) continue;
      const id = conversationIdOf(row.id, node.id);
      const parentId = node.parent === 1 ? root.id : conversationIdOf(row.id, node.parent);
      const parentName = node.parent === 1 ? root.name : this.tree(row.id).find(n => n.id === node.parent)?.name ?? parentId;
      out.push({
        id, kind: "job", name: node.name, avatar: avatarOf(node.name), model: modelRef(node.model), thinkingLevel: root.thinkingLevel,
        status: statusOf(node.status), parent: { id: parentId, name: parentName }, thread: row.id, conversation: node.id, archived: row.archived,
        createdAt: node.createdAt ?? row.createdAt, updatedAt: row.updatedAt, preview: "", channels: this.channelsOf(id), host: this.box,
      });
    }
    return out;
  }

  agents(opts: { archived?: boolean } = {}): AgentSummary[] {
    return [...this.list.values()].filter(t => opts.archived || !t.archived).flatMap(t => this.agentsOf(t)).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  jobs(thread: string): JobNode[] {
    return this.tree(thread).map(node => ({
      id: conversationIdOf(thread, node.id), parent: node.parent === null ? null : conversationIdOf(thread, node.parent), name: node.name, depth: node.depth,
      status: statusOf(node.status), model: node.model, createdAt: node.createdAt,
    }));
  }

  /** Unread for a thread: it changed after the owner's read mark and is not working now. */
  private unread(id: ConversationId, updatedAt: number, status: RunStatus): number {
    const mark = this.store.state.reads[id];
    return status !== "working" && updatedAt > (mark?.at ?? 0) ? 1 : 0;
  }

  /**
   * A row per thread and job for the directory, search and the transcript view. A root chat no agent holds yet is `solo`; an agent's work
   * thread and every job are `job`, under the agent's DM room or their parent, so no thread sits in the sidebar beside its agent's DM.
   */
  threadConversations(): ConversationSummary[] {
    const out: ConversationSummary[] = [];
    for (const row of this.list.values()) {
      const meta = this.meta(row.id);
      const agents = this.agentsOf(row);
      const root = agents[0]!;
      const record = this.agentRecords?.ofWorkThread(row.id);
      const working = agents.filter(a => a.status === "working").map(a => ({ id: a.id, name: a.name }));
      const status = statusOf(row.status);
      const solo = !record && meta.kind !== "job";
      const parent = record ? record.room : meta.kind === "job" ? root.parent?.id : undefined;
      out.push({
        id: row.id, kind: solo ? "solo" : "job", name: row.name || "Untitled", status, archived: row.archived,
        lastActivityAt: row.updatedAt, preview: row.preview.slice(0, 200), unread: solo ? this.unread(row.id, row.updatedAt, status) : 0,
        hasNew: solo && row.updatedAt > (this.store.state.reads[row.id]?.at ?? 0), working, agent: root.id, ...(parent ? { parent } : {}),
      });
      for (const agent of agents.slice(1)) {
        out.push({
          id: agent.id, kind: "job", name: agent.name, status: agent.status, archived: row.archived, lastActivityAt: agent.updatedAt,
          preview: "", unread: 0, hasNew: false, working: agent.status === "working" ? [{ id: agent.id, name: agent.name }] : [], agent: agent.id,
          ...(agent.parent ? { parent: agent.parent.id } : {}),
        });
      }
    }
    return out;
  }

  conversations(): ConversationSummary[] {
    return [...this.roomSummaries(), ...this.threadConversations(), ...this.channelSummaries()];
  }

  /** Keeps the earliest send_message call in `entries` as the conversation's, and returns the earliest known. */
  noteSends(thread: string, conversation: number, entries: readonly EntryRecord[]): number | undefined {
    const id = conversationIdOf(thread, conversation);
    const first = earliest(this.firstSends.get(id), firstSendIn(entries.filter(e => e.conversationId === conversation)));
    if (first !== undefined) this.firstSends.set(id, first);
    return first;
  }

  /** The conversation's earliest known send_message call; with none known yet, reads its newest page, as the page the owner opens would. */
  async firstSend(thread: string, conversation: number): Promise<number | undefined> {
    const known = this.firstSends.get(conversationIdOf(thread, conversation));
    if (known !== undefined) return known;
    return this.noteSends(thread, conversation, (await this.pageBefore(thread, conversation, undefined, PAGE)).entries);
  }

  /**
   * One turn's entries, oldest first, from a settled submission: the entries after its input up to its answer, or back from its answer to
   * the input before it when the record has no input entry.
   */
  async turnOf(thread: string, conversation: number, settled: { entry?: number; answer?: number }): Promise<EntryRecord[]> {
    let entries: EntryRecord[];
    if (settled.entry !== undefined) entries = (await this.pageAfter(thread, conversation, settled.entry, 1)).entries.filter(e => !isInput(e));
    else if (settled.answer !== undefined) entries = (await this.pageBefore(thread, conversation, settled.answer + 1, 1)).entries.filter(e => !isInput(e));
    else return [];
    const turn = settled.answer === undefined ? entries : entries.filter(e => e.id <= settled.answer!);
    this.noteSends(thread, conversation, turn);
    return turn;
  }

  /**
   * What a settled turn said to people, for a channel thread or a duty report: its send_message messages, or none, when the agent talks
   * through send_message (`speaksThroughSendMessage`); otherwise, for an agent that has never called it, its answer's text as one message.
   */
  async said(thread: string, conversation: number, settled: { entry?: number; answer?: number }): Promise<{ text: string; to?: string }[]> {
    const turn = await this.turnOf(thread, conversation, settled);
    if (speaksThroughSendMessage(turn, await this.firstSend(thread, conversation))) return sentMessages(turn).map(({ text, to }) => ({ text, ...(to ? { to } : {}) }));
    const answer = settled.answer === undefined ? undefined : (await this.host.entries(thread, { conversation, before: settled.answer + 1, limit: 1 })).entries[0]?.model?.[0];
    if (answer?.role !== "assistant") return [];
    const text = typeof answer.content === "string" ? answer.content : answer.content.flatMap(b => (b.type === "text" ? [b.text] : [])).join("\n\n");
    return text.trim() ? [{ text }] : [];
  }

  context(thread: string, conversation: number, live?: LiveConversation): TimelineContext {
    const agent = this.principal(conversationIdOf(thread, conversation));
    const firstSend = this.firstSends.get(conversationIdOf(thread, conversation));
    return {
      ...(firstSend === undefined ? {} : { firstSend }),
      thread, conversation, agent, ...(agent.parent ? { parent: this.principal(agent.parent) } : {}),
      ...(this.firstEntries.has(conversationIdOf(thread, conversation)) ? { firstEntry: this.firstEntries.get(conversationIdOf(thread, conversation))! } : {}),
      principal: from => this.principal(from),
      ...(conversation === 1 ? { testSends: this.testSendsOf(thread) } : {}),
      tree: this.tree(thread),
      jobStatus: id => this.statusOfConversation(thread, id),
      running: live ? live.running : this.statusOfConversation(thread, conversation) === "working",
      ...(live ? { runningTools: live.runningTools } : {}),
    };
  }

  /** Entries before `before` (exclusive), oldest first, widened up to the input that starts the oldest turn. */
  private async pageBefore(thread: string, conversation: number, before: number | undefined, limit: number): Promise<{ entries: EntryRecord[]; more: boolean }> {
    const got = await this.host.entries(thread, { conversation, ...(before === undefined ? {} : { before }), limit });
    const entries = [...got.entries];
    let more = got.more;
    while (more && entries.length && !isInput(entries.at(-1)!) && entries.length < TURN_READ_CAP) {
      const next = await this.host.entries(thread, { conversation, before: entries.at(-1)!.id, limit: 100 });
      if (!next.entries.length) {
        more = false;
        break;
      }
      const cut = next.entries.findIndex(isInput);
      entries.push(...(cut >= 0 ? next.entries.slice(0, cut + 1) : next.entries));
      more = cut >= 0 ? next.more || cut + 1 < next.entries.length : next.more;
      if (cut >= 0) break;
    }
    return { entries: entries.reverse(), more };
  }

  /** Entries after `after` (exclusive), oldest first, stopped before the next input once `limit` is reached. */
  private async pageAfter(thread: string, conversation: number, after: number, limit: number): Promise<{ entries: EntryRecord[]; more: boolean }> {
    const entries: EntryRecord[] = [];
    let cursor = after;
    for (;;) {
      const got = await this.host.entries(thread, { conversation, after: cursor, limit: 100 });
      for (const entry of got.entries) {
        if (entries.length >= limit && isInput(entry)) return { entries, more: true };
        entries.push(entry);
      }
      if (!got.more || !got.entries.length) return { entries, more: false };
      cursor = got.entries.at(-1)!.id;
    }
  }

  /** Reads and keeps the conversation's first entry id, so `context` can name the author of a job's task. */
  async loadFirstEntry(thread: string, conversation: number): Promise<void> {
    const id = conversationIdOf(thread, conversation);
    if (this.firstEntries.has(id)) return;
    const first = (await this.host.entries(thread, { conversation, after: 0, limit: 1 })).entries[0];
    if (first) this.firstEntries.set(id, first.id);
  }

  async timeline(id: ConversationId, opts: { before?: string; after?: string; around?: string; limit?: number }): Promise<TimelinePage> {
    const { thread, conversation } = parseConversationId(id);
    await this.loadFirstEntry(thread, conversation);
    const limit = Math.min(Math.max(opts.limit ?? PAGE, 1), 200);
    const live = this.live.get(id);
    const ctx = this.context(thread, conversation, live);
    if (opts.around) {
      const target = entryOf(opts.around);
      if (target === undefined) throw new Error(`around must be an item id like e12, got ${opts.around}`);
      const older = await this.pageBefore(thread, conversation, target + 1, Math.ceil(limit / 2));
      const newer = await this.pageAfter(thread, conversation, target, Math.floor(limit / 2));
      const entries = [...older.entries, ...newer.entries];
      this.noteSends(thread, conversation, entries);
      const items = buildItems(entries, { ...this.context(thread, conversation, live), running: ctx.running && !newer.more });
      const focus = opts.around.startsWith("t") && items.some(i => i.id === opts.around) ? opts.around : itemIdFor(entries, target);
      return { items, ...(older.more && entries[0] ? { older: `e${entries[0].id}` } : {}), ...(newer.more && entries.at(-1) ? { newer: `e${entries.at(-1)!.id}` } : {}), ...(focus ? { focus } : {}) };
    }
    if (opts.after) {
      const after = entryOf(opts.after);
      if (after === undefined) throw new Error(`after must be an item id like e12, got ${opts.after}`);
      // After an input, read from the input itself, so the turn that answers it keeps the input's id; the input item is dropped below.
      const page = await this.pageAfter(thread, conversation, opts.after.startsWith("e") ? after - 1 : after, limit);
      // After a turn means after the whole turn: its own entries past the input belong to the item the page holds.
      if (opts.after.startsWith("t")) {
        const next = page.entries.findIndex(isInput);
        page.entries = next < 0 ? [] : page.entries.slice(next);
      }
      this.noteSends(thread, conversation, page.entries);
      const items = buildItems(page.entries, { ...this.context(thread, conversation, live), running: ctx.running && !page.more }).filter(item => item.id !== opts.after);
      return { items, ...(page.more && page.entries.at(-1) ? { newer: `e${page.entries.at(-1)!.id}` } : {}) };
    }
    const before = entryOf(opts.before);
    const page = await this.pageBefore(thread, conversation, before, limit);
    this.noteSends(thread, conversation, page.entries);
    const items = buildItems(page.entries, { ...this.context(thread, conversation, live), ...(before === undefined ? {} : { running: false }) });
    return { items, ...(page.more && page.entries[0] ? { older: `e${page.entries[0].id}` } : {}) };
  }

  // Live side

  async watch(id: ConversationId): Promise<{ items: Item[]; partial: LivePartial | null; status: RunStatus }> {
    let live = this.live.get(id);
    if (!live) {
      const { thread, conversation } = parseConversationId(id);
      const created: LiveConversation = {
        thread, conversation, recent: [], running: this.statusOfConversation(thread, conversation) === "working", runningTools: new Set(), partial: null, watchers: 0,
        ready: Promise.resolve(),
      };
      created.ready = this.attach(id, created);
      this.live.set(id, created);
      live = created;
    }
    live.watchers += 1;
    await live.ready;
    return { items: buildItems(live.recent, this.context(live.thread, live.conversation, live)), partial: live.partial, status: live.running ? "working" : this.statusOfConversation(live.thread, live.conversation) };
  }

  async unwatch(id: ConversationId): Promise<void> {
    const live = this.live.get(id);
    if (!live) return;
    live.watchers -= 1;
    if (live.watchers > 0) return;
    this.live.delete(id);
    await live.stop?.().catch(() => undefined);
  }

  private async attach(id: ConversationId, live: LiveConversation): Promise<void> {
    await this.loadFirstEntry(live.thread, live.conversation);
    const tail = await this.host.entries(live.thread, { conversation: live.conversation, limit: 1 });
    const newest = tail.entries[0]?.id;
    if (newest !== undefined) {
      // A page, not only the newest turn, so a live quiet turn of a conversation that talks through send_message reads as one.
      const page = await this.pageBefore(live.thread, live.conversation, newest + 1, this.firstSends.has(id) ? 1 : PAGE);
      this.noteSends(live.thread, live.conversation, page.entries);
      const start = page.entries.findLastIndex(isInput);
      live.recent = start >= 0 ? page.entries.slice(start) : page.entries;
    }
    live.stop = await this.host.watch(live.thread, { conversation: live.conversation, ...(newest === undefined ? {} : { fromEntry: newest }) }, event => this.onEvent(id, live, event));
  }

  private onEvent(id: ConversationId, live: LiveConversation, event: DurableEvent): void {
    if (event.type === "doc") {
      this.onDoc(live.thread, event.name, event.value);
      return;
    }
    if (event.type === "status") {
      if (live.conversation === 1) {
        const status = statusOf(event.status);
        const running = status === "working";
        if (running !== live.running) {
          live.running = running;
          this.emitItems(id, live);
        }
        this.events.status(id, status);
      }
      return;
    }
    if (event.type !== "events" || event.conversation !== live.conversation) return;
    // No streaming: partial text, thinking and tool calls never go to the page. Items go out when an input, an answer with text or a
    // send_message call lands, and when a run starts (an empty live turn, drawn as typing dots) or ends; the rest of a turn shows with its
    // next item.
    let changed = false;
    for (const agentEvent of event.events as AgentEvent[]) {
      switch (agentEvent.type) {
        case "run_start":
          if (!live.running) {
            live.running = true;
            changed = true;
            this.events.status(id, "working");
          }
          break;
        case "run_end":
          live.running = false;
          live.runningTools.clear();
          changed = true;
          this.events.status(id, this.statusOfConversation(live.thread, live.conversation) === "sleeping" ? "sleeping" : "idle");
          break;
        case "message_end":
        case "entry_appended":
          if (this.addEntry(live, agentEvent.entry) && shows(agentEvent.entry)) changed = true;
          break;
        case "tool_execution_start":
          live.runningTools.add(agentEvent.toolCallId);
          break;
        case "tool_execution_end":
          live.runningTools.delete(agentEvent.toolCallId);
          this.addEntry(live, agentEvent.entry);
          break;
        default:
          break;
      }
    }
    if (changed) this.emitItems(id, live);
  }

  private addEntry(live: LiveConversation, entry: EntryRecord | undefined): boolean {
    if (!entry || entry.conversationId !== live.conversation || live.recent.some(e => e.id === entry.id)) return false;
    if (isInput(entry) && live.recent.length && !live.running) live.recent = [];
    live.recent.push(entry);
    this.noteSends(live.thread, live.conversation, [entry]);
    live.recent.sort((a, b) => a.id - b.id);
    if (live.recent.length > TURN_READ_CAP) live.recent = live.recent.slice(-TURN_READ_CAP);
    return true;
  }

  private emitItems(id: ConversationId, live: LiveConversation): void {
    this.events.items(id, buildItems(live.recent, this.context(live.thread, live.conversation, live)));
  }
}

/** An entry the page sees at once: an input, an answer with text, or a tell_owner or send_message call, whose message shows the moment it is sent. */
export function shows(entry: EntryRecord): boolean {
  if (isInput(entry)) return true;
  const message = entry.model?.[0];
  if (message?.role !== "assistant") return false;
  return typeof message.content === "string"
    ? !!message.content.trim()
    : message.content.some(b => (b.type === "text" && b.text.trim()) || speaks(b));
}
