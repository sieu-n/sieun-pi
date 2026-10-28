/**
 * Every shape the chat server sends and takes. The server imports this file too, so a field changes in one place.
 * apps/chat/API.md describes each endpoint and event in words.
 */
import type { BoardOp, ChatBoard, CheckInPause, CheckInView, ChatAgent, OwnerTodo, PlanStatus, AccountsView, MachineView } from "./shared/types.ts";
import type { DutyView } from "./shared/chat-duties.ts";

export type { BoardOp, ChatBoard, CheckInPause, CheckInView, ChatAgent, OwnerTodo, PlanItem, PlanStatus, AccountsView, MachineView } from "./shared/types.ts";
export type { DutyView } from "./shared/chat-duties.ts";

/** Epoch milliseconds. */
export type Ms = number;

/**
 * A conversation id names one timeline.
 * A root thread is its pi-host thread id, a job inside a thread is `<thread>:<conversation>`, and a channel is `ch_<id>`.
 * An agent's id is the id of its own conversation, so `/api/c/<agent id>` opens its transcript.
 */
export type ConversationId = string;
export type AgentId = string;
export type ChannelId = string;

export type ConversationKind = "solo" | "dm" | "channel" | "job";
/** A thread's or job's run state. pi-host says idle, running, sleeping or failed, and the server names running "working". */
export type RunStatus = "working" | "idle" | "sleeping" | "failed";

/** Who wrote an item: the owner, a chat (a root thread) or a job (a child conversation or a root a chat started). */
export interface Principal {
  id: "owner" | AgentId;
  kind: "owner" | "chat" | "job";
  name: string;
  /** Two letters and a color seed for the avatar; the shell draws it. */
  avatar: { initials: string; hue: number };
  /** A job's parent agent id. */
  parent?: AgentId;
}

export interface ModelRef { provider: string; id: string; label: string }
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export interface ModelInfo extends ModelRef { family: string; levels: ThinkingLevel[] }
export interface ModelCatalog { models: ModelInfo[]; default: { model: string; thinkingLevel: ThinkingLevel } }

/** One card on the Agents page and one row of the @ typeahead. */
export interface AgentSummary {
  id: AgentId;
  kind: "chat" | "job";
  name: string;
  avatar: Principal["avatar"];
  model: ModelRef | null;
  thinkingLevel: ThinkingLevel | null;
  status: RunStatus;
  parent: { id: AgentId; name: string } | null;
  thread: string;
  /** The conversation inside the thread file; 1 is the root. */
  conversation: number;
  archived: boolean;
  createdAt: Ms;
  updatedAt: Ms;
  /** The newest text it wrote, one line. */
  preview: string;
  /** Channels it is a member of. */
  channels: ChannelId[];
  host: string;
}

/** One row of the conversation directory, which the sidebar, search and the # typeahead read. */
export interface ConversationSummary {
  id: ConversationId;
  kind: ConversationKind;
  name: string;
  status: RunStatus;
  archived: boolean;
  lastActivityAt: Ms;
  preview: string;
  /** The owner's unread items; for a channel only posts that mention him. */
  unread: number;
  /** New posts since his read mark, for a channel row's bold. */
  hasNew: boolean;
  /** Agents working in it now. */
  working: { id: AgentId; name: string }[];
  /** For a dm or job: the agent it belongs to. */
  agent?: AgentId;
  /** For a job: its parent conversation. */
  parent?: ConversationId;
}

export interface Sidebar {
  /** Root threads the owner runs with agents, newest first. */
  solo: ConversationSummary[];
  /** Channels he is a member of, by name. */
  channels: ConversationSummary[];
  /** Root chats he opened as DMs, newest first; jobs and duty threads never sit here. */
  dms: ConversationSummary[];
  /** Open For you todos across every chat. */
  forYou: number;
}

export interface ImageRef { url: string; mimeType: string; width?: number; height?: number }
/** An image the composer attaches, base64 without the data: prefix. */
export interface ImageUpload { data: string; mimeType: string }

