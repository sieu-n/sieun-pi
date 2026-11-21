/**
 * Every shape the chat server sends and takes. The server imports this file too, so a field changes in one place.
 * apps/chat/API.md describes each endpoint and event in words.
 */
import type { BoardOp, ChatBoard, CheckInPause, CheckInView, ChatAgent, OwnerTodo, PlanStatus, AccountsView, MachineView } from "./shared/types.ts";
import type { DutySchedule, DutyView } from "./shared/chat-duties.ts";
import type { DutyCardModel } from "./shared/duty-card.ts";
import type { SkillScan } from "./shared/skills.ts";
import type { ReviewEvent } from "./shared/skills-review.ts";

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
  /** "away" while the chat server has no live link to the agent's box (`host`); absent on a server with one box. */
  hostState?: AgentHostState;
}

/** Whether the chat server has a live link to a box's agent relay. */
export type AgentHostState = "up" | "away";
/** One box agents can run on, as `GET /api/agent-hosts` lists it; `since` is when its link last changed state. */
export interface AgentHost {
  box: string; label: string; self: boolean; state: AgentHostState; since?: Ms;
  /** The box's home folder and project checkouts, the default first, once its relay said hello. */
  home?: string; projects?: string[];
}
export interface AgentHostList { hosts: AgentHost[] }

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
  /** The top-level post he marked unread, while the room reads unread from it (server/keep-unread.ts). */
  unreadFrom?: string;
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
  /** The owner starred it, so the sidebar lists it under Starred (server/sidebar-prefs.ts). */
  starred?: true;
  /** The owner muted it: new posts make no bold and a DM shows no count, while a mention in a channel still counts. */
  muted?: true;
  /** Out of the sidebar: a DM he closed or that has no posts yet, until a new post comes, or a channel he left, until he posts there or joins. */
  hidden?: "closed" | "left";
}

/** The owner's sidebar choices for one room, in the server's state.json under `sidebar`. */
export interface ConversationPrefs {
  starred?: true;
  muted?: true;
  hidden?: { kind: "closed" | "left"; at: Ms };
}

/** `PUT /api/c/:id/prefs`: each given field sets or clears that choice; `hidden: null` puts the room back in the sidebar. */
export interface PrefsPatch {
  starred?: boolean;
  muted?: boolean;
  hidden?: "closed" | "left" | null;
}


/** Where a room read from before Mark all as read, which its Undo puts back: `seq` 0 when he had read nothing, `from` the post he marked unread. */
export interface ReadPoint { room: ConversationId; seq: number; from?: string }
/** `POST /api/read`: Mark all as read on `rooms`, answered with their read points, or its Undo with the points to `restore`. */
export type ReadAllRequest = { rooms: ConversationId[] } | { restore: ReadPoint[] };

export interface Sidebar {
  /** Solo rooms (`so_<id>`, with `agenda`), open ones first, each newest first. */
  solo: ConversationSummary[];
  /** Channels he is a member of, by name. */
  channels: ConversationSummary[];
  /** One DM room per agent (`dm_<slug>`), newest first; jobs and work threads never sit here. */
  dms: ConversationSummary[];
  /** Open For you todos across every chat. */
  forYou: number;
}

export interface ImageRef { url: string; mimeType: string; width?: number; height?: number }

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

/** One emoji under a room post and who put it there, the owner or agents (server/reactions.ts), in the order each emoji first came. */
export interface Reaction { emoji: string; by: Principal[] }

/**
 * Why a message is on an agent's For list (server/for-me.ts): a post in its DM, a post that names it, a group room post delivered to it as
 * a member, a reply in a channel thread it posted in, or someone's reaction on its own post.
 */
export type ForMeReason = "dm" | "mention" | "member" | "thread" | "reaction";
export type ForMeStatus = "pending" | "completed";
/** One message an agent is involved in, as its For <agent> tab and its `list_for_me_messages` tool show it. */
export interface ForMeItem {
  /** `<room id>/<post id>`, the messageId `mark_message` takes. */
  id: string;
  room: RoomId;
  roomKind: "dm" | "channel" | "solo";
  /** `#name` for a channel, the Solo room's name, or `DM`. */
  roomName: string;
  post: string;
  /** Channels: the root post of the thread the post is in. */
  threadRoot?: string;
  author: Principal;
  text: string;
  at: Ms;
  /** The newest time someone other than the agent touched the item: the post itself, or a reaction on the agent's own post. */
  activityAt: Ms;
  reasons: ForMeReason[];
  reactions?: Reaction[];
  /** The done flag of the post's thread, on its root (server/thread-done.ts); absent while the thread is open. */
  done?: ThreadDone;
  /** The agent's own save of the post (server/later-agents.ts); absent when it has no open save of it. */
  later?: LaterMark;
  status: ForMeStatus;
  /** When the agent marked it completed; absent on a completed item from before the list existed. */
  completedAt?: Ms;
}
/** `GET /api/agents/:id/for-me`: the agent's items, newest activity first, and its counts. */
export interface ForMeList { agent: AgentId; items: ForMeItem[]; pending: number; completed: number }

