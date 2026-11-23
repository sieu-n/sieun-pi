/**
 * Threads, jobs and agents as the pages see them, built from pi-host's thread list and trees, and the live side: one host watch per
 * conversation a page has open, turned into item upserts and status. Nothing streams: a turn shows as each entry with text or a
 * send_message call lands.
 */
import type {
  AgentId, AgentSummary, ConversationId, ConversationSummary, Item, JobNode, ModelRef, Principal, RunStatus, ThinkingLevel, TimelinePage,
} from "../web/src/lib/api/types.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import type { AgentEvent, CreateOptions, DurableEvent, DurableThread, EntriesQuery, EntryRecord, Host, TreeNode } from "./host/types.ts";
import type { Store } from "./store.ts";
import type { AgentRecord } from "./agent-store.ts";
import { agentSummary, isAgentId, isRoomId, rootRetrying, type AgentRows, type Agents } from "./agents.ts";
import { TailCache } from "./tail-cache.ts";
import { buildItems, earliest, entryOf, firstSendIn, isInput, openSendIn, itemIdFor, sentMessages, speaks, speaksThroughSendMessage, stepOutputOf, type TimelineContext } from "./timeline.ts";

export const OWNER: Principal = { id: "owner", kind: "owner", name: "You", avatar: { initials: "Me", hue: 210 } };

export function avatarOf(name: string): Principal["avatar"] {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  const initials = ((words[0]?.[0] ?? "?") + (words[1]?.[0] ?? words[0]?.[1] ?? "")).toUpperCase();
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return { initials, hue: hash % 360 };
}

