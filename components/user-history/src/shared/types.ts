export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface TextPart { type: "text"; text: string; truncated?: true }
export interface ThinkingPart { type: "thinking"; thinking: string; truncated?: true; redacted?: true }
export interface ImagePart { type: "image"; mimeType: string; url: string }
export interface ToolCallPart { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; truncated?: true }

export interface UserMessage { role: "user"; content: string | (TextPart | ImagePart)[]; timestamp: number; skill?: string }
/** Native per-call `usage` of an assistant message; `cost` is the native `cost.total`. */
export interface MessageUsage { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number }
export interface AssistantMessage {
  role: "assistant"; content: (TextPart | ThinkingPart | ToolCallPart)[]; provider: string; model: string;
  stopReason: StopReason; errorMessage?: string; timestamp: number; usage?: MessageUsage;
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

export interface ModelInfo { provider: string; id: string; name: string; input: ("text" | "image")[]; contextWindow: number; reasoning: boolean; thinkingLevels?: ThinkingLevel[] }
export interface ContextUsage { tokens: number; contextWindow: number; percent: number }
export interface SessionUsage { inputTokens: number; outputTokens: number; cost: number }
/** Native `getSessionStats()` totals for a live thread. */
export interface ThreadStats { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }; cost: number }
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
  /** The child messaged its parent since its current task arrived; absent when the daemon cannot tell (a child resumed after a restart). */
  repliedSinceTask?: boolean;
  /** Epoch ms of the child's last model, tool or progress-note event. */
  lastActivityAt?: number;
}
/**
 * What a running session is doing, from its native daemon summary. `activityAt` is its latest activity or that of any running subagent under it,
 * so a thread that only waits on busy subagents still reads as live.
 */
export interface Pulse {
  streaming: boolean; tools: boolean; bash: boolean; children: boolean; activityAt?: string; summary?: string;
  /** The daemon judged `summary` at the session's present message count (it sends `taskState` only then); absent once a later message landed. */
  summaryCurrent?: true;
  silentSince?: string; failed?: boolean;
}
/** The pool account a new chat starts on; `force` uses an account that cannot serve now, after the user confirmed. */
export interface NewChatAccount { provider: string; id: string; force: boolean }
export interface ChildPulse extends Pulse { rlmChildId: string; sessionId: string }
export interface SessionPulse extends Pulse { subagents: ChildPulse[] }
/** A subagent's native session id and cost, matched to a ChildAgent by `rlmChildId` (its id) or its session name. */
export interface ChildUsage { sessionId: string; rlmChildId?: string; sessionName?: string; cost?: number }
export interface QueueState { steering: string[]; followUp: string[] }
export type ThreadConnection = "connected" | "reconnecting" | "closed";

export interface ToolRun {
  toolCallId: string; toolName: string; status: "running" | "done"; startedAt: number; partial?: string; isError?: boolean;
}
export interface RetryState { attempt: number; maxAttempts: number; delayMs: number; error: string }

/**
 * A chat's shared board, one JSON file per chat (`<dataDir>/boards/<sessionId>.json`). The agent writes it with the `chat_board` tool, the owner
 * through `POST api/threads/<id>/board`; both go through `applyBoardOp` (src/shared/chat-board.ts). `rev` rises by one per applied op.
 */
export type PlanStatus = "todo" | "doing" | "done" | "blocked" | "dropped";
export interface PlanItem { id: string; text: string; status: PlanStatus; job?: string; note?: string; children: PlanItem[] }
/**
 * Where an artifact link points. Stored as a string, resolved by the page (src/shared/artifact-link.ts):
 * `job:<name>` opens that job's drawer in this chat; `thread:<sessionId>` opens a thread, `thread:<sessionId>@<timestamp>` jumps to one message
 * in it (the message's `timestamp`, ms); `wiki:<path>` opens an llm-wiki page on :5176; `http(s)://...` opens in a new tab. A pasted chat URL
 * (`.../#<sessionId>@<timestamp>`) is stored as its `thread:` form.
 */
export interface ArtifactLink { label: string; target: string }
/** One scratchpad note: short text, optionally with links to what it is about, and notes nested under it to any depth. */
export interface ScratchItem { id: string; text: string; links: ArtifactLink[]; at: string; children: ScratchItem[] }
/**
 * Something only the owner can give: a decision, a login, an approval. `choices` are the answers the agent offers (first one is its
 * recommendation); the owner taps one or writes `reply`.
 */