/** Save for later (server/later.ts): Slack's In progress is `open`, its Completed is `done`. */
export type LaterState = "open" | "done";
/** One room post a principal saved for later, the owner or an agent (`by`), stored in `<data dir>/later/<by>.json`. */
export interface LaterItem {
  /** `<room id>:<post id>`, such as `ch_1a2b3c4d:p12`: one item per saved post. */
  id: string;
  by: "owner" | AgentId;
  room: RoomId;
  post: string;
  savedAt: Ms;
  state: LaterState;
  /** When it was checked off; absent while open. */
  doneAt?: Ms;
  /** Remind me: when the reminder is due, and when it fired. A new `remindAt` clears `notifiedAt`. */
  remindAt?: Ms;
  notifiedAt?: Ms;
  /**
   * Keep unread: the owner marked the post unread (server/keep-unread.ts). It sits pinned atop In progress until he replies, reacts or checks
   * it off, and its reminder marks the room unread from it again.
   */
  unread?: true;
}
/** A Later item with what its row shows of the post. `gone` is a post that was deleted or whose room is gone, which has no text. */
export interface LaterRow extends LaterItem {
  roomKind: "dm" | "channel" | "solo";
  /** `#name` for a channel, the Solo room's name, or the agent's name for its DM. */
  roomName: string;
  /** Absent on a post that is gone. */
  author?: Principal;
  text: string;
  /** When the post was written. */
  at: Ms;
  images: number;
  /** Channels: the root post of the thread the post is in. */
  threadRoot?: string;
  gone?: true;
  /** A post in a `test: true` room. */
  test?: true;
}
/**
 * Why a new post is for the owner (server/notices.ts): `dm` in a DM or Solo room, and in a channel `mention` (it names him), `reply` (it
 * answers his post), `thread` (it replies in a thread he wrote in) or `post` (any other).
 */
export type NoticeReason = "dm" | "mention" | "reply" | "thread" | "post";
/** A new post someone else wrote, for the page's system notification. */
export interface Notice {
  room: ConversationId;
  roomKind: "dm" | "channel" | "solo";
  /** `#name` for a channel, the Solo room's name, or the agent's name for its DM. */
  roomName: string;
  post: string;
  threadRoot?: string;
  author: Principal;
  /** The post's text on one line, cut to 300 characters. */
  text: string;
  images: number;
  reason: NoticeReason;
  at: Ms;
}
/** `GET /api/later?state=open|done`: the owner's rows, newest first, with the counts of both tabs. */
export interface LaterList { items: LaterRow[]; open: number; done: number }
/** What a room post shows its reader about the reader's own save; absent when the reader has no open save of it. */
export interface LaterMark { saved: boolean; remindAt?: Ms; /** Kept unread: the owner marked it unread and has not handled it. */ unread?: true }
/** `POST /api/later`. Saving a saved post keeps its one item. */
export interface LaterRequest { room: RoomId; post: string; remindAt?: Ms }
/** `PATCH /api/later/:id`: check off or reopen, and set or clear (`null`) the reminder. */
export interface LaterPatch { state?: LaterState; remindAt?: Ms | null }

/** A job a turn spawned, drawn as a thread pill under that turn. */
export interface JobRef { conversation: ConversationId; name: string; status: RunStatus; replies: number; lastAt: Ms }

export type Step =
  | { kind: "thinking"; text: string }
  /** A turn's own text when the agent talks through send_message: a private working note, shown only in the fold. */
  | { kind: "note"; text: string }
  | { kind: "tool"; id: string; name: string; summary: string; status: "running" | "done" | "error"; outputRef?: StepOutputRef; job?: ConversationId };

/**
 * Where a tool step's output is: `GET /api/c/<conversation>/output/<entry>` reads it when the owner opens it, so a page carries no output
 * text. On 11-03 a job's 277-step turn made a 450 KB page, 305 KB of it output the fold hides.
 */