const MODEL_LABELS: Record<string, string> = {
  "claude-opus-5-5": "Opus 5.5", "claude-sonnet-5-5": "Sonnet 5.5", "claude-fable-5-2": "Fable 5.2", "claude-fable-5-1": "Fable 5.1", "gpt-6.1-sol": "GPT-6.1 sol", "gpt-6-luna": "GPT-6 luna",
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
/** How many entries one widening read asks for, past the page, to reach the input that starts the page's oldest turn. */
const WIDEN = 100;

const FIRST_SENDS_CACHE = "first-sends";
/**
 * Version 2 counts only a speaking call that went out (timeline.ts `firstSendIn`). A version 1 scan that found a call may have found one that
 * failed, so it is read again; one that found none still holds.
 */
const FIRST_SENDS_VERSION = 2;
type FirstSendsCache = { v: typeof FIRST_SENDS_VERSION; scans: Record<string, FirstSendScan> };
/** How many entries one read of a scan for a conversation's earliest speaking call asks for, the most one timeline page reads. */
const SCAN_READ = 200;
/**
 * What a scan knows of one conversation's earliest speaking call: every entry up to `to` was read, and `first` is the earliest call among
 * them, which no later read can move. Before it, a page drew its turns by the earliest call any read had seen so far, so a read of an older
 * page could turn a later page's bubbles into private notes: on 11-22 at 05:35 UTC six turns of the agent factory's work thread and one of
 * vent's lost their text between two reads of the same page, and each open of a page kept before that waited a round trip for the change
 * (work/p157-opens/kept-follow.mjs).
 */
type FirstSendScan = { to: number; first?: number };

interface LiveConversation {
  thread: string;
  conversation: number;
  /** Entries from the newest input on, oldest first. */
  recent: EntryRecord[];
  running: boolean;
  /** pi-host's newest status event: "sleeping" while the run waits for a working slot or an account, which no run event says. */
  hostStatus?: RunStatus;
  runningTools: Set<string>;
  stop?: () => Promise<void>;
  watchers: number;
  ready: Promise<void>;
}

/** What `Threads.change` sends a thread's host without waiting for it: every field of `Host.set` but the folder, which the host checks. */
export interface ThreadChange { name?: string; model?: string; thinkingLevel?: string; archived?: boolean }

export interface ThreadEvents {
  /** Registered agents only. */
  agents(changed: AgentSummary[], removed: AgentId[]): void;
  /** Jobs that work for a registered agent (`jobList`). */
  jobList(changed: AgentSummary[], removed: AgentId[]): void;
  conversations(changed: ConversationSummary[]): void;
  items(conversation: ConversationId, items: Item[]): void;
  status(conversation: ConversationId, status: RunStatus): void;
  jobs(thread: string, jobs: JobNode[]): void;
}

/**
 * Where one timeline read's handler time went, for its request log line: `calls` pi-host entries reads that took `host` ms and brought
 * `entries` entries, and which page it asked for (`newest`, `before`, `after` or `around`). The line's `run` less `host` is the drawing.
 */
export type ItemsSplit = Record<string, number>;
const itemsSplit = new AsyncLocalStorage<ItemsSplit>();

const THREADS_CACHE = "threads";
/** Lets the calls waiting on the event loop run, such as a search whose Meilisearch answer came in. */
const yieldLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
type ThreadsCache = { threads: DurableThread[]; trees: [string, { updatedAt: number; nodes: TreeNode[] }][] };

export class Threads {
  private list = new Map<string, DurableThread>();
  /** The rows `put` holds until a list read as new as each comes back. */
  private readonly fresh = new Map<string, DurableThread>();
  /** Each thread's last change sent to its host, which its next change waits for. */
  private readonly changing = new Map<string, Promise<void>>();
  private trees = new Map<string, { updatedAt: number; nodes: TreeNode[] }>();
  private agentCache = new Map<AgentId, string>();
  /** Agent and thread ids by name, for `principal`; refresh drops it. */
  private names?: Map<string, AgentId>;
  /** `rootChats` under the store versions it read; a change to the list drops it. */
  private roots?: { key: string; threads: string[] };
  /** Each thread's summaries (`agentsOf`) with the row they were built from, under `summariesKey`, the store versions they read. */
  private readonly summaries = new Map<string, { row: DurableThread; out: AgentSummary[] }>();
  private summariesKey = "";
  private jobCache = new Map<AgentId, string>();
  /** Each job's time and the run status, name and retry note it was taken at, by conversation id (`jobTime`). */
  private readonly jobTimes = new Map<ConversationId, { seen: string; at: number }>();
  private convCache = new Map<ConversationId, string>();
  private readonly live = new Map<ConversationId, LiveConversation>();
  /** Each conversation's first entry id, which never changes once it exists. */
  private readonly firstEntries = new Map<ConversationId, number>();
  /**
   * The earliest send_message call seen in each conversation, from every page and live entry read: a page of a conversation that talks
   * through send_message reads that way even when the page itself holds no call, such as a run of quiet turns.
   */
  private readonly firstSends = new Map<ConversationId, number>();
  /** Each conversation's scan for its earliest speaking call (`settleFirstSend`), kept in the cache across restarts. */
  private readonly scans: Map<ConversationId, FirstSendScan>;
  private readonly scanning = new Set<ConversationId>();
  /** The scans run one at a time, so a release that reads many conversations at once starts no burst of history reads on pi-host. */
  private scanQueue: Promise<void> = Promise.resolve();
  private readonly tails: TailCache;
  private timer?: NodeJS.Timeout;
  /** The channels and Solo rooms (group-rooms.ts), merged into conversations(). */
  groupSummaries: () => ConversationSummary[] = () => [];
  /** The agents' DM rooms (rooms.ts), merged into conversations(). */
  roomSummaries: () => ConversationSummary[] = () => [];
  /** The channels and Solo rooms each agent is a member of, by agent id. */
  roomsOf: (agent: AgentId) => string[] = () => [];
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
  /** Thread creates in flight (`create`); a thread list read meanwhile holds back each thread it has not listed before. */
  private creating = 0;

  constructor(readonly host: Host, readonly store: Store, readonly events: ThreadEvents, readonly box: string, private readonly log: (line: string) => void = () => {}) {
    const cache = store.cache<ThreadsCache>(THREADS_CACHE, { threads: [], trees: [] });
    this.list = new Map(cache.threads.map(t => [t.id, t]));
    this.trees = new Map(cache.trees);
    this.cached = JSON.stringify(cache);
    this.tails = new TailCache({ entries: (thread, query) => this.entries(thread, query) }, 64, TURN_READ_CAP + 200 + WIDEN, join(store.dir, "cache", "tails"));
    this.scans = new Map(firstSendScans(store.cache<FirstSendsCache | Record<string, FirstSendScan>>(FIRST_SENDS_CACHE, {})));
    for (const [id, scan] of this.scans) if (scan.first !== undefined) this.firstSends.set(id, scan.first);
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
  poll(): Promise<void> {
    this.refreshing ??= this.refresh()
      .catch(error => this.log(`thread refresh failed: ${String(error)}`))
      .finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    for (const live of this.live.values()) await live.stop?.().catch(() => undefined);
    this.saveListCache();
    this.tails.stop();
  }

  /**
   * Saves the thread list the next server starts on (`start`), with every thread this one knows, one made since the last list read too.
   * The cache held only what the last read listed: on 11-22 a hand-over came 3 s after the Agent memory duty made 12 test agents, the new
   * server served a cache without them, and the duty's 12 sends got 404 "No thread" (~/work/agent-memory/d3-hand-2611220900.json).
   */
  private saveListCache(): void {
    const cache = JSON.stringify({ threads: [...this.list.values()], trees: [...this.trees] } satisfies ThreadsCache);
    if (cache === this.cached) return;
    this.cached = cache;
    this.store.saveCache(THREADS_CACHE, JSON.parse(cache));
  }

  /**
   * Makes a thread and runs `claim` on it (its agent record, alias, job meta or comm thread) before any thread list read lists it. A read
   * during the create listed the new thread as a root chat no agent holds, so on 11-03 a walk's test DM and channel comm threads went to
   * the owner's page as Solo rows.
   */
  async create(opts: CreateOptions, claim: (thread: DurableThread) => void = () => {}): Promise<DurableThread> {
    this.creating += 1;
    try {
      const thread = await this.host.create(opts);
      claim(thread);
      return thread;
    } finally {
      this.creating -= 1;
    }
  }

  /**
   * A row pi-host answered a create or a change with, in the list at once, and the next poll sends what changed. A change used to wait for a
   * whole thread list read: on 11-21 the owner's model change on his agent's DM took 590 to 1830 ms in the handler, since the read lists 979
   * threads (467 KB from the box's pi-host, 50 to 530 ms) and waits for the Mac's relay as well. The row stays over any list read older than it.
   */
  put(row: DurableThread): void {
    this.fresh.set(row.id, row);
    this.list.set(row.id, row);
    this.names = undefined;
    this.roots = undefined;
    this.agentRecords?.follow(this.list);
    void this.poll();
  }

  /**
   * A change of a thread's name, model, thinking level or archive, shown at once and sent to its host behind the thread's earlier changes.
   * With the list's own read out of the way, the owner's change on a test agent's DM still took 17 to 1179 ms on 11-21 at a box load of 121,
   * all of it pi-host's answer to durable_set, so the answer no longer waits for it. If the host refuses, the list reads the thread as it
   * stands again and the pages follow. Answers false for a thread the list does not hold.
   */
  change(thread: string, set: ThreadChange): boolean {
    const row = this.list.get(thread);
    if (!row) return false;
    const [provider, ...model] = set.model?.split("/") ?? [];
    this.put({
      ...row, ...(set.name !== undefined ? { name: set.name } : {}), ...(set.archived !== undefined ? { archived: set.archived } : {}),
      ...(set.thinkingLevel !== undefined ? { thinkingLevel: set.thinkingLevel } : {}), ...(provider ? { provider, modelId: model.join("/") } : {}),
      updatedAt: Math.max(Date.now(), row.updatedAt + 1),
    });
    const sent: Promise<void> = (this.changing.get(thread) ?? Promise.resolve()).then(() => this.host.set(thread, set)).then(
      // The answer to an earlier change would show the thread without the later ones until they land.
      answered => { if (this.changing.get(thread) === sent) this.put(answered); },
      error => {
        this.log(`change of ${thread} (${JSON.stringify(set)}) failed, so the list reads it again: ${String(error)}`);
        this.fresh.delete(thread);
        void this.poll();
      },
    );
    this.changing.set(thread, sent);
    void sent.finally(() => { if (this.changing.get(thread) === sent) this.changing.delete(thread); });
    return true;
  }

  /** Reads the thread list, and the tree of every thread whose file changed, and sends what changed. */
  async refresh(): Promise<void> {
    // A box link that went up or down reads in hostState before the list does.
    this.summaries.clear();
    const known = new Set(this.list.keys());
    const read = await this.host.threads();
    // A thread new to this read may be one a create in flight has not claimed yet; the next read lists it.
    const listed = this.creating ? read.filter(t => this.list.has(t.id)) : read;
    for (const thread of listed) {
      const tree = this.trees.get(thread.id);
      // A retrying run sleeps between attempts and writes no newer row, so its tree is read again while the row carries pi-host's flag.
      // A job run that ends with no root entry leaves the row's updatedAt as it was, so a tree kept with a running job is read again: on
      // 11-24 a removed job, "thread open walk" (28350de8:73), read working 89 h after its run ended.
      if (thread.children > 0 && (!tree || tree.updatedAt !== thread.updatedAt || thread.status === "running" || thread.retrying !== undefined
        || tree.nodes.some(n => n.retrying || n.status === "running"))) {
        const nodes = await this.host.tree(thread.id).catch(() => tree?.nodes ?? []);
        const before = JSON.stringify(tree?.nodes ?? []);
        this.trees.set(thread.id, { updatedAt: thread.updatedAt, nodes });
        this.summaries.delete(thread.id);
        if (JSON.stringify(nodes) !== before) this.events.jobs(thread.id, this.jobs(thread.id));
      }
    }
    // A row `put` while this read ran is newer than the read's, so it stays, as does a change the host has not answered yet.
    const threads = listed.map(t => {
      const known = this.fresh.get(t.id);
      if (!known) return t;
      if (this.changing.has(t.id) || known.updatedAt > t.updatedAt) return known;
      this.fresh.delete(t.id);
      return t;
    });
    const next = new Map(threads.map(t => [t.id, t]));
    // A thread `put` while this read ran is one the read began too early to list. On 11-22 such reads dropped 6 of 8 agents the Agent memory
    // duty made at once, and each send to them right after answered 404.
    for (const [id, row] of this.list) if (!known.has(id) && !next.has(id)) next.set(id, row);
    this.list = next;
    this.names = undefined;
    this.roots = undefined;
    this.summaries.clear();
    this.agentRecords?.dropUntitled(next);
    this.agentRecords?.follow(next);
    await this.agentRecords?.fileSpawned(next);
    this.saveListCache();
    // Each part below builds or compares every thread's summaries, and run back to back they held the event loop 130 to 200 ms on 11-23 with
    // 2,091 threads, so a ⌘K search that came then waited for all of it; a yield between parts lets waiting calls run.
    await yieldLoop();
    const agents = diff(this.agentCache, this.agents({ archived: true }));
    this.agentCache = agents.cache;
    if (agents.changed.length || agents.removed.length) this.events.agents(agents.changed, agents.removed);
    await yieldLoop();
    const jobs = diff(this.jobCache, this.jobList({ archived: true }));
    this.jobCache = jobs.cache;
    if (jobs.changed.length || jobs.removed.length) this.events.jobList(jobs.changed, jobs.removed);
    await yieldLoop();
    const conversations = this.threadConversations();
    const convChanged = conversations.filter(c => this.convCache.get(c.id) !== JSON.stringify(c));
    const convNext = new Map(conversations.map(c => [c.id, JSON.stringify(c)]));
    const convGone = [...this.convCache.keys()].some(id => !convNext.has(id));
    this.convCache = convNext;
    // A row that leaves the list (a thread an agent claimed) sends the sidebar again too.
    if (convChanged.length || convGone) this.events.conversations(convChanged);
    for (const live of this.live.values()) {
      const status = this.statusOfConversation(live.thread, live.conversation);
      if ((status === "working") !== live.running && !live.recent.length) {
        live.running = status === "working";
        this.events.status(conversationIdOf(live.thread, live.conversation), status);
      }
    }
    await yieldLoop();
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

  /** Whether the owner archived a job inside `thread`, or a job it runs under, so archiving a job takes the jobs it started with it. */
  jobArchived(thread: string, conversation: number): boolean {
    const archived = this.store.state.archivedJobs;
    if (!archived) return false;
    const nodes = this.tree(thread);
    for (let at: number | null | undefined = conversation; at && at !== 1; at = nodes.find(n => n.id === at)?.parent) {
      if (archived[conversationIdOf(thread, at)] !== undefined) return true;
    }
    return false;
  }

  /** Archives or restores a job inside a thread; a root thread's archive is pi-host's. */
  setJobArchived(thread: string, conversation: number, archived: boolean): void {
    const id = conversationIdOf(thread, conversation);
    const all = (this.store.state.archivedJobs ??= {});
    if (archived === (all[id] !== undefined)) return;
    if (archived) all[id] = Date.now();
    else delete all[id];
    this.store.saveState();
  }

  statusOfConversation(thread: string, conversation: number): RunStatus {
    const row = this.list.get(thread);
    if (!row) return "idle";
    if (conversation === 1) return statusOf(row.status);
    const node = this.tree(thread).find(n => n.id === conversation);
    return node ? statusOf(node.status) : "idle";
  }

  /**
   * A conversation's run status, where a watched one's live run and pi-host's newest status event win over the list's row. The list reads
   * every 2 s, so a run that starts and ends between two reads never shows in it, and a read that began before the run ended still lists it
   * running. A run that waits for a working slot or an account is sleeping, from pi-host's status event only.
   */
  runStatus(thread: string, conversation: number): RunStatus {
    const listed = this.statusOfConversation(thread, conversation);
    const live = this.live.get(conversationIdOf(thread, conversation));
    if (!live) return listed;
    if (live.running) return "working";
    if (live.hostStatus && live.hostStatus !== "working") return live.hostStatus;
    return listed === "working" ? "idle" : listed;
  }

  /** Who an id or a name is. A name finds a registered agent before any job or thread of the same name. */
  principal(id: string): Principal {
    if (id === "owner") return OWNER;
    const agent = this.agent(id);
    if (agent) return { id: agent.id, kind: agent.kind, name: agent.name, avatar: agent.avatar, ...(agent.parent ? { parent: agent.parent.id } : {}) };
    const record = this.agentRecords?.record(id);
    if (record) return { id: record.id, kind: "chat", name: record.name, avatar: avatarOf(record.name) };
    const byName = this.idByName(id);
    if (byName) return this.principal(byName);
    return { id, kind: "job", name: id, avatar: avatarOf(id) };
  }

  /**
   * The id a name finds, a registered agent's before any thread's or job's, from an index built once per thread list read: a solo thread's
   * page names its board's sender ("board") on dozens of inputs, and a scan of every thread and job for each took 300 ms on 11-03.
   */
  private idByName(name: string): AgentId | undefined {
    if (!this.names) {
      this.names = new Map();
      for (const agent of [...this.agents({ archived: true }), ...this.allSummaries({ archived: true })]) if (!this.names.has(agent.name)) this.names.set(agent.name, agent.id);
    }
    return this.names.get(name);
  }

  /**
   * The registered agent a mention or a channel member names: an agent id, its DM room id, its work thread id or its name. A job, a root
   * job thread, a thread no agent holds and a name only a job has name none, so nothing is delivered to them.
   */
  registered(id: string): AgentRecord | undefined {
    const records = this.agentRecords;
    if (!records) return undefined;
    if (isAgentId(id) || isRoomId(id)) return records.record(id);
    return records.ofWorkThread(id) ?? records.list().find(r => (this.list.get(r.workThread)?.name || r.name) === id);
  }

  /**
   * An agent (`ag_<slug>`, or its DM room `dm_<slug>`), a job (`<thread>:<n>`, or a root job thread), or a root chat no agent holds yet. A
   * work thread's id answers its agent.
   */
  agent(id: AgentId): AgentSummary | undefined {
    const comm = this.agentRecords?.ofComm(id);
    if (comm) return this.agent(comm.record.id);
    if (isAgentId(id) || isRoomId(id)) {
      const record = this.agentRecords?.record(id);
      const row = record && this.list.get(record.workThread);
      if (!record) return undefined;
      return row ? this.agentsOf(row)[0] : agentSummary(record, { tree: [], jobs: [], comm: this.commRows(record) }, { model: null, rooms: this.roomsOf(record.id), hostState: this.agentRecords?.hostState(record.host) });
    }
    const { thread, conversation } = parseConversationId(id);
    const row = this.list.get(thread);
    if (!row) return undefined;
    return this.agentsOf(row).find(a => a.conversation === conversation);
  }

  /** The pi-host conversation an id names: the work thread of an agent, its DM room or one of its comm threads, and any other id as it is. */
  conversationOf(id: string): ConversationId {
    const comm = this.agentRecords?.ofComm(id);
    if (comm) return comm.record.workThread;
    return (isAgentId(id) || isRoomId(id)) ? this.agentRecords?.record(id)?.workThread ?? id : id;
  }

  private commRows(record: AgentRecord): NonNullable<AgentRows["comm"]> {
    return Object.entries(record.comm ?? {}).map(([room, thread]) => ({ room, thread, ...(this.list.has(thread) ? { row: this.list.get(thread)! } : {}) }));
  }

  /** Whether the thread is an agent's comm thread, which no list shows (phase 4). */
  private isComm(thread: string): boolean {
    return this.agentRecords?.isComm(thread) ?? false;
  }

  /**
   * The registered agent a thread works for: its own record when it is a work thread, the record it is aliased to, or for a root job thread
   * the agent its kind's parent names.
   */
  private ownerOf(row: DurableThread): AgentRecord | undefined {
    const records = this.agentRecords;
    if (!records) return undefined;
    const direct = records.ofWorkThread(row.id) ?? records.record(row.id);
    if (direct) return direct;
    const meta = this.meta(row.id);
    if (meta.kind !== "job" || !meta.parent) return undefined;
    return records.record(meta.parent) ?? records.record(parseConversationId(meta.parent).thread);
  }

  /** The agent a root job thread belongs to, from its kind's parent, through the agent's aliases. */
  private parentOf(meta: { parent?: AgentId }): { id: AgentId; name: string } | null {
    if (!meta.parent) return null;
    const record = this.agentRecords?.record(meta.parent) ?? this.agentRecords?.record(parseConversationId(meta.parent).thread);
    if (record) return { id: record.id, name: this.list.get(record.workThread)?.name || record.name };
    return { id: meta.parent, name: this.list.get(parseConversationId(meta.parent).thread)?.name ?? meta.parent };
  }

  /**
   * A thread's summaries, built once until the next thread list read, a tree read of that thread, or a save of the agent records, the rooms or
   * the thread kinds. On 11-03 the 2 s thread list read, each board, duty and For you read and the step owners' tick built every thread's
   * summaries again, up to once per chat, and held the event loop for 250 to 310 ms at a time.
   */
  private agentsOf(row: DurableThread): AgentSummary[] {
    const key = `${this.agentRecords?.store.version ?? 0}:${this.store.version}`;
    if (key !== this.summariesKey) {
      this.summaries.clear();
      this.summariesKey = key;
    }
    const hit = this.summaries.get(row.id);
    if (hit?.row === row) return hit.out;
    const out = this.buildAgentsOf(row);
    this.summaries.set(row.id, { row, out });
    return out;
  }

  /**
   * A job's time (`AgentSummary.updatedAt`, its conversation's `lastActivityAt`): its thread's while it runs, else the thread's time when its
   * run status, name or retry note last changed. pi-host's tree has no time per conversation. When every job carried its thread's time, each
   * change of agent factory's work thread sent its 390 jobs again as 780 job and conversation events within 1 s, and a page that took them
   * held a ⌘K answer up to 950 ms after its network ended (11-23, ~/work/p224-search-page).
   */
  private jobTime(row: DurableThread, node: TreeNode): number {
    const key = conversationIdOf(row.id, node.id);
    const seen = `${node.status}\u0000${node.name}\u0000${node.retrying ?? ""}`;
    const known = this.jobTimes.get(key);
    if (node.status !== "running" && known?.seen === seen) return known.at;
    this.jobTimes.set(key, { seen, at: row.updatedAt });
    return row.updatedAt;
  }

  private buildAgentsOf(row: DurableThread): AgentSummary[] {
    const meta = this.meta(row.id);
    const rootModel = modelRef(`${row.provider}/${row.modelId}`);
    const record = this.agentRecords?.ofWorkThread(row.id);
    const root: AgentSummary = record
      ? agentSummary(record, {
        row, tree: this.tree(row.id),
        jobs: this.agentRecords!.jobThreads(record).flatMap(id => (this.list.has(id) ? [this.list.get(id)!] : [])),
        comm: this.commRows(record),
      }, { model: rootModel, rooms: this.roomsOf(record.id), hostState: this.agentRecords!.hostState(record.host) })
      : {
        id: row.id, kind: meta.kind, name: row.name || "Untitled", avatar: avatarOf(row.name || row.id), model: rootModel,
        thinkingLevel: (row.thinkingLevel as ThinkingLevel) ?? null, status: statusOf(row.status), parent: meta.kind === "job" ? this.parentOf(meta) : null,
        thread: row.id, conversation: 1, archived: row.archived, createdAt: row.createdAt, updatedAt: row.updatedAt,
        preview: row.preview.split("\n").find(line => line.trim()) ?? "", rooms: [], host: row.box ?? this.box,
        ...(rootRetrying({ row, tree: this.tree(row.id) }) ? { retrying: rootRetrying({ row, tree: this.tree(row.id) })! } : {}),
      };
    const owner = this.ownerOf(row);
    const worksFor = owner ? { id: owner.id, name: this.list.get(owner.workThread)?.name || owner.name } : undefined;
    if (worksFor && !record) root.agent = worksFor;
    const out = [root];
    const nodes = this.tree(row.id);
    const names = new Map<number, string>();
    for (const node of nodes) if (!names.has(node.id)) names.set(node.id, node.name);
    for (const node of nodes) {
      if (node.parent === null) continue;
      const id = conversationIdOf(row.id, node.id);
      const parentId = node.parent === 1 ? root.id : conversationIdOf(row.id, node.parent);
      const parentName = node.parent === 1 ? root.name : names.get(node.parent) ?? parentId;
      out.push({
        id, kind: "job", name: node.name, avatar: avatarOf(node.name), model: modelRef(node.model), thinkingLevel: root.thinkingLevel,
        status: statusOf(node.status), parent: { id: parentId, name: parentName }, thread: row.id, conversation: node.id, archived: row.archived || this.jobArchived(row.id, node.id),
        createdAt: node.createdAt ?? row.createdAt, updatedAt: this.jobTime(row, node), preview: "", rooms: [], host: this.box,
        ...(worksFor ? { agent: worksFor } : {}), ...(node.retrying ? { retrying: node.retrying } : {}),
      });
    }
    return out;
  }

  /**
   * Every thread and every conversation in it as a summary, registered or not, newest first, except comm threads. Lookups read it; no list
   * the owner sees does, because it holds threads no agent owns.
   */
  allSummaries(opts: { archived?: boolean } = {}): AgentSummary[] {
    return [...this.list.values()].filter(t => (opts.archived || !t.archived) && !this.isComm(t.id)).flatMap(t => this.agentsOf(t))
      .filter(a => opts.archived || !a.archived).sort(newestFirst);
  }

  /** The registered agents (`agents.json`), newest first. A thread is an agent only through a record. */
  agents(opts: { archived?: boolean; test?: boolean } = {}): AgentSummary[] {
    return (this.agentRecords?.list() ?? []).flatMap(record => {
      if (record.test && !opts.test) return [];
      const agent = this.agent(record.id);
      return agent && (opts.archived || !agent.archived) ? [agent] : [];
    }).sort(newestFirst);
  }

  /**
   * The jobs of registered agents, newest first: each child conversation of an agent's work thread or of its root job threads, and each root
   * job thread, with `agent` set. A job of a thread no agent owns is not in it.
   */
  jobList(opts: { archived?: boolean } = {}): AgentSummary[] {
    return this.allSummaries(opts).filter(a => a.kind === "job" && a.agent !== undefined && !this.agentRecords?.record(a.agent.id)?.test);
  }

  /**
   * One registered agent's jobs, archived ones too: the same rows `jobList` holds for it, so its Jobs tab and its card count the same jobs.
   * A test agent has them too, though `jobList` leaves them out.
   */
  jobsOf(agent: AgentId): AgentSummary[] {
    return this.allSummaries({ archived: true }).filter(a => a.kind === "job" && a.agent?.id === agent);
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
   * A row per thread and job for the directory, search and the transcript view. A root chat no agent holds yet is `solo`, and no sidebar
   * group lists it; an agent's work thread and every job are `job`, under the agent's DM room or their parent. A
   * comm thread and its jobs, and every thread of a walk's test agent, have no row here; `conversation` still finds them, so they open as a
   * transcript by id.
   */
  threadConversations(): ConversationSummary[] {
    return [...this.list.values()].filter(row => !this.isComm(row.id) && !this.agentRecords?.store.isTest(row.id)).flatMap(row => this.rowConversations(row));
  }

  /**
   * The threads that are root chats no agent holds, the `solo` rows of `threadConversations`, read with no summary built. Kept until the
   * thread list, the agent records or the thread kinds change: each search asked it, 1,000 to 2,000 threads, 0.4 to 1 ms on 11-23.
   */
  rootChats(): readonly string[] {
    const key = `${this.agentRecords?.store.version ?? -1}:${this.store.version}`;
    if (this.roots?.key !== key) {
      this.roots = { key, threads: [...this.list.keys()].filter(id => this.meta(id).kind !== "job" && !this.agentRecords?.ofWorkThread(id) && !this.isComm(id)) };
    }
    return this.roots.threads;
  }

  /** The summary of any conversation by id: a DM room, a channel or Solo room, a thread or job, or a comm or test thread or one of its jobs. */
  conversation(id: ConversationId): ConversationSummary | undefined {
    const row = this.list.get(parseConversationId(id).thread);
    return (row ? this.rowConversation(row, id) : undefined) ?? this.conversations().find(c => c.id === id);
  }

  /** The conversation `id` of the thread `row`, built alone: agent factory's work thread has 390 jobs, and a search hit needs one of them. */
  private rowConversation(row: DurableThread, id: ConversationId): ConversationSummary | undefined {
    if (id === row.id) return this.rootConversation(row, this.agentsOf(row));
    const job = this.agentsOf(row).slice(1).find(agent => agent.id === id);
    return job && Threads.jobConversation(job);
  }

  private rowConversations(row: DurableThread): ConversationSummary[] {
    const agents = this.agentsOf(row);
    return [this.rootConversation(row, agents), ...agents.slice(1).map(Threads.jobConversation)];
  }

  private rootConversation(row: DurableThread, agents: readonly AgentSummary[]): ConversationSummary {
    const meta = this.meta(row.id);
    const root = agents[0]!;
    const record = this.agentRecords?.ofWorkThread(row.id);
    const comm = this.agentRecords?.ofComm(row.id);
    const working = agents.filter(a => a.status === "working").map(a => ({ id: a.id, name: a.name }));
    const status = statusOf(row.status);
    const solo = !record && !comm && meta.kind !== "job";
    const parent = record ? record.room : comm ? comm.room : meta.kind === "job" ? root.parent?.id : undefined;
    return {
      id: row.id, kind: solo ? "solo" : "job", name: row.name || "Untitled", status, archived: row.archived,
      lastActivityAt: row.updatedAt, preview: row.preview.slice(0, 200), unread: solo ? this.unread(row.id, row.updatedAt, status) : 0,
      hasNew: solo && row.updatedAt > (this.store.state.reads[row.id]?.at ?? 0), working, agent: root.id, ...(parent ? { parent } : {}),
    };
  }

  private static jobConversation(agent: AgentSummary): ConversationSummary {
    return {
      id: agent.id, kind: "job", name: agent.name, status: agent.status, archived: agent.archived, lastActivityAt: agent.updatedAt,
      preview: "", unread: 0, hasNew: false, working: agent.status === "working" ? [{ id: agent.id, name: agent.name }] : [], agent: agent.id,
      ...(agent.parent ? { parent: agent.parent.id } : {}),
    };
  }

  conversations(): ConversationSummary[] {
    return [...this.roomSummaries(), ...this.threadConversations(), ...this.groupSummaries()];
  }

  /**
   * Keeps the earliest send_message call in `entries` as the conversation's, and returns the earliest known: the scan's once it found one.
   * `run` says the entries are a run of the conversation read in order, such as a page, which can extend its scan; a live entry is not.
   */
  noteSends(thread: string, conversation: number, entries: readonly EntryRecord[], run = true): number | undefined {
    const id = conversationIdOf(thread, conversation);
    const mine = entries.filter(e => e.conversationId === conversation);
    if (run) this.noteRun(thread, conversation, mine);
    const first = this.scans.get(id)?.first ?? earliest(this.firstSends.get(id), firstSendIn(mine));
    if (first !== undefined) this.firstSends.set(id, first);
    return first;
  }

  /** Extends the conversation's scan with a run that joins it, or starts a scan from where the last one stopped when the run is past it. */
  private noteRun(thread: string, conversation: number, entries: readonly EntryRecord[]): void {
    const id = conversationIdOf(thread, conversation);
    const scan = this.scans.get(id);
    if (!entries.length || scan?.first !== undefined || this.scanning.has(id)) return;
    const ids = entries.map(e => e.id);
    const oldest = Math.min(...ids);
    const newest = Math.max(...ids);
    if (!scan || oldest > scan.to) return this.settleFirstSend(thread, conversation);
    if (newest <= scan.to) return;
    const fresh = entries.filter(e => e.id > scan.to);
    const first = firstSendIn(fresh);
    const open = first === undefined ? openSendIn(fresh) : undefined;
    this.scans.set(id, { to: open === undefined ? newest : open - 1, ...(first === undefined ? {} : { first }) });
    this.saveScans();
  }

  /**
   * Reads the conversation forward from where its scan stopped, the first entry at the start, until a speaking call or its newest entry.
   * It runs behind the read that asked, so that read draws its page as before; the reads after it draw by the scan's call.
   */
  private settleFirstSend(thread: string, conversation: number): void {
    const id = conversationIdOf(thread, conversation);
    if (this.scanning.has(id)) return;
    this.scanning.add(id);
    this.scanQueue = this.scanQueue.then(async () => {
      let scan = this.scans.get(id) ?? { to: 0 };
      while (scan.first === undefined) {
        const got = await this.entries(thread, { conversation, after: scan.to, limit: SCAN_READ, lean: true });
        if (!got.entries.length) break;
        const mine = got.entries.filter(e => e.conversationId === conversation);
        const first = firstSendIn(mine);
        const open = first === undefined ? openSendIn(mine) : undefined;
        const before = scan.to;
        scan = { to: open === undefined ? got.entries.at(-1)!.id : open - 1, ...(first === undefined ? {} : { first }) };
        this.scans.set(id, scan);
        if (!got.more || scan.to <= before) break;
      }
      if (scan.first !== undefined) this.firstSends.set(id, scan.first);
      this.saveScans();
    }).catch(error => this.log(`first send scan of ${id} failed: ${String(error)}`)).finally(() => this.scanning.delete(id));
  }

  private saveScans(): void {
    this.store.saveCache(FIRST_SENDS_CACHE, { v: FIRST_SENDS_VERSION, scans: Object.fromEntries(this.scans) } satisfies FirstSendsCache);
  }

  /** Ends when every scan started so far has ended; tests wait on it. */
  scansDone(): Promise<void> {
    return this.scanQueue;
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

  /** Only what a settled turn sent with send_message, never its final answer, which stays in its thread (a check-in job's report, `reportCheckIn`). */
  async sent(thread: string, conversation: number, settled: { entry?: number; answer?: number }): Promise<{ text: string; to?: string }[]> {
    return sentMessages(await this.turnOf(thread, conversation, settled)).map(({ text, to }) => ({ text, ...(to ? { to } : {}) }));
  }

  /**
   * What a settled turn said to people, for a channel thread or a duty report: its send_message messages, or none, when the agent talks
   * through send_message (`speaksThroughSendMessage`); otherwise, for an agent that has never called it, its answer's text as one message.
   */
  async said(thread: string, conversation: number, settled: { entry?: number; answer?: number }): Promise<{ text: string; to?: string }[]> {
    const turn = await this.turnOf(thread, conversation, settled);
    if (speaksThroughSendMessage(turn, await this.firstSend(thread, conversation))) return sentMessages(turn).map(({ text, to }) => ({ text, ...(to ? { to } : {}) }));
    const answer = settled.answer === undefined ? undefined : (await this.entries(thread, { conversation, before: settled.answer + 1, limit: 1 })).entries[0]?.model?.[0];
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

  /**
   * Entries before `before` (exclusive), oldest first, widened up to the input that starts the oldest turn; lean, as a page draws them.
   * The first read asks for WIDEN entries past `limit`, so a page whose oldest turn starts within them takes one pi-host call, not two. The
   * reads go through `tails`, so a repeat read of a page it holds costs one one-entry pi-host read.
   */
  private async pageBefore(thread: string, conversation: number, before: number | undefined, limit: number): Promise<{ entries: EntryRecord[]; more: boolean }> {
    const read = await this.tails.reader(thread, conversation, before);
    const got = await read(before, limit + WIDEN);
    const entries = got.entries.slice(0, limit);
    let rest = got.entries.slice(limit);
    let hostMore = got.more;
    while (entries.length && !isInput(entries.at(-1)!) && entries.length < TURN_READ_CAP) {
      if (!rest.length) {
        if (!hostMore) break;
        const next = await read(entries.at(-1)!.id, WIDEN);
        rest = next.entries;
        hostMore = next.more;
        if (!rest.length) {
          hostMore = false;
          break;
        }
      }
      const cut = rest.findIndex(isInput);
      entries.push(...(cut >= 0 ? rest.slice(0, cut + 1) : rest));
      rest = cut >= 0 ? rest.slice(cut + 1) : [];
      if (cut >= 0) break;
    }
    return { entries: entries.reverse(), more: rest.length > 0 || hostMore };
  }

  /** Entries after `after` (exclusive), oldest first, stopped before the next input once `limit` is reached. */
  private async pageAfter(thread: string, conversation: number, after: number, limit: number): Promise<{ entries: EntryRecord[]; more: boolean }> {
    const entries: EntryRecord[] = [];
    let cursor = after;
    for (;;) {
      const got = await this.entries(thread, { conversation, after: cursor, limit: 100, lean: true });
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
    const first = (await this.entries(thread, { conversation, after: 0, limit: 1, lean: true })).entries[0];
    if (first) this.firstEntries.set(id, first.id);
  }

  /** pi-host's entries read, counted into the split of the timeline read it runs for. */
  private async entries(thread: string, query: EntriesQuery): Promise<{ entries: EntryRecord[]; more: boolean }> {
    const split = itemsSplit.getStore();
    if (!split) return this.host.entries(thread, query);
    const started = performance.now();
    const got = await this.host.entries(thread, query);
    split.calls = (split.calls ?? 0) + 1;
    split.host = (split.host ?? 0) + performance.now() - started;
    split.entries = (split.entries ?? 0) + got.entries.length;
    return got;
  }

  async timeline(id: ConversationId, opts: { before?: string; after?: string; around?: string; limit?: number }, split?: ItemsSplit): Promise<TimelinePage> {
    if (!split) return this.read(id, opts);
    split[opts.around ? "around" : opts.after ? "after" : opts.before ? "before" : "newest"] = 1;
    return itemsSplit.run(split, () => this.read(id, opts));
  }

  private async read(id: ConversationId, opts: { before?: string; after?: string; around?: string; limit?: number }): Promise<TimelinePage> {
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

  /** A tool step's output (`Step.outputRef`), the text of the conversation's tool result entry `entry`; undefined when it is no such entry. */
  async stepOutput(id: ConversationId, entry: number): Promise<{ output: string } | undefined> {
    const { thread, conversation } = parseConversationId(id);
    const found = (await this.entries(thread, { conversation, before: entry + 1, limit: 1, lean: true })).entries[0];
    const message = found?.id === entry ? found.model?.[0] : undefined;
    return message?.role === "toolResult" ? { output: stepOutputOf(message) } : undefined;
  }

  // Live side

  async watch(id: ConversationId): Promise<{ items: Item[]; status: RunStatus }> {
    let live = this.live.get(id);
    if (!live) {
      const { thread, conversation } = parseConversationId(id);
      const created: LiveConversation = {
        thread, conversation, recent: [], running: this.statusOfConversation(thread, conversation) === "working", runningTools: new Set(), watchers: 0,
        ready: Promise.resolve(),
      };
      created.ready = this.attach(id, created);
      this.live.set(id, created);
      live = created;
    }
    live.watchers += 1;
    await live.ready;
    return { items: buildItems(live.recent, this.context(live.thread, live.conversation, live)), status: live.running ? "working" : this.statusOfConversation(live.thread, live.conversation) };
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
    const tail = await this.entries(live.thread, { conversation: live.conversation, limit: 1, lean: true });
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
        live.hostStatus = status;
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
    // No streaming: partial text never goes to the page. Items go out when an input, an answer with text or a send_message call lands,
    // and when a run starts (an empty live turn, drawn as typing dots) or ends. A work thread's turn also goes out with each step that
    // lands, so a page kept from the socket matches the next read: on 11-22 every refresh of a kept work thread while its agent worked
    // brought steps the socket never sent (work/p157-opens/kept-follow.mjs), and its turns were 1.2 to 7.7 KB with up to 18 steps. A job's
    // turn runs to hundreds of steps, so its steps still show with its next item.
    const steps = live.conversation === 1;
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
          this.events.status(id, this.runStatus(live.thread, live.conversation) === "sleeping" ? "sleeping" : "idle");
          break;
        case "message_end":
        case "entry_appended":
          if (this.addEntry(live, agentEvent.entry) && (steps || shows(agentEvent.entry))) changed = true;
          break;
        case "tool_execution_start":
          live.runningTools.add(agentEvent.toolCallId);
          break;
        case "tool_execution_end":
          live.runningTools.delete(agentEvent.toolCallId);
          if (this.addEntry(live, agentEvent.entry) && steps) changed = true;
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
    // The whole turn, so a speaking call's result, which says whether it went out, meets its call.
    this.noteSends(live.thread, live.conversation, live.recent, false);
    return true;
  }

  private emitItems(id: ConversationId, live: LiveConversation): void {
    this.events.items(id, buildItems(live.recent, this.context(live.thread, live.conversation, live)));
  }
}

const newestFirst = (a: AgentSummary, b: AgentSummary): number => b.updatedAt - a.updatedAt;

function firstSendScans(cache: FirstSendsCache | Record<string, FirstSendScan>): [string, FirstSendScan][] {
  if ("v" in cache && cache.v === FIRST_SENDS_VERSION) return Object.entries((cache as FirstSendsCache).scans);
  return Object.entries(cache as Record<string, FirstSendScan>).filter(([, scan]) => scan.first === undefined);
}

/** The summaries that differ from `cache`, the ids gone from it, and the next cache. */
function diff(cache: ReadonlyMap<AgentId, string>, list: AgentSummary[]): { changed: AgentSummary[]; removed: AgentId[]; cache: Map<AgentId, string> } {
  const next = new Map(list.map(a => [a.id, JSON.stringify(a)]));
  return { changed: list.filter(a => cache.get(a.id) !== next.get(a.id)), removed: [...cache.keys()].filter(id => !next.has(id)), cache: next };
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