export interface OwnerTodo { id: string; text: string; done: boolean; reply?: string; choices?: string[]; from: "agent" | "owner"; at: string }
export interface ChatBoard { v: 2; rev: number; plan: PlanItem[]; scratch: ScratchItem[]; todos: OwnerTodo[]; updatedAt: string }
export type BoardActor = "agent" | "owner";
export type PlanItemInput = { id?: string; text: string; status?: PlanStatus; job?: string; note?: string; children?: PlanItemInput[] };
export type BoardOp =
  | { op: "plan_set"; items: PlanItemInput[] }
  | { op: "plan_add"; parent?: string; text: string; status?: PlanStatus; job?: string }
  | { op: "plan_update"; id: string; text?: string; status?: PlanStatus; job?: string | null; note?: string | null }
  | { op: "plan_remove"; id: string }
  | { op: "scratch_add"; parent?: string; text: string; links?: ArtifactLink[] }
  | { op: "scratch_update"; id: string; text?: string; links?: ArtifactLink[] }
  | { op: "scratch_remove"; id: string }
  | { op: "todo_add"; text: string; choices?: string[] }
  | { op: "todo_update"; id: string; text?: string; done?: boolean; reply?: string | null }
  | { op: "todo_remove"; id: string };

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
  /** Chats only: the shared board, null until the first op. */
  board?: ChatBoard | null;
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
  | { type: "board"; board: ChatBoard }
  | { type: "status"; connection: ThreadConnection; error?: string };

export type SessionKind = "live" | "saved";
export type SessionStatus = "running" | "idle" | "saved";
export interface SessionRow {
  id: string;
  /** The native title: session name, else first message (see sessionTitle). */
  name: string;
  cwd: string;
  kind: SessionKind;
  status: SessionStatus;
  archived: boolean;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  created?: string;
  lastActivityAt?: string;
  messageCount: number;
  /** The thread's own turn runs (`status` "running") or a subagent below it runs. Drives the Working group. */
  working: boolean;
  /** Running subagents at any depth, as the terminal agents view counts them under a row. */
  subagentsRunning: number;
  /** Not working, and its last activity came after the browser last left it (the read marker). */
  unread: boolean;
  workerState?: string;
  statusLabel?: string;
  /** The daemon's failure line when the session settled on a failed model call and nothing came after it. Only on rows that are not running. */
  failure?: string;
  tags: string[];
  priority: Priority;
  schedule?: ThreadSchedule;
  progress: Progress;
  /** Cost in dollars of the thread plus every subagent below it, the terminal agents view's number; absent when the daemon reported no usage. */
  cost?: number;
  /** Present while working: freshness inputs for this thread and its running subagents. */
  pulse?: SessionPulse;
  /** The thread is a chat (listed in `<dataDir>/chats.json`): the sidebar sections it under Chats and the main view renders Chat.svelte. */
  chat?: true;
  /** Chats only: the subagent sessions under it, for the sidebar tree. A chat's `unread` ignores `working`, so a job report shows while other jobs run. */
  jobs?: ChatJob[];
  /** Chats only: the check-in schedule the owner set (`<dataDir>/check-in-settings.json`). */
  checkIn?: CheckInState;
  /**
   * Who started the thread: a person through this chat (`threads.json`, `chats.json`) or an agent through `rlm.create_session` (its name precedes
   * `session_state` in the session file). The sidebar hides agent-created rows by default. Absent reads as user.
   */
  origin?: "user" | "agent";
}
/**
 * A chat's check-in schedule in the sessions stream: its interval, the pause in force (`pausedUntil`, "forever" until resumed, null when none) and
 * when the next one runs (null while paused until resumed; after a timed pause it can be later than the pause end).
 */
export interface CheckInState { everyMs: number; paused: boolean; pausedUntil: number | "forever" | null; nextAt: number | null }
/** `GET api/threads/<id>/check-in`: the state and the last check-in this service ran (null before its first). */
export interface CheckInView extends CheckInState { lastAt: number | null }
/** The pause the owner picks: an hour, until the next 09:00 local, or until resumed. */
export type CheckInPause = "1h" | "tomorrow" | "forever";
export const CHECK_IN_PAUSES: readonly CheckInPause[] = ["1h", "tomorrow", "forever"];
/** The intervals the owner may set, in whole minutes; the control offers 1, 5, 15, 30 and 60 and takes any other in range. */
export const CHECK_IN_MIN_MINUTES = 1;
export const CHECK_IN_MAX_MINUTES = 240;
export const CHECK_IN_PRESET_MINUTES: readonly number[] = [1, 5, 15, 30, 60];
/** One job of a chat in the sessions stream: a subagent session whose parent is the chat. `name` is its session name, what the chat and the plan call it. */
export interface ChatJob {
  id: string; childId?: string; name: string; status: "running" | "idle" | "saved";
  /** What it is doing (the daemon summary or status label) while running, or how it ended. */
  activity?: string; lastActivityAt?: string; failed?: true;
}
export interface SessionsEvent { type: "sessions"; sessions: SessionRow[]; tags: Tag[]; daemon: "up" | "down"; error?: string }