/**
 * Where a conversation's run stands in pi-pool's turn queue: working (kind owner, ahead, slot and so on), queued at a position, marked as
 * the owner's turn and not started yet, or none (no run asks for a slot).
 */
export type TurnPlace =
  | { state: "working"; kind: string }
  | { state: "queued"; position: number; total: number }
  | { state: "marked" }
  | { state: "none" };

/**
 * An owner send the chat server holds until the agent has it: sending (pi-host has not taken it yet), sent (pi-host took it, maybe as a
 * steer that waits for the running turn) or failed (pi-host refused it for good, or the page could not reach the chat server).
 */
export type SendState = "sending" | "sent" | "failed";

export type DeliveryState = "queued" | "delivered" | "read" | "answered" | "no_reply" | "stopped" | "failed";
export interface Delivery {
  target: AgentId; name: string; state: DeliveryState; at: Ms; answer?: string; error?: string;
  /** While the target's run waits for a working slot: its place in pi-pool's turn queue. */
  queue?: TurnPlace;
}

/** A job a turn spawned, drawn as a thread pill under that turn. */
export interface JobRef { conversation: ConversationId; name: string; status: RunStatus; replies: number; lastAt: Ms }

export type Step =
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; summary: string; status: "running" | "done" | "error"; output?: string; job?: ConversationId };

/**
 * One row of a timeline. Every item has a stable id, and a live update replaces the item with the same id.
 * In a thread, `message` is an input (the owner's or another agent's), `turn` is the agent's answer to it with every model call and tool step,
 * and `system` is a note such as a compaction. In a channel every post is a `message`, and replies sit in `thread`.
 */
export type Item =
  | {
      kind: "message"; id: string; at: Ms; author: Principal; text: string; images: ImageRef[]; mentions: AgentId[];
      /** Channel posts: the post's place in the channel log. */
      seq?: number;
      /** Channel posts: the root of the Buzz-style thread this reply is in. */
      threadRoot?: string;
      /** Channel root posts: the thread's size and last reply. */
      thread?: { replies: number; lastAt: Ms; authors: Principal[] };
      deliveries: Delivery[];
      /** An owner send `r:<requestId>` that has not shown as an entry yet. */
      pending?: boolean;
      /** A pending send's state; the page shows Sending…, nothing once sent, and Not delivered with Retry when failed. */
      send?: SendState;
      /** Why a send failed, or why its delivery keeps retrying. */
      sendError?: string;
      /** The send's request id: on a pending send and on the owner's channel posts, so the page swaps its own copy for it. */
      requestId?: string;
      /** A pending send's place in pi-pool's turn queue; the live `queue` event updates it. */
      queue?: TurnPlace;
    }
  | {
      kind: "turn"; id: string; at: Ms; author: Principal; text: string; live: boolean; steps: Step[]; images: ImageRef[]; jobs: JobRef[];
      stop?: "aborted" | "error"; error?: string; model?: string;
      usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
    }
  | { kind: "system"; id: string; at: Ms; text: string; avatars: Principal[] };

export interface TimelinePage {
  items: Item[];
  /** Pass as `before` to read the page above; absent at the start. */
  older?: string;
  /** Pass as `after` to read the page below; absent at the end. */
  newer?: string;
  /** With `around`: the item that holds the asked id. */
  focus?: string;
}

export interface Member { principal: Principal; role: "owner" | "member"; wakeOn: "mention" | "all" | "none"; status?: RunStatus }

export interface ConversationHeader {
  summary: ConversationSummary;
  members: Member[];
  model: ModelRef | null;
  thinkingLevel: ThinkingLevel | null;
  /** A thread's root agent, for a solo or dm conversation. */
  agent?: AgentSummary;
  /** Live answer text that has not become an item yet. */
  partial?: LivePartial | null;
  /** While the conversation's run waits for a working slot: its place in pi-pool's turn queue. */
  queue?: TurnPlace | null;
  /** Channels: the chat whose board the side panel shows. */
  homeChat?: string;
  purpose?: string;
  readSeq?: number;
}

export interface LivePartial { itemId: string; text: string; thinking: string; tool?: string }

