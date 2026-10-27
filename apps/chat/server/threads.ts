/**
 * Threads, jobs and agents as the pages see them, built from pi-host's thread list and trees, and the live side: one host watch per
 * conversation a page has open, turned into item upserts, partial text and status.
 */
import type {
  AgentId, AgentSummary, ConversationId, ConversationSummary, Item, JobNode, LivePartial, ModelRef, Principal, RunStatus, ThinkingLevel, TimelinePage,
} from "../web/src/lib/api/types.ts";
import type { AgentEvent, DurableEvent, DurableThread, EntryRecord, Host, TreeNode } from "./host/types.ts";
import type { Store } from "./store.ts";
import { buildItems, entryOf, isInput, itemIdFor, turnKey, type TimelineContext } from "./timeline.ts";

export const OWNER: Principal = { id: "owner", kind: "owner", name: "You", avatar: { initials: "Me", hue: 210 } };

export function avatarOf(name: string): Principal["avatar"] {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  const initials = ((words[0]?.[0] ?? "?") + (words[1]?.[0] ?? words[0]?.[1] ?? "")).toUpperCase();
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return { initials, hue: hash % 360 };
}

const MODEL_LABELS: Record<string, string> = { "claude-opus-5-5": "Opus 5.5", "claude-sonnet-5": "Sonnet 5", "gpt-5.5": "GPT-5.5" };
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
  partial: LivePartial | null;
  partialTimer?: NodeJS.Timeout;
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

export class Threads {
  private list = new Map<string, DurableThread>();
  private trees = new Map<string, { updatedAt: number; nodes: TreeNode[] }>();
  private agentCache = new Map<AgentId, string>();
  private convCache = new Map<ConversationId, string>();
  private readonly live = new Map<ConversationId, LiveConversation>();
  private timer?: NodeJS.Timeout;
  /** Extra summaries the channel layer adds (channels), merged into conversations(). */
  channelSummaries: () => ConversationSummary[] = () => [];
  /** Channels each agent is in. */
  channelsOf: (agent: AgentId) => string[] = () => [];
  /** A `doc` event from a watched thread, such as the chat writing `chat.board`. */
  onDoc: (thread: string, name: string, value: unknown) => void = () => {};

  constructor(readonly host: Host, readonly store: Store, readonly events: ThreadEvents, readonly box: string, private readonly log: (line: string) => void = () => {}) {}

  async start(pollMs = 2000): Promise<void> {
    await this.refresh().catch(error => this.log(`first thread read failed: ${String(error)}`));
    this.timer = setInterval(() => void this.refresh().catch(error => this.log(`thread refresh failed: ${String(error)}`)), pollMs);
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
    const byName = this.agents({ archived: true }).find(a => a.name === id);
    if (byName) return this.principal(byName.id);
    return { id, kind: "job", name: id, avatar: avatarOf(id) };
  }

  agent(id: AgentId): AgentSummary | undefined {
    const { thread, conversation } = parseConversationId(id);
    const row = this.list.get(thread);
    if (!row) return undefined;
    return this.agentsOf(row).find(a => a.conversation === conversation);
  }

