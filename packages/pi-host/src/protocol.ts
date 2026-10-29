/**
 * The subset of Prime's v7 daemon JSONL protocol that pi-host speaks.
 *
 * Shapes follow `prime-agent/dist/modes/daemon/daemon-protocol.d.ts` (PROTOCOL_VERSION 7, SCHEMA_REVISION 30), so the chat service's
 * `DaemonClient` and `DaemonAgentConnection`, prime-relay and `hosts-cli` parse these lines unchanged. A client sends one JSON object per line,
 * either a bare command `{ id, type, ... }` or an envelope `{ type: "command", id, protocol, clientId, command }`. The host writes bare outbound
 * objects: `daemon_hello` once on connect, then responses, progress lines and events.
 *
 * Only the commands in `HOST_COMMANDS` are served. Any other command gets a failure whose text says pi-host does not serve it, which is the
 * text `isUnknownDaemonCommandError` matches, so a client that falls back on an old daemon falls back here too.
 */

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { FeedRow } from "../../../components/prime-relay/agents/protocol.ts";
import type { Job } from "./schedule.ts";

export const PROTOCOL_NAME = "prime-agent.daemon";
export const PROTOCOL_VERSION = 7;
export const SCHEMA_REVISION = 30;
export const SCHEMA_ID = "pi-host-protocol-7-schema-30";

export interface ProtocolInfo {
  name: typeof PROTOCOL_NAME;
  version: number;
}
export const PROTOCOL: ProtocolInfo = { name: PROTOCOL_NAME, version: PROTOCOL_VERSION };

export interface EventCursor {
  generation: string;
  sequence: number;
}

export type ClientCapability = "attach_snapshot" | "event_sequence" | "extension_ui" | "slim_attach" | "chunked_snapshot" | "client_owned_sessions" | "heartbeat_catalog";

/** What the hello promises. Each one gates a command in the client's `DAEMON_COMMAND_COMPATIBILITY` table, so the list names only what the host serves. */
export const SERVER_CAPABILITIES = [
  "attach_snapshot", "event_sequence", "slim_attach", "chunked_snapshot", "heartbeat_catalog",
  "agent_roster", "session_input_admission", "queue_message_mutation", "authoritative_child_roster", "delete_rlm_subagent", "model_catalog", "saved_session_archive", "heartbeat_management",
] as const;
export type ServerCapability = (typeof SERVER_CAPABILITIES)[number];

export type QueueMode = "all" | "one-at-a-time";
export type QueueLane = "steering" | "followUp";
export type QueueMutation = { type: "delete" } | { type: "replace"; text: string; lane?: QueueLane };
export type MessageDeliveryMode = "auto" | "steer" | "follow_up";
export type CloseReason = "killed" | "shutdown" | "completed" | "replaced" | "update";
export type SavedSessionScope = "current" | "all";

/** Prime's `AgentSessionRuntimeConfig`, the part a create may carry. */
export interface RuntimeConfig {
  cwd?: string;
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
  extensionFlagValues?: Record<string, boolean | string>;
}

export interface ResumeCursor extends Partial<EventCursor> {
  activeSessionId?: string;
  eventSequence?: number;
}

type Input = { message: string; content?: (TextContent | ImageContent)[]; images?: ImageContent[] };
type Session = { id?: string; activeSessionId: string };

