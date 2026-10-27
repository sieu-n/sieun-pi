/**
 * Durable threads: one pi-durable Harness per root thread, each on its own SQLite file, all in one pi-host process.
 *
 * A thread file holds the root conversation, every child conversation its subagents create, their entries, tasks and
 * documents. pi-host is the only writer of each file (a lockfile per file, as for Pi session files). The folder's
 * `index.sqlite` keeps the thread list, each thread's last wake, and the search and usage rows; all of it is derived
 * from the thread files.
 *
 * Crash safety comes from pi-durable: every input is admitted in a commit before anything runs, every step of a run
 * is a checkpointed task, and a reopened file continues from the last checkpoint. This class adds what pi-durable
 * leaves to the host: which files to reopen after a crash (`markActive` before an admit, then the Harness's `onWake`),
 * a timer for sleeping tasks in closed files, and closing idle files.
 */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ImageContent, Message, ModelThinkingLevel, TextContent, Usage } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  Harness, LiveDoc, ROOT_CONVERSATION_ID, watchEvents, type AgentEvent, type AgentEventStream, type CommitPublication, type Conversation,
  type ConversationId, type ConversationRecord, type EntryDraft, type EntryId, type EntryRecord, type HarnessSettings, type ModelRef, type ReportInfo, type SettledSubmissionRecord,
  type SubmissionId, type SubmissionRecord, type Wake,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Leases, SessionLockedError } from "../lease.ts";
import { statusOf, ThreadIndex, type IndexedEntry, type SearchHit, type SearchQuery, type ThreadRow, type ThreadStatus, type UsageRow, type UsageTotal } from "./index-db.ts";
import { headFor, parseSession } from "./import.ts";
import { AgentMessageEntry, ChatDoc, threadEnv, threadRegistry } from "./registry.ts";

const context: Context = BACKGROUND_CONTEXT;
const PREVIEW_CHARS = 200;
const PAGE_MAX = 500;

export interface DurableThreadsOptions {
  /** The folder of thread files (`threads/<id>.sqlite`) and `index.sqlite`. */
  dir: string;
  /** Model access for one thread; pi-host passes pi-pool's provider keyed by the thread, so a thread is one pool tree. */
  models: (threadId: string) => Models;
  defaultModel: ModelRef;
  defaultThinkingLevel?: ModelThinkingLevel;
  defaultCwd: string;
  /** How long a file with no runnable work and no watcher stays open; default 10 minutes. */
  idleCloseMs?: number;
  settings?: HarnessSettings;
  log?: (line: string) => void;
  now?: () => number;
}

export interface ThreadInfo extends ThreadRow {
  status: ThreadStatus;
}

export interface TreeNode {
  id: number;
  parent: number | null;
  /** The tool task in the parent that owns it. */
  ownerTask: number | null;
  name: string;
  depth: number;
  status: "idle" | "running";
  model: string | null;
  createdAt: number | null;
}

export type DurableEvent =
  | { type: "events"; conversation: number; events: readonly AgentEvent[] }
  | { type: "conversation"; node: TreeNode }
  | { type: "status"; status: ThreadStatus; wakeAt?: number }
  | { type: "doc"; conversation: number; name: string; value: unknown }
  | { type: "closed"; reason: string };

export type DurableSink = (event: DurableEvent) => void;

export interface SubmitInput {
  conversation?: number;
  text?: string;
  images?: { data: string; mimeType: string }[];
  requestId?: string;
  whenBusy?: "steer" | "followUp" | "reject";
  entry?: { kind: "agent.message"; data: { from: string; via?: string } };
}

interface Watcher {
  sink: DurableSink;
  conversation?: number;
  streams: Map<number, AgentEventStream>;
  /** The newest entry id this watcher has been sent, so a replay and a live batch never send one twice. */
  sent: number;
}

interface OpenThread {
  id: string;
  file: string;
  harness: Harness;
  root: Conversation;
  watchers: Set<Watcher>;
  wake: Wake;
  idleTimer?: NodeJS.Timeout;
  stopCommits: () => void;
}

