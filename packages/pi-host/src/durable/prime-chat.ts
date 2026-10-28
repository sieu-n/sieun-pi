/**
 * A Prime browser chat's own extension (legacy/prime/user-history/extension/index.ts, the user-history extension every Prime chat loads)
 * running in a durable thread's root conversation, through the adapter in `pi-extensions.ts`.
 *
 * pi-host loads the extension once, as a chat: the flags `chat` and `owner-thread` are set, so its `session_start` handler marks the session
 * a chat and registers what a Prime chat gets, in Prime's order: `search_history`, `chat_board`, `tell_owner`, `correction_add` and
 * `poteto_mode`. Each becomes a pi-durable tool with the name, description and parameters the extension registered. Their promptGuidelines
 * (the chat brief and the poteto-mode line) are already in the `guidance` section `prime-prompt.ts` builds with Prime's builder, so they
 * are not added again. Its context hook's turn wrappers run as a `beforeRequest` hook, with Prime's own functions.
 *
 * Where a tool's store differs in the new chat, its binding runs the same Prime functions against that store:
 *
 * | Tool | Runs | Store | Replay |
 * |---|---|---|---|
 * | `search_history` | the extension's execute | pi-history's socket, as in Prime | safe: it only reads |
 * | `chat_board` | Prime's ops parse, flags, `chatCheckIn`, `checkInLine`, `renderOpenPlan`, `boardRevLine`, `agentLines` | apps/chat's board, check-in and agents API for this thread (`chat-app.ts`), never the legacy `browser-chat/boards` | unsafe: a rerun would apply the ops twice |
 * | `tell_owner` | Prime's live guard (`liveGuard`: `tellTurn`, `tellOwner`, `askedTodos`) over the thread's messages | apps/chat's board for the asked todos, its For you list for other chats' asks; the message itself is the call's `text`, which apps/chat draws as the bubble | safe: nothing leaves the thread |
 * | `correction_add` | the extension's execute | the shared ledger Prime chats write (`AGENT_CHAT_SHARED_DIR`, else `<agentDir>/browser-chat`), or the chat host's corrections route, as Prime | unsafe: a rerun could add the correction twice |
 * | `poteto_mode` | the extension's execute | none | safe |
 *
 * Skipped, with the reason:
 * - The `[corrections]` block of the context hook (`deliverCorrections`): `prime-prompt.ts` sends the same `ledgerPrompt` text as its
 *   pinned `corrections` section, so it would be there twice.
 * - The first context hook (Prime's notice rewording for cancelled and parked rlm children, and the image fitter): a durable thread has no
 *   rlm child notices, and pi-durable's `read` already fits images to the model.
 * - `before_provider_request` (prompt capture, parent labels), `tool_call` and `tool_result` (ipython code rewrites, job registry, load-wait
 *   notes, moved-session block), `before_agent_start` and `session_compact`: they act on the `ipython` REPL, Prime's job registry, Prime
 *   session files or the legacy chat service, none of which a durable thread has. The pinned brief is the `guidance` section's pin.
 * - `job_reply`: the extension registers it only for a session whose parent is a Prime chat session file; a subagent's child conversation
 *   gets its guideline from `prime-prompt.ts`, and no chat tool.
 * - Commands (`what-did-i-say`, `agent-chat`): they open the legacy chat.
 * - The `[correction check]` line: the legacy chat server adds it to an owner message (chats.ts `correctionStep`), not the extension.
 */
