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
  /** Its daemon session id, when the daemon's list gave it (`rosterChildren`); the hub's snapshots have none. */
  sessionId?: string;
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
/** The pool account a new chat starts on. */
export interface NewChatAccount { provider: string; id: string }
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
/**
 * `waitUntil` (an ISO date-time) and `waitFor` (a short text naming an event or a thread) mark a step that waits on purpose: the check-in
 * counts it `waiting` until that time, or for STEP_STALE_MS of no progress, then `due` or `stale-chase` (`stepClass` in src/checkin-steps.ts).
 */
export interface PlanItem {
  id: string; text: string; status: PlanStatus; job?: string; note?: string; waitUntil?: string; waitFor?: string;
  /** The session id of the thread that owns the step (a job of the chat or another thread), kept when the job is deleted or renamed; `job` keeps what the chat wrote. */
  sessionId?: string;
  /** The step ships, ports, deploys, merges to a shared app, or moves demo work to a real app: it moves only after the owner's go (`stepGo`). Once set, it stays. */
  go?: "needed";
  /** A Build step: one whose text starts with "Build", or this flag. It starts only after its goal's requirements check passes (`requirementGaps`). */
  kind?: "build";
  /** A goal's requirements check: one line per owner requirement, quoting the owner's words. */
  requirements?: Requirement[];
  /** A goal's measurable target and its last measurement (`goalGaps` in src/checkin-findings.ts); only a top-level plan item carries one. */
  target?: GoalTarget;
  /**
   * The duty metric this step fixes, `<dutyId>/<metricKey>` like "d6/usable_pct_24h" or "checkin/stuck_steps" (`dutyFixes` in
   * src/shared/duty-fixes.ts). Each duty run reads it as the fix for that metric's miss, and its close starts a verify run of the duty.
   */
  duty?: string;
  /**
   * The board reopened this done item because an open step went under it (plan_add, or plan_update with a parent). When its last open step
   * closes, the board marks it done again; a status the agent sets clears the mark.
   */
  reopened?: true;
  children: PlanItem[];
}
/**
 * A goal's target, as the chat set it: `metric` reaches `target` (a positive number, in `unit`), higher is better. `current`, `measuredAt` (ISO)
 * and `source` (how it was measured) are the last measurement, all three or none. `cadence: "daily"` marks a metric a daily duty measures: its
 * measurement goes stale after 24 h instead of 2 check-in intervals.
 */
export interface GoalTarget { metric: string; target: number; unit: string; current?: number; measuredAt?: string; source?: string; cadence?: "daily" }
export const REQUIREMENT_STATUSES = ["met", "unmet", "open"] as const;
export type RequirementStatus = typeof REQUIREMENT_STATUSES[number];
/** One line of the owner's request on a goal: the owner's words, whether the design meets it, the evidence for met, a note for an unmet or open line the owner put off. */
export interface Requirement { text: string; status: RequirementStatus; evidence?: string; note?: string }
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
export interface OwnerTodo {
  id: string; text: string; done: boolean; reply?: string; choices?: string[]; from: "agent" | "owner"; at: string;
  /** The plan step this todo asks the owner's go for; a step id in the text links it too (`linksStep`), and a PR the step names makes it about that step (`coversStep`). */
  step?: string;
  /** Who wrote `reply`. Only the owner answers; a reply without it predates the field and is no go. */
  answeredBy?: "owner";
  /** The pages the owner opens to answer it; a review ask needs one here or an http URL in its text (`reviewAskWithoutLink`). */
  links?: ArtifactLink[];
}
export interface ChatBoard { v: 2; rev: number; plan: PlanItem[]; scratch: ScratchItem[]; todos: OwnerTodo[]; updatedAt: string }
export type BoardActor = "agent" | "owner";
/** The gate fields a plan op can set: `go` only to "needed" (it never clears), `kind` and `requirements` (null clears them on plan_update). */
type GateInput = { go?: "needed"; kind?: "build"; requirements?: Requirement[] };
export type PlanItemInput = { id?: string; text: string; status?: PlanStatus; job?: string; sessionId?: string; note?: string; waitUntil?: string; waitFor?: string; target?: GoalTarget;
  duty?: string; children?: PlanItemInput[] } & GateInput;
