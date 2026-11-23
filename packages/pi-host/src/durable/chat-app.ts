/**
 * The new chat (apps/chat, :5184) as a durable thread's chat tools reach it: the thread's board, its check-in, its agents and the owner's
 * For you list, over the chat server's HTTP API on loopback (apps/chat/server/http.ts). The chat server is the board's one writer: it applies
 * an agent's ops with its reducer (`Boards.apply`, actor `agent`) to the thread's `chat.board` document in pi-host and tells its pages, as
 * Prime's chat service does for a Prime chat's `chat_board` (legacy/prime/user-history/src/agent-board.ts `agentOpsViaService`).
 */
import type { CheckInSetting, CheckInSettings } from "../../../../legacy/prime/user-history/src/checkin-settings.ts";
import type { ChatAgent, ChatBoard, OwnerTodo } from "../../../../legacy/prime/user-history/src/shared/types.ts";
import type { ForMeItem, ForMeList, ForMeStatus, SearchResult } from "../../../../apps/chat/web/src/lib/api/types.ts";
import type { LaterChange } from "./later.ts";

export const CHAT_URL_ENV = "PI_HOST_CHAT_URL";
export const DEFAULT_CHAT_URL = "http://127.0.0.1:5184";

/** apps/chat's CheckInView (web/src/lib/api/types.ts): `everyMs` is the interval it runs at, and `planEveryMs` the setting while a board with no open step runs daily. */
export interface CheckInView { everyMs: number; planEveryMs?: number; paused: boolean; pausedUntil: number | "forever" | null; nextAt: number | null; lastAt: number | null }
export interface OtherAsk { chat: string; id: string; text: string; at: string }

export class ChatApp {
  constructor(readonly base: string = process.env[CHAT_URL_ENV] || DEFAULT_CHAT_URL, private readonly timeoutMs = 15_000) {}

