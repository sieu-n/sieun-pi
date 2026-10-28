/**
 * The new chat (apps/chat, :5184) as a durable thread's chat tools reach it: the thread's board, its check-in, its agents and the owner's
 * For you list, over the chat server's HTTP API on loopback (apps/chat/server/http.ts). The chat server is the board's one writer: it applies
 * an agent's ops with its reducer (`Boards.apply`, actor `agent`) to the thread's `chat.board` document in pi-host and tells its pages, as
 * Prime's chat service does for a Prime chat's `chat_board` (legacy/prime/user-history/src/agent-board.ts `agentOpsViaService`).
 */
import type { CheckInSetting, CheckInSettings } from "../../../../legacy/prime/user-history/src/checkin-settings.ts";
import type { ChatAgent, ChatBoard, OwnerTodo } from "../../../../legacy/prime/user-history/src/shared/types.ts";

export const CHAT_URL_ENV = "PI_HOST_CHAT_URL";
export const DEFAULT_CHAT_URL = "http://127.0.0.1:5184";

/** apps/chat's CheckInView (web/src/lib/api/types.ts). */
export interface CheckInView { everyMs: number; paused: boolean; pausedUntil: number | "forever" | null; nextAt: number | null; lastAt: number | null }
export interface OtherAsk { chat: string; id: string; text: string; at: string }

export class ChatApp {
  constructor(readonly base: string = process.env[CHAT_URL_ENV] || DEFAULT_CHAT_URL, private readonly timeoutMs = 15_000) {}

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
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

  async agents(thread: string, signal?: AbortSignal): Promise<ChatAgent[]> {
    const body = await this.call<{ agents?: unknown }>("GET", this.thread(thread, "agents"), undefined, signal);
    return Array.isArray(body.agents) ? body.agents as ChatAgent[] : [];
  }

  /** The open todos the owner's other chats asked him, which tell_owner's same-ask check reads (Prime's `otherAsks`). */
  async otherAsks(thread: string, signal?: AbortSignal): Promise<OtherAsk[]> {
    const body = await this.call<{ items?: { chatId: string; todo: OwnerTodo }[] }>("GET", "/api/for-you", undefined, signal);
    return (body.items ?? []).filter(item => item.chatId !== thread && !item.todo.done && item.todo.from === "agent")
      .map(item => ({ chat: item.chatId, id: item.todo.id, text: item.todo.text, at: item.todo.at }));
  }

  /**
   * The thread's check-in as Prime's setting store, so Prime's own `chatCheckIn` and `checkInLine` judge and word it. apps/chat keeps no
   * `pausedBy`, so every pause reads as the owner's, which an agent may not lift (Prime's rule for a pause with no author).
   */
  checkInSettings(signal?: AbortSignal): CheckInSettings {
    const setting = (view: CheckInView): CheckInSetting => ({ everyMs: view.everyMs, ...(view.paused && view.pausedUntil !== null ? { pausedUntil: view.pausedUntil } : {}) });
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