export interface StepOutputRef { conversation: ConversationId; entry: number }

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
      /** A thread reply also sent to the channel: the channel shows it with a "replied to a thread" line naming the root's first line. */
      alsoInChannel?: { rootText: string };
      /** Agent posts in a DM, a channel or a Solo room: the owner post this one answers, which the page draws apart from the agent's other answers. */
      answers?: string;
      /** Channel root posts: the thread's size and last reply. */
      /** A root post's thread: `lastSeq` is its newest reply's seq, which a read of the room covers (stores.svelte.ts `markRead`). */
      thread?: { replies: number; lastAt: Ms; lastSeq?: number; authors: Principal[] };
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
      /** Room posts: the emoji the owner and agents put under the post. */
      reactions?: Reaction[];
      /** Room posts the owner saved for later (server/later.ts); absent when he has no open save of it. */
      later?: LaterMark;
      /** Room posts: when the owner last edited his post; the page shows "(edited)". */
      editedAt?: Ms;
      /** Room posts: the owner deleted it, so it has no text; the page drops it, or shows a stub on a channel root with replies. */
      deleted?: true;
      /** A thread's root post the owner or an agent marked done (server/thread-done.ts); absent while the thread is open. */
      done?: ThreadDone;
      /** Room posts the owner pinned to the room (server/pins.ts); absent while the post is not pinned. */
      pinned?: PostPin;
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

/** `GET /api/unfurl?url=`: what a web page's <head> states, drawn as a Slack-style card under a post that links it (server/unfurl.ts). */
export interface LinkPreview {
  url: string;
  site: string;
  title: string;
  description?: string;
  /** An https image the page names, absolute. */
  image?: string;
}

export interface TimelinePage {
  items: Item[];
  /** Pass as `before` to read the page above; absent at the start. */
  older?: string;
  /** Pass as `after` to read the page below; absent at the end. */
  newer?: string;
  /** With `around`: the item that holds the asked id. */
  focus?: string;
}

/**
 * A conversation's first page and header, which `POST /api/rooms` and `POST /api/agents` send with the new room, so its first open shows
 * from the page's cache. On 11-20 the owner's first open of a channel and of an agent's DM he had just made waited 212 and 197 ms for an
 * empty page (requests/2026-11-20.jsonl).
 */
export interface OpenedPage { page: TimelinePage; header: ConversationHeader }

export interface Member { principal: Principal; role: "owner" | "member"; wakeOn: "all" | "none"; status?: RunStatus }

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
  /** DMs, channels and Solo rooms: the pinned posts, newest pin first, which the header's Pinned button lists (server/pins.ts). */
  pins?: Item[];
  /** A walk's throwaway room (`POST /api/rooms {test: true}`), whose member picker lists test agents too. */
  test?: true;
}

export interface LivePartial { itemId: string; text: string; thinking: string; tool?: string }

export interface SendRequest {
  text: string;
  /** Refs POST /api/uploads answered: the composer uploads an image when it is attached, so the send itself carries no image bytes. */
  images?: ImageRef[];
  mentions?: AgentId[];
  /** Channel thread replies. */
  threadRoot?: string;
  /** A channel thread reply that shows in the channel too, from the thread composer's "Also send to #channel" box. */
  alsoInChannel?: boolean;
  /** A retried send with the same id lands once. */
  requestId: string;
  /** For a busy thread: steer the running turn (default) or wait for it to end. */
  whenBusy?: "steer" | "followUp";
}
export interface SendResult { item: Item; deliveries: Delivery[]; queue?: TurnPlace | null }
/** `POST /api/c/:id/posts/:post/reactions`: the owner adds (`on`, the default) or takes off his own `emoji` on a room post. */
export interface ReactionRequest { emoji: string; on?: boolean }
/** Who marked a thread done and when, on its root post. */
export interface ThreadDone { by: Principal; at: Ms }
/** `POST /api/c/:id/posts/:post/done`: the owner marks the thread of a post done, or reopens it. */
export interface ThreadDoneRequest { done: boolean }
/** Who pinned a room post and when. */
export interface PostPin { by: Principal; at: Ms }
/** `POST /api/c/:id/posts/:post/pin`: the owner pins a room post, or with `pinned` false un-pins it. */
export interface PinRequest { pinned: boolean }

/**
 * A channel (`ch_<id>`) or a Solo room (`so_<id>`), as `/api/rooms` returns it (agent-model.md phase 5). `agenda` is a Solo room's agenda
 * and a channel's purpose. A DM is a room too, but it is listed by agent (`/api/dms`), never here.
 */
