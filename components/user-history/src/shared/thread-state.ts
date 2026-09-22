import type { AssistantMessage, ChildAgent, ProjectedSessionEvent, ThreadEvent, ThreadMessage, ThreadSnapshot, ThreadState, ToolRun } from "./types.ts";

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
  return { ...snapshot, connection: "connected" };
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

export function applyThreadEvent(state: ThreadState, event: ThreadEvent, now = Date.now()): ThreadState {
  switch (event.type) {
    case "snapshot": return { ...threadStateFromSnapshot(event.snapshot), connection: state.connection };
    case "event": return applySessionEvent(state, event.event, now);
    case "info": return { ...state, info: event.info };
    case "queue": return { ...state, queue: event.queue };
    case "children": return { ...state, children: event.children };
    case "status": return { ...state, connection: event.connection, ...(event.error === undefined ? {} : { error: event.error }) };
  }
}

export function isThreadBusy(state: Pick<ThreadState, "info" | "queue" | "children" | "tools">): boolean {
  const { info } = state;
  return info.isStreaming || info.isCompacting || info.isBashRunning || info.retryAttempt > 0 || info.sessionAction !== null || info.queuedActions > 0 ||
    state.tools.some(tool => tool.status === "running") || state.children.some(child => child.status === "running" || child.status === "queued");
}
