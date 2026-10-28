/**
 * The one seam between the chat server and pi-host. Every host call goes through `Host`, which pi-host's socket (`pi-host.ts`) and the
 * fixture (`fixture.ts`) both implement. The shapes mirror pi-host's `durable_*` commands (packages/pi-host/src/durable/README.md).
 */
import type { TurnPlace } from "../../web/src/lib/api/types.ts";

export type ThreadStatus = "idle" | "running" | "sleeping" | "failed";

export interface DurableThread {
  id: string; name: string; provider: string; modelId: string; thinkingLevel: string; cwd: string;
  createdAt: number; updatedAt: number; wakeAt?: number; failed: boolean; archived: boolean; preview: string; children: number; status: ThreadStatus;
}

export interface TreeNode { id: number; parent: number | null; ownerTask: number | null; name: string; depth: number; status: "idle" | "running"; model: string | null; createdAt: number | null }

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } }

export interface Message {
  role: "user" | "assistant" | "toolResult" | "system";
  content: string | ContentBlock[];
  timestamp?: number;
  provider?: string; model?: string; usage?: Usage; stopReason?: string; errorMessage?: string;
  toolCallId?: string; toolName?: string; isError?: boolean; details?: Record<string, unknown>;
}

export interface EntryRecord { id: number; conversationId: number; kind: string; model?: Message[]; data?: unknown; head?: number; byTaskId?: number }

export interface SubmissionRecord { id: number; conversationId: number; requestId?: string; type: string; status: string; entry?: number; answer?: number }

/** The agent events this server reads; pi-durable sends more, which pass through untyped. */
export type AgentEvent =
  | { type: "snapshot"; generation?: { message?: Message }; tools?: { toolCallId: string; toolName: string }[]; inbox?: unknown[] }
  | { type: "run_start" | "run_end"; inputs: number[] }
  | { type: "message_start"; message: Message }
  | { type: "message_update"; changes: ({ type: string; delta?: string; contentIndex: number; block?: ContentBlock } | { type: "message"; message: Message })[] }
  | { type: "message_end"; entry: EntryRecord }
  | { type: "entry_appended"; entry: EntryRecord }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; output?: { trimStart?: number; append?: string } | { set: string } }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; entry?: EntryRecord }
  | { type: "submission"; record: SubmissionRecord }
  | { type: "task_failed"; kind: string; message: string }
  | { type: "auto_retry_start"; attempt: number; at: number; errorMessage: string }
  | { type: "other"; [key: string]: unknown };

export type DurableEvent =
  | { type: "events"; conversation: number; events: AgentEvent[] }
  | { type: "conversation"; node: TreeNode }
  | { type: "status"; status: ThreadStatus; wakeAt?: number }
  | { type: "doc"; conversation: number; name: string; value: unknown }
  | { type: "closed"; reason: string };

/** `text` is the entry's whole indexed text, only when the query asked `withText`. */
export interface SearchHit { thread: string; conversation: number; entryId: number; kind: string; author: string; at: number; snippet: string; text?: string }
/** pi-host's durable_search: `from` matches the author column, `by` is what one agent said (its own entries and the agent messages it sent). */
export interface SearchQuery {
  q: string; threads?: string[]; conversation?: number; from?: string; by?: { thread: string; conversation: number; id: string };
  /** A LIKE pattern: agent messages whose text matches it are left out, such as the copies of channel posts. */
  skipAgentMessages?: string;
  /** An author to leave out; `kinds` and `skipKinds` keep or leave out entry kinds; `demoteKinds` rank after every other match by relevance. */
  notFrom?: string; kinds?: string[]; skipKinds?: string[]; demoteKinds?: string[];
  withText?: boolean;
  after?: number; before?: number; limit?: number; offset?: number; sort?: "relevance" | "recent";
}
/** One page of hits and the exact count of every match; copies of one entry in several threads count and show once. */
export interface SearchPage { hits: SearchHit[]; total: number }
export interface UsageTotal {
  thread: string; model: string; turns: number; input: number; output: number; cacheRead: number; cacheWrite: number;
  cost: number; costInput: number; costOutput: number; costCacheRead: number; costCacheWrite: number;
}

export interface Ticket { session: string; tree: string; place: TurnPlace }
export interface Submitted {
  submission: number; requestId?: string; status: string; ticket?: Ticket | null;
  /** With `ownerTurn`: whether pi-pool marked the run as the owner's, and how many runs it put it ahead of. */
  owner?: { state: "marked" | "off" | "failed"; ahead?: number };
}

export interface SubmitInput {
  conversation?: number; text?: string; images?: { data: string; mimeType: string }[]; requestId?: string;
  whenBusy?: "steer" | "followUp" | "reject"; entry?: { kind: "agent.message"; data: { from: string; via?: string } };
  /** The owner's own input: pi-host marks the run with `pi-pool owner-turn`, so it starts at once. */
  ownerTurn?: boolean;
}

export interface Host {
  readonly name: string;
  threads(opts?: { archived?: boolean }): Promise<DurableThread[]>;
  create(opts: { name?: string; model?: string; thinkingLevel?: string; cwd?: string }): Promise<DurableThread>;
  submit(thread: string, input: SubmitInput): Promise<Submitted>;
  /** The conversation's run in pi-pool's turn queue now, or null when it has none. */
  ticket(thread: string, conversation?: number): Promise<Ticket | null>;
  abort(thread: string, conversation?: number): Promise<void>;
  /** Resolves once the submission is done or unanswered; `answer` is the entry that answered it. */
  wait(thread: string, submission: number): Promise<SubmissionRecord>;
  tree(thread: string): Promise<TreeNode[]>;
  /** Newest first with `before`, oldest first with `after`. */
  entries(thread: string, opts: { conversation?: number; before?: number; after?: number; limit?: number }): Promise<{ entries: EntryRecord[]; more: boolean }>;
  watch(thread: string, opts: { conversation?: number; fromEntry?: number }, sink: (event: DurableEvent) => void): Promise<() => Promise<void>>;
  search(query: SearchQuery): Promise<SearchPage>;
  usage(range: { since?: number; until?: number; threads?: string[] }): Promise<UsageTotal[]>;
  docGet(thread: string, name: string): Promise<unknown>;
  docPut(thread: string, name: string, value: unknown): Promise<void>;
  /** `cwd` moves the thread: pi-host runs its next request's tools, prompt and kernels there. */
  set(thread: string, patch: { name?: string; model?: string; thinkingLevel?: string; archived?: boolean; cwd?: string }): Promise<DurableThread>;
  /** True while the host answers. */
  ping(): Promise<{ ok: true; version: string } | { ok: false; error: string }>;
  close(): Promise<void>;
}