  private agentsOf(row: DurableThread): AgentSummary[] {
    const meta = this.meta(row.id);
    const rootModel = modelRef(`${row.provider}/${row.modelId}`);
    const root: AgentSummary = {
      id: row.id, kind: meta.kind, name: row.name || "Untitled", avatar: avatarOf(row.name || row.id), model: rootModel,
      thinkingLevel: (row.thinkingLevel as ThinkingLevel) ?? null, status: statusOf(row.status),
      parent: meta.parent ? { id: meta.parent, name: this.list.get(parseConversationId(meta.parent).thread)?.name ?? meta.parent } : null,
      thread: row.id, conversation: 1, archived: row.archived, createdAt: row.createdAt, updatedAt: row.updatedAt,
      preview: row.preview.split("\n").find(line => line.trim()) ?? "", channels: this.channelsOf(row.id), host: this.box,
    };
    const out = [root];
    for (const node of this.tree(row.id)) {
      if (node.parent === null) continue;
      const id = conversationIdOf(row.id, node.id);
      const parentId = conversationIdOf(row.id, node.parent);
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

  threadConversations(): ConversationSummary[] {
    const out: ConversationSummary[] = [];
    const dms = new Set(this.store.state.dms);
    for (const row of this.list.values()) {
      const meta = this.meta(row.id);
      const agents = this.agentsOf(row);
      const working = agents.filter(a => a.status === "working").map(a => ({ id: a.id, name: a.name }));
      const status = statusOf(row.status);
      out.push({
        id: row.id, kind: meta.kind === "job" || dms.has(row.id) ? "dm" : "solo", name: row.name || "Untitled", status, archived: row.archived,
        lastActivityAt: row.updatedAt, preview: row.preview.slice(0, 200), unread: this.unread(row.id, row.updatedAt, status),
        hasNew: row.updatedAt > (this.store.state.reads[row.id]?.at ?? 0), working, agent: row.id,
      });
      for (const agent of agents.slice(1)) {
        out.push({
          id: agent.id, kind: dms.has(agent.id) ? "dm" : "job", name: agent.name, status: agent.status, archived: row.archived, lastActivityAt: agent.updatedAt,
          preview: "", unread: 0, hasNew: false, working: agent.status === "working" ? [{ id: agent.id, name: agent.name }] : [], agent: agent.id,
          ...(agent.parent ? { parent: agent.parent.id } : {}),
        });
      }
    }
    return out;
  }

  conversations(): ConversationSummary[] {
    return [...this.threadConversations(), ...this.channelSummaries()];
  }

  context(thread: string, conversation: number, live?: LiveConversation): TimelineContext {
    const agent = this.principal(conversationIdOf(thread, conversation));
    return {
      thread, conversation, agent, ...(agent.parent ? { parent: this.principal(agent.parent) } : {}),
      principal: from => this.principal(from),
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

  async timeline(id: ConversationId, opts: { before?: string; after?: string; around?: string; limit?: number }): Promise<TimelinePage> {
    const { thread, conversation } = parseConversationId(id);
    const limit = Math.min(Math.max(opts.limit ?? PAGE, 1), 200);
    const live = this.live.get(id);
    const ctx = this.context(thread, conversation, live);
    if (opts.around) {
      const target = entryOf(opts.around);
      if (target === undefined) throw new Error(`around must be an item id like e12, got ${opts.around}`);
      const older = await this.pageBefore(thread, conversation, target + 1, Math.ceil(limit / 2));
      const newer = await this.pageAfter(thread, conversation, target, Math.floor(limit / 2));
      const entries = [...older.entries, ...newer.entries];
      const items = buildItems(entries, { ...ctx, running: ctx.running && !newer.more, fromStart: !older.more });
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
      const items = buildItems(page.entries, { ...ctx, running: ctx.running && !page.more }).filter(item => item.id !== opts.after);
      return { items, ...(page.more && page.entries.at(-1) ? { newer: `e${page.entries.at(-1)!.id}` } : {}) };
    }
    const before = entryOf(opts.before);
    const page = await this.pageBefore(thread, conversation, before, limit);
    const items = buildItems(page.entries, { ...ctx, ...(before === undefined ? {} : { running: false }), fromStart: !page.more });
    return { items, ...(page.more && page.entries[0] ? { older: `e${page.entries[0].id}` } : {}) };
  }

  /** The item id that holds an entry, for a search hit. */
  async itemIdOf(thread: string, conversation: number, entryId: number): Promise<string> {
    const page = await this.pageBefore(thread, conversation, entryId + 1, 1);
    return itemIdFor(page.entries, entryId) ?? `e${entryId}`;
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
    clearTimeout(live.partialTimer);
    await live.stop?.().catch(() => undefined);
  }

  private async attach(id: ConversationId, live: LiveConversation): Promise<void> {
    const tail = await this.host.entries(live.thread, { conversation: live.conversation, limit: 1 });
    const newest = tail.entries[0]?.id;
    if (newest !== undefined) {
      const page = await this.pageBefore(live.thread, live.conversation, newest + 1, 1);
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
    let changed = false;
    for (const agentEvent of event.events as AgentEvent[]) {
      switch (agentEvent.type) {
        case "snapshot": {
          const message = agentEvent.generation?.message;
          if (message) this.setPartial(id, live, partialOf(live, message));
          break;
        }
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
          this.setPartial(id, live, null);
          changed = true;
          this.events.status(id, this.statusOfConversation(live.thread, live.conversation) === "sleeping" ? "sleeping" : "idle");
          break;
        case "message_start":
          if (agentEvent.message.role === "assistant") this.setPartial(id, live, partialOf(live, agentEvent.message));
          break;
        case "message_update":
          for (const change of agentEvent.changes) {
            const partial = live.partial ?? { itemId: currentTurnId(live), text: "", thinking: "" };
            if (change.type === "text_delta") partial.text += (change as { delta?: string }).delta ?? "";
            else if (change.type === "thinking_delta") partial.thinking += (change as { delta?: string }).delta ?? "";
            else if (change.type === "toolcall_start") partial.tool = ((change as { block?: { name?: string } }).block?.name) ?? partial.tool;
            else if (change.type === "message") Object.assign(partial, partialOf(live, (change as unknown as { message: { content: unknown } }).message));
            this.setPartial(id, live, partial, true);
          }
          break;
        case "message_end":
        case "entry_appended":
          if (this.addEntry(live, agentEvent.entry)) changed = true;
          if (agentEvent.type === "message_end") this.setPartial(id, live, null);
          break;
        case "tool_execution_start":
          live.runningTools.add(agentEvent.toolCallId);
          changed = true;
          break;
        case "tool_execution_end":
          live.runningTools.delete(agentEvent.toolCallId);
          if (agentEvent.entry) this.addEntry(live, agentEvent.entry);
          changed = true;
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
    live.recent.sort((a, b) => a.id - b.id);
    if (live.recent.length > TURN_READ_CAP) live.recent = live.recent.slice(-TURN_READ_CAP);
    return true;
  }

  private emitItems(id: ConversationId, live: LiveConversation): void {
    this.events.items(id, buildItems(live.recent, this.context(live.thread, live.conversation, live)));
  }

  private setPartial(id: ConversationId, live: LiveConversation, partial: LivePartial | null, throttle = false): void {
    live.partial = partial;
    if (!throttle) {
      clearTimeout(live.partialTimer);
      live.partialTimer = undefined;
      this.events.partial(id, partial ? { ...partial } : null);
      return;
    }
    live.partialTimer ??= setTimeout(() => {
      live.partialTimer = undefined;
      this.events.partial(id, live.partial ? { ...live.partial } : null);
    }, 80);
  }
}

function currentTurnId(live: LiveConversation): string {
  const input = live.recent.find(isInput);
  return turnKey(input?.id ?? live.recent[0]?.id ?? 0);
}

function partialOf(live: LiveConversation, message: { content: unknown }): LivePartial {
  const blocks = Array.isArray(message.content) ? (message.content as { type: string; text?: string; thinking?: string; name?: string }[]) : [];
  return {
    itemId: currentTurnId(live),
    text: blocks.filter(b => b.type === "text").map(b => b.text ?? "").join(""),
    thinking: blocks.filter(b => b.type === "thinking").map(b => b.thinking ?? "").join(""),
    ...(blocks.some(b => b.type === "toolCall") ? { tool: blocks.findLast(b => b.type === "toolCall")?.name ?? "" } : {}),
  };
}