export type Priority = 0 | 1 | 2 | 3;
export interface Tag { id: string; name: string; hue: number }
export type Progress = "none" | "plan" | "implementation" | "qa";
export const PROGRESS_STEPS: readonly Progress[] = ["none", "plan", "implementation", "qa"];
export interface ThreadLabels { tags: string[]; priority: Priority; progress: Progress }
/** A person's memo on a thread. `updatedAt` is 0 when there is none. */
export interface ThreadNote { text: string; updatedAt: number }
export interface ThreadSchedule { kind: "heartbeat" | "cron"; label?: string; status: "active" | "paused"; expression: string; nextRunAt?: string }
export type LabelAction =
  | { op: "create"; name: string; ids: string[] }
  | { op: "rename"; tagId: string; name: string }
  | { op: "delete"; tagId: string }
  | { op: "tag"; tagId: string; ids: string[]; on: boolean }
  | { op: "priority"; ids: string[]; priority: Priority }
  | { op: "progress"; ids: string[]; progress: Progress };

/**
 * Model catalog for one thread, or, with no thread, for the new-chat screen: `current`, `thinkingLevel` and `availableThinkingLevels` then come from
 * the Prime Agent defaults (`ChatDefaults`) resolved against `models`.
 */
export interface ModelCatalog { models: ModelInfo[]; configuredProviders: string[]; current: ModelInfo | null; thinkingLevel: ThinkingLevel | null; availableThinkingLevels: ThinkingLevel[] }
/** The model and effort a new native session starts with, from `defaultProvider`, `defaultModel` and `defaultThinkingLevel` in Prime Agent's settings.json. */
export interface ChatDefaults { provider: string | null; modelId: string | null; thinkingLevel: ThinkingLevel | null }
/** A write of the defaults; a missing or null `thinkingLevel` keeps the stored level, which the native session clamps to the model. */
export interface ChatDefaultsInput { provider: string; modelId: string; thinkingLevel?: ThinkingLevel | null }
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const isThinkingLevel = (value: unknown): value is ThinkingLevel => typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
export interface Command { name: string; description?: string; argumentHint?: string; source: "extension" | "prompt" | "skill" | "session" }
export interface Workspace { cwd: string; lastUsedAt?: string; count: number }
export interface ImageInput { type: "image"; mimeType: string; data: string }
export type SendMode = "steer" | "followUp";

export interface PoolWindow { kind: "session" | "weekly" | "model"; label: string; pct: number; resetsAt: number | null }
export interface PoolAccount {
  id: string; email: string; plan?: string; usage: string; session_pct: number | null; weekly_pct: number | null;
  usable: boolean; reason: string | null; current: boolean; pinned: boolean; force: boolean; live: boolean; seat: boolean; score: number | null;
  tier: string | null; windows: PoolWindow[]; usageAt: number | null; cooldownUntil: number | null; cooldownReason: string | null; disabled: boolean;
  /** Claude only: the last read of the account's banked usage-limit resets; null when never read. */
  resets?: AccountResets | null;
}
/** One banked reset grant. Times are epoch ms. */
export interface ResetGrant {
  id: string; label: string; resetsTotal: number; resetsLeft: number; startsAt: number | null; endsAt: number | null;
  clears: string[]; paused: boolean; usableNow: boolean; useRequiresLimit: boolean;
}
/** `pi-pool resets` for one account. `grants` is the last good read; `error` is a later read that failed. */
export interface AccountResets {
  checkedAt: number | null; eligible: boolean | null; ineligibleReason: string | null; atLimit: boolean; cooldownUntil: number | null;
  grants: ResetGrant[]; nextGrantId: string | null; error: string | null; errorAt: number | null;
  /** A claim whose outcome is unknown; using the reset again retries it with the same request id. */
  pending: { grantId: string; createdAt: number } | null;
}
export interface PoolResolution { account: string | null; email: string | null; reason: string | null; pinned: boolean }
export interface PoolProvider { provider: "anthropic" | "openai-codex"; rows: PoolAccount[]; resolution: PoolResolution | null; poolPin?: string | null; error?: string }
export interface AccountsView { sessionId: string | null; checkedAt: string; providers: PoolProvider[]; notice?: string }
export type AccountAction = { action: "use"; provider: string; account: string; id: string; force: boolean; newSession?: boolean } | { action: "follow"; provider: string; id: string }
  | { action: "pin"; provider: string; account: string } | { action: "unpin"; provider: string } | { action: "switch"; provider: string }
  | { action: "recheck"; provider: string } | { action: "resets"; provider: string; account?: string } | { action: "reset"; provider: string; account: string; grant?: string }
  | { action: "disable"; provider: string; account: string } | { action: "enable"; provider: string; account: string } | { action: "remove"; provider: string; account: string };