export type BoardOp =
  | { op: "plan_set"; items: PlanItemInput[] }
  | ({ op: "plan_add"; parent?: string; text: string; status?: PlanStatus; job?: string; sessionId?: string; waitUntil?: string; waitFor?: string; target?: GoalTarget; duty?: string } & GateInput)
  | { op: "plan_update"; id: string; parent?: string | null; text?: string; status?: PlanStatus; job?: string | null; sessionId?: string | null; note?: string | null; waitUntil?: string | null;
      waitFor?: string | null; go?: "needed"; kind?: "build" | null; requirements?: Requirement[] | null; target?: GoalTarget | null; duty?: string | null }
  | { op: "plan_remove"; id: string }
  | { op: "scratch_add"; parent?: string; text: string; links?: ArtifactLink[] }
  | { op: "scratch_update"; id: string; text?: string; links?: ArtifactLink[] }
  | { op: "scratch_remove"; id: string }
  | { op: "todo_add"; text: string; choices?: string[]; step?: string; links?: ArtifactLink[] }
  | { op: "todo_update"; id: string; text?: string; done?: boolean; reply?: string | null; links?: ArtifactLink[] }
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
  /** Chats only: while the server waits to restart a failed owner turn, what it waits for; the feed shows it under the owner's message. */
  wait?: ChatWait | null;
  /** The session file holds messages before `messages[0]` that the server did not read; `POST api/threads/<id>/older` reads them. */
  older?: true;
}
/** `retry`: the turn is restarted at `at`. `account`: no Claude account can serve the selected Anthropic model; `until` is when one frees up. Epoch ms. */
export type ChatWait = { kind: "retry"; error: string; at: number } | { kind: "account"; until: number | null };

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
  | { type: "wait"; wait: ChatWait | null }
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
  /** Chats only: every thread linked to it (`chatAgents`), running first, for the Agents card and the sidebar tree. A chat's `unread` ignores `working`, so a job report shows while other jobs run. */
  agents?: ChatAgent[];
  /** Chats only: plan steps done and in total (dropped ones left out), for the sidebar line; absent with no plan. */
  plan?: { done: number; total: number };
  /** Chats only: open For you todos on its board, the sidebar's "N for you"; absent at 0. */
  forYou?: number;
  /** Chats only, with `unread`: the feed rows that came after the read marker (the chat's replies and folded update runs); absent when not known. */
  unreadCount?: number;
  /** Chats only: the check-in schedule the owner set (`<dataDir>/check-in-settings.json`). */
  checkIn?: CheckInState;
  /** Chats only: the brief it last loaded against the current one (Settings > Updates, Chat rules). */
  brief?: ChatBriefState;
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
/**
 * A chat's brief in the sessions stream: the version it last loaded (null when it loaded before versions were recorded), the version the service
 * runs now, and whether a reload onto it is queued or waits for the chat's turn to end.
 */
export interface ChatBriefState { version: string | null; current: string; updating: boolean }
/** The pause the owner picks: an hour, until the next 09:00 local, or until resumed. */
export type CheckInPause = "1h" | "tomorrow" | "forever";
export const CHECK_IN_PAUSES: readonly CheckInPause[] = ["1h", "tomorrow", "forever"];
/** The intervals the owner may set, in whole minutes; the control offers 1, 5, 15, 30 and 60 and takes any other in range. */
export const CHECK_IN_MIN_MINUTES = 1;
export const CHECK_IN_MAX_MINUTES = 240;
export const CHECK_IN_PRESET_MINUTES: readonly number[] = [1, 5, 15, 30, 60];
/** How a thread is linked to a chat, the strongest kept when several apply: its subagent, a root it started, a plan step's owner, a thread it exchanged agent messages with in the last day. */
export type AgentLink = "subagent" | "root" | "step" | "message";
/**
 * A subagent works, has ended its task (done) or stopped on an error (failed); any other thread works or is idle. `waiting` is an idle one whose
 * last exchange with the chat is a message it sent that asks something, so the chat owes it an answer.
 */
export type AgentState = "working" | "waiting" | "idle" | "done" | "failed";
/** Output tokens per second of a thread, from the usage store's calls: `live` from the calls that ended in the last minute, else the average over its calls. */
export interface TokenRate { tps: number; live: boolean }
/**
 * One thread linked to a chat, in the sessions stream on the chat's row (`SessionRow.agents`, computed by `chatAgents` on the server): the Agents card,
 * the sidebar tree and the chat_board tool list the same rows. `name` is the display name: the session name, or one derived from its first task when
 * the name is empty, "Untitled" or kebab-case (display only; the session keeps its name). `job` is what `store.openJob` takes: the subagent's name,
 * or `session:<id>` for any other thread.
 */