const textOfContent = (content: Message["content"] | undefined): string => {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return (content as { type: string; text?: string }[]).flatMap(c => (c.type === "text" && typeof c.text === "string" ? [c.text] : [])).join("\n");
};

/** The searchable text, author and time of one entry; `undefined` for bookkeeping entries. */
export function describeEntry(entry: EntryRecord, now: number): { text: string; author: string; at: number } | undefined {
  const message = entry.model?.[0] as (Message & { timestamp?: number; toolName?: string }) | undefined;
  const at = typeof message?.timestamp === "number" ? message.timestamp : now;
  if (entry.kind === AgentMessageEntry.kind) {
    const from = (entry.data as { from?: string } | undefined)?.from ?? "agent";
    return { text: textOfContent(message?.content), author: from, at };
  }
  if (!message) return undefined;
  if (message.role === "user") return { text: textOfContent(message.content), author: entry.kind === "pi.user" ? "owner" : entry.kind, at };
  if (message.role === "assistant") {
    const parts = message.content.flatMap(c => (c.type === "text" ? [c.text] : c.type === "toolCall" ? [`${c.name} ${JSON.stringify(c.arguments)}`] : []));
    return { text: parts.join("\n"), author: `${message.provider}/${message.model}`, at };
  }
  if (message.role === "toolResult") return { text: textOfContent(message.content), author: `tool:${message.toolName}`, at };
  return undefined;
}

function usageOf(entry: EntryRecord, thread: string, now: number): UsageRow | undefined {
  const message = entry.model?.[0] as (Message & { usage?: Usage; timestamp?: number }) | undefined;
  if (message?.role !== "assistant" || !message.usage) return undefined;
  const usage = message.usage;
  return {
    thread, conversation: entry.conversationId, entryId: entry.id, model: `${message.provider}/${message.model}`, at: message.timestamp ?? now,
    input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, cost: usage.cost.total,
  };
}

export class DurableThreads {
  readonly index: ThreadIndex;
  private readonly open = new Map<string, Promise<OpenThread>>();
  private readonly leases = new Leases("pi-host-durable");
  private readonly registry = threadRegistry();
  private readonly threadsDir: string;
  private readonly idleCloseMs: number;
  private readonly now: () => number;
  private wakeTimer?: NodeJS.Timeout;
  private closing = false;

  constructor(private readonly options: DurableThreadsOptions) {
    this.threadsDir = join(options.dir, "threads");
    mkdirSync(this.threadsDir, { recursive: true, mode: 0o700 });
    this.index = new ThreadIndex(join(options.dir, "index.sqlite"));
    this.idleCloseMs = options.idleCloseMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
  }

  private log(line: string): void {
    this.options.log?.(`durable: ${line}`);
  }

  fileOf(id: string): string {
    if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error(`Bad thread id ${JSON.stringify(id)}`);
    return join(this.threadsDir, `${id}.sqlite`);
  }

