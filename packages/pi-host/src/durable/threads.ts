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
  Harness, LiveDoc, ProviderDoc, ROOT_CONVERSATION_ID, watchEvents, type AgentEvent, type AgentEventStream, type CommitChange, type CommitPublication, type Conversation,
  type ConversationId, type ConversationRecord, type EntryDraft, type EntryId, type EntryRecord, type HarnessSettings, type ModelRef, type ReportInfo, type SettledSubmissionRecord,
  type Storage, type SubmissionId, type SubmissionRecord, type Wake,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { OwnerMark, TurnTicket } from "@sieun-pi/pi-pool/durable";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Leases, SessionLockedError } from "../lease.ts";
import { statusOf, ThreadIndex, type IndexedEntry, type IndexRead, type SearchPage, type SearchQuery, type ThreadRow, type ThreadStatus, type UsageRow } from "./index-db.ts";
import { speechOf } from "./feed.ts";
import { leanEntry } from "./lean.ts";
import { headFor, parseSession } from "./import.ts";
import { ChatDoc } from "./chat-doc.ts";
import { AgentMessageEntry, threadEnv, threadRegistry } from "./registry.ts";
import { SPEAKING_TOOLS, type PrimeChat } from "./prime-chat.ts";
import { PrimeRoots } from "./prime-roots.ts";
import { jobTitle } from "./job-title.ts";
import { peekDoc } from "./doc-peek.ts";
import { chunkScans } from "./chunked-scan.ts";
import { FirstEntries } from "./first-entry.ts";
import { loopSlices, rlmChildName, type DurableRlm, type PiRootView, type RlmThread, type RootRow } from "./rlm.ts";
import type { DurableRules } from "./rules.ts";
import type { PoolLabels } from "./pool-labels.ts";
import { AGENT_REF_DOC, applyAgentRole, parseAgentRef, threadAgent } from "./agent-profile.ts";
import { InputDropped, RlmChildDoc } from "./children.ts";
import { commExtension, noteHanded, noteHeard, type CommHost, type CommSubmit } from "./comm.ts";
import { drainGate } from "./drain-gate.ts";
import { deliverHarnessDigest, type PrimePromptOptions } from "./prime-prompt.ts";
import { liveRetry, retrySince, retryingText } from "./retrying.ts";
import { clearsOnItsOwn, failedInputs, failureNotice, rootFailed, failureTarget, isRetry, lastModel, mayRetry, newestRootFailed, retryInput, roomLine, roomLineWrites, roomPost, toldName, TURN_FAILED_VIA, type FailedInput } from "./turn-failed.ts";

const context: Context = BACKGROUND_CONTEXT;
const PREVIEW_CHARS = 200;
const PAGE_MAX = 500;
/** A doc value's `rev`, such as a chat.board's, for `docPut`'s newerOnly; a value with none counts as older than any. */
const revOf = (value: unknown): number =>
  typeof value === "object" && value !== null && typeof (value as { rev?: unknown }).rev === "number" ? (value as { rev: number }).rev : -Infinity;

export interface DurableThreadsOptions {
  /** The folder of thread files (`threads/<id>.sqlite`) and `index.sqlite`. */
  dir: string;
  /** Model access for one thread; pi-host passes pi-pool's provider keyed by the thread, so a thread is one pool tree. */
  models: (threadId: string) => Models;
  /** A new thread's model when none is named; a function is asked at each creation, as pi-host reads Prime's settings.json (`primeDefaults`). */
  defaultModel: ModelRef | (() => ModelRef);
  /** A new thread's thinking level when none is named, default "medium" (c221); a function is asked at each creation. */
  defaultThinkingLevel?: ModelThinkingLevel | (() => ModelThinkingLevel);
  defaultCwd: string;
  /** How long a file with no runnable work and no watcher stays open; default 10 minutes. */
  idleCloseMs?: number;
  /** Each thread's run settings, such as pi-pool's `durableSettings`, which retries every transient error with no retry count. */
  settings?: (threadId: string) => HarnessSettings;
  /**
   * Called when an input of a conversation settles, with the conversation's provider session id and whether a run
   * still goes on in it; pi-host gives the session's pi-pool working slot back here.
   */
  inputSettled?: (threadId: string, sessionId: string, runContinues: boolean) => void | Promise<void>;
  /** pi-pool's turn queue as one thread's conversation sees it, keyed like `inputSettled`; pi-host passes its TurnQueue. */
  turns?: {
    ownerTurn: (threadId: string, sessionId: string) => Promise<OwnerMark>;
    ticket: (threadId: string, sessionId: string) => TurnTicket;
    /** Gives back a session's working slot outside a settle: the slot of a host module's own model call, such as refine's. */
    release: (threadId: string, sessionId: string) => Promise<void>;
  };
  log?: (line: string) => void;
  now?: () => number;
  /** Prime's agent dir and prompt options: each thread then runs with Prime's system prompt (`prime-prompt.ts`); unset, with the preamble alone. */
  prompt?: Omit<PrimePromptOptions, "thread" | "log">;
  /** Prime's chat extension, loaded once (`loadPrimeChat`): each thread's root conversation then offers its tools and turn wrappers. */
  chat?: PrimeChat;
  /** Prime's `ipython` and its RLM runtime (`DurableRlm.load`): every conversation then offers it, with one kernel each. */
  rlm?: DurableRlm;
  /** sieun-rules' tool guards (`DurableRules.load`): every tool call of every conversation then passes the send, repo and transcript guards. */
  rules?: DurableRules;
  /** The Prime root sessions a thread's root reaches with `agent_message` and `agent_observe`; default `new PrimeRoots()` with `rlm`, none for null. */
  primeRoots?: PrimeRoots | null;
  /** pi-pool's tree, class and lead place for each thread's agent role (`pool-labels.ts`), told at each open, `agent.ref` write, root input and close. */
  pool?: Pick<PoolLabels, "agent" | "submitted" | "closed">;
  /** An agent's work thread by agent id, which hears of a run that failed with no answer (`turn-failed.ts`); pi-host asks apps/chat. */
  agentWork?: (agent: string) => Promise<string | undefined>;
}

export interface ThreadInfo extends ThreadRow {
  status: ThreadStatus;
  /** "retrying since HH:MM: <error kind>" (KST) while a run of the open file has retried a transient error past 5 minutes (`retrying.ts`). */
  retrying?: string;
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
  /** "retrying since HH:MM: <error kind>" (KST) while the conversation's run has retried a transient error past 5 minutes (`retrying.ts`). */
  retrying?: string;
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
  /** The owner sent it: pi-pool marks the conversation's next run as the owner's, so it skips the turn queue. */
  ownerTurn?: boolean;
}