export interface ChatAgent {
  /** `child:<rlmChildId>` for a subagent, else `thread:<sessionId>`. */
  key: string;
  /** The thread to open; absent for a subagent whose session the daemon does not list (deleted, or not listed yet). */
  sessionId?: string;
  childId?: string;
  name: string;
  job: string;
  /** The name its messages to the chat carry (`chatLines` `from`): the session name as given, so a derived display name still finds its reports. */
  sender: string;
  link: AgentLink;
  state: AgentState;
  /** One line: what it does while working, the first line of its last message to the chat, or how it ended. */
  activity?: string;
  lastActivityAt?: string;
  /** Plan item ids whose owner it is. */
  steps: string[];
  /** Its output tokens per second, when the usage store has a timed call for its session. */
  rate?: TokenRate;
  /** Running subagents below it at any depth, the sidebar's `SessionRow.subagentsRunning`; absent at 0. */
  subagentsRunning?: number;
  /** Every subagent it spawned at any depth, finished and deleted ones included; absent at 0. */
  subagentsTotal?: number;
  /** Its turn waits in the Mac-wide turn queue (`pi-pool queue --json`); absent when it does not. */
  queued?: QueuePlace;
}
/** A session's place in the Mac-wide turn queue: its position, how many wait, and when it began to wait (epoch ms). */
export interface QueuePlace { position: number; total: number; since: number }
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
  /** `label` is what to show: the email, plus the organization when two pooled accounts share the email. */
  id: string; email: string; label: string; plan?: string; usage: string; session_pct: number | null; weekly_pct: number | null;
  usable: boolean; reason: string | null; current: boolean; pinned: boolean; live: boolean; seat: boolean; score: number | null;
  tier: string | null; windows: PoolWindow[]; usageAt: number | null; cooldownUntil: number | null; cooldownReason: string | null; disabled: boolean;
  /** Epoch ms until which the provider answered 429 for this account (`pi-pool limited`); null when no limit is on file. */
  limitedUntil: number | null;
  /** Threads on this account: root sessions (each with its jobs) whose last request through the pool was within `active_session_sec`. */
  sessions: number;
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
/** A thread's class in the pool (`pi-pool priority`): high trees get admission slots first, low ones wait for the emptiest accounts. */
export type PoolPriority = "high" | "normal" | "low";
export const POOL_PRIORITIES: readonly PoolPriority[] = ["high", "normal", "low"];
/** The pool holds the thread until `account` admits it at `slotAt` (epoch ms): its 429 ends, its 5h window resets, or a slot frees. */
export interface PoolWait { account: string; slotAt: number }
/** `wait` is null when the thread does not wait on this provider. */
export interface PoolProvider { provider: "anthropic" | "openai-codex"; rows: PoolAccount[]; resolution: PoolResolution | null; wait?: PoolWait | null; poolPin?: string | null; error?: string }
/** The numeric settings of `pi-pool config` (pool/base.py DEFAULTS merged with ~/.config/pi-pool/config.json), by key. */
export type PoolConfig = Readonly<Record<string, number>>;
/** `poolConfig` is null when `pi-pool config` could not be read; the client then shows pi-pool's defaults. */
/** `priority` is the thread's pool class, null with no thread or when the pool does not say. */
export interface AccountsView { sessionId: string | null; checkedAt: string; providers: PoolProvider[]; poolConfig: PoolConfig | null; priority?: PoolPriority | null; notice?: string }
export type AccountAction = { action: "use"; provider: string; account: string; id: string; newSession?: boolean } | { action: "follow"; provider: string; id: string }
  | { action: "pin"; provider: string; account: string } | { action: "unpin"; provider: string } | { action: "switch"; provider: string }
  | { action: "recheck"; provider: string } | { action: "resets"; provider: string; account?: string } | { action: "reset"; provider: string; account: string; grant?: string }
  | { action: "disable"; provider: string; account: string } | { action: "enable"; provider: string; account: string } | { action: "remove"; provider: string; account: string };
/** One account inside a usage refresh. `usageAt` and `retryAt` are epoch ms. */
export interface UsageRefreshAccount {
  id: string; email: string | null; label: string | null; state: "queued" | "reading" | "read" | "failed"; reason: string | null; usageAt: number | null; retryAt: number | null;
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
  /** "Open the app at login". `appName` is the installed app for this chat URL, null while none is installed. */
  openAppAtLogin: { available: boolean; enabled: boolean; appName: string | null; message: string };
  /** False on a remote origin: these switches change only from the Mac that runs the chat. */
  editable: boolean;
}
export interface RemoteAccessInput { tailscale?: boolean; keepRunning?: boolean; openAppAtLogin?: boolean }