export interface SendRequest {
  text: string;
  images?: ImageUpload[];
  mentions?: AgentId[];
  /** Channel thread replies. */
  threadRoot?: string;
  /** A retried send with the same id lands once. */
  requestId: string;
  /** For a busy thread: steer the running turn (default) or wait for it to end. */
  whenBusy?: "steer" | "followUp";
}
export interface SendResult { item: Item; deliveries: Delivery[]; queue?: TurnPlace | null }

export interface ChannelInput { name: string; purpose?: string; members?: AgentId[]; homeChat?: string }
export interface Channel { id: ChannelId; name: string; purpose: string; homeChat?: string; createdAt: Ms; archived: boolean; members: Member[]; lastSeq: number }

export interface ConversationPatch { name?: string; archived?: boolean; model?: string; thinkingLevel?: ThinkingLevel }

export interface SearchHit {
  id: string;
  conversation: { id: ConversationId; kind: ConversationKind; name: string };
  /** `e<entry>` for a thread hit and `p<n>` for a post: open `/api/c/<conversation>/items?around=<messageId>`, whose `focus` is the item that holds it. */
  messageId: string;
  author: { id: string; name: string; kind: "owner" | "agent" };
  at: Ms;
  kind: "message" | "turn" | "tool" | "post";
  /** Escaped text with only <mark> tags around matches. */
  snippet: string;
}
export interface SearchResult { hits: SearchHit[]; total: number; nextCursor?: string }

export interface JobNode { id: ConversationId; parent: ConversationId | null; name: string; depth: number; status: RunStatus; model: string | null; createdAt: Ms | null }

/** Board: a plan step that waits for the owner's go carries `awaitingGo`. */
export interface BoardView { board: ChatBoard | null; awaitingGo: string[] }
export interface ForYouItem { chatId: string; chatName: string; todo: OwnerTodo; step?: { id: string; text: string; status: PlanStatus } }
export interface BoardRow {
  chatId: string; chatName: string; rev: number; progress: { done: number; total: number }; openAsks: number; needsGo: number;
  checkIn?: { nextAt: Ms | null; paused: boolean }; duties: { id: string; name: string; nextAt: Ms | null; lastVerdict: string | null }[];
}
export interface DutyAction { duty: string; action: "run" | "pause" | "resume" | "schedule"; schedule?: unknown }
export interface CheckInPatch { everyMs?: number; pause?: CheckInPause | null }