import type { Context } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import {
  defineExtension, GenerationTask, hook, ROOT_CONVERSATION_ID, type ContextView, type ConversationId, type EntryRecord, type Extension, type Harness, type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { join } from "node:path";
import { askedTodos, CHAT_BOARD_TOOL, type TellInput, type TellTurn, withMessageIds, withWakeNotes } from "../../../../legacy/prime/user-history/src/chat-guard.ts";
import { liveGuard } from "../../../../legacy/prime/user-history/src/chat-guard-live.ts";
import { agentLines } from "../../../../legacy/prime/user-history/src/chat-agents.ts";
import { chatCheckIn, checkInLine, parseChatCheckIn } from "../../../../legacy/prime/user-history/src/checkin-settings.ts";
import { planHasOpenStep } from "../../../../legacy/prime/user-history/src/checkin-steps.ts";
import { CORRECTION_TOOL } from "../../../../legacy/prime/user-history/src/chat-corrections.ts";
import { PERSONA_TOOL } from "../../../../legacy/prime/user-history/src/chat-brief.ts";
import { boardRevLine, parseBoardOps, parseBoard, renderOpenPlan } from "../../../../legacy/prime/user-history/src/shared/chat-board.ts";
import { TELL_OWNER_TOOL } from "../../../../legacy/prime/user-history/src/shared/chat-feed.ts";
import { holdAskFlag } from "../../../../legacy/prime/user-history/src/shared/hold-ask.ts";
import { laneHoldFlag } from "../../../../legacy/prime/user-history/src/shared/lane-hold.ts";
import { boardLimitFlag } from "../../../../legacy/prime/user-history/src/shared/reply-lint.ts";
import type { ChatBoard, PlanItem, ThreadMessage } from "../../../../legacy/prime/user-history/src/shared/types.ts";
import { SEARCH_HISTORY_TOOL } from "../../../pi-history/src/pi/index.ts";
import { ChatApp } from "./chat-app.ts";
import { durableTool, loadPiExtension, piContext, type LoadedPiExtension, type PiSession, type PiTool, type PiToolResult } from "./pi-extensions.ts";

export const PRIME_CHAT_EXTENSION = "prime-chat";
/** The tools a durable chat thread offers from the extension, in the order a Prime chat's request lists them. */
export const PRIME_CHAT_TOOLS = [SEARCH_HISTORY_TOOL, CHAT_BOARD_TOOL, TELL_OWNER_TOOL, CORRECTION_TOOL, PERSONA_TOOL] as const;
/** The tools an agent speaks to people through: Prime's tell_owner, and send_message, which apps/chat draws the same way. */
export const SPEAKING_TOOLS: ReadonlySet<string> = new Set([TELL_OWNER_TOOL, "send_message"]);
/** tell_owner's answer when the message went out (chat-guard.ts TELL_OWNER_DONE). */
export { TELL_OWNER_TOOL };

/** Only the name, so a subagent's child conversation can drop the extension without importing it. */
export const PrimeChatName: Extension = defineExtension({ name: PRIME_CHAT_EXTENSION });

export interface PrimeChat {
  readonly loaded: LoadedPiExtension;
  readonly tools: readonly PiTool[];
  readonly agentDir: string;
  /** The data dir the extension was given: the shared one whose ledger correction_add writes. */
  readonly dataDir: string;
  readonly app: ChatApp;
}

export interface PrimeChatOptions {
  agentDir: string;
  /** Where correction_add writes: default AGENT_CHAT_SHARED_DIR, else AGENT_CHAT_DATA_DIR, else `<agentDir>/browser-chat`, the ledger Prime chats share. */
  dataDir?: string;
  app?: ChatApp;
  /** The extension's factory; default the user-history extension. */
  factory?: (pi: never) => unknown;
  log?: (line: string) => void;
}

/** The ledger's folder a durable chat shares with Prime's chats: the live chat's data dir, which pi-host's unit names AGENT_CHAT_SHARED_DIR. */
export function sharedChatDir(agentDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_CHAT_SHARED_DIR || env.AGENT_CHAT_DATA_DIR || join(agentDir, "browser-chat");
}

/** Loads the user-history extension as a chat once per process, so every thread gets its tools as a Prime chat's session_start leaves them. */
export async function loadPrimeChat(options: PrimeChatOptions): Promise<PrimeChat> {
  const dataDir = options.dataDir ?? sharedChatDir(options.agentDir);
  const factory = options.factory ?? (await import("../../../../legacy/prime/user-history/extension/index.ts")).default;
  const loaded = await loadPiExtension(factory as (pi: never) => unknown, {
    flags: { chat: true, "owner-thread": true, "agent-chat-data-dir": dataDir },
    ...(options.log ? { log: options.log } : {}),
  });
  const session: PiSession = { id: "pi-host-durable-chat", cwd: options.agentDir, depth: 0, entries: () => [] };
  await loaded.emit("session_start", { type: "session_start", reason: "startup" }, piContext(session));
  const tools = PRIME_CHAT_TOOLS.flatMap(name => {
    const tool = loaded.tools.get(name);
    if (!tool) options.log?.(`prime chat: the extension registered no ${name}`);
    return tool ? [tool] : [];
  });
  return { loaded, tools, agentDir: options.agentDir, dataDir, app: options.app ?? new ChatApp() };
}

// ---------------------------------------------------------------------------------------------------------------------------
// A durable conversation as Prime's messages.

/**
 * Who an input is from, as Prime's chat reads it: the owner's text, a custom message (another sender's `agent_message`, or the custom type an
 * imported Prime message had), or neither, such as a compaction summary.
 */
type Origin = "owner" | { customType: string } | "other";

const AGENT_MESSAGE = "agent_message";
function originOf(entry: EntryRecord): Origin {
  if (entry.kind === "pi.user") return "owner";
  if (entry.kind === "agent.message") return (entry.data as { from?: unknown } | undefined)?.from === "owner" ? "owner" : { customType: AGENT_MESSAGE };
  const customType = (entry.data as { customType?: unknown } | undefined)?.customType;
  if (entry.kind === "prime.custom" && typeof customType === "string") return { customType };
  return "other";
}

const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.flatMap(part => (part?.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n") : "";
const keyOf = (message: { timestamp?: unknown; content?: unknown }): string => `${String(message.timestamp)}\0${textOf(message.content).slice(0, 200)}`;

/** The origin of each user message of a context view, by its time and text. */
function origins(view: ContextView): Map<string, Origin> {
  const out = new Map<string, Origin>();
  view.entries.forEach((entry, index) => {
    for (const message of view.contributions[index] ?? []) if (message.role === "user") out.set(keyOf(message), originOf(entry));
  });
  return out;
}

const OTHER_ROLE = "pi-host-other";

/** A user message as Prime holds it: the owner's stays a user message, another sender's is a custom message, and a summary is neither. */
function toPrime<M extends { role: string }>(message: M, origin: Origin | undefined): M {
  if (message.role !== "user" || origin === undefined || origin === "owner") return message;
  return origin === "other" ? { ...message, role: OTHER_ROLE } : { ...message, role: "custom", customType: origin.customType };
}
function fromPrime(message: { role: string; customType?: unknown }): Message {
  if (message.role === "custom") {
    const { customType: _drop, ...rest } = message;
    return { ...rest, role: "user" } as Message;
  }
  return (message.role === OTHER_ROLE ? { ...message, role: "user" } : message) as Message;
}

/**
 * The model's view with Prime's turn wrappers: `[message id: ...]` after each owner message (`withMessageIds`) and the `[not from the owner: ...]`
 * note after each wake (`withWakeNotes`), the order Prime's context hook applies them in. Each note depends only on its own message, so the
 * cached prefix holds. Without a view of the entries, every user message counts as the owner's.
 */
export function withTurnWrappers(messages: readonly Message[], view: ContextView | undefined): Message[] {
  const by = view ? origins(view) : new Map<string, Origin>();
  const shaped = messages.map(message => toPrime(message, by.get(keyOf(message))));
  let out = withMessageIds(shaped as never[]) ?? shaped;
  out = withWakeNotes(out as never[]) ?? out;
  return (out as { role: string }[]).map(fromPrime);
}

/** The conversation as Prime's session branch reads to tell_owner's guard, up to and with the assistant message that made `callId`. */
export function threadMessages(view: ContextView, callId?: string): ThreadMessage[] {
  const out: ThreadMessage[] = [];
  for (const [index, entry] of view.entries.entries()) {
    for (const message of view.contributions[index] ?? []) {
      if (message.role === "system") continue;
      const shaped: { role: string } = toPrime(message, message.role === "user" ? originOf(entry) : undefined);
      if (shaped.role === OTHER_ROLE) continue;
      out.push(shaped as unknown as ThreadMessage);
      if (callId && message.role === "assistant" && message.content.some(part => part.type === "toolCall" && part.id === callId)) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// The extension of one thread.

export interface ChatThread {
  id: string;
  name: () => string;
  file: string;
  cwd: string;
  /** The thread's Harness once open; the hook and tell_owner read the conversation's entries through it. */
  harness: () => Harness | undefined;
  /** The thread's `chat.board` document, read when the chat server does not answer. */
  boardDoc?: () => Promise<unknown>;
  log?: (line: string) => void;
}

async function contextOf(thread: ChatThread, conversation: ConversationId, context: Context): Promise<ContextView | undefined> {
  const harness = thread.harness();
  if (!harness) return undefined;
  return (await harness.conversation(conversation, context))?.context(context);
}

const text = (lines: readonly string[]): PiToolResult => ({ content: [{ type: "text", text: lines.join("\n") }] });

/** Every step's job field, for Prime's limit-claim flag, which leaves job names out of what reads as a claim. */
function jobNamesOf(board: ChatBoard | null): string[] {
  const names = new Set<string>();
  const walk = (items: readonly PlanItem[]) => { for (const item of items) { if (item.job?.trim()) names.add(item.job.trim()); walk(item.children); } };
  walk(board?.plan ?? []);
  return [...names];
}

/** chat_board as Prime's runs it (extension/index.ts `boardTool`), on apps/chat's board, check-in and agents for this thread. */
async function chatBoard(chat: PrimeChat, thread: ChatThread, params: unknown, signal: AbortSignal | undefined): Promise<PiToolResult> {
  const input = (params ?? {}) as { ops?: unknown; check_in?: unknown };
  const raw = input.ops ?? [];
  const writes = Array.isArray(raw) && raw.length > 0;
  const change = input.check_in === undefined ? undefined : parseChatCheckIn(input.check_in);
  // Prime's parse refuses a bad op before anything is written, with its own words.
  const ops = parseBoardOps(raw);
  const now = Date.now();
  let board: ChatBoard | null;
  let summaries: string[] = [];
  if (writes) {
    ({ board, summaries } = await chat.app.apply(thread.id, raw, signal));
    const flags = [boardLimitFlag(ops) && boardLimitFlag(ops, jobNamesOf(board)), laneHoldFlag(ops), holdAskFlag(ops)].filter((flag): flag is string => flag !== null);
    summaries = [...summaries, ...flags];
  } else {
    board = await chat.app.board(thread.id, signal).catch(async error => {
      const doc = await thread.boardDoc?.().catch(() => null);
      if (doc === undefined) throw error;
      return doc ? parseBoard(doc) : null;
    });
  }
  const settings = chat.app.checkInSettings(signal);
  const changed = change ? [await chatCheckIn(settings, thread.id, change, now)] : [];
  const checkIn = await settings.get(thread.id).then(setting => checkInLine(setting, now, planHasOpenStep(board)), () => undefined);
  if (writes && board) return text([...changed, ...summaries, boardRevLine(board)]);
  const agents = agentLines(await chat.app.agents(thread.id, signal).catch(() => []), now);
  return text([...changed, renderOpenPlan(board, thread.id, checkIn), ...agents]);
}

/** tell_owner as Prime's runs it (extension/index.ts), with the turn read from the thread and the asks from apps/chat's boards. */
async function tellOwner(chat: PrimeChat, thread: ChatThread, params: unknown, api: ToolExecutionApi, context: Context): Promise<PiToolResult> {
  const guard = await liveGuard(chat.agentDir);
  let turn: TellTurn = { owner: true, ownerIds: new Set() };
  try {
    const view = await contextOf(thread, api.conversationId, context);
    if (view) turn = guard.tellTurn(threadMessages(view, api.callId));
  } catch { /* read as an owner turn, so nothing is held */ }
  const asked = guard.askedTodos ?? askedTodos;
  if (!turn.owner) try {
    const why = (params as TellInput).why;
    const board = await chat.app.board(thread.id, context.abortSignal);
    if (board) turn = { ...turn, asked: asked(board.todos, turn.startedAt), plan: board.plan };
    if (why === "decision" || why === "blocker") turn = { ...turn, others: await chat.app.otherAsks(thread.id, context.abortSignal) };
  } catch { /* no board read, so no todo holds the message */ }
  const result = guard.tellOwner(params as TellInput, turn);
  if (result.kind === "refused") throw new Error(result.text);
  return text([result.text]);
}

const REPLAY: Record<string, "safe" | "unsafe"> = {
  [SEARCH_HISTORY_TOOL]: "safe", [CHAT_BOARD_TOOL]: "unsafe", [TELL_OWNER_TOOL]: "safe", [CORRECTION_TOOL]: "unsafe", [PERSONA_TOOL]: "safe",
};

/** The extension's tools for one thread: the definitions it registered, each with its binding. */
export function primeChatTools(chat: PrimeChat, thread: ChatThread): ToolRegistration[] {
  const session = (): PiSession => ({ id: thread.id, name: thread.name(), file: thread.file, cwd: thread.cwd, depth: 0 });
  return chat.tools.map(tool => durableTool(tool, {
    replay: REPLAY[tool.name] ?? "unsafe",
    session,
    ...(tool.name === CHAT_BOARD_TOOL ? { execute: (params: unknown, _api: ToolExecutionApi, context: Context) => chatBoard(chat, thread, params, context.abortSignal) } : {}),
    ...(tool.name === TELL_OWNER_TOOL ? { execute: (params: unknown, api: ToolExecutionApi, context: Context) => tellOwner(chat, thread, params, api, context) } : {}),
  }));
}

/** The pi-durable extension a thread's root conversation selects: the chat's tools and the turn wrappers. */
export function primeChat(chat: PrimeChat, thread: ChatThread): Extension {
  return defineExtension({
    name: PRIME_CHAT_EXTENSION,
    tools: primeChatTools(chat, thread),
    hooks: [hook(GenerationTask, {
      beforeRequest: async ({ messages }, api, context) => {
        if (api.conversationId !== ROOT_CONVERSATION_ID) return undefined;
        let view: ContextView | undefined;
        try {
          view = await contextOf(thread, api.conversationId, context);
        } catch (error) {
          thread.log?.(`turn wrappers read no entries: ${error instanceof Error ? error.message : String(error)}`);
        }
        return { messages: withTurnWrappers(messages, view) };
      },
    })],
  });
}