  /** Reopens every thread that had runnable or due work when the last process stopped, and arms the timer for later sleeps. */
  async start(): Promise<string[]> {
    const due = this.index.due(this.now());
    for (const id of due) {
      try {
        await this.thread(id);
      } catch (error) {
        this.log(`recover ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.armWakes();
    if (due.length) this.log(`recovered ${due.length} threads: ${due.join(", ")}`);
    return due;
  }

  list(options: { archived?: boolean } = {}): ThreadInfo[] {
    return this.index.list(options).map(row => ({ ...row, status: statusOf(row) }));
  }

  info(id: string): ThreadInfo {
    const row = this.index.get(id);
    if (!row) throw new Error(`No durable thread ${id}`);
    return { ...row, status: statusOf(row) };
  }

  async create(input: { name?: string; model?: ModelRef; thinkingLevel?: ModelThinkingLevel; cwd?: string; id?: string } = {}): Promise<ThreadInfo> {
    const id = input.id ?? randomUUID();
    const model = input.model ?? this.options.defaultModel;
    const thinkingLevel = input.thinkingLevel ?? this.options.defaultThinkingLevel ?? "high";
    const cwd = input.cwd ?? this.options.defaultCwd;
    const at = this.now();
    if (this.index.get(id)) throw new Error(`Durable thread ${id} exists`);
    this.index.insertThread({ id, name: input.name ?? "New thread", provider: model.provider, modelId: model.modelId, thinkingLevel, cwd, createdAt: at, updatedAt: at });
    await this.thread(id, { agent: { model, thinkingLevel, cwd } });
    return this.info(id);
  }

  /** The open thread, opening its file on first use. */
  thread(id: string, init?: { agent: { model: ModelRef; thinkingLevel: ModelThinkingLevel; cwd: string } }): Promise<OpenThread> {
    if (this.closing) return Promise.reject(new Error("pi-host is shutting down"));
    let opening = this.open.get(id);
    if (!opening) {
      opening = this.openThread(id, init);
      this.open.set(id, opening);
      opening.catch(() => this.open.delete(id));
    }
    return opening.then(open => {
      this.touch(open);
      return open;
    });
  }

  private async openThread(id: string, init?: { agent: { model: ModelRef; thinkingLevel: ModelThinkingLevel; cwd: string } }): Promise<OpenThread> {
    const row = this.index.get(id);
    if (!row) throw new Error(`No durable thread ${id}`);
    const file = this.fileOf(id);
    const real = this.leases.acquire(file, id);
    let state: OpenThread | undefined;
    let wake: Wake = { active: false };
    try {
      const storage = await openNodeSqliteStorage(file);
      const harness = await Harness.open(storage, {
        models: this.options.models(id),
        registry: this.registry,
        env: threadEnv(row.cwd),
        ...(this.options.settings === undefined ? {} : { settings: this.options.settings }),
        onWake: next => {
          wake = next;
          if (state) this.onWake(state, next);
          else this.index.setWake(id, next);
        },
        onReport: (error: unknown, info: ReportInfo) => this.log(`${id} ${info.type}${"reason" in info && info.reason ? ` ${String(info.reason)}` : ""}: ${error instanceof Error ? error.message : String(error)}`),
      }, context);
      const root = await harness.root(context, init ? { agent: init.agent } : undefined);
      if (root.id !== ROOT_CONVERSATION_ID) throw new Error(`${file}: the root conversation is ${root.id}`);
      await this.backfill(id, harness);
      state = { id, file, harness, root, watchers: new Set(), wake, stopCommits: () => {} };
      const opened = state;
      opened.stopCommits = harness.subscribeCommits(publication => this.onCommit(opened, publication));
      this.onWake(opened, harness.wake());
      harness.resume();
      return opened;
    } catch (error) {
      this.leases.release(real);
      throw error;
    }
  }

  /** Adds every entry the index has not seen, so search and usage cover what a crashed process committed. */
  private async backfill(id: string, harness: Harness): Promise<void> {
    const mark = this.index.indexedEntry(id);
    const now = this.now();
    const conversations = await this.conversations(harness);
    const entries: IndexedEntry[] = [];
    const usage: UsageRow[] = [];
    for (const record of conversations) {
      const conversation = await harness.conversation(record.id, context);
      if (!conversation) continue;
      let cursor: Parameters<Conversation["entries"]>[2];
      do {
        const page = await conversation.entries({ order: "ascending", minEntryId: (mark + 1) as EntryRecord["id"] }, PAGE_MAX, cursor, context);
        for (const entry of page.items) this.collect(id, entry, now, entries, usage);
        cursor = page.next;
      } while (cursor !== undefined);
    }
    this.index.addEntries(id, entries.sort((a, b) => a.entryId - b.entryId), usage);
    const root = conversations.find(c => c.id === ROOT_CONVERSATION_ID);
    if (root) {
      const last = [...entries].reverse().find(entry => entry.conversation === ROOT_CONVERSATION_ID && entry.text);
      this.index.update(id, { children: conversations.length - 1, ...(last ? { preview: last.text.slice(0, PREVIEW_CHARS) } : {}) });
    }
  }

  private collect(thread: string, entry: EntryRecord, now: number, entries: IndexedEntry[], usage: UsageRow[]): void {
    const described = describeEntry(entry, now);
    if (described) entries.push({ thread, conversation: entry.conversationId, entryId: entry.id, kind: entry.kind, ...described });
    const row = usageOf(entry, thread, now);
    if (row) usage.push(row);
  }

  private async conversations(harness: Harness): Promise<ConversationRecord[]> {
    return harness.commit(async tx => {
      const out: ConversationRecord[] = [];
      let cursor: Parameters<typeof tx.scanConversations>[2];
      do {
        const page = await tx.scanConversations({}, PAGE_MAX, cursor);
        out.push(...page.items);
        cursor = page.next;
      } while (cursor !== undefined);
      return out;
    }, context);
  }

  private onCommit(open: OpenThread, publication: CommitPublication): void {
    const now = this.now();
    const entries: IndexedEntry[] = [];
    const usage: UsageRow[] = [];
    let preview: string | undefined;
    let failed: boolean | undefined;
    for (const change of publication.changes) {
      if (change.type === "entry") {
        this.collect(open.id, change.value, now, entries, usage);
        if (change.value.conversationId === ROOT_CONVERSATION_ID) {
          const text = entries.at(-1)?.entryId === change.value.id ? entries.at(-1)?.text : undefined;
          if (text) preview = text.slice(0, PREVIEW_CHARS);
        }
      } else if (change.type === "submission") {
        const record = change.value as SubmissionRecord;
        if (record.conversationId === ROOT_CONVERSATION_ID && record.type === "input") {
          if (record.status === "unanswered") failed = true;
          if (record.status === "done") failed = false;
        }
      } else if (change.type === "conversation") {
        void this.announceConversation(open, change.value);
      }
    }
    try {
      if (entries.length || usage.length) this.index.addEntries(open.id, entries, usage);
      if (preview !== undefined || failed !== undefined) this.index.update(open.id, { updatedAt: now, ...(preview === undefined ? {} : { preview }), ...(failed === undefined ? {} : { failed }) });
    } catch (error) {
      this.log(`${open.id} index write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async announceConversation(open: OpenThread, record: ConversationRecord): Promise<void> {
    const children = (this.index.get(open.id)?.children ?? 0) + (record.id === ROOT_CONVERSATION_ID ? 0 : 1);
    this.index.update(open.id, { children });
    if (!open.watchers.size) return;
    const node: TreeNode = { id: record.id, parent: record.owner?.conversationId ?? null, ownerTask: record.owner?.taskId ?? null, name: "", depth: 0, status: "running", model: null, createdAt: this.now() };
    for (const watcher of open.watchers) {
      watcher.sink({ type: "conversation", node });
      if (watcher.conversation === undefined) void this.attachStream(open, watcher, record.id);
    }
  }

  private onWake(open: OpenThread, wake: Wake): void {
    open.wake = wake;
    this.index.setWake(open.id, wake);
    const row = this.index.get(open.id);
    const status = row ? statusOf(row) : wake.active ? "running" : "idle";
    for (const watcher of open.watchers) watcher.sink({ type: "status", status, ...(wake.at === undefined ? {} : { wakeAt: wake.at }) });
    this.touch(open);
    this.armWakes();
  }

  /** One timer for the earliest sleep among files with no runnable work; it opens the file if needed and resumes it. */
  private armWakes(): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    if (this.closing) return;
    const next = this.index.nextWake();
    if (!next) return;
    const delay = Math.max(0, next.at - this.now());
    this.wakeTimer = setTimeout(() => void this.fireWakes(), Math.min(delay, 2 ** 31 - 1));
    this.wakeTimer.unref();
  }

  private async fireWakes(): Promise<void> {
    for (const id of this.index.due(this.now())) {
      try {
        const open = await this.thread(id);
        open.harness.resume();
      } catch (error) {
        this.log(`wake ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.armWakes();
  }

  /** Closes a file once it has no runnable work and no watcher for `idleCloseMs`; a later sleep reopens it from the wake timer. */
  private touch(open: OpenThread): void {
    if (open.idleTimer) clearTimeout(open.idleTimer);
    open.idleTimer = undefined;
    if (open.wake.active || open.watchers.size || this.idleCloseMs <= 0) return;
    open.idleTimer = setTimeout(() => void this.closeThread(open.id, "idle"), this.idleCloseMs);
    open.idleTimer.unref();
  }

  async closeThread(id: string, reason: string): Promise<void> {
    const opening = this.open.get(id);
    if (!opening) return;
    this.open.delete(id);
    const open = await opening;
    if (open.idleTimer) clearTimeout(open.idleTimer);
    open.stopCommits();
    for (const watcher of open.watchers) {
      for (const stream of watcher.streams.values()) await stream.stop().catch(() => undefined);
      watcher.sink({ type: "closed", reason });
    }
    open.watchers.clear();
    await open.harness.close(context).catch(error => this.log(`${id} close failed: ${error instanceof Error ? error.message : String(error)}`));
    this.leases.release(open.file);
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    await Promise.all([...this.open.keys()].map(id => this.closeThread(id, "shutdown")));
    this.leases.releaseAll();
    this.index.close();
  }

  private async conversation(open: OpenThread, id: number | undefined): Promise<Conversation> {
    if (id === undefined || id === ROOT_CONVERSATION_ID) return open.root;
    const conversation = await open.harness.conversation(id as ConversationId, context);
    if (!conversation) throw new Error(`Thread ${open.id} has no conversation ${id}`);
    return conversation;
  }

  /** Admits one input durably and returns at once; `wait` reacquires it by id, also after a restart. */
  async submit(id: string, input: SubmitInput): Promise<{ submission: SubmissionId; requestId: string; status: SubmissionRecord["status"] }> {
    const open = await this.thread(id);
    const conversation = await this.conversation(open, input.conversation);
    const content: (TextContent | ImageContent)[] = [];
    if (input.text) content.push({ type: "text", text: input.text });
    for (const image of input.images ?? []) content.push({ type: "image", data: image.data, mimeType: image.mimeType });
    if (!content.length) throw new Error("durable_submit needs text or images");
    const requestId = input.requestId ?? `pi-host:${randomUUID()}`;
    this.index.markActive(id, this.now());
    const submission = await conversation.submit({
      type: "input", content, requestId,
      ...(input.whenBusy ? { whenBusy: input.whenBusy } : {}),
      ...(input.entry ? { entry: { kind: input.entry.kind, data: input.entry.data } } : {}),
    }, context);
    const status = (await submission.status(context)).status;
    // A repeated request id admits nothing and changes no wake, so the mark set above is cleared from the Harness's own value.
    this.onWake(open, open.harness.wake());
    return { submission: submission.id, requestId, status };
  }

  async wait(id: string, submission: SubmissionId, waitContext: Context = context): Promise<SettledSubmissionRecord> {
    const open = await this.thread(id);
    const handle = await open.harness.submission(submission, waitContext);
    if (!handle) throw new Error(`Thread ${id} has no submission ${submission}`);
    return handle.wait(waitContext);
  }

  async abort(id: string, conversation?: number): Promise<void> {
    const open = await this.thread(id);
    await (await this.conversation(open, conversation)).abort(context);
  }

  async set(id: string, change: { name?: string; model?: ModelRef; thinkingLevel?: ModelThinkingLevel; archived?: boolean }): Promise<ThreadInfo> {
    this.info(id);
    if (change.model || change.thinkingLevel) {
      const open = await this.thread(id);
      await open.root.configure({ ...(change.model ? { model: change.model } : {}), ...(change.thinkingLevel ? { thinkingLevel: change.thinkingLevel } : {}) }, context);
    }
    this.index.update(id, {
      ...(change.name === undefined ? {} : { name: change.name }),
      ...(change.model ? { provider: change.model.provider, modelId: change.model.modelId } : {}),
      ...(change.thinkingLevel ? { thinkingLevel: change.thinkingLevel } : {}),
      ...(change.archived === undefined ? {} : { archived: change.archived }),
      updatedAt: this.now(),
    });
    return this.info(id);
  }

  /** Entries newest first: `before` is an exclusive entry id, so the timeline loads the newest page and scrolls up. */
  async entries(id: string, query: { conversation?: number; before?: number; after?: number; limit?: number }): Promise<{ entries: EntryRecord[]; more: boolean }> {
    const open = await this.thread(id);
    const conversation = await this.conversation(open, query.conversation);
    const limit = Math.min(query.limit ?? 50, PAGE_MAX);
    const page = await conversation.entries({
      order: query.after === undefined ? "descending" : "ascending",
      ...(query.before === undefined ? {} : { maxEntryId: (query.before - 1) as EntryRecord["id"] }),
      ...(query.after === undefined ? {} : { minEntryId: (query.after + 1) as EntryRecord["id"] }),
    }, limit, undefined, context);
    return { entries: [...page.items], more: page.next !== undefined };
  }

  async tree(id: string): Promise<TreeNode[]> {
    const open = await this.thread(id);
    const records = await this.conversations(open.harness);
    const parents = new Map(records.map(record => [record.id as number, record.owner?.conversationId ?? null]));
    const depthOf = (conversation: number): number => {
      let depth = 0;
      for (let parent = parents.get(conversation); parent !== null && parent !== undefined; parent = parents.get(parent)) depth++;
      return depth;
    };
    const nodes: TreeNode[] = [];
    for (const record of records) {
      const conversation = await open.harness.conversation(record.id, context);
      if (!conversation) continue;
      const first = (await conversation.entries({ order: "ascending" }, 4, undefined, context)).items.find(entry => describeEntry(entry, 0)?.text);
      const described = first ? describeEntry(first, 0) : undefined;
      const live = await open.harness.snapshot(LiveDoc, record.id, context);
      const agent = await conversation.agent(context);
      nodes.push({
        id: record.id, parent: record.owner?.conversationId ?? null, ownerTask: record.owner?.taskId ?? null,
        name: record.id === ROOT_CONVERSATION_ID ? this.info(id).name : (described?.text ?? "").split("\n")[0]!.slice(0, 80),
        depth: depthOf(record.id), status: live?.run ? "running" : "idle", model: agent.model ? `${agent.model.provider}/${agent.model.modelId}` : null,
        createdAt: described?.at ?? null,
      });
    }
    return nodes;
  }

  /**
   * Streams one conversation's agent events, or every conversation's in the file, tagged by conversation. With
   * `fromEntry`, entries committed after that id are sent first as `entry_appended` events, so a client that
   * reconnects misses nothing; each entry reaches a watcher once.
   */
  async watch(id: string, options: { conversation?: number; fromEntry?: number }, sink: DurableSink): Promise<() => Promise<void>> {
    const open = await this.thread(id);
    const watcher: Watcher = { sink, ...(options.conversation === undefined ? {} : { conversation: options.conversation }), streams: new Map(), sent: options.fromEntry ?? 0 };
    open.watchers.add(watcher);
    this.touch(open);
    const targets = options.conversation === undefined ? (await this.conversations(open.harness)).map(record => record.id as number) : [options.conversation];
    for (const target of targets) await this.attachStream(open, watcher, target, options.fromEntry);
    const row = this.index.get(id);
    if (row) sink({ type: "status", status: statusOf(row), ...(row.wakeAt === undefined ? {} : { wakeAt: row.wakeAt }) });
    return async () => {
      open.watchers.delete(watcher);
      for (const stream of watcher.streams.values()) await stream.stop().catch(() => undefined);
      this.touch(open);
    };
  }

  private async attachStream(open: OpenThread, watcher: Watcher, conversation: number, fromEntry?: number): Promise<void> {
    if (watcher.streams.has(conversation)) return;
    const stream = await watchEvents(open.harness, conversation as ConversationId, context);
    watcher.streams.set(conversation, stream);
    const { entries: _entries, ...snapshot } = stream.snapshot;
    const first: AgentEvent[] = [{ ...snapshot, entries: [] }];
    if (fromEntry !== undefined) {
      const handle = await this.conversation(open, conversation);
      let cursor: Parameters<Conversation["entries"]>[2];
      do {
        const page = await handle.entries({ order: "ascending", minEntryId: (fromEntry + 1) as EntryRecord["id"] }, PAGE_MAX, cursor, context);
        for (const entry of page.items) first.push({ type: "entry_appended", entry });
        cursor = page.next;
      } while (cursor !== undefined);
    }
    const replayed = new Set(first.flatMap(event => (event.type === "entry_appended" ? [event.entry.id as number] : [])));
    watcher.sink({ type: "events", conversation, events: first });
    stream.start(async events => {
      const fresh = events.filter(event => !(event.type === "entry_appended" && replayed.has(event.entry.id as number)));
      if (fresh.length) watcher.sink({ type: "events", conversation, events: fresh });
    });
  }

  async docGet(id: string, name: string, conversation?: number): Promise<unknown> {
    const open = await this.thread(id);
    const target = (conversation ?? ROOT_CONVERSATION_ID) as ConversationId;
    const doc = await open.harness.snapshot(ChatDoc, target, name, context);
    return doc?.value ?? null;
  }

  async docPut(id: string, name: string, value: unknown, conversation?: number): Promise<void> {
    const open = await this.thread(id);
    const target = (conversation ?? ROOT_CONVERSATION_ID) as ConversationId;
    await open.harness.commit(async tx => {
      const draft = await tx.doc(ChatDoc, target, name, null);
      draft.value = value as never;
    }, context);
    for (const watcher of open.watchers) watcher.sink({ type: "doc", conversation: target, name, value });
  }

  /**
   * Imports a Prime or Pi session file as a new thread (`import.ts`). The file is only read; the old thread keeps
   * running where it is. The model and thinking level are the session's last ones unless given.
   */
  async importSession(path: string, input: { name?: string; model?: ModelRef; thinkingLevel?: ModelThinkingLevel; cwd?: string } = {}): Promise<ThreadInfo & { imported: number; skipped: Record<string, number> }> {
    const parsed = parseSession(path);
    const created = await this.create({
      name: input.name ?? parsed.name ?? `Imported ${parsed.id ?? path}`,
      model: input.model ?? parsed.model ?? this.options.defaultModel,
      thinkingLevel: input.thinkingLevel ?? parsed.thinkingLevel ?? this.options.defaultThinkingLevel ?? "high",
      cwd: input.cwd ?? parsed.cwd ?? this.options.defaultCwd,
    });
    const open = await this.thread(created.id);
    const written = new Map<string, EntryId>();
    for (let start = 0; start < parsed.drafts.length; start += PAGE_MAX) {
      const batch = parsed.drafts.slice(start, start + PAGE_MAX);
      await open.harness.commit(async tx => {
        for (const item of batch) {
          const draft: EntryDraft = item.draft.kind === "pi.compaction" ? { ...item.draft, head: headFor(item.headFrom, written) } : item.draft;
          const record = await tx.appendEntry(ROOT_CONVERSATION_ID, draft);
          written.set(item.from, record.id);
        }
      }, context);
    }
    return { ...this.info(created.id), imported: parsed.drafts.length, skipped: parsed.skipped };
  }

  search(query: SearchQuery): SearchHit[] {
    return this.index.search(query);
  }

  usage(range: { since?: number; until?: number; threads?: string[] }): UsageTotal[] {
    return this.index.usage(range);
  }

  /** Files in the folder that the index does not list, such as a copied-in thread; each needs `adopt`. */
  unlisted(): string[] {
    if (!existsSync(this.threadsDir)) return [];
    return readdirSync(this.threadsDir).filter(name => name.endsWith(".sqlite")).map(name => name.slice(0, -".sqlite".length)).filter(id => !this.index.get(id));
  }

  isLocked(error: unknown): error is SessionLockedError {
    return error instanceof SessionLockedError;
  }
}