/** One account inside a usage refresh. `usageAt` and `retryAt` are epoch ms. */
export interface UsageRefreshAccount {
  id: string; email: string | null; state: "queued" | "reading" | "read" | "failed"; reason: string | null; usageAt: number | null; retryAt: number | null;
}
/** One `pi-pool refresh --stream` run: every account of a provider, or one account. The last run per provider stays readable after it ends. */
export interface UsageRefresh {
  id: string; provider: "anthropic" | "openai-codex"; account: string | null; status: "running" | "done" | "failed";
  accounts: UsageRefreshAccount[]; message: string | null; startedAt: number; endedAt: number | null;
}
/** One browser-driven `pi-pool login`: add an account, or sign one in again when `account` is set. */
export interface AccountLogin {
  id: string; provider: "anthropic" | "openai-codex"; account: string | null;
  status: "starting" | "waiting" | "finishing" | "done" | "failed" | "cancelled";
  url: string | null; manualUrl: string | null; code: string | null; paste: boolean; message: string | null;
}

/** Phone access: `tailscale` follows this Mac's tailnet name, `custom` is a fixed `--public-origin`, `off` is loopback only. */
export type RemoteMode = "tailscale" | "custom" | "off";
export interface RemoteAccessView {
  mode: RemoteMode;
  state: "on" | "off" | "checking" | "problem";
  message: string;
  origin: string | null;
  /** The full private chat URL on the remote origin; null while there is no origin. */
  phoneUrl: string | null;
  checkedAt: string | null;
  /** Result of the last request to `<origin>/<capability>/api/identity` from this Mac; null before the first check. */
  reachable: boolean | null;
  keepRunning: { available: boolean; enabled: boolean; state: "on" | "off" | "problem"; message: string };
  /** False on a remote origin: these switches change only from the Mac that runs the chat. */
  editable: boolean;
}
export interface RemoteAccessInput { tailscale?: boolean; keepRunning?: boolean }

/** Settings > Slack: the bridge that links each chat to a private Slack channel. */
export interface SlackView {
  state: "off" | "no-tokens" | "no-owner" | "connecting" | "on" | "problem";
  message: string;
  enabled: boolean;
  /** The one Slack member id whose messages reach the chats. */
  ownerUserId: string | null;
  /** The bot's team from auth.test; events from any other team are dropped. */
  teamId: string | null;
  teamName: string | null;
  /** Chats linked to a channel. */
  channels: number;
  tokenSource: "keychain" | "environment" | null;
  /** The Keychain service the tokens are read from. */
  keychainService: string;
  /** False on a remote origin: the switch changes only from the Mac that runs the chat. */
  editable: boolean;
}
export interface SlackInput { enabled?: boolean; ownerUserId?: string | null }

/** A chat-client SDK update. `failed` comes back after a restart until the daemon version changes or Retry succeeds. */
export interface SdkUpdateState { state: "idle" | "running" | "failed" | "restarting"; target?: string; message: string; log: string[]; at?: string }
/** Settings > Versions: the Prime Agent daemon, the prime-agent package this chat loaded, and the chat build. */
export interface SdkView {
  daemon: string | null;
  client: string;
  build: string;
  matched: boolean;
  auto: boolean;
  /** scripts/sync-prime-agent.mjs is present, so this chat can update itself. */
  available: boolean;
  /** The service runs under launchd, so it can restart itself after an update. */
  canRestart: boolean;
  update: SdkUpdateState;
}