/** Settings > Slack: the workspace connection, and the chats the owner synced to a private Slack channel each. */
export interface SlackView {
  state: "off" | "no-tokens" | "no-owner" | "connecting" | "on" | "problem";
  message: string;
  enabled: boolean;
  /** The one Slack member id whose messages reach the chats. */
  ownerUserId: string | null;
  /** The bot's team from auth.test; events from any other team are dropped. */
  teamId: string | null;
  teamName: string | null;
  /** Chats synced to a channel now. */
  channels: number;
  /** Each synced chat's channel, by chat id. A chat not listed is not synced; sync is off until the owner turns it on. */
  chats: Record<string, SlackChatLink>;
  tokenSource: "keychain" | "environment" | null;
  /** The Keychain service the tokens are read from. */
  keychainService: string;
  /** False on a remote origin: the switch changes only from the Mac that runs the chat. */
  editable: boolean;
}
export interface SlackInput { enabled?: boolean; ownerUserId?: string | null }
/** A synced chat's channel as the header shows it: the id (for the Open in Slack link), the name without `#`, and whether it is private. */
export interface SlackChatLink { channel: string; name: string; isPrivate: boolean }
/** The channel a chat gets when it is synced: a name in Slack's alphabet and private (the default) or public. */
export interface SlackChannelSetup { name: string; isPrivate: boolean }
/** A channel the bot can see, for the setup dialog's existing-channel list. */
export interface SlackChannelOption { id: string; name: string; isPrivate: boolean }
/**
 * A chat's Slack control. `connect` is idempotent: a chat already synced keeps its channel whatever the body says. Without `existing` the
 * channel is created (or reused by name); `existing` is a channel id or `#name` the bot is already in.
 */
export type SlackChatInput =
  | { action: "connect"; name?: string; isPrivate?: boolean; existing?: string }
  | { action: "rename"; name: string }
  | { action: "stop" };

/** Settings > This Mac: CPU and memory of the machine the chat service runs on, read on each request. */
export type MemoryPressure = "normal" | "warn" | "critical";
export interface MachineView {
  /** Busy share of all cores since the previous reading, 0 to 100. */
  cpu: { percent: number; cores: number; load: [number, number, number] };
  /** usedBytes counts app, wired and compressed memory, as Activity Monitor's "Memory Used" does on macOS. Swap and pressure are null off macOS. */
  memory: { usedBytes: number; totalBytes: number; swapUsedBytes: number | null; swapTotalBytes: number | null; pressure: MemoryPressure | null };
}

/** One session in `pi-pool queue --json`. Times leave the server in epoch ms. */
export interface AgentQueueSession { session: string; tree: string; parent: string | null; priority: PoolPriority; since: number }
export interface AgentQueuedSession extends AgentQueueSession { basePriority: PoolPriority; position: number; total: number; waitMs: number }
/** The pi-pool memory governor's level: ok, or high and critical, which lower the working limit and hold low turns. */
export type PressureLevel = "ok" | "high" | "critical";
/** One memory reading behind a level, in bytes but `kernel`, which is kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical. */
export interface PressureReading { kernel: number; swapUsedBytes: number; swapTotalBytes: number; compressorBytes: number; ramBytes: number }
/** A level change and the working limits before and after it, with the reading that made it; `at` in epoch ms. */
export interface PressureChange { from: PressureLevel; to: PressureLevel; at: number; limitFrom: number; limitTo: number; reading: PressureReading | null }
/** `queue --json`'s `pressure`: `limit` is the working limit the level allows and `held` the queued turns it holds. `on` is false when `memory_governor_on` is 0. */
export interface AgentQueueGovernor { on: boolean; level: PressureLevel; limit: number; held: number; since: number; reading: PressureReading | null; changed: PressureChange | null }
/** Who last ran `pi-pool set` on a key and when, in epoch ms. `by` is null for a value written before pi-pool recorded writers; `at` is then config.json's file time. */
export interface PoolSetRecord { by: string | null; at: number }
/**
 * `pi-pool queue --json` as parsed. `enabled` is the `agent_queue_on` switch; the two limits keep their numbers while it is off.
 * `macWorkingMaxSet` is null while the Mac limit holds pi-pool's default.
 */
export interface AgentQueueReading { enabled: boolean; macWorkingMax: number; macWorkingMaxSet: PoolSetRecord | null; treeWorkingMax: number; working: AgentQueueSession[]; queued: AgentQueuedSession[]; governor: AgentQueueGovernor | null }
export type IdleEvictionMinutes = number | "off";