export interface Room {
  id: RoomId; kind: "channel" | "solo"; name: string; agenda: string; homeChat?: string; createdAt: Ms; archived: boolean; closedAt?: Ms;
  members: Member[]; lastSeq: number;
}
/** `POST /api/rooms`. A Solo room needs an agenda and at least one agent, and its name defaults to the agenda's start; a channel needs a name. */
export interface RoomInput {
  kind: "channel" | "solo"; name?: string; agenda?: string; members?: AgentId[]; homeChat?: string;
  /** A walk's throwaway room: no owner list, live event or badge shows it; `GET /api/rooms?test=1` lists it. */
  test?: boolean;
}
/** `PATCH /api/rooms/:id`. `closed` closes or reopens a Solo room. */
export interface RoomPatch { name?: string; agenda?: string; closed?: boolean; archived?: boolean; homeChat?: string | null }

/** `cwd` moves a root thread to another project folder; its next request runs there. */
export interface ConversationPatch { name?: string; archived?: boolean; model?: string; thinkingLevel?: ThinkingLevel; cwd?: string }

/** `GET /api/projects`: the project checkouts on this box a new agent can run in, the default first, and the home folder the server refuses. */
export interface ProjectFolder { path: string; name: string }
export interface ProjectList { projects: ProjectFolder[]; default: string | null; home: string }

/**
 * Where a search hit sits: a top-level post or root-chat message (`root`), a reply in a channel thread (`thread`), or inside an agent's
 * work (`tool`): every entry of a work thread or job, and the tool output of a root chat.
 */
export type SearchWhere = "root" | "thread" | "tool";

/**
 * The six places a search hit sits in exactly one of (server/search.ts SEARCH_PLACES): top-level posts of channels, DMs and Solo rooms
 * (`solo` also holds a root chat's own words), replies in any room's threads, the entries of agents' jobs and work threads, and tool output.
 */
export type SearchPlace = "channels" | "dms" | "solo" | "threads" | "jobs" | "tools";

export interface SearchHit {
  id: string;
  where: SearchWhere;
  /** For `where: "thread"`: the thread's root post and its first words, so a row reads "reply in <title>". */
  thread?: { root: string; title: string };
  /**
   * The web hash route that opens the hit, built once on the server: `#/c/<room>?m=<post>` for a post, `#/c/<room>?thread=<root>&m=<reply>`
   * for a thread reply, and `#/c/<conversation>?m=e<entry>` for a thread entry.
   */
  link: string;
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
  /** A channel reply: the root post of its thread. Same as `thread.root`, which replaces it once the search pages read `thread`. */
  threadRoot?: string;
  /** Escaped text with only <mark> tags around matches, about 36 words of the human text; tool output comes cleaned of JSON punctuation. */
  snippet: string;
  /** The longer text "Show more" opens, up to 2,000 characters in the same form, only when it holds more than the snippet. */
  text?: string;
  /** A post's reactions as agents read them (server/reactions.ts `reactionsLine`), such as `[reactions: 👀 vent · 👍 Sieun (owner)]`. */
  reactionsLine?: string;
}
/** A box whose threads a search could not read, such as a Mac that is offline, with the line the page shows. */
export interface SearchMissing { box: string; note: string }
/**
 * `missing` names each box whose threads are not in `hits` or `total`. `pending`, only in a `local=1` answer, names the boxes whose hits
 * and count are still to come, so `total` is not final until the same request without `local=1` answers.
 */
export interface SearchResult { hits: SearchHit[]; total: number; nextCursor?: string; missing?: SearchMissing[] }

/** A wiki page as GET /api/pages lists it (server/wiki/pages.ts); `path` opens it in the viewer as `wiki:<path>`. */
export interface WikiPageRow { path: string; title: string; description: string | null; updated: string }
/** With `q`, `pages` are the matches with a title match first and `favorites` is empty; without it, the favorites and the pages updated last. */
export interface WikiPages { query: string; favorites: WikiPageRow[]; pages: WikiPageRow[] }
/**
 * `from` takes many values, each `owner`, `agents` (anyone but the owner), an agent id or an agent name; `where` takes many of `root`,
 * `thread` and `tool`, all three when absent, and `place` many of the six SearchPlace values, all six when absent. Many values of one filter
 * are OR-ed, and filters are AND-ed. `in` is a conversation id, a channel or Solo room name (with or without `#`) or an agent name for its
 * DM; `after` and `before` are YYYY-MM-DD in KST.
 */