  private async call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const response = await fetch(new URL(path, this.base), {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = await response.text();
    let parsed: unknown;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    if (!response.ok) {
      const error = (parsed as { error?: unknown } | null)?.error;
      throw new Error(typeof error === "string" && error ? error : `The chat server answered ${response.status}.`);
    }
    return parsed as T;
  }

  private thread(id: string, rest: string): string {
    return `/api/threads/${encodeURIComponent(id)}/${rest}`;
  }

  async board(thread: string, signal?: AbortSignal): Promise<ChatBoard | null> {
    return (await this.call<{ board?: ChatBoard | null }>("GET", this.thread(thread, "board"), undefined, signal)).board ?? null;
  }

  /** The agent's ops, applied all or none; the answer carries each op's summary line. */
  async apply(thread: string, ops: unknown, signal?: AbortSignal): Promise<{ board: ChatBoard | null; summaries: string[] }> {
    const body = await this.call<{ board?: ChatBoard | null; summaries?: string[] }>("POST", this.thread(thread, "board"), { ops, actor: "agent" }, signal);
    return { board: body.board ?? null, summaries: Array.isArray(body.summaries) ? body.summaries : [] };
  }

  checkIn(thread: string, signal?: AbortSignal): Promise<CheckInView> {
    return this.call<CheckInView>("GET", this.thread(thread, "check-in"), undefined, signal);
  }

  setCheckIn(thread: string, patch: { everyMs?: number; pause?: "1h" | "tomorrow" | "forever" | null }, signal?: AbortSignal): Promise<CheckInView> {
    return this.call<CheckInView>("POST", this.thread(thread, "check-in"), patch, signal);
  }

  /** The wakes set on a conversation of this thread that have not gone out yet (`GET /api/threads/:id/wakes`). */
  async wakes(thread: string, conversation: number, signal?: AbortSignal): Promise<unknown[]> {
    const body = await this.call<{ wakes?: unknown }>("GET", this.thread(thread, `wakes?conversation=${conversation}`), undefined, signal);
    return Array.isArray(body?.wakes) ? body.wakes : [];
  }

  /** Deletes the wakes set on a conversation of this thread that have not gone out (`DELETE /api/threads/:id/wakes`); returns how many. */
  async dropWakes(thread: string, conversation: number, signal?: AbortSignal): Promise<number> {
    const body = await this.call<{ dropped?: unknown }>("DELETE", this.thread(thread, `wakes?conversation=${conversation}`), undefined, signal);
    return typeof body?.dropped === "number" ? body.dropped : 0;
  }

  async agents(thread: string, signal?: AbortSignal): Promise<ChatAgent[]> {
    const body = await this.call<{ agents?: unknown }>("GET", this.thread(thread, "agents"), undefined, signal);
    return Array.isArray(body.agents) ? body.agents as ChatAgent[] : [];
  }

  /** An agent's work thread by its id, from apps/chat's agent list (`GET /api/agents`, and `?test=1` for a walk's throwaway agent). */
  async agentWork(agent: string, signal?: AbortSignal): Promise<string | undefined> {
    for (const query of ["", "?test=1"]) {
      const rows = await this.call<unknown>("GET", `/api/agents${query}`, undefined, signal);
      const found = Array.isArray(rows) ? (rows as { id?: unknown; thread?: unknown }[]).find(row => row.id === agent) : undefined;
      if (typeof found?.thread === "string" && found.thread) return found.thread;
    }
    return undefined;
  }

  /** Puts this thread's agent's reaction on a room post or takes it off; the answer's `text` is one line that names the post and its reactions. */
  async react(thread: string, change: { message: string; emoji: string; on: boolean }, signal?: AbortSignal): Promise<{ text: string }> {
    const body = await this.call<{ text?: unknown }>("POST", this.thread(thread, "reactions"), change, signal);
    return { text: typeof body?.text === "string" ? body.text : `${change.emoji} is ${change.on ? "on" : "off"} ${change.message}.` };
  }

  /** Replaces the text of one of this thread's agent's own room posts (`POST /api/threads/:id/edits`); the answer's `text` names the post. */
  async editPost(thread: string, change: { message: string; text: string }, signal?: AbortSignal): Promise<{ text: string }> {
    const body = await this.call<{ text?: unknown }>("POST", this.thread(thread, "edits"), change, signal);
    return { text: typeof body?.text === "string" ? body.text : `Edited ${change.message}.` };
  }

  /** Marks the thread of a room post done or open again (`POST /api/threads/:id/done`); the flag goes on the root, and `text` names it. */
  async threadDone(thread: string, change: { message: string; done: boolean }, signal?: AbortSignal): Promise<{ text: string }> {
    const body = await this.call<{ text?: unknown }>("POST", this.thread(thread, "done"), change, signal);
    return { text: typeof body?.text === "string" ? body.text : `The thread of ${change.message} is ${change.done ? "done" : "open"}.` };
  }

  /** Adds an agent to a channel or Solo room or removes it (`POST /api/threads/:id/members`); the answer's `text` is the tool's result line. */
  async roomMember(thread: string, change: { room: string; agent: string; member: boolean }, signal?: AbortSignal): Promise<{ text: string }> {
    const body = await this.call<{ text?: unknown }>("POST", this.thread(thread, "members"), change, signal);
    return { text: typeof body?.text === "string" ? body.text : `${change.agent} is ${change.member ? "in" : "out of"} ${change.room}.` };
  }

  /** Sets this thread's agent's Later item for a post (`POST /api/threads/:id/later`); the answer's `text` is the tool's result line. */
  async later(thread: string, change: LaterChange, signal?: AbortSignal): Promise<{ text: string }> {
    const body = await this.call<{ text?: unknown }>("POST", this.thread(thread, "later"), change, signal);
    return { text: typeof body?.text === "string" ? body.text : `Saved ${change.message}.` };
  }

  /** This thread's agent's Later list with `state`, written as the agent reads it (`GET /api/threads/:id/later`). */
  async laterList(thread: string, state: "open" | "done", signal?: AbortSignal): Promise<{ text: string }> {
    const body = await this.call<{ text?: unknown }>("GET", this.thread(thread, `later?state=${state}`), undefined, signal);
    return { text: typeof body?.text === "string" ? body.text : "No saved messages." };
  }

  /** The owner's Cmd K search with the filters in `query` (`GET /api/search`), as the search_messages tool reads it (`search-messages.ts`). */
  search(query: URLSearchParams, signal?: AbortSignal): Promise<SearchResult> {
    return this.call<SearchResult>("GET", `/api/search?${query}`, undefined, signal);
  }

  /** The open todos the owner's other chats asked him, which tell_owner's same-ask check reads (Prime's `otherAsks`). */
  async otherAsks(thread: string, signal?: AbortSignal): Promise<OtherAsk[]> {
    const body = await this.call<{ items?: { chatId: string; todo: OwnerTodo }[] }>("GET", "/api/for-you", undefined, signal);
    return (body.items ?? []).filter(item => item.chatId !== thread && !item.todo.done && item.todo.from === "agent")
      .map(item => ({ chat: item.chatId, id: item.todo.id, text: item.todo.text, at: item.todo.at }));
  }

  /** The For list of this thread's agent (`GET /api/agents/:id/for-me`): its items with `status`, newest activity first, and both counts. */
  forMe(thread: string, status: ForMeStatus | "all", signal?: AbortSignal): Promise<ForMeList> {
    return this.call<ForMeList>("GET", `/api/agents/${encodeURIComponent(thread)}/for-me?status=${status}`, undefined, signal);
  }

  /** Marks an item of this thread's agent's For list completed or pending again; the server's mark is idempotent. */
  markForMe(thread: string, change: { messageId: string; completed: boolean }, signal?: AbortSignal): Promise<{ item: ForMeItem; pending: number }> {
    return this.call<{ item: ForMeItem; pending: number }>("POST", `/api/agents/${encodeURIComponent(thread)}/for-me`, change, signal);
  }

  /**
   * The thread's check-in as Prime's setting store, so Prime's own `chatCheckIn` and `checkInLine` judge and word it. apps/chat keeps no
   * `pausedBy`, so every pause reads as the owner's, which an agent may not lift (Prime's rule for a pause with no author).
   */
  checkInSettings(signal?: AbortSignal): CheckInSettings {
    const setting = (view: CheckInView): CheckInSetting => ({ everyMs: view.planEveryMs ?? view.everyMs, ...(view.paused && view.pausedUntil !== null ? { pausedUntil: view.pausedUntil } : {}) });
    return {
      all: async () => ({}),
      get: async id => setting(await this.checkIn(id, signal)),
      update: async (id, change) => {
        const current = setting(await this.checkIn(id, signal));
        const next = change(current);
        if (next === current) return current;
        const patch: { everyMs?: number; pause?: "1h" | "tomorrow" | "forever" | null } = {};
        if (next.everyMs !== current.everyMs) patch.everyMs = next.everyMs;
        if (next.pausedUntil !== current.pausedUntil) {
          // apps/chat takes Prime's pause words, not a time: Prime's pauseEnd gives "1h" an hour from now and "tomorrow" the next 09:00.
          patch.pause = next.pausedUntil === undefined ? null : next.pausedUntil === "forever" ? "forever" : next.pausedUntil - Date.now() <= 61 * 60_000 ? "1h" : "tomorrow";
        }
        return setting(await this.setCheckIn(id, patch, signal));
      },
    };
  }
}