/**
 * Settings > This Mac > Agent queue. `pool` is `unread` when the pool did not answer, so every turn runs unqueued; `nextTitle` names the first
 * queued session. `idleEvictionMinutes` is the daemon's own setting in ~/.prime/agent/settings.json, which it rereads on every sweep.
 */
export type AgentQueuePool = (AgentQueueReading & AgentQueueTimers & { state: "read"; nextTitle: string | null }) | { state: "unread"; error: string };
/** The queue's two timers from `pi-pool config`: a waiting turn moves up one class every `queueAgingS`, and a slot with no model call for `leaseS` lapses. */
export interface AgentQueueTimers { queueAgingS: number; leaseS: number }
export interface AgentQueueView { pool: AgentQueuePool; idleEvictionMinutes: IdleEvictionMinutes }

/** One Agent queue write: a single `pi-pool set` for the switch, the two limits and the two timers, or the daemon's idle unload time. */
export type AgentQueueInput = { action: "queue"; on: boolean } | { action: "mac" | "tree" | "aging" | "lease"; value: number } | { action: "idle"; value: IdleEvictionMinutes };

/**
 * Settings > Tools and skills: live checks of the tools agents use (the Aside browser, web search, computer use), run on the chat server with
 * the Skills and tools duty's own checks (scripts/duties/skills-and-tools.ts). `id` is that duty's check id; `off` is installed but closed on purpose.
 */
export type ToolKind = "browser" | "web search" | "computer use";
export interface ToolCheck { id: string; kind: ToolKind; tool: string; status: "pass" | "fail" | "off"; detail: string; fix?: string; ms: number }
/** The newest `--only` re-check of a flagged check after the daily run, as the duty job runs it after a fix. */
export interface ToolsRecheck { at: number; status: "pass" | "fail" | "off"; detail: string }
/**
 * The daily Skills and tools duty's newest run: its chat, when, the verdict, and each check it flagged as failing or off, by check id, with the
 * duty job's latest re-check of that check when there is one.
 */
export interface ToolsDailyRun {
  chatId: string; dutyId: string; name: string; at: number; verdict: "met" | "missed" | "error" | "skipped"; summary: string;
  checksRun: number | null; problems: { id: string; status: "fail" | "off"; text: string; recheck?: ToolsRecheck }[];
}
/** `checkedAt` is when the live checks ran; the server keeps one result for a few minutes so opening the tab does not pay for a search each time. */
export interface ToolsView { checkedAt: number; checks: ToolCheck[]; daily: ToolsDailyRun | null }

/** Where an installed skill comes from: the global folder, the running Prime release's built-in skills, or a repo's skill folder. */
export type SkillSource = "global" | "built-in" | "repo";
/**
 * One installed skill: its front matter name and one-line description, its source, a short label of the folder (`from`), and its SKILL.md path after links.
 * `tokens` is what its <skill> block adds to every Prime session's system prompt, 0 when Prime leaves it out; `userOnly` is a skill whose front matter
 * sets disable-model-invocation, which Prime loads for /skill commands but never lists in the prompt.
 */
export interface SkillInfo { name: string; description: string; source: SkillSource; from: string; path: string; enabled: boolean; tokens: number; userOnly: boolean }
/** The first request of the newest fresh root session in the repo: input plus cache read plus cache write tokens, from its first reply's usage. */
export interface FirstPrompt { tokens: number; at: number; sessionId: string }
/**
 * Skill tokens per fresh session: each group's blocks, the fixed lines around them, the sum, the measured first prompt they are a share of, and the
 * chars per token the blocks are counted at.
 */
export interface SkillTokens { groups: Record<SkillSource, number>; header: number; total: number; firstPrompt: FirstPrompt | null; charsPerToken: number }
export interface SkillsView { skills: SkillInfo[]; tokens: SkillTokens }

/** A chat-client SDK update. `failed` comes back after a restart until the daemon version changes or Retry succeeds. */
export interface SdkUpdateState { state: "idle" | "running" | "failed" | "restarting"; target?: string; message: string; log: string[]; at?: string }
/** Settings > Updates: the Prime Agent daemon, the prime-agent package this chat loaded, and the chat build. */
export interface SdkView {
  daemon: string | null;
  /** The prime-agent SDK version the daemon ships; the Rust daemon (0.10.0+) ships an older TypeScript SDK. Null until the daemon reports. */
  sdk: string | null;
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