export interface SubmitResult {
  submission: SubmissionId;
  requestId: string;
  status: SubmissionRecord["status"];
  /** The conversation's run in pi-pool's turn queue right after the admit; absent when pi-host runs without the queue. */
  ticket?: TurnTicket;
  /** The answer of the owner-turn mark; absent when `ownerTurn` was not set or the run already held its slot. */
  owner?: OwnerMark;
}

/** An input a schedule sends: a board.wake or Remind me from apps/chat's wake ticker, or a heartbeat tick (heartbeat.ts). */
const scheduled = (input: SubmitInput): boolean => input.entry?.data.via === "wake" || input.entry?.data.from === "heartbeat";

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
  /** Resumes the open file at its earliest sleep; pi-durable arms no timer of its own once the host takes `onWake`. */
  sleepTimer?: NodeJS.Timeout;
  stopCommits: () => void;
  /** The prompt options of this thread, which also deliver Prime's harness digest before each root input. */
  prompt?: PrimePromptOptions & { thread: NonNullable<PrimePromptOptions["thread"]> };
  /** The newest digest check, so the next waits for it and two never record the same digest. */
  digesting: Promise<void>;
  /** Each task-owned conversation's first input, its task, which its owner conversation wrote: the entry once seen, and the owner. */
  tasks: Map<number, TaskInput>;
  /** This file's comm extension, whose hand-over task a comm thread's send to its work thread creates. */
  comm: ReturnType<typeof commExtension>;
  /** The file's storage, whose submission scan the retry of a failed owner post reads (`turn-failed.ts`). */
  storage: Storage;
  /**
   * Each conversation's tree node as `tree` last built it, until a commit touches that conversation (`onCommit`). A node reads about five
   * records, so on 11-22 a tree of agent factory's 380 conversations held pi-host's loop 250 to 300 ms, the chat read it every 2 s while the
   * thread ran, and every timeline read of any thread waited behind it (~/work/thread-reads/).
   */
  treeNodes: Map<number, TreeNode>;
  /** How many commits touched each conversation, so a node built while one landed is not kept. */
  treeTouches: Map<number, number>;
}

/** A child conversation's task: the input its owner wrote, which the index must not credit to the owner of the box. */
interface TaskInput { owner: number; entry?: number }

/** A task sent as an agent message, which needs no credit of its own. */
const NO_TASK_INPUT = -1;
const isInput = (entry: EntryRecord): boolean => entry.kind === "pi.user" || entry.kind === AgentMessageEntry.kind;

/**
 * The first of a conversation's first `within` entries that `wanted` takes. Its own first entry answers when `wanted` takes it, read alone
 * (`first-entry.ts`); a fork, whose first entries are its source's, and any other conversation go through pi-durable's page read.
 */
async function firstEntry(conversation: Conversation, record: ConversationRecord, firsts: FirstEntries, within: number, wanted: (entry: EntryRecord) => boolean): Promise<EntryRecord | undefined> {
  const own = record.parent ? undefined : firsts.get(record.id);
  if (own && wanted(own)) return own;
  return (await conversation.entries({ order: "ascending" }, within, undefined, context)).items.find(wanted);
}

/** The author of a task input: the conversation that wrote it, as apps/chat names conversations (`<thread>` for the root, else `<thread>:<n>`). */
export const taskAuthor = (thread: string, owner: number): string => (owner === ROOT_CONVERSATION_ID ? thread : `${thread}:${owner}`);

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

/**
 * The thread list's preview line from one entry: the message a tell_owner or send_message call sent, nothing for its result, and the
 * searchable text of any other entry.
 */
export function previewText(entry: EntryRecord, now: number): string | undefined {
  const message = entry.model?.[0] as Message | undefined;
  if (message?.role === "toolResult" && SPEAKING_TOOLS.has(message.toolName)) return undefined;
  if (message?.role === "assistant") {
    const sent = message.content.flatMap(c => (c.type === "toolCall" && SPEAKING_TOOLS.has(c.name) && typeof c.arguments?.text === "string" ? [c.arguments.text as string] : []));
    if (sent.length) return sent.at(-1);
  }
  return describeEntry(entry, now)?.text || undefined;
}

/**
 * The conversation a commit change touches, whose tree node it may change: a conversation record, an entry, a submission or a conversation's
 * doc. A task record and a Session doc feed no node.
 */
function conversationOf(change: CommitChange): number | undefined {
  switch (change.type) {
    case "conversation":
      return change.value.id;
    case "entry":
    case "submission":
      return change.value.conversationId;
    case "document":
    case "document.copy":
      return change.conversationId;
    default:
      return undefined;
  }
}

function usageOf(entry: EntryRecord, thread: string, now: number): UsageRow | undefined {
  const message = entry.model?.[0] as (Message & { usage?: Usage; timestamp?: number }) | undefined;
  if (message?.role !== "assistant" || !message.usage) return undefined;
  const usage = message.usage;
  return {
    thread, conversation: entry.conversationId, entryId: entry.id, model: `${message.provider}/${message.model}`, at: message.timestamp ?? now,
    input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, cost: usage.cost.total,
    costInput: usage.cost.input, costOutput: usage.cost.output, costCacheRead: usage.cost.cacheRead, costCacheWrite: usage.cost.cacheWrite,
  };
}

export class DurableThreads {
  readonly index: ThreadIndex;
  private readonly open = new Map<string, Promise<OpenThread>>();
  /** Each closed thread's doc reads in flight (`docGet`), one after another; an open of the thread waits for them, so one file never has two connections. */
  private readonly peeks = new Map<string, Promise<void>>();
  /** The slot release of each conversation's last settled input, by `<thread>:<conversation>`, until it is done. */
  private readonly releasing = new Map<string, Promise<void>>();
  /** Each open thread's conversations whose run sleeps on a retry, with the retrying's start once read and the last error. */
  private readonly retries = new Map<string, Map<number, { since?: number; error: string }>>();
  private readonly leases = new Leases("pi-host-durable");
  private readonly threadsDir: string;
  private readonly idleCloseMs: number;
  private readonly now: () => number;
  private wakeTimer?: NodeJS.Timeout;
  private closing = false;
  /** Holds each new request and tool call once `shutdown` starts, so the close cuts none of them midway (`drain-gate.ts`). */
  private readonly gate = drainGate(() => this.closing);
  private readonly primeRoots: PrimeRoots | undefined;

