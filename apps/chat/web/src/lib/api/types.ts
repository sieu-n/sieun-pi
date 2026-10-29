/**
 * Every shape the chat server sends and takes. The server imports this file too, so a field changes in one place.
 * apps/chat/API.md describes each endpoint and event in words.
 */
import type { BoardOp, ChatBoard, CheckInPause, CheckInView, ChatAgent, OwnerTodo, PlanStatus, AccountsView, MachineView } from "./shared/types.ts";
import type { DutyView } from "./shared/chat-duties.ts";
import type { DutyCardModel } from "./shared/duty-card.ts";

export type { BoardOp, ChatBoard, CheckInPause, CheckInView, ChatAgent, OwnerTodo, PlanItem, PlanStatus, AccountsView, MachineView } from "./shared/types.ts";
export type { DutyView } from "./shared/chat-duties.ts";

/** A duty row as the server sends it: the DutyView with its runs newest first, the card model and the judged last run. */
export type DutyRow = DutyView & { card: DutyCardModel; last: { verdict: string; at: number; streak: number; afterJob: boolean } | null };

/** Epoch milliseconds. */
export type Ms = number;

/**
 * A conversation id names one timeline.
 * An agent's DM room is `dm_<slug>`, a root thread is its pi-host thread id, a job inside a thread is `<thread>:<conversation>`, and a
 * channel is `ch_<id>` and a Solo room `so_<id>`. `/api/c/<thread id>` opens a work thread's or job's transcript.
 */
export type ConversationId = string;
/** An agent is `ag_<slug>`. A job keeps its conversation id, and a root thread that no agent record holds yet keeps its thread id. */
export type AgentId = string;
/** A room the chat server stores: `dm_<slug>` for an agent's DM, `ch_<id>` for a channel and `so_<id>` for a Solo room. */
export type RoomId = string;

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
  /** The channels and Solo rooms it is a member of. */
  rooms: RoomId[];
  host: string;
  /** An agent's DM room, `dm_<slug>`. */
  room?: RoomId;
  /** An agent's home folder: its work thread's cwd when the agent was made. */
  home?: string;
  /** For a job: the registered agent it works for, even when its `parent` is another job. */
  agent?: { id: AgentId; name: string };
  /**
   * An agent's comm threads, one per room (agent-model.md phase 4): the thin thread that talks in that room, reads the work thread's state
   * and hands it work. A comm thread is never an agent, a job or a solo chat, so no list shows it as one.
   */
  comm?: { room: RoomId; thread: string; status: RunStatus }[];
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
  /** For a dm whose agent has a comm thread: that thread's state, so the room shows typing dots while it answers. */
  commStatus?: RunStatus;
  /** For a Solo room (`so_<id>`, kind solo): its agenda. An untitled root chat in the Solo group has none. */
  agenda?: string;
  /** For a closed Solo room: when the owner closed it; the sidebar folds it under "Done". */
  closedAt?: Ms;
}

