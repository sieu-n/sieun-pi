export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface TextPart { type: "text"; text: string; truncated?: true }
export interface ThinkingPart { type: "thinking"; thinking: string; truncated?: true; redacted?: true }
export interface ImagePart { type: "image"; mimeType: string; url: string }
export interface ToolCallPart { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; truncated?: true }

export interface UserMessage { role: "user"; content: string | (TextPart | ImagePart)[]; timestamp: number; skill?: string }
export interface AssistantMessage {
  role: "assistant"; content: (TextPart | ThinkingPart | ToolCallPart)[]; provider: string; model: string;
  stopReason: StopReason; errorMessage?: string; timestamp: number;
}
export interface ToolResultMessage {
  role: "toolResult"; toolCallId: string; toolName: string; content: (TextPart | ImagePart)[]; isError: boolean; timestamp: number;
  durationMs?: number;
}
export interface CustomMessage { role: "custom"; customType: string; content: string | (TextPart | ImagePart)[]; timestamp: number }
export interface BashExecutionMessage {
  role: "bashExecution"; command: string; output: string; exitCode?: number; cancelled: boolean; truncated: boolean; timestamp: number;
}
export interface BranchSummaryMessage { role: "branchSummary"; summary: string; timestamp: number }
export interface CompactionSummaryMessage { role: "compactionSummary"; summary: string; tokensBefore: number; timestamp: number }
export type ThreadMessage = UserMessage | AssistantMessage | ToolResultMessage | CustomMessage | BashExecutionMessage | BranchSummaryMessage | CompactionSummaryMessage;

export interface ModelInfo { provider: string; id: string; name: string; input: ("text" | "image")[]; contextWindow: number; reasoning: boolean }
export interface ContextUsage { tokens: number; contextWindow: number; percent: number }
export interface SessionUsage { inputTokens: number; outputTokens: number; cost: number }
export interface SessionAction { label: string }
export interface ThreadInfo {
  sessionId: string;
  name?: string;
  cwd: string;
  model: ModelInfo | null;
  thinkingLevel: ThinkingLevel;
  availableThinkingLevels: ThinkingLevel[];
  isStreaming: boolean;
  isCompacting: boolean;
  isBashRunning: boolean;
  retryAttempt: number;
  messageCount: number;
  context: ContextUsage | null;
  usage: SessionUsage | null;
  sessionAction: SessionAction | null;
  queuedActions: number;
  recap?: string;
}
export type ChildStatus = "queued" | "running" | "done" | "error" | "cancelled";
export interface ChildAgent {
  id: string; parentId?: string; sessionName?: string; model?: string; label: string; status: ChildStatus;
  durationMs?: number; recap?: string; error?: string; answerPreview?: string;
  activity?: { kind: "waiting" | "writing" | "executing"; toolName?: string };
}
export interface QueueState { steering: string[]; followUp: string[] }
export type ThreadConnection = "connected" | "reconnecting" | "closed";

export interface ToolRun {
  toolCallId: string; toolName: string; status: "running" | "done"; startedAt: number; partial?: string; isError?: boolean;
}
export interface RetryState { attempt: number; maxAttempts: number; delayMs: number; error: string }

export interface ThreadSnapshot {
  kind: "live" | "saved";
  info: ThreadInfo;
  messages: ThreadMessage[];
  streaming: AssistantMessage | null;
  queue: QueueState;
  children: ChildAgent[];
  tools: ToolRun[];
  retry: RetryState | null;
  runStartedAt: number | null;
}

export interface ThreadState extends ThreadSnapshot { connection: ThreadConnection; error?: string }

export type ProjectedSessionEvent =
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "turn_start" }
  | { type: "turn_end" }
  | { type: "message_start"; message: ThreadMessage }
  | { type: "message_update"; message: AssistantMessage }
  | { type: "message_end"; message: ThreadMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; partial: string }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; isError: boolean }
  | { type: "compaction_start" }
  | { type: "compaction_end"; aborted: boolean; errorMessage?: string }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | { type: "session_info_changed"; name: string | undefined }
  | { type: "thinking_level_changed"; level: ThinkingLevel }
  | { type: "rlm_child_update"; child: ChildAgent }
  | { type: "session_action_update"; active: SessionAction | null; queuedCount: number }
  | { type: "recap_update"; recap: string | undefined }
  | { type: "bash_start"; command: string }
  | { type: "bash_end"; exitCode: number | undefined; cancelled: boolean };

export type ThreadEvent =
  | { type: "snapshot"; snapshot: ThreadSnapshot }
  | { type: "event"; event: ProjectedSessionEvent }
  | { type: "info"; info: ThreadInfo }
  | { type: "queue"; queue: QueueState }
  | { type: "children"; children: ChildAgent[] }
  | { type: "status"; connection: ThreadConnection; error?: string };

export type SessionKind = "live" | "saved";
export type SessionStatus = "running" | "idle" | "saved";
export interface SessionRow {
  id: string;
  name: string;
  named: boolean;
  cwd: string;
  kind: SessionKind;
  status: SessionStatus;
  archived: boolean;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  created?: string;
  lastActivityAt?: string;
  messageCount: number;
  unread: boolean;
  workerState?: string;
  statusLabel?: string;
}
export interface SessionsEvent { type: "sessions"; sessions: SessionRow[]; daemon: "up" | "down"; error?: string }

export interface ModelCatalog { models: ModelInfo[]; configuredProviders: string[]; current: ModelInfo | null; thinkingLevel: ThinkingLevel | null; availableThinkingLevels: ThinkingLevel[] }
export interface Command { name: string; description?: string; argumentHint?: string; source: "extension" | "prompt" | "skill" }
export interface Workspace { cwd: string; lastUsedAt?: string; count: number }
export interface ImageInput { type: "image"; mimeType: string; data: string }
export type SendMode = "steer" | "followUp";

export interface PoolAccount {
  id: string; email: string; plan?: string; usage: string; session_pct: number | null; weekly_pct: number | null;
  usable: boolean; reason: string | null; current: boolean; pinned: boolean; force: boolean; live: boolean; seat: boolean; score: number | null;
}
export interface PoolResolution { account: string | null; email: string | null; reason: string | null; pinned: boolean }
export interface PoolProvider { provider: "anthropic" | "openai-codex"; rows: PoolAccount[]; resolution: PoolResolution | null; error?: string }
export interface AccountsView { sessionId: string | null; checkedAt: string; providers: PoolProvider[] }
export interface PoolEvent { ts: string; event: string; provider?: string; account?: string; reason?: string; source?: string }
export type AccountAction = { action: "use"; provider: string; account: string; id: string; force: boolean } | { action: "follow"; provider: string; id: string }
  | { action: "pin"; provider: string; account: string } | { action: "unpin"; provider: string } | { action: "switch"; provider: string };