  constructor(private readonly options: DurableThreadsOptions) {
    this.primeRoots = options.primeRoots === null ? undefined : options.primeRoots ?? (options.rlm ? new PrimeRoots() : undefined);
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
    if (this.index.rebuilt) {
      // The index dropped its derived rows: open each thread once so its backfill writes them again, then let idle close it.
      for (const row of this.index.list()) {
        try {
          await this.thread(row.id);
        } catch (error) {
          this.log(`reindex ${row.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    this.clearStaleFailed();
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
    void this.retryFailedPosts();
    return due;
  }

  /**
   * Clears `failed` on each row whose thread file's newest settled root input is no failure (`newestRootFailed`), such as a stop an older
   * build counted, so a thread that nothing runs again stops reading failed. A start runs it, so its end state is the same however often.
   */
  private clearStaleFailed(): void {
    const cleared = this.index.list().filter(row => row.failed && existsSync(this.fileOf(row.id)) && newestRootFailed(this.fileOf(row.id)) === false);
    for (const row of cleared) this.index.update(row.id, { failed: false });
    if (cleared.length) this.log(`cleared a stale failed flag on ${cleared.length} threads: ${cleared.map(row => row.id).join(", ")}`);
  }

  /**
   * After a restart, such as the release of a fix, gives each comm thread's newest owner post its turn again when the run that held it
   * failed with no answer and nothing later answered it (`retryInput`), so nobody has to send it again. A read-only look picks the files.
   */
  async retryFailedPosts(): Promise<string[]> {
    const retried: string[] = [];
    for (const row of this.index.list()) {
      if (this.closing) break;
      // Each look is a synchronous read, 1.9 ms on average over the 1,265 files on us-metal02 on 11-22, so the loop yields between files.
      await new Promise(resolve => setImmediate(resolve));
      if (!existsSync(this.fileOf(row.id)) || !mayRetry(this.fileOf(row.id))) continue;
      try {
        const open = await this.thread(row.id);
        const ref = await threadAgent(open.harness, context);
        if (ref?.role !== "comm") continue;
        const input = await retryInput(open.harness, open.storage, ref.room, context);
        if (!input) continue;
        await this.submit(row.id, { ...input, whenBusy: "followUp", ownerTurn: true });
        retried.push(`${row.id} ${input.requestId}`);
      } catch (error) {
        this.log(`retry of ${row.id}'s failed post failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (retried.length) this.log(`retried ${retried.length} failed owner posts: ${retried.join(", ")}`);
    return retried;
  }

  list(options: { archived?: boolean } = {}): ThreadInfo[] {
    return this.index.list(options).map(row => this.withRetry({ ...row, status: statusOf(row) }));
  }

  private defaultModel(): ModelRef {
    const value = this.options.defaultModel;
    return typeof value === "function" ? value() : value;
  }

  private defaultThinkingLevel(): ModelThinkingLevel {
    const value = this.options.defaultThinkingLevel ?? "medium";
    return typeof value === "function" ? value() : value;
  }

  info(id: string): ThreadInfo {
    const row = this.index.get(id);
    if (!row) throw new Error(`No durable thread ${id}`);
    return this.withRetry({ ...row, status: statusOf(row) });
  }

  /** The row with the retrying flag of its longest-retrying conversation, when one has retried past `RETRY_FLAG_MS`. */
  private withRetry(info: ThreadInfo): ThreadInfo {
    const oldest = [...(this.retries.get(info.id)?.values() ?? [])].filter(retry => retry.since !== undefined).sort((a, b) => a.since! - b.since!)[0];
    const text = oldest ? retryingText(oldest.since!, oldest.error, this.now()) : undefined;
    return text ? { ...info, retrying: text } : info;
  }

  /** Notes a conversation's `pi.live` change: a retry starts or goes on, and reads its start once; no retry drops it. */
  private noteRetry(open: OpenThread, conversation: number, value: unknown): void {
    const retry = liveRetry(value);
    const kept = this.retries.get(open.id) ?? new Map<number, { since?: number; error: string }>();
    if (!retry) {
      kept.delete(conversation);
      if (!kept.size) this.retries.delete(open.id);
      return;
    }
    const known = kept.get(conversation);
    kept.set(conversation, { ...known, error: retry.error });
    this.retries.set(open.id, kept);
    if (known) return;
    setImmediate(() => void retrySince(open.harness, conversation as ConversationId, context).then(since => {
      const now = kept.get(conversation);
      if (now && since !== undefined) now.since = since;
    }).catch(error => this.log(`${open.id} retry start read failed: ${error instanceof Error ? error.message : String(error)}`)));
  }

  /**
   * Makes a thread, or answers the thread `input.id` names when one exists, so a create sent again with the same id makes nothing. On 11-23
   * apps/chat's comm thread create for a room timed out three times during a 14 min loop freeze, and each try made its own thread.
   */
  async create(input: { name?: string; model?: ModelRef; thinkingLevel?: ModelThinkingLevel; cwd?: string; id?: string } = {}): Promise<ThreadInfo> {
    const id = input.id ?? randomUUID();
    const known = this.index.get(id);
    if (known) {
      await this.thread(id, { agent: { model: { provider: known.provider, modelId: known.modelId }, thinkingLevel: known.thinkingLevel as ModelThinkingLevel, cwd: known.cwd } });
      return this.info(id);
    }
    const model = input.model ?? this.defaultModel();
    const thinkingLevel = input.thinkingLevel ?? this.defaultThinkingLevel();
    const cwd = input.cwd ?? this.options.defaultCwd;
    const at = this.now();
    this.index.insertThread({ id, name: input.name ?? "New thread", provider: model.provider, modelId: model.modelId, thinkingLevel, cwd, createdAt: at, updatedAt: at });
    await this.thread(id, { agent: { model, thinkingLevel, cwd } });
    return this.info(id);
  }

  /** The open thread, opening its file on first use. */
  thread(id: string, init?: { agent: { model: ModelRef; thinkingLevel: ModelThinkingLevel; cwd: string } }): Promise<OpenThread> {
    if (this.closing) return Promise.reject(new Error("pi-host is shutting down"));
    let opening = this.open.get(id);
    if (!opening) {
      const peek = this.peeks.get(id);
      opening = peek ? peek.then(() => this.openThread(id, init)) : this.openThread(id, init);
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
    let openHarness: Harness | undefined;
    try {
      // Entry scans read a few entries per loop turn: one read of a long context held the loop 100 to 300 ms on 11-23 (chunked-scan.ts).
      const storage = chunkScans(await openNodeSqliteStorage(file));
      const name = () => this.index.get(id)?.name ?? row.name;
      // The row's cwd at each read, so a `set` cwd reaches the open file's tools, prompt, chat extension and kernels from the next call on.
      const cwd = () => this.index.get(id)?.cwd ?? row.cwd;
      const chat = this.options.chat && {
        chat: this.options.chat,
        thread: {
          id, file, name, get cwd() { return cwd(); }, harness: () => openHarness, boardDoc: () => this.docGet(id, "chat.board"), log: (line: string) => this.log(`${id} ${line}`),
          submit: (text: string, requestId: string) => this.submit(id, { text, requestId, whenBusy: "followUp", ownerTurn: true }),
        },
      };
      const prompt = this.options.prompt && { ...this.options.prompt, thread: { id, file, name, get cwd() { return cwd(); }, harness: () => openHarness }, log: (line: string) => this.log(`${id} ${line}`) };
      const comm = commExtension(this.commHost(id));
      const models = this.options.models(id);
      const harness = await Harness.open(storage, {
        models,
        registry: threadRegistry(prompt, chat, {
          thread: { id, file }, comm: comm.extension,
          ...(this.options.rlm ? { rlm: this.options.rlm.extension(this.rlmThread(id, file, name, cwd, () => openHarness, models)) } : {}),
          ...(this.options.rules ? { rules: this.options.rules.extension({ id, file, name, cwd }) } : {}),
          gate: this.gate,
        }),
        env: threadEnv(id, cwd),
        ...(this.options.settings === undefined ? {} : { settings: this.options.settings(id) }),
        onWake: next => {
          wake = next;
          if (state) this.onWake(state, next);
          else this.index.setWake(id, next, this.now());
        },
        onReport: (error: unknown, info: ReportInfo) => this.log(`${id} ${info.type}${"reason" in info && info.reason ? ` ${String(info.reason)}` : ""}: ${error instanceof Error ? error.message : String(error)}`),
      }, context);
      openHarness = harness;
      const root = await harness.root(context, init ? { agent: init.agent } : undefined);
      if (root.id !== ROOT_CONVERSATION_ID) throw new Error(`${file}: the root conversation is ${root.id}`);
      // The role from this release's code, so a role whose tools or text changed reaches the thread on its first open after the restart.
      const ref = await threadAgent(harness, context);
      if (ref) await harness.commit(tx => applyAgentRole(tx, ref), context);
      // The pool tree before the first request after the open, which `harness.resume()` below may start.
      if (this.options.pool) this.options.pool.agent({ id, name: name() }, ref, ref?.role === "comm" ? await this.sessionOf(harness, ROOT_CONVERSATION_ID) : undefined);
      const tasks = await this.backfill(id, harness);
      state = { id, file, harness, root, watchers: new Set(), wake, stopCommits: () => {}, ...(prompt ? { prompt } : {}), digesting: Promise.resolve(), tasks, comm, storage, treeNodes: new Map(), treeTouches: new Map() };
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

  /** The thread as the RLM runtime reaches it: its conversations' inputs, the other threads' roots, and new threads for `rlm.create_session`. */
  private rlmThread(id: string, file: string, name: () => string, cwd: () => string, harness: () => Harness | undefined, models: Models): RlmThread {
    return {
      id, file, name, harness, models,
      get cwd() { return cwd(); },
      submit: input => this.submit(id, { conversation: input.conversation, text: input.text, requestId: input.requestId, whenBusy: input.whenBusy, entry: input.entry }),
      roots: async () => {
        const threads: RootRow[] = this.list().map(row => ({ kind: "pi", id: row.id, name: row.name, cwd: row.cwd, status: row.status }));
        if (!this.primeRoots) return { rows: threads };
        const prime = await this.primeRoots.list();
        return { rows: [...threads, ...prime.roots], ...(prime.missing ? { missing: prime.missing } : {}) };
      },
      submitRoot: async (root, input) => {
        if (root.kind === "pi") return this.sendRoot(id, root.id, input);
        if (!this.primeRoots) throw new Error(`Prime session ${root.id} is not reachable from here`);
        return this.primeRoots.send(root.id, input.text);
      },
      observeRoot: (root, open) => this.observe(root, { open }),
      releaseSlot: async session => { await this.options.turns?.release(id, session); },
      recordUsage: row => this.index.addUsage(row),
      createSession: async input => {
        const created = await this.create({
          ...(input.name ? { name: input.name } : {}), ...(input.model ? { model: input.model } : {}), cwd: input.cwd,
          ...(input.thinking ? { thinkingLevel: input.thinking as ModelThinkingLevel } : {}),
        });
        await this.submit(created.id, { text: input.prompt, entry: { kind: "agent.message", data: { from: id, via: "rlm.create_session" } } });
        return { id: created.id, name: created.name, file: this.fileOf(created.id), model: `${created.provider}/${created.modelId}` };
      },
      log: line => this.log(`${id} ${line}`),
    };
  }

  /** What a thread's comm extension reaches: the other threads' inputs, waits, answers, names and aborts. */
  private commHost(id: string): CommHost {
    return {
      thread: id,
      submit: (thread, input) => this.submit(thread, input),
      wait: (thread, submission, waitContext) => this.wait(thread, submission, waitContext),
      answer: async (thread, entry) => {
        const open = await this.thread(thread);
        return (await open.harness.commit(tx => tx.entry(entry as EntryId), context))?.model?.[0] as Message | undefined;
      },
      name: thread => this.index.get(thread)?.name ?? thread,
      abort: thread => this.abort(thread),
      closing: () => this.closing,
    };
  }

  /**
   * An agent message from one thread's root to another's. A comm thread's message to its agent's work thread becomes a `comm.hand` task of
   * the comm thread, which admits it and sends the work-done notice when it settles; a message to a comm thread from its work thread is
   * counted there, so that notice goes out only when the work thread wrote nothing back.
   */
  private async sendRoot(from: string, to: string, input: CommSubmit): Promise<unknown> {
    const sender = await this.thread(from);
    const ref = await threadAgent(sender.harness, context);
    if (ref?.role === "comm" && ref.work === to) {
      this.index.markActive(from, this.now());
      const at = this.now();
      const task = await sender.harness.commit(async tx => {
        await noteHanded(tx, at);
        return tx.createTask(sender.comm.hand, { work: to, ...input }, { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID, background: true });
      }, context);
      this.onWake(sender, sender.harness.wake());
      return { task };
    }
    const result = await this.submit(to, { text: input.text, requestId: input.requestId, whenBusy: input.whenBusy, entry: input.entry });
    const target = await this.thread(to);
    const targetRef = await threadAgent(target.harness, context);
    if (targetRef?.role === "comm" && targetRef.work === from) await target.harness.commit(tx => noteHeard(tx, from), context);
    return result;
  }

  /**
   * A thread's root as another thread's `agent_observe` reads it: its run, its harness (whose root context the reader reads), live rlm children
   * and turn-queue place. It submits and writes nothing. With `open` false, a closed file gives undefined.
   */
  async observe(id: string, options: { open?: boolean } = {}): Promise<PiRootView | undefined> {
    if (!options.open && !this.open.has(id)) return undefined;
    const open = await this.thread(id);
    const harness = open.harness;
    const running = Boolean((await harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context))?.run);
    const children: PiRootView["children"] = [];
    const next = loopSlices();
    for (const record of await this.conversations(harness)) {
      await next();
      if (record.owner?.conversationId !== ROOT_CONVERSATION_ID) continue;
      const doc = await harness.snapshot(RlmChildDoc, record.id, context);
      if (!doc?.id || doc.deleted) continue;
      const live = Boolean((await harness.snapshot(LiveDoc, record.id, context))?.run);
      if (live || doc.status === "running") children.push({ id: `${id}:${record.id}`, name: doc.name, status: "running", progressNote: doc.progressNote || null });
    }
    const session = (await harness.snapshot(ProviderDoc, ROOT_CONVERSATION_ID, context))?.sessionId;
    const row = this.info(id);
    return {
      status: running ? "running" : row.status, running, cwd: row.cwd, harness, children,
      ...(this.options.turns && session ? { turnQueue: this.options.turns.ticket(id, session).place } : {}),
    };
  }

  /**
   * Adds every entry the index has not seen, so search and usage cover what a crashed process committed, and answers each task-owned
   * conversation's task input, so the commits after it keep crediting that input to the conversation that wrote it.
   */
  private async backfill(id: string, harness: Harness): Promise<Map<number, TaskInput>> {
    const mark = this.index.indexedEntry(id);
    const now = this.now();
    const conversations = await this.conversations(harness);
    const entries: IndexedEntry[] = [];
    const usage: UsageRow[] = [];
    const tasks = new Map<number, TaskInput>();
    let preview: string | undefined;
    const firsts = new FirstEntries(this.fileOf(id));
    // A turn of the loop between conversations: in one go, 72ba1ed2's 445 held it 369 ms on 11-23 (~/work/pi-host-stalls/e-cold-tree/).
    const next = loopSlices();
    try {
      for (const record of conversations) {
        await next();
        const conversation = await harness.conversation(record.id, context);
        if (!conversation) continue;
        if (record.owner) {
          // The task is the conversation's first input; one sent as an agent message (8116f3dd on) already names its sender.
          const first = await firstEntry(conversation, record, firsts, 8, isInput);
          tasks.set(record.id, { owner: record.owner.conversationId, ...(first ? { entry: first.kind === "pi.user" ? first.id : NO_TASK_INPUT } : {}) });
        }
        let cursor: Parameters<Conversation["entries"]>[2];
        do {
          const page = await conversation.entries({ order: "ascending", minEntryId: (mark + 1) as EntryRecord["id"] }, PAGE_MAX, cursor, context);
          for (const entry of page.items) {
            this.collect(id, entry, now, entries, usage, tasks);
            if (record.id === ROOT_CONVERSATION_ID) preview = previewText(entry, now) ?? preview;
          }
          cursor = page.next;
          if (cursor !== undefined) await next();
        } while (cursor !== undefined);
      }
    } finally {
      firsts.close();
    }
    this.index.addEntries(id, entries.sort((a, b) => a.entryId - b.entryId), usage);
    const root = conversations.find(c => c.id === ROOT_CONVERSATION_ID);
    if (root) this.index.update(id, { children: conversations.length - 1, ...(preview ? { preview: preview.slice(0, PREVIEW_CHARS) } : {}) });
    return tasks;
  }

  private collect(thread: string, entry: EntryRecord, now: number, entries: IndexedEntry[], usage: UsageRow[], tasks: Map<number, TaskInput>): void {
    const described = describeEntry(entry, now);
    const task = isInput(entry) ? tasks.get(entry.conversationId) : undefined;
    if (task && task.entry === undefined) task.entry = entry.kind === "pi.user" ? entry.id : NO_TASK_INPUT;
    if (described && task?.entry === entry.id) described.author = taskAuthor(thread, task.owner);
    if (described) entries.push({ thread, conversation: entry.conversationId, entryId: entry.id, kind: entry.kind, ...described, ...speechOf(entry) });
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
    for (const change of publication.changes) {
      const touched = conversationOf(change);
      if (touched === undefined) continue;
      open.treeNodes.delete(touched);
      open.treeTouches.set(touched, (open.treeTouches.get(touched) ?? 0) + 1);
    }
    const now = this.now();
    const entries: IndexedEntry[] = [];
    const usage: UsageRow[] = [];
    let preview: string | undefined;
    const failed = rootFailed(publication.changes);
    for (const change of publication.changes) {
      if (change.type !== "conversation") continue;
      const owner = (change.value as ConversationRecord).owner;
      if (owner && !open.tasks.has(change.value.id)) open.tasks.set(change.value.id, { owner: owner.conversationId });
    }
    for (const change of publication.changes) {
      if (change.type === "entry") {
        this.collect(open.id, change.value, now, entries, usage, open.tasks);
        if (change.value.conversationId === ROOT_CONVERSATION_ID) {
          const text = previewText(change.value, now);
          if (text) preview = text.slice(0, PREVIEW_CHARS);
        }
      } else if (change.type === "submission") {
        const record = change.value as SubmissionRecord;
        if (record.type === "input" && (record.status === "done" || record.status === "unanswered")) this.settle(open, record.conversationId);
      } else if (change.type === "conversation") {
        void this.announceConversation(open, change.value);
      } else if (change.type === "document" && change.record.kind === "pi.live" && change.conversationId !== undefined) {
        this.noteRetry(open, change.conversationId, change.value);
      }
    }
    const runFailed = failedInputs(publication.changes);
    // Off the commit listener, which must not call Session APIs.
    if (runFailed.length) setImmediate(() => void this.reportFailure(open, runFailed));
    try {
      if (entries.length || usage.length) this.index.addEntries(open.id, entries, usage);
      if (preview !== undefined || failed !== undefined) this.index.update(open.id, { updatedAt: now, ...(preview === undefined ? {} : { preview }), ...(failed === undefined ? {} : { failed }) });
    } catch (error) {
      this.log(`${open.id} index write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Gives a settled input's slot back off the commit listener, which must not call Session APIs. The release is kept
   * per conversation from the settle commit on, so `submit` waits for it before it reads the queue and admits.
   */
  private settle(open: OpenThread, conversation: ConversationId): void {
    const key = `${open.id}:${conversation}`;
    const released = (this.releasing.get(key) ?? Promise.resolve())
      .then(() => new Promise<void>(resolve => setImmediate(resolve)))
      .then(() => this.settled(open, conversation))
      .then(() => this.options.rlm?.settled(open.id, conversation).catch(error => this.log(`${open.id} kernel settle failed: ${error instanceof Error ? error.message : String(error)}`)));
    this.releasing.set(key, released);
    void released.then(() => {
      if (this.releasing.get(key) === released) this.releasing.delete(key);
    });
  }

  private async settled(open: OpenThread, conversation: ConversationId): Promise<void> {
    if (!this.options.inputSettled) return;
    try {
      const provider = await open.harness.snapshot(ProviderDoc, conversation, context);
      if (!provider?.sessionId) {
        this.log(`${open.id} conversation ${conversation} settled an input with no provider session id`);
        return;
      }
      const live = await open.harness.snapshot(LiveDoc, conversation, context);
      await this.options.inputSettled(open.id, provider.sessionId, Boolean(live?.run));
    } catch (error) {
      this.log(`${open.id} settle hook failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Tells someone once that a root run ended with no answer on an error pi-durable does not retry (`turn-failed.ts`): a comm thread posts
   * `roomLine` in the thread of the failed room post, and the agent's work thread for a job, or else agent factory's, gets the notice;
   * agent factory's own work thread tells its DM comm thread. The room line names who is told only when someone is.
   */
  private async reportFailure(open: OpenThread, failed: FailedInput[]): Promise<void> {
    const first = failed[0]!;
    try {
      const ref = await threadAgent(open.harness, context);
      let work: string | undefined;
      try {
        work = await this.options.agentWork?.(failureTarget(ref));
      } catch (error) {
        this.log(`${open.id} failure notice: ${failureTarget(ref)}'s work thread did not resolve: ${error instanceof Error ? error.message : String(error)}`);
      }
      // Agent factory's own work thread would tell itself, so its DM comm thread hears and tells the owner.
      const toComm = work === open.id && ref?.role === "work" ? ref.comm : undefined;
      const target = toComm ?? work;
      const told = target && target !== open.id ? toldName(ref) : undefined;
      const post = ref?.role === "comm" ? failed.map(input => roomPost(input.requestId, ref.room)).findLast(Boolean) : undefined;
      if (post && !isRetry(first)) {
        const model = await lastModel(open.harness, context);
        if (model) for (const write of roomLineWrites(first, post, model, this.now(), roomLine(told, first.error))) await open.root.submit(write, context);
        // An error that clears on its own gives the post its one retry now, not at the next restart (`clearsOnItsOwn`).
        const retry = ref?.role === "comm" && clearsOnItsOwn(first.error) ? await retryInput(open.harness, open.storage, ref.room, context) : undefined;
        if (retry) await this.submit(open.id, { ...retry, whenBusy: "followUp", ownerTurn: true });
      }
      const name = this.index.get(open.id)?.name ?? open.id;
      if (!told || !target) {
        this.log(`${open.id} run failed with no one to tell: ${first.error}`);
        return;
      }
      await this.submit(target, {
        text: failureNotice({ id: open.id, name }, ref, first, Boolean(toComm)), requestId: `turn-failed:${open.id}:${first.submission}`, whenBusy: "followUp",
        entry: { kind: "agent.message", data: { from: open.id, via: TURN_FAILED_VIA } },
      });
    } catch (error) {
      this.log(`${open.id} failure notice failed: ${error instanceof Error ? error.message : String(error)}`);
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
    this.index.setWake(open.id, wake, this.now());
    const row = this.index.get(open.id);
    const status = row ? statusOf(row) : wake.active ? "running" : "idle";
    for (const watcher of open.watchers) watcher.sink({ type: "status", status, ...(wake.at === undefined ? {} : { wakeAt: wake.at }) });
    this.touch(open);
    this.armSleep(open);
    this.armWakes();
  }

  /**
   * Resumes an open file at its earliest sleep whatever `wake.active` says: a sleep under a running task, such as a
   * child's turn poll or retry backoff while the root's subagent call waits on it, has no other timer.
   */
  private armSleep(open: OpenThread): void {
    if (open.sleepTimer) clearTimeout(open.sleepTimer);
    open.sleepTimer = undefined;
    const at = open.wake.at;
    if (at === undefined || this.closing || this.open.get(open.id) === undefined) return;
    open.sleepTimer = setTimeout(() => {
      open.sleepTimer = undefined;
      open.harness.resume();
      // An unchanged wake gives no onWake, so a sleep still ahead of the clock keeps its timer from here.
      if (open.wake.at === at && at > this.now()) this.armSleep(open);
    }, Math.min(Math.max(0, at - this.now()), 2 ** 31 - 1));
    open.sleepTimer.unref();
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
    this.retries.delete(id);
    const open = await opening;
    if (open.idleTimer) clearTimeout(open.idleTimer);
    if (open.sleepTimer) clearTimeout(open.sleepTimer);
    open.stopCommits();
    for (const watcher of open.watchers) {
      for (const stream of watcher.streams.values()) await stream.stop().catch(() => undefined);
      watcher.sink({ type: "closed", reason });
    }
    open.watchers.clear();
    this.options.pool?.closed(id);
    await this.options.rlm?.closeThread(id, reason).catch(error => this.log(`${id} kernels did not close: ${error instanceof Error ? error.message : String(error)}`));
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

  /** The provider session id of a conversation, which is its session in pi-pool's turn queue. */
  private async sessionOf(harness: Harness, conversation: ConversationId): Promise<string> {
    const existing = await harness.snapshot(ProviderDoc, conversation, context);
    if (existing?.sessionId) return existing.sessionId;
    // A conversation from before pi.provider gets its identity in one commit, as pi-durable's ensureProviderSessionId does.
    return harness.commit(async tx => (await tx.doc(ProviderDoc, conversation)).sessionId, context);
  }

  /** Where a conversation's run stands in pi-pool's turn queue. */
  async ticket(id: string, conversationId?: number): Promise<TurnTicket | undefined> {
    if (!this.options.turns) return undefined;
    const open = await this.thread(id);
    const conversation = await this.conversation(open, conversationId);
    return this.options.turns.ticket(id, await this.sessionOf(open.harness, conversation.id));
  }

  /**
   * Admits one input durably and returns at once; `wait` reacquires it by id, also after a restart. An owner input
   * marks its run in pi-pool's turn queue before the admit, because the admit starts the run, unless the run already
   * holds its slot and takes the input as a steer or follow-up.
   */
  async submit(id: string, input: SubmitInput): Promise<SubmitResult> {
    const open = await this.thread(id);
    if (scheduled(input) && input.conversation !== undefined && input.conversation !== ROOT_CONVERSATION_ID) {
      const gone = await this.removedJob(open, input.conversation);
      if (gone) {
        this.log(`${id}:${input.conversation} ${gone}: dropped its ${input.entry?.data.via ?? "scheduled input"} ${input.requestId ?? ""}, no run`);
        void this.options.rlm?.forget(id, input.conversation);
        throw new InputDropped(`${id}:${input.conversation} ${gone}`);
      }
    }
    const conversation = await this.conversation(open, input.conversation);
    const content: (TextContent | ImageContent)[] = [];
    if (input.text) content.push({ type: "text", text: input.text });
    for (const image of input.images ?? []) content.push({ type: "image", data: image.data, mimeType: image.mimeType });
    if (!content.length) throw new Error("durable_submit needs text or images");
    const requestId = input.requestId ?? `pi-host:${randomUUID()}`;
    const turns = this.options.turns;
    const session = turns ? await this.sessionOf(open.harness, conversation.id) : undefined;
    // Right after a settle, turns.json still shows the ended run working until its release lands, which would skip the
    // mark and let the next run renew a slot that the release then drops.
    await this.releasing.get(`${id}:${conversation.id}`);
    let owner: OwnerMark | undefined;
    if (input.ownerTurn && turns && session && turns.ticket(id, session).place.state !== "working") owner = await turns.ownerTurn(id, session);
    this.index.markActive(id, this.now(), conversation.id === ROOT_CONVERSATION_ID);
    if (conversation.id === ROOT_CONVERSATION_ID) this.options.pool?.submitted(id);
    if (open.prompt && conversation.id === ROOT_CONVERSATION_ID) await this.deliverDigest(open, conversation.id, input);
    const submission = await conversation.submit({
      type: "input", content, requestId,
      ...(input.whenBusy ? { whenBusy: input.whenBusy } : {}),
      ...(input.entry ? { entry: { kind: input.entry.kind, data: input.entry.data } } : {}),
    }, context);
    const status = (await submission.status(context)).status;
    // A repeated request id admits nothing and changes no wake, so the mark set above is cleared from the Harness's own value.
    this.onWake(open, open.harness.wake());
    return {
      submission: submission.id, requestId, status,
      ...(turns && session ? { ticket: turns.ticket(id, session) } : {}),
      ...(owner ? { owner } : {}),
    };
  }

  /** Why a job conversation takes no scheduled input: it does not exist, or it or a job above it was removed (`rlm.delete_subagent`). */
  private async removedJob(open: OpenThread, conversation: number): Promise<string | undefined> {
    const chain = await open.harness.commit(async tx => {
      const ids: number[] = [];
      for (let at: number | undefined = conversation; at !== undefined && at !== ROOT_CONVERSATION_ID && ids.length < 64;) {
        const record = await tx.conversation(at as ConversationId);
        if (!record) return undefined;
        ids.push(at);
        at = record.owner?.conversationId;
      }
      return ids;
    }, context);
    if (!chain) return "does not exist";
    for (const at of chain) {
      if ((await open.harness.snapshot(RlmChildDoc, at as ConversationId, context))?.deleted) return at === conversation ? "was removed" : `is under removed job ${at}`;
    }
    return undefined;
  }

  /** Prime's harness check for the turn the input starts (`deliverHarnessDigest`), one at a time per thread; a failure only logs. */
  private deliverDigest(open: OpenThread, conversation: ConversationId, input: SubmitInput): Promise<void> {
    const prompt = open.prompt!;
    const run = open.digesting.then(() => deliverHarnessDigest(prompt, open.harness, conversation, { text: input.text ?? "", ...(input.whenBusy ? { whenBusy: input.whenBusy } : {}) }, context, this.now()))
      .catch(error => this.log(`${open.id} harness digest failed: ${error instanceof Error ? error.message : String(error)}`));
    open.digesting = run;
    return run;
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

  /**
   * Changes a thread's name, model, thinking level, archived flag or cwd. A new cwd goes into the root conversation's agent, which its next
   * request reads for the tools' environment and Prime's prompt, and into the row, which the open file's chat extension and kernels read.
   */
  async set(id: string, change: { name?: string; model?: ModelRef; thinkingLevel?: ModelThinkingLevel; archived?: boolean; cwd?: string; jobs?: boolean }): Promise<ThreadInfo> {
    const before = this.info(id);
    if (change.cwd !== undefined) {
      if (!isAbsolute(change.cwd)) throw new Error(`cwd must be an absolute path, got ${JSON.stringify(change.cwd)}`);
      if (!existsSync(change.cwd) || !statSync(change.cwd).isDirectory()) throw new Error(`cwd ${change.cwd} is not a folder on this box`);
    }
    if (change.model || change.thinkingLevel || change.cwd !== undefined) {
      const open = await this.thread(id);
      await open.root.configure({
        ...(change.model ? { model: change.model } : {}), ...(change.thinkingLevel ? { thinkingLevel: change.thinkingLevel } : {}),
        ...(change.cwd === undefined ? {} : { cwd: change.cwd }),
      }, context);
      if (change.jobs && (change.model || change.thinkingLevel)) await this.moveJobs(open, { provider: before.provider, modelId: before.modelId }, change);
    }
    this.index.update(id, {
      ...(change.name === undefined ? {} : { name: change.name }),
      ...(change.cwd === undefined ? {} : { cwd: change.cwd }),
      ...(change.model ? { provider: change.model.provider, modelId: change.model.modelId } : {}),
      ...(change.thinkingLevel ? { thinkingLevel: change.thinkingLevel } : {}),
      ...(change.archived === undefined ? {} : { archived: change.archived }),
      updatedAt: this.now(),
    });
    // An archive ends the thread's jobs, as Prime's chat service ends an archived job's leftovers (`DurableRlm.endThread`).
    if (change.archived === true && !before.archived) void this.options.rlm?.endThread(id, this.fileOf(id)).catch(error => this.log(`${id} job ends failed: ${error instanceof Error ? error.message : String(error)}`));
    return this.info(id);
  }

  /**
   * With `jobs`, `set` moves each job conversation that runs the root's old model to the new model and thinking level from its next request
   * on, as c221 moved every thread and job to Fable 5.2 on 2026-11-10. A job spawned on another model keeps it.
   */
  private async moveJobs(open: OpenThread, old: ModelRef, change: { model?: ModelRef; thinkingLevel?: ModelThinkingLevel }): Promise<void> {
    for (const record of await this.conversations(open.harness)) {
      if (record.id === ROOT_CONVERSATION_ID) continue;
      const conversation = await open.harness.conversation(record.id, context);
      const model = conversation ? (await conversation.agent(context)).model : undefined;
      if (!conversation || model?.provider !== old.provider || model.modelId !== old.modelId) continue;
      await conversation.configure({ ...(change.model ? { model: change.model } : {}), ...(change.thinkingLevel ? { thinkingLevel: change.thinkingLevel } : {}) }, context);
      // rlm.list_subagents reads a job's model and thinking from its RlmChildDoc.
      if ((await open.harness.snapshot(RlmChildDoc, record.id, context))?.id) {
        await open.harness.commit(async tx => {
          const doc = await tx.doc(RlmChildDoc, record.id);
          if (change.model) doc.model = `${change.model.provider}/${change.model.modelId}`;
          if (change.thinkingLevel) doc.thinking = change.thinkingLevel;
        }, context);
      }
    }
  }

  /** Entries newest first: `before` is an exclusive entry id, so the timeline loads the newest page and scrolls up. */
  async entries(id: string, query: { conversation?: number; before?: number; after?: number; limit?: number; lean?: boolean }): Promise<{ entries: EntryRecord[]; more: boolean }> {
    const open = await this.thread(id);
    const conversation = await this.conversation(open, query.conversation);
    const limit = Math.min(query.limit ?? 50, PAGE_MAX);
    const page = await conversation.entries({
      order: query.after === undefined ? "descending" : "ascending",
      ...(query.before === undefined ? {} : { maxEntryId: (query.before - 1) as EntryRecord["id"] }),
      ...(query.after === undefined ? {} : { minEntryId: (query.after + 1) as EntryRecord["id"] }),
    }, limit, undefined, context);
    return { entries: query.lean ? page.items.map(leanEntry) : [...page.items], more: page.next !== undefined };
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
    const firsts = new FirstEntries(open.file);
    // A turn of the loop between built nodes: a cold tree of 72ba1ed2's 445 held it 424 ms in one go on 11-23 (~/work/pi-host-stalls/e-cold-tree/).
    const next = loopSlices();
    try {
      for (const record of records) {
        const kept = open.treeNodes.get(record.id);
        if (kept) {
          nodes.push({ ...kept, depth: depthOf(record.id), ...(record.id === ROOT_CONVERSATION_ID ? { name: this.info(id).name } : {}) });
          continue;
        }
        await next();
        const node = await this.treeNode(open, record, depthOf(record.id), firsts);
        if (node) nodes.push(node);
      }
    } finally {
      firsts.close();
    }
    return nodes;
  }

  /** A conversation's tree node, built from its records and kept until a commit touches the conversation; undefined when it is gone. */
  private async treeNode(open: OpenThread, record: ConversationRecord, depth: number, firsts: FirstEntries): Promise<TreeNode | undefined> {
    const touches = open.treeTouches.get(record.id) ?? 0;
    const conversation = await open.harness.conversation(record.id, context);
    if (!conversation) return undefined;
    const first = await firstEntry(conversation, record, firsts, 4, entry => Boolean(describeEntry(entry, 0)?.text));
    const described = first ? describeEntry(first, 0) : undefined;
    const live = await open.harness.snapshot(LiveDoc, record.id, context);
    const retry = liveRetry(live);
    const since = retry ? await retrySince(open.harness, record.id, context) : undefined;
    const retrying = retry && since !== undefined ? retryingText(since, retry.error, this.now()) : undefined;
    const agent = await conversation.agent(context);
    const node: TreeNode = {
      id: record.id, parent: record.owner?.conversationId ?? null, ownerTask: record.owner?.taskId ?? null,
      name: record.id === ROOT_CONVERSATION_ID ? this.info(open.id).name : (await rlmChildName(open.harness, record.id, context)) ?? jobTitle(described?.text ?? ""),
      depth, status: live?.run ? "running" : "idle", model: agent.model ? `${agent.model.provider}/${agent.model.modelId}` : null,
      createdAt: described?.at ?? null, ...(retrying ? { retrying } : {}),
    };
    // A retrying node's text names the time, so it is built again on each read.
    if (!retry && (open.treeTouches.get(record.id) ?? 0) === touches) open.treeNodes.set(record.id, node);
    return node;
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

  /** A chat.doc's value, or null. A thread that is not open answers from its file and stays closed (`doc-peek.ts`). */
  async docGet(id: string, name: string, conversation?: number): Promise<unknown> {
    const target = (conversation ?? ROOT_CONVERSATION_ID) as ConversationId;
    if (!this.closing && !this.open.has(id)) {
      if (!this.index.get(id)) throw new Error(`No durable thread ${id}`);
      const file = this.fileOf(id);
      // A row with no file yet: the open below makes it, as before.
      if (existsSync(file)) return this.peek(id, () => peekDoc({ file, conversation: target, name }, line => this.log(line)));
    }
    const open = await this.thread(id);
    const doc = await open.harness.snapshot(ChatDoc, target, name, context);
    return doc?.value ?? null;
  }

  /** Runs a read of a closed thread's file after the thread's earlier ones; `thread()` waits for the last before it opens the file. */
  private peek<T>(id: string, read: () => Promise<T>): Promise<T> {
    const result = (this.peeks.get(id) ?? Promise.resolve()).then(read);
    const done = result.then(() => undefined, () => undefined);
    this.peeks.set(id, done);
    void done.then(() => { if (this.peeks.get(id) === done) this.peeks.delete(id); });
    return result;
  }

  /**
   * Writes a chat.doc. An `agent.ref` in the root conversation also sets the root's tools and instructions for its role, in the same commit.
   * With `newerOnly` the doc it holds stays when its `rev` is above `value.rev`, checked in the same commit, and the answer is false: apps/chat
   * puts a board after it answered the write, so a put that lands late, such as one a release's stop left running, must not replace a later
   * board (apps/chat/server/boards.ts `putBoards`).
   */
  async docPut(id: string, name: string, value: unknown, conversation?: number, opts: { newerOnly?: boolean } = {}): Promise<boolean> {
    const open = await this.thread(id);
    const target = (conversation ?? ROOT_CONVERSATION_ID) as ConversationId;
    let written = true;
    await open.harness.commit(async tx => {
      const draft = await tx.doc(ChatDoc, target, name, null);
      if (opts.newerOnly && revOf(draft.value) > revOf(value)) {
        written = false;
        return;
      }
      draft.value = value as never;
      if (name === AGENT_REF_DOC && target === ROOT_CONVERSATION_ID) await applyAgentRole(tx, parseAgentRef(value));
    }, context);
    if (!written) return false;
    if (name === AGENT_REF_DOC && target === ROOT_CONVERSATION_ID && this.options.pool) {
      const ref = parseAgentRef(value);
      this.options.pool.agent({ id, name: this.index.get(id)?.name ?? id }, ref, ref?.role === "comm" ? await this.sessionOf(open.harness, ROOT_CONVERSATION_ID) : undefined);
    }
    for (const watcher of open.watchers) watcher.sink({ type: "doc", conversation: target, name, value });
    return true;
  }

  /**
   * Imports a Prime or Pi session file as a new thread (`import.ts`). The file is only read; the old thread keeps
   * running where it is. The model and thinking level are the session's last ones unless given.
   */
  async importSession(path: string, input: { name?: string; model?: ModelRef; thinkingLevel?: ModelThinkingLevel; cwd?: string } = {}): Promise<ThreadInfo & { imported: number; skipped: Record<string, number> }> {
    const parsed = parseSession(path);
    const created = await this.create({
      name: input.name ?? parsed.name ?? `Imported ${parsed.id ?? path}`,
      model: input.model ?? parsed.model ?? this.defaultModel(),
      thinkingLevel: input.thinkingLevel ?? parsed.thinkingLevel ?? this.defaultThinkingLevel(),
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

  search(query: SearchQuery): SearchPage {
    return this.index.search(query);
  }

  /** The index rows after `cursor`, which the chat reads into its one Meilisearch index for every box. */
  indexRead(cursor: string | undefined): IndexRead {
    return this.index.read(cursor);
  }

  isLocked(error: unknown): error is SessionLockedError {
    return error instanceof SessionLockedError;
  }
}