export interface Sidebar {
  /** Solo rooms (`so_<id>`, with `agenda`), open ones first, then root chats that no agent holds, each newest first. */
  solo: ConversationSummary[];
  /** Channels he is a member of, by name. */
  channels: ConversationSummary[];
  /** One DM room per agent (`dm_<slug>`), newest first; jobs and work threads never sit here. */
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
  /** A turn's own text when the agent talks through send_message: a private working note, shown only in the fold. */
  | { kind: "note"; text: string }
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
      /** DM agent posts: the `why` of the tell_owner call (answer, done, decision, blocker, update). */
      why?: string;
      /** DM agent posts: "Show work" opens this conversation at `around` (`e<entry>`), the turn that holds the call. */
      work?: { conversation: ConversationId; around: string };
      /** DM agent posts: the jobs the post's turn started, drawn as job pills. */
      jobs?: JobRef[];
      /** A post or input a job typed into the owner's composer to test it: `author` is that job, and the page says it was a test send. */
      testSend?: { by: Principal; reason: string };
    }
  | {
      kind: "turn"; id: string; at: Ms; author: Principal; text: string; live: boolean; steps: Step[]; images: ImageRef[]; jobs: JobRef[];
      /**
       * Set when the agent talks through send_message: each call's text, one bubble each, and `text` is them joined. Empty on a quiet turn,
       * which shows only its fold. Absent on a turn from before the conversation's first send_message call, whose `text` is the bubble.
       */
      sent?: string[];
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
  /** A DM: the agent's work thread, which "Open work thread" opens. */
  workThread?: ConversationId;
  /** Live answer text that has not become an item yet. */
  partial?: LivePartial | null;
  /** While the conversation's run waits for a working slot: its place in pi-pool's turn queue. */
  queue?: TurnPlace | null;
  /** Channels: the chat whose board the side panel shows. */
  homeChat?: string;
  purpose?: string;
  /** Solo rooms: the agenda, pinned on top. */
  agenda?: string;
  /** A closed Solo room: it takes no posts until the owner reopens it. */
  closedAt?: Ms;
  /** Channels and Solo rooms: the member agents whose boards the side panel shows. */
  boards?: AgentId[];
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

/**
 * A channel (`ch_<id>`) or a Solo room (`so_<id>`), as `/api/rooms` returns it (agent-model.md phase 5). `agenda` is a Solo room's agenda
 * and a channel's purpose. A DM is a room too, but it is listed by agent (`/api/dms`), never here.
 */
export interface Room {
  id: RoomId; kind: "channel" | "solo"; name: string; agenda: string; homeChat?: string; createdAt: Ms; archived: boolean; closedAt?: Ms;
  members: Member[]; lastSeq: number;
}
/** `POST /api/rooms`. A Solo room needs an agenda and at least one agent, and its name defaults to the agenda's start; a channel needs a name. */
export interface RoomInput { kind: "channel" | "solo"; name?: string; agenda?: string; members?: AgentId[]; homeChat?: string }
/** `PATCH /api/rooms/:id`. `closed` closes or reopens a Solo room. */
export interface RoomPatch { name?: string; agenda?: string; closed?: boolean; archived?: boolean; homeChat?: string | null }

/** `cwd` moves a root thread to another project folder; its next request runs there. */
export interface ConversationPatch { name?: string; archived?: boolean; model?: string; thinkingLevel?: ThinkingLevel; cwd?: string }

/** `GET /api/projects`: the project checkouts on this box a new agent can run in, the default first, and the home folder the server refuses. */
export interface ProjectFolder { path: string; name: string }
export interface ProjectList { projects: ProjectFolder[]; default: string | null; home: string }

export interface SearchHit {
  id: string;
  /** Where it was said: a channel, a solo chat, a DM or a job, with the agent a job or DM belongs to as `parent`. */
  conversation: { id: ConversationId; kind: ConversationKind; name: string; parent?: { id: ConversationId; name: string }; archived?: boolean };
  /** `e<entry>` for a thread hit and `p<n>` for a post: open `/api/c/<conversation>/items?around=<messageId>`, whose `focus` is the item that holds it. */
  messageId: string;
  /** The owner, an agent, or for a system note (a check-in, a job report, a board change) `system` with the note's label as its name. */
  author: { id: string; name: string; kind: "owner" | "agent" | "system" };
  /** A job's test send typed into the owner's DM: `author` is that job. */
  testSend?: { reason: string };
  at: Ms;
  kind: "message" | "turn" | "tool" | "post";
  /**
   * What holds the match: the owner's or an agent's own words, a tool's call or output (`tool` names it, and `inCall` says the match sits
   * in the call's arguments), or a system note.
   */
  role: "owner" | "agent" | "tool" | "system";
  tool?: string;
  inCall?: boolean;
  /** A channel reply: the root post of its thread. */
  threadRoot?: string;
  /** Escaped text with only <mark> tags around matches, about 36 words of the human text; tool output comes cleaned of JSON punctuation. */
  snippet: string;
  /** The longer text "Show more" opens, up to 2,000 characters in the same form, only when it holds more than the snippet. */
  text?: string;
}
export interface SearchResult { hits: SearchHit[]; total: number; nextCursor?: string }
/**
 * `from` is `owner`, `agents` (anyone but the owner) or one agent id; `type` keeps only messages (no tool output) or only tool output;
 * `in` is a conversation id; `after` and `before` are YYYY-MM-DD in KST.
 */
export interface SearchQuery {
  q: string; from?: string; in?: string; after?: string; before?: string; sort?: "relevance" | "recent"; type?: "messages" | "tools";
  limit?: number; cursor?: string;
}

export interface JobNode { id: ConversationId; parent: ConversationId | null; name: string; depth: number; status: RunStatus; model: string | null; createdAt: Ms | null }

/** Board: a plan step that waits for the owner's go carries `awaitingGo`. */
export interface BoardView { board: ChatBoard | null; awaitingGo: string[] }
/** `chatId` is the agent id (or a thread id that no agent holds yet), and `chatName` the agent's name. */
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

/** One entry of Prime's harness store (`harness_state.json`), as Prime's `rlm.harness` writes it. */
export interface HarnessEntryView {
  id: string;
  kind: "memory" | "prompt" | "skill" | "subagent";
  title: string;
  content: string;
  path: string;
  /** Who wrote it: "agent" for `rlm.harness` in a kernel, "owner" for the Agents page. */
  source: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/**
 * An agent's folder (`~/.pi/agent/agents/<slug>/`, apps/chat/docs/agent-model.md phase 3): its brief and its memory. pi-host loads both into
 * every thread of the agent, the brief as a Prime context file and the memory as the local store of Prime's harness digest.
 */
export interface AgentFolder {
  agent: AgentId;
  dir: string;
  /** `brief.md`: the agent's responsibility in the owner's words. `text` is "" when the file is missing. */
  brief: ConfigFile & { text: string };
  /** `harness/harness_state.json`: the agent's local harness store; `count` is its entries, newest `updatedAt` first in `entries`. */
  memory: ConfigFile & { entries: HarnessEntryView[] };
}

export interface MemoryInput { title: string; content: string; path?: string }

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
    /** False when the cwd is the home folder or above it, so no project's AGENTS.md, skills or rules load. */
    project: boolean;
    /** True for a root thread, whose cwd `PATCH /api/c/:id` can change; a job inside a thread follows its thread. */
    canMove: boolean;
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
  /** The folder of the agent this card belongs to, shared by its work thread and every job; null for a root chat no agent holds. */
  folder: AgentFolder | null;
  memory:
    | { kind: "none"; note: string; related: ConfigFile[] }
    | { kind: "agent"; note: string; related: ConfigFile[] };
  instructions: { files: ConfigFile[]; note: string };
  swarm: {
    parent: { id: AgentId; name: string } | null;
    jobs: { id: AgentId; name: string; kind: "job" | "duty" | "root job"; status: RunStatus; createdAt: Ms | null; parent: AgentId | null; depth: number }[];
    /** The channels and Solo rooms it is a member of. */
    rooms: { id: RoomId; kind: "channel" | "solo"; name: string }[];
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
  /** `agents` holds registered agents only (`ag_<slug>`); `jobs` holds each job and child conversation that works for one of them. */
  | { type: "hello"; me: Me; sidebar: Sidebar; agents: AgentSummary[]; jobs: AgentSummary[]; conversations: ConversationSummary[] }
  | { type: "sidebar"; sidebar: Sidebar }
  | { type: "agent"; agent: AgentSummary }
  | { type: "agent_removed"; id: AgentId }
  | { type: "job"; job: AgentSummary }
  | { type: "job_removed"; id: AgentId }
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
  /** A chat's duty rows, sent when a run starts or ends and when a duty is paused, resumed or rescheduled. */
  | { type: "duties"; chatId: string; duties: DutyRow[] }
  | { type: "room"; room: Room }
  | { type: "error"; message: string };

/** Page to server. `after` is the newest item id the page holds, so a reconnect sends only what it missed. */
export type LiveCommand =
  | { type: "watch"; conversation: ConversationId; after?: string }
  | { type: "unwatch"; conversation: ConversationId };