export interface SearchQuery {
  q: string; from?: string | string[]; in?: string; where?: SearchWhere | SearchWhere[]; place?: SearchPlace | readonly SearchPlace[]; after?: string; before?: string; sort?: "relevance" | "recent";
  limit?: number; cursor?: string;
  /** Leaves each hit's `text` out, for rows that show only the snippet. */
  brief?: boolean;
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
/**
 * A change to a board's duties. `set` takes a whole duty definition, Prime's duty JSON, and adds it or updates the duty with the same name;
 * `remove` deletes a duty with its runs and precheck state; `goal` rewrites what good means; the rest name a duty by id.
 */
export type DutyAction =
  | { action: "run" | "pause" | "resume" | "remove"; duty: string }
  | { action: "schedule"; duty: string; schedule: DutySchedule }
  | { action: "goal"; duty: string; goal: string }
  | { action: "set"; duty: unknown };
export interface CheckInPatch { everyMs?: number; pause?: CheckInPause | null }

export interface UsageRow {
  thread: string; threadName: string; host: string; model: string; turns: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
/** The span the Usage page reads, as Prime's chat Usage page offers it, ending with the bucket that holds now (shared/usage-range.ts). */
export type UsageRange = "1h" | "24h" | "7d" | "30d" | "90d";
/** What one chart bar sums. A minute and an hour start on the clock, and a day starts at the owner's local midnight. */
export type UsageBucket = "minute" | "hour" | "day";
/** One bucket's sums: turns, tokens and cost of each kind, and the cost of each model for the chart's stacks. */
export interface UsageBucketSum {
  start: Ms; turns: number;
  tokens: UsageRow["tokens"]; cost: UsageRow["cost"];
  byModel: Record<string, number>;
}
/** `buckets` holds every bucket of the range, empty ones too, and its sums equal the sums of `rows` (c191). */
export interface UsageReport { at: Ms; since: Ms; until: Ms; range: UsageRange; bucket: UsageBucket; rows: UsageRow[]; buckets: UsageBucketSum[] }

export interface HostThread { id: string; name: string; status: RunStatus; model: string | null; updatedAt: Ms; children: number }
/**
 * The chat server's link to a box's agent relay (`/v2/agents`), as its `RelayHost` holds it in memory: up or away since when, the last pong
 * to its 15 s liveness ping, what the relay's last `hello` said, and the feed cursor the server saved for the box.
 */
export interface AgentRelayLink {
  state: "up" | "away"; since: Ms; lastPongAt: Ms | null; version: string | null;
  piHost: { up: boolean; version?: string; error?: string } | null;
  feedCursor: number;
}
export interface HostView {
  name: string; address: string; self: boolean;
  /** The machine relay (`/v1/host`, relayPort) that the page reads the machine figures from. */
  relay: { state: "up"; pingMs: number } | { state: "unreachable"; error: string };
  /** `socket` is set on the chat server's own box. A box with an agent relay reads pi-host from the relay's last `hello`. */
  piHost: { state: "answering"; version: string; socket?: string } | { state: "down"; error: string } | { state: "absent" };
  /** Null when the chat server dials no agent relay for the box. */
  agentRelay: AgentRelayLink | null;
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
    jobs: { id: AgentId; name: string; kind: "job" | "duty" | "root job"; status: RunStatus; createdAt: Ms | null; parent: AgentId | null; depth: number; archived: boolean }[];
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

export interface Me {
  owner: Principal; host: string; fixture: boolean; wikiBase: string; version: string;
  /** The entry script of the web build the server serves now; a page that loaded another one is stale (lib/api/stale.ts). */
  web: string | null;
}

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
  /** A principal's Later list changed (server/later.ts): `by` is owner or an agent id, `open` its In progress count. */
  | { type: "later"; by: string; open: number }
  /** Someone else wrote a new post in a room the owner sees (server/notices.ts); one tab raises a system notification if his setting asks. */
  | { type: "notice"; notice: Notice }
  /** The owner's reminder on a saved post fell due (server/later-due.ts); every tab shows it and one of them notifies. */
  | { type: "later_due"; row: LaterRow }
  /** The skills scanner started or ended (server/skills.ts); an end comes after its inventory is parsed, so a page reads it at once. */
  | { type: "skills"; scan: SkillScan }
  /** A skills review item or the set's Mac queue changed (server/skills-review.ts); `id` is null for a queue change. */
  | ReviewEvent
  /** Only to pages that watch `for:<agent id>`: the agent's For list changed, with its new pending count. */
  | { type: "for_me"; agent: AgentId; pending: number }
  | { type: "error"; message: string };

/** Page to server. `after` is the newest item id the page holds, so a reconnect sends only what it missed. */
export type LiveCommand =
  /** `conversation` may be `for:<agent id>`, which watches that agent's For list and gets its `for_me` events. */
  | { type: "watch"; conversation: ConversationId; after?: string }
  | { type: "unwatch"; conversation: ConversationId };
