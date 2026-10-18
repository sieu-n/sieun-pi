import { keyIndex, parseCursor } from "./message-key.ts";
import type { AssistantMessage, ChatBoard, ChildAgent, ProjectedSessionEvent, ThreadEvent, ThreadMessage, ThreadSnapshot, ThreadState, ToolRun } from "./types.ts";

export function runStartedAtFromMessages(messages: readonly ThreadMessage[]): number | null {
  let startedAt: number | null = null;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "user" || message.role === "custom") { startedAt = message.timestamp; break; }
    if (message.role === "assistant" && message.stopReason !== "toolUse") break;
  }
  return startedAt;
}

export function threadStateFromSnapshot(snapshot: ThreadSnapshot): ThreadState {
  return { ...snapshot, children: snapshot.children ?? [], connection: "connected" };
}

function upsertChild(children: readonly ChildAgent[], child: ChildAgent): ChildAgent[] {
  const index = children.findIndex(entry => entry.id === child.id);
  if (index < 0) return [...children, child];
  const next = [...children];
  next[index] = child;
  return next;
}

function applySessionEvent(state: ThreadState, event: ProjectedSessionEvent, now: number): ThreadState {
  switch (event.type) {
    case "agent_start":
      return { ...state, info: { ...state.info, isStreaming: true }, runStartedAt: state.runStartedAt ?? now };
    case "agent_end":
      return { ...state, info: { ...state.info, isStreaming: false }, streaming: null, tools: [], retry: null, runStartedAt: null };
    case "turn_start":
    case "turn_end":
      return state;
    case "message_start":
      return event.message.role === "assistant" ? { ...state, streaming: event.message as AssistantMessage } : state;
    case "message_update":
      return { ...state, streaming: event.message };
    case "message_end": {
      const message = event.message;
      const tools = message.role === "toolResult" ? state.tools.filter(tool => tool.toolCallId !== message.toolCallId) : state.tools;
      return { ...state, messages: [...state.messages, message], streaming: message.role === "assistant" ? null : state.streaming, tools,
        runStartedAt: state.runStartedAt ?? (message.role === "user" || message.role === "custom" ? message.timestamp : null) };
    }
    case "tool_execution_start": {
      const run: ToolRun = { toolCallId: event.toolCallId, toolName: event.toolName, status: "running", startedAt: now };
      return { ...state, tools: [...state.tools.filter(tool => tool.toolCallId !== event.toolCallId), run] };
    }
    case "tool_execution_update":
      return { ...state, tools: state.tools.map(tool => tool.toolCallId === event.toolCallId ? { ...tool, partial: event.partial } : tool) };
    case "tool_execution_end":
      return { ...state, tools: state.tools.map(tool => tool.toolCallId === event.toolCallId ? { ...tool, status: "done", isError: event.isError } : tool) };
    case "compaction_start":
      return { ...state, info: { ...state.info, isCompacting: true } };
    case "compaction_end":
      return { ...state, info: { ...state.info, isCompacting: false } };
    case "auto_retry_start":
      return { ...state, retry: { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, error: event.errorMessage },
        info: { ...state.info, retryAttempt: event.attempt } };
    case "auto_retry_end":
      return { ...state, retry: null, info: { ...state.info, retryAttempt: 0 } };
    case "session_info_changed": {
      const { name: _name, ...info } = state.info;
      return { ...state, info: event.name === undefined ? info : { ...info, name: event.name } };
    }
    case "thinking_level_changed":
      return { ...state, info: { ...state.info, thinkingLevel: event.level } };
    case "rlm_child_update":
      return { ...state, children: upsertChild(state.children, event.child) };
    case "session_action_update":
      return { ...state, info: { ...state.info, sessionAction: event.active, queuedActions: event.queuedCount } };
    case "recap_update": {
      const { recap: _recap, ...info } = state.info;
      return { ...state, info: event.recap === undefined ? info : { ...info, recap: event.recap } };
    }
    case "bash_start":
      return { ...state, info: { ...state.info, isBashRunning: true } };
    case "bash_end":
      return { ...state, info: { ...state.info, isBashRunning: false } };
  }
}

/** A board's revision as a reconnecting page names it (`ThreadHave.board`). */
export const boardKey = (board: ChatBoard): string => `${board.rev}|${board.updatedAt}`;

/** A snapshot with `after` holds only the messages after that one: the held messages up to it come first, with the held `older` cursor. */
function withHeld(state: ThreadState, snapshot: ThreadSnapshot): ThreadSnapshot {
  if (snapshot.after === undefined) return snapshot;
  const { after, older: _older, ...rest } = snapshot;
  const cursor = parseCursor(after);
  const index = cursor?.kind === "message" ? keyIndex(state.messages, cursor.key) : -1;
  return { ...rest, messages: [...state.messages.slice(0, index + 1), ...snapshot.messages], ...(state.older !== undefined ? { older: state.older } : {}) };
}

export function applyThreadEvent(state: ThreadState, event: ThreadEvent, now = Date.now()): ThreadState {
  switch (event.type) {
    case "snapshot": {
      // The board, the wait, the outbox and the children come as their own events: a snapshot without them keeps the ones held.
      const snapshot = withHeld(state, event.snapshot);
      return { ...snapshot, children: snapshot.children ?? state.children, connection: state.connection,
        ...(snapshot.board === undefined && state.board !== undefined ? { board: state.board } : {}), ...(snapshot.wait === undefined && state.wait !== undefined ? { wait: state.wait } : {}),
        ...(snapshot.outbox === undefined && state.outbox !== undefined ? { outbox: state.outbox } : {}) };
    }
    case "event": return applySessionEvent(state, event.event, now);
    case "info": return { ...state, info: event.info };
    case "queue": return { ...state, queue: event.queue };
    case "children": return { ...state, children: event.children };
    case "board": return { ...state, board: event.board };
    case "wait": return { ...state, wait: event.wait };
    case "outbox": return { ...state, outbox: event.outbox };
    case "status": return { ...state, connection: event.connection, ...(event.error === undefined ? {} : { error: event.error }) };
  }
}

/** Whether the session runs something now: a turn, a compaction, a command, a retry, a session action. Queued input alone does not count. */
export function isTurnRunning(info: ThreadState["info"]): boolean {
  return info.isStreaming || info.isCompacting || info.isBashRunning || info.retryAttempt > 0 || info.sessionAction !== null;
}

export function isThreadBusy(state: Pick<ThreadState, "info" | "queue" | "children" | "tools">): boolean {
  return isTurnRunning(state.info) || state.info.queuedActions > 0 ||
    state.tools.some(tool => tool.status === "running") || state.children.some(child => child.status === "running" || child.status === "queued");
}