export type HostCommand =
  | { id?: string; type: "list"; all?: boolean; cwd?: string; sessionDir?: string; includeClientOwned?: boolean }
  | { id?: string; type: "list_saved_sessions"; activeSessionId?: string; cwd?: string; sessionDir?: string; scope: SavedSessionScope }
  | { id?: string; type: "roster_subscribe" }
  | { id?: string; type: "roster_unsubscribe" }
  | { id?: string; type: "create"; sessionPath?: string; name?: string; config?: RuntimeConfig; lifecycle?: "resident" | "client_owned"; continueRecent?: boolean; noSession?: boolean }
  | (Session & { type: "attach"; supportsExtensionUi?: boolean; clientId?: string; capabilities?: readonly ClientCapability[]; resumeCursor?: ResumeCursor })
  | { id?: string; type: "detach"; activeSessionId?: string }
  | (Session & { type: "kill"; origin?: string })
  | (Session & { type: "rename"; name: string })
  | (Session & { type: "set_session_name"; name: string })
  | { id?: string; type: "archive_saved_session"; sessionPath: string }
  | { id?: string; type: "rename_saved_session"; activeSessionId?: string; sessionPath: string; name: string }
  | (Session & Input & { type: "prompt"; streamingBehavior?: "steer" | "followUp"; queueIfBusy?: boolean; expandPromptTemplates?: boolean; source?: string })
  | (Session & Input & { type: "steer" })
  | (Session & Input & { type: "follow_up" })
  | (Session & { type: "abort" | "abort_bash" | "abort_compaction" | "abort_retry" | "abort_branch_summary" | "abort_and_clear_queue" | "clear_queue" })
  | (Session & { type: "resume_queue" })
  | (Session & { type: "append_custom_message"; message: { customType: string; content: string | (TextContent | ImageContent)[]; display: boolean; details?: unknown } })
  | (Session & { type: "mutate_queued_message"; lane: QueueLane; index: number; expectedText: string; mutation: QueueMutation })
  | { id?: string; type: "send_message"; targetActiveSessionId: string; message: string; fromActiveSessionId?: string; agentOrigin?: boolean; deliveryMode?: MessageDeliveryMode; fromName?: string;
      /** Repeats with the same key deliver once; pi-agent-bus keeps the dedupe durable. Envelopes default it to `<clientId>:<id>`. */
      idempotencyKey?: string }
  | (Session & { type: "get_state" | "get_connection_state" | "get_messages" | "get_queue" | "get_session_stats" | "get_commands" | "get_model_catalog"
      | "get_available_models" | "get_session_header" | "get_session_context" | "get_last_assistant_text" | "get_system_prompt" | "get_rlm_children" | "wait_for_idle" })
  | (Session & { type: "set_model"; provider: string; modelId: string })
  | (Session & { type: "set_thinking_level"; level: ThinkingLevel })
  | (Session & { type: "set_steering_mode" | "set_follow_up_mode"; mode: QueueMode })
  | (Session & { type: "set_auto_compaction" | "set_auto_retry"; enabled: boolean })
  | (Session & { type: "compact"; customInstructions?: string })
  | (Session & { type: "reload" })
  | (Session & { type: "cancel_rlm_child" | "delete_rlm_subagent"; childId: string })
  | { id?: string; type: "cron_list"; activeSessionId?: string; includeInactive?: boolean }
  | { id?: string; type: "heartbeats_list"; activeSessionId?: string }
  | (Session & { type: "heartbeat_get" })
  | (Session & { type: "heartbeat_set"; schedule: string; prompt: string; deliveryMode?: "steer" | "follow_up"; promoteOwnedSession?: boolean })
  | (Session & { type: "heartbeat_update"; action: "pause" | "resume" | "clear" })
  | (Session & { type: "heartbeat_manage"; jobId: string; action: "pause" | "resume" | "stop" })
  | (Session & { type: "cron_add"; schedule: string; prompt: string; promoteOwnedSession?: boolean })
  | { id?: string; type: "cron_cancel"; activeSessionId?: string; jobId: string }
  | { id?: string; type: "ack_result"; commandId: string }
  | { id?: string; type: "shutdown"; force?: boolean };

export type HostCommandType = HostCommand["type"];

export const HOST_COMMANDS: ReadonlySet<HostCommandType> = new Set<HostCommandType>([
  "list", "list_saved_sessions", "roster_subscribe", "roster_unsubscribe", "create", "attach", "detach", "kill", "rename", "set_session_name",
  "rename_saved_session", "archive_saved_session", "prompt", "steer", "follow_up", "abort", "abort_bash", "abort_compaction", "abort_retry", "abort_branch_summary",
  "abort_and_clear_queue", "clear_queue", "resume_queue", "append_custom_message", "mutate_queued_message", "send_message", "get_state",
  "get_connection_state", "get_messages", "get_queue", "get_session_stats", "get_commands", "get_model_catalog", "get_available_models",
  "get_session_header", "get_session_context", "get_last_assistant_text", "get_system_prompt", "get_rlm_children", "wait_for_idle", "set_model",
  "set_thinking_level", "set_steering_mode", "set_follow_up_mode", "set_auto_compaction", "set_auto_retry", "compact", "reload",
  "cancel_rlm_child", "delete_rlm_subagent", "cron_list", "heartbeats_list", "heartbeat_get", "heartbeat_set", "heartbeat_update",
  "heartbeat_manage", "cron_add", "cron_cancel", "ack_result", "shutdown",
]);

export interface CommandEnvelope {
  type: "command";
  id: string;
  protocol: ProtocolInfo;
  clientId?: string;
  command: HostCommand;
}