export interface UsageRow {
  thread: string; threadName: string; host: string; model: string; turns: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
export interface UsageReport { at: Ms; since: Ms; until: Ms; rows: UsageRow[]; days: { start: Ms; byModel: Record<string, number> }[]; previous: { cost: number; complete: boolean } }

export interface HostThread { id: string; name: string; status: RunStatus; model: string | null; updatedAt: Ms; children: number }
export interface HostView {
  name: string; address: string; self: boolean;
  relay: { state: "up"; pingMs: number } | { state: "unreachable"; error: string };
  piHost: { state: "answering"; version: string; socket: string } | { state: "down"; error: string } | { state: "absent" };
  machine: MachineView | null;
  threads: HostThread[];
}
export interface HostsReport { checkedAt: Ms; registryError: string | null; hosts: HostView[] }

/** A file the config names: where it is, whether it is there, and a short look inside. `loaded` says whether the agent's model sees it. */
export interface ConfigFile {
  label: string;
  path: string;
  exists: boolean;
  size: number | null;
  modifiedAt: Ms | null;
  /** The first lines, or the newest entries of a store. */
  preview?: string;
  /** Entries in a store, such as the memories in a harness file. */
  count?: number;
  loaded?: boolean;
  note?: string;
}

/**
 * `GET /api/agents/:id/config`: one agent as a role, not a thread. Who it is and what it is for, where it runs, the data it shares with its
 * jobs (board, memory, instructions), and its swarm (jobs, channels, duties, check-in). Every field is read from where it lives; see API.md.
 */
export interface AgentConfig {
  agent: AgentSummary;
  identity: {
    /** The first input of its conversation: the owner's first message, or the brief its parent or a duty gave it. */
    purpose: { text: string; truncated: boolean; from: { id: string; name: string }; at: Ms; via?: string } | null;
    /** The system text its model runs with. */
    system: { text: string | null; source: string };
    /** The duty whose run started it, for a duty job. */
    duty: { chat: AgentId; id: string; name: string } | null;
    wakeAt: Ms | null;
  };
  runs: {
    host: string;
    /** The seam the server reads it through: pi-host, or the in-memory fixture. */
    hostKind: string;
    hostVersion: string | null;
    socket: string;
    /** Its working directory, where its tools run; a thread imported from another box can name a folder this box lacks. */
    cwd: string;
    cwdExists: boolean;
    thread: string;
    conversation: number;
    /** The pi-durable file that holds its transcript, jobs and documents; null on the fixture host. */
    threadFile: ConfigFile | null;
    dataDir: string;
  };
  board: {
    chat: AgentId;
    chatName: string;
    /** False when the agent works on the board of the chat it belongs to. */
    own: boolean;
    doc: string;
    rev: number;
    updatedAt: string;
    goals: { id: string; text: string; status: PlanStatus; open: number; done: number }[];
    steps: { open: number; done: number; total: number };
    awaitingGo: number;
    openTodos: { id: string; text: string; at: string; step?: string }[];
  } | null;
  memory:
    | { kind: "none"; note: string; related: ConfigFile[] }
    | { kind: "files"; files: ConfigFile[]; note?: string };
  instructions: { files: ConfigFile[]; note: string };
  swarm: {
    parent: { id: AgentId; name: string } | null;
    jobs: { id: AgentId; name: string; kind: "job" | "duty" | "root job"; status: RunStatus; createdAt: Ms | null; parent: AgentId | null; depth: number }[];
    channels: { id: ChannelId; name: string }[];
    duties: { id: string; name: string; goal: string; schedule: string; paused: boolean; nextAt: Ms | null; lastVerdict: string | null; lastAt: Ms | null; runs: number }[];
    /** The check-in clock of its chat, when one is set. */
    checkIn: { everyMs: number; paused: boolean; nextAt: Ms | null; lastAt: Ms | null } | null;
    /** The file that holds the duties, their runs and the check-in. */
    dutiesFile: ConfigFile | null;
  };
  /** pi-host's own sums for its whole thread file over the last 7 days; null when the host does not answer. */
  usage: { days: number; turns: number; cost: number; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; scope: string } | null;
}

export interface Me { owner: Principal; host: string; fixture: boolean; wikiBase: string; version: string }

/** Server to page, over the one WebSocket at /api/live. */
export type LiveEvent =
  | { type: "hello"; me: Me; sidebar: Sidebar; agents: AgentSummary[]; conversations: ConversationSummary[] }
  | { type: "sidebar"; sidebar: Sidebar }
  | { type: "agent"; agent: AgentSummary }
  | { type: "agent_removed"; id: AgentId }
  | { type: "conversation"; conversation: ConversationSummary }
  /** Only for a conversation the page watches. */
  | { type: "items"; conversation: ConversationId; items: Item[]; /** Ids to drop, such as a pending send that landed or was discarded. */ removed?: string[] }
  | { type: "partial"; conversation: ConversationId; partial: LivePartial | null }
  | { type: "status"; conversation: ConversationId; status: RunStatus }
  /** Only to tabs that watch it: the run's place in pi-pool's turn queue while it waits, then null once it works or ends. */
  | { type: "queue"; conversation: ConversationId; place: TurnPlace | null }
  | { type: "jobs"; thread: string; jobs: JobNode[] }
  | { type: "board"; chatId: string; board: ChatBoard; awaitingGo: string[] }
  | { type: "for_you"; count: number }
  | { type: "channel"; channel: Channel }
  | { type: "error"; message: string };

/** Page to server. `after` is the newest item id the page holds, so a reconnect sends only what it missed. */
export type LiveCommand =
  | { type: "watch"; conversation: ConversationId; after?: string }
  | { type: "unwatch"; conversation: ConversationId };
