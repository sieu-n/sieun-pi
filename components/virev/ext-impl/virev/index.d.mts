import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionEvent,
  ExtensionHandler,
  SessionStartEvent,
  ToolCallEvent,
  ToolCallEventResult,
} from "prime-agent";

export const IMPL_VERSION: string;
export function init(options: { implDir: string }): void;
export function describe(): string;
export const onSessionStart: ExtensionHandler<SessionStartEvent>;
export const onToolCall: ExtensionHandler<ToolCallEvent, ToolCallEventResult>;
export const onBeforeAgentStart: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>;
export const onMessageEnd: ExtensionHandler<Extract<ExtensionEvent, { type: "message_end" }>>;