export type ErrorInfo =
  | { code: "session_already_active"; sessionPath: string; activeSessionId?: string }
  | { code: "session_locked"; sessionPath: string; holderPid?: number }
  | { code: "unknown_session"; activeSessionId: string };

export type Response =
  | { id?: string; type: "response"; command: string; success: true; data?: unknown }
  | { id?: string; type: "response"; command: string; success: false; error: string; errorInfo?: ErrorInfo };

/** Prime's `SessionActionSnapshot`, filled from Pi's steering and follow-up queues. */
export interface SessionActions {
  queuedCount: number;
  steering: readonly string[];
  followUps: readonly string[];
}

export interface ModelRef {
  provider: string;
  id: string;
  name?: string;
  api?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

/** Prime's `SessionSummary`: one row of `list`, the data of `create` and `get_state`, and `snapshot.summary`. */
export interface SessionSummary {
  id: string;
  activeSessionId: string;
  sessionId: string;
  sessionFile?: string;
  sessionName?: string;
  cwd: string;
  lifecycle: "resident";
  activity: "idle" | "model" | "tool" | "bash" | "compacting" | "busy";
  isSessionActive: boolean;
  runtimeKind: "top-level" | "subagent";
  rlmDepth: number;
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  isBashRunning: boolean;
  isRunningTools: boolean;
  hasRunningRlmChildren: boolean;
  attachedClients: number;
  messageCount: number;
  unfinishedActionCount: number;
  sessionActions: SessionActions;
  streamingMessage?: AgentMessage;
  created?: string;
  modified?: string;
  lastActivityAt?: string;
  firstMessage?: string;
  parentActiveSessionId?: string;
  parentSessionId?: string;
  parentSessionPath?: string;
  rlmChildId?: string;
  rosterStatus: "running" | "idle" | "inactive";
  workerState: "ready";
  workerPid: number;
  diagnostics?: { type: "info" | "warning" | "error"; message: string }[];
}

/** Prime's row for a saved session that no runtime holds, as its `summaryForInactiveSession` writes it: no `activeSessionId`. */
export interface SavedSessionSummary {
  id: string;
  sessionId: string;
  sessionFile: string;
  sessionName?: string;
  cwd: string;
  lifecycle: "archived";
  activity: "idle";
  isSessionActive: false;
  isStreaming: false;
  isCompacting: false;
  attachedClients: 0;
  messageCount: number;
  unfinishedActionCount: 0;
  sessionActions: SessionActions;
  created: string;
  modified: string;
  lastActivityAt: string;
  firstMessage: string;
  parentSessionPath?: string;
}

/** Prime's `AgentConnectionState`, which `get_connection_state` and `snapshot.state` carry. */
export interface ConnectionState {
  activeSessionId: string;
  cwd: string;
  model?: ModelRef;
  thinkingLevel: ThinkingLevel;
  serviceTier: "auto";
  availableThinkingLevels: ThinkingLevel[];
  isStreaming: boolean;
  isCompacting: boolean;
  isBashRunning: boolean;
  retryAttempt: number;
  steeringMode: QueueMode;
  followUpMode: QueueMode;
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  sessionDir?: string;
  leafId: string | null;
  autoCompactionEnabled: boolean;
  messageCount: number;
  sessionActions: SessionActions;
  compactionCount: number;
  goal: { status: "none" };
  /** The session's user heartbeat (`/heartbeat`, `heartbeat_set`), or null. */
  heartbeat: Job | null;
  scopedModels: never[];
  activeToolNames: string[];
  contextUsage?: unknown;
}

/** Prime's `AgentConnectionRlmChildAgentSnapshot`, built from `pi-family/registry.ts` entries. */
export interface ChildSnapshot {
  id: string;
  parentId?: string;
  activeSessionId?: string;
  sessionName?: string;
  label: string;
  status: "running" | "idle" | "completed" | "failed";
  sessionDir: string;
}

export interface SessionSnapshot {
  activeSessionId: string;
  summary: SessionSummary;
  state: ConnectionState;
  messages: AgentMessage[];
  lastEventSequence: number;
  lastEventCursor: EventCursor;
  children: ChildSnapshot[];
}

export interface ReplayInfo {
  status: "complete" | "partial" | "unavailable";
  fromSequence?: number;
  toSequence: number;
  fromCursor?: EventCursor;
  toCursor?: EventCursor;
  reason?: string;
}

export interface AttachResult {
  protocol: ProtocolInfo;
  activeSessionId: string;
  state?: SessionSummary;
  messages?: AgentMessage[];
  snapshot: SessionSnapshot;
  replay: ReplayInfo;
  lastEventSequence: number;
  lastEventCursor: EventCursor;
  snapshotStream?: { id: string; messageCount: number; targetChunkBytes: number };
  client: { id: string; capabilities: ClientCapability[] };
}

export interface SavedSessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  allMessagesText: string;
}

export interface EventMeta {
  id: string;
  protocol: ProtocolInfo;
  activeSessionId: string;
  sequence: number;
  cursor: EventCursor;
  emittedAt: string;
  replayed?: true;
}

/** Prime's `AgentRosterEntry`; `summary` drops the streaming message and queue snapshot. */
export interface RosterEntry {
  agentId: string;
  status: "running" | "idle" | "inactive";
  summary: Omit<SessionSummary, "streamingMessage" | "sessionActions" | "diagnostics">;
}

export interface Hello {
  type: "daemon_hello";
  socketPath: string;
  protocol: ProtocolInfo;
  schemaId: string;
  schemaRevision: number;
  appVersion: string;
  supervisorGeneration: string;
  supervisorPid: number;
  clientId: string;
  serverCapabilities: readonly ServerCapability[];
  /** The chat's scratch serve passes writes only to a daemon whose hello carries this mark (user-history `src/read-only-daemon.ts`). */
  replay?: true;
  host: "pi-host";
}

export type Outbound =
  | Hello
  | Response
  | { type: "daemon_closing"; reason: "shutdown" }
  | { type: "heartbeats_changed" }
  | { type: "durable_event"; thread: string; watch: string; event: unknown }
  | { type: "durable_feed_event"; feed: string; row: FeedRow }
  | { type: "roster_update"; changed: RosterEntry[]; removed?: string[]; resync?: true }
  | { type: "session_event"; activeSessionId: string; event: { type: string; [key: string]: unknown }; meta: EventMeta }
  | { type: "session_snapshot_begin"; activeSessionId: string; snapshotId: string; snapshot: Omit<SessionSnapshot, "messages">; messageCount: number; targetChunkBytes: number; purpose: "attach" }
  | { type: "session_snapshot_chunk"; activeSessionId: string; snapshotId: string; index: number; messages: AgentMessage[] }
  | { type: "session_snapshot_end"; activeSessionId: string; snapshotId: string; chunkCount: number; lastEventSequence: number; lastEventCursor: EventCursor }
  | { type: "session_closed"; activeSessionId: string; reason: CloseReason; meta?: EventMeta }
  | { type: "session_list_progress"; id: string; command: "list_saved_sessions"; loaded: number; total: number }
  | { type: "session_list_item"; id: string; command: "list_saved_sessions"; session: SavedSessionInfo }
  | { type: "extension_error"; activeSessionId: string; extensionPath: string; event: string; error: string };

export function ok(id: string | undefined, command: string, data?: unknown): Response {
  return { id, type: "response", command, success: true, ...(data === undefined ? {} : { data }) };
}

export function fail(id: string | undefined, command: string, error: unknown, errorInfo?: ErrorInfo): Response {
  const text = error instanceof Error ? error.message : String(error);
  return { id, type: "response", command, success: false, error: text, ...(errorInfo ? { errorInfo } : {}) };
}

/** The failure text for a command pi-host does not serve; Prime's `isUnknownDaemonCommandError` matches `Unknown daemon command: <type>`. */
export const unknownCommand = (type: string) => `Unknown daemon command: ${type}. pi-host serves a subset of the Prime v7 protocol (packages/pi-host/src/protocol.ts).`;

/** Parses one client line into a command and its correlation id. Returns an error text for a line that is not a command. */
export function parseCommandLine(line: string): { command: HostCommand & { id?: string }; id?: string; clientId?: string } | { error: string; id?: string } {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return { error: "The line is not JSON." }; }
  if (!value || typeof value !== "object") return { error: "The line is not a JSON object." };
  const wire = value as { type?: unknown; id?: unknown; clientId?: unknown; command?: unknown };
  const id = typeof wire.id === "string" ? wire.id : undefined;
  if (wire.type === "command") {
    const command = wire.command as { type?: unknown } | undefined;
    if (!command || typeof command !== "object" || typeof command.type !== "string") return { error: "The envelope has no command type.", id };
    return { command: { ...(command as HostCommand), id }, id, clientId: typeof wire.clientId === "string" ? wire.clientId : undefined };
  }
  if (typeof wire.type !== "string") return { error: "The command has no type.", id };
  return { command: value as HostCommand, id };
}
