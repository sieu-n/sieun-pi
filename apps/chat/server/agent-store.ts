/**
 * The files that make agents and DM rooms the chat server's own (apps/chat/docs/agent-model.md, phase 2): `agents.json` with each agent and
 * the thread ids that belong to it, `rooms.json` with each room and the feed cursor per agent, and one append-only post log per room under
 * `rooms/`. The server (`agents.ts`, `rooms.ts`) and the migration (`migrate.ts`) both read and write them through this file only.
 */
import { join } from "node:path";
import type { AgentId, ForwardedPost, ImageRef, Ms } from "../web/src/lib/api/types.ts";
import { writeJson } from "./store.ts";
import { ChatRecords, type Doc } from "./chat-records.ts";
import { AGENTS, ROOMS } from "./record-kinds.ts";
import { JsonPostLog, PostLog, POSTS, type Posts } from "./post-log.ts";

export type RoomId = string;

export interface AgentRecord {
  /** `ag_<slug>`. */
  id: AgentId;
  slug: string;
  name: string;
  /** `dm_<slug>`. */
  room: RoomId;
  /** The pi-host thread id of its main work thread, whose root conversation 1 is the agent. */
  workThread: string;
  /** The box whose pi-host runs the agent's threads, as the hosts registry names it. */
  host: string;
  /** Where the agent folders live on its box, for an agent on another box than the chat's (`BoxInfo.agentsDir`); absent means this box's. */
  agentsDir?: string;
  /** The work thread's cwd when the agent was made. */
  home: string;
  createdAt: Ms;
  archived: boolean;
  /** Set when the migration copied the old thread's history into the room. */
  migrated?: { at: Ms; posts: number; since: Ms };
  /**
   * The comm thread per room (phase 4): the thread that talks in that room and hands work to the work thread. A comm thread is never an
   * alias, a job or an agent of its own, and no list shows it.
   */
  comm?: Record<RoomId, string>;
  /** A walk's throwaway agent (`POST /api/agents {test: true}`): no owner list, live event or badge shows it, and its DM room is a test room too. */
  test?: true;
}

export interface AgentsFile {
  v: 1;
  agents: AgentRecord[];
  /** Every thread id that belongs to an agent: its work thread and each root job thread whose parent is the agent's thread. */
  aliases: Record<string, AgentId>;
}

export interface RoomDelivery {
  target: AgentId;
  /** `stopped`: a group room's post `MAX_HOPS` agent hops from the owner's last post, which is never submitted (hard: money). */
  state: "sending" | "delivered" | "failed" | "stopped";
  attempts: number;
  at: Ms;
  /** `d:<postId>:<agentId>` in a DM and `d:<room>:<postId>:<agentId>` in a group room: the durable_submit requestId, which pi-host keeps once. */
  requestId: string;
  submission?: number;
  error?: string;
  /** The delivery went as a test send's agent message, so the agent never read the post as the owner's. */
  testSend?: true;
  /** The thread the delivery went to: the agent's comm thread for the room. Absent on a delivery from before the split, which went to the work thread. */
  thread?: string;
  /** The box that was offline when the delivery last tried; it waits, with no retry timer, until that box's link comes back. */
  away?: string;
  /** The delivery waited for an offline box, so its input opens with its age. */
  waited?: true;
  /**
   * The waiting posts that go to the agent as one input, oldest first, saved on each member before the submit: `requestId` is
   * `b:<first post id>:<agent id>`, so a retry sends the same members under the same key, which pi-host keeps once.
   */
  bundle?: { requestId: string; members: string[] };
}

export interface RoomPost {
  /** `p<seq>`. */
  id: string;
  seq: number;
  room: RoomId;
  author: "owner" | AgentId;
  text: string;
  images: ImageRef[];
  at: Ms;
  /**
   * The post's one dedup key: the client's requestId for an owner post, `m:<thread>:<toolCallId>` for a speaking call, `i:<thread>:<entry>`
   * for an owner input typed outside the room, and `h:<thread>:...` for migrated history.
   */
  requestId: string;
  why?: string;
  /** The entry that holds an agent post's call, in the thread the feed read (the comm thread once there is one), so "Show work" opens its turn. */
  source?: { thread: string; conversation: number; entry: number };
  /** Jobs the post's turn started, as ConversationIds `<thread>:<n>`. */
  jobs?: string[];
  /** A DM post's one delivery, to the room's agent. */
  delivery?: RoomDelivery;
  /**
   * When the owner post's input entered each agent thread it reached, the time Prime's `[message id: ...]` note shows in base 36, so a
   * reply_to with that id names this post exactly (`agentPost`). A queued input enters after newer posts, which a time match then named.
   */
  inputs?: { thread: string; at: Ms }[];
  /** A group room post's deliveries, one per member it wakes. */
  deliveries?: RoomDelivery[];
  /** Group rooms: the members the post names (agent ids, or "owner"). */
  mentions?: (AgentId | "owner")[];
  /** Group rooms: agent hops since the owner's last post; the owner's posts carry 0. */
  hops?: number;
  /** Channels: the root post of the Buzz-style thread this reply is in. */
  threadRoot?: string;
  /** A thread reply that also shows in the channel, as Slack's "Also send to #channel" box sends it. */
  alsoInChannel?: true;
  /** An agent post: the owner post it answers, its turn's or the one its call's reply_to names, so its delivery reads as answered and the page draws it apart. */
  answers?: string;
  imported?: boolean;
  /** Set on an owner post that a job typed into the room to test it: the post reads as that job's, never as the owner's. */
  testSend?: TestSend;
  /** The emoji the owner and agents put under the post, oldest first (reactions.ts). */
  reactions?: StoredReaction[];
  /** When the owner last edited his post (post-edits.ts). */
  editedAt?: Ms;
  /** An agent post's last edit: the thread whose edit_message made it, a comm, work or job thread, so a trace needs no request log. */
  editedFrom?: string;
  /** When the owner deleted his post; its text and images are gone (post-edits.ts). */
  deletedAt?: Ms;
  /** A thread's root post: whether the owner marked its thread done, and when he last marked or reopened it (thread-done.ts). */
  done?: StoredDone;
  /** Whether the owner pinned the post to its room, and when he last pinned or un-pinned it (pins.ts). */
  pinned?: StoredPin;
  /** The post this one forwards, as it read then (forward.ts). */
  forward?: ForwardedPost;
}

/** The pin flag on a post; un-pinning keeps the row with `pinned: false`, as `done` does. */
export interface StoredPin { pinned: boolean; by: "owner"; at: Ms }

/** The done flag on a thread's root post; reopening keeps the row with `done: false`, as un-pinning does. */
export interface StoredDone { done: boolean; at: Ms }

/** One emoji one principal put on a post. */
export interface StoredReaction { emoji: string; by: "owner" | AgentId; at: Ms }

/**
 * A job's test send. `by` names the job (a ConversationId `<thread>:<n>`, an agent id or a name). `entry` is the work-thread input the delivery
 * wrote, once known; search and the work thread's timeline read that entry as the job's. `notice` is when the agent got the agent message
 * that says the post was a test send.
 */
export interface TestSend { by: string; reason: string; at: Ms; entry?: number; notice?: Ms }

export type PostPatch = Partial<Pick<RoomPost, "delivery" | "deliveries" | "inputs" | "jobs" | "text" | "testSend" | "reactions" | "images" | "editedAt" | "editedFrom" | "deletedAt" | "done" | "pinned">>;

/**
 * Who in a room a post wakes (phase 5): `all` hears every post, as if each one tagged it, and `none` (muted) hears nothing. A member of a
 * channel or a Solo room is `all` unless the owner mutes it. The owner is in every room and is never a member row.
 */
export type WakeOn = "all" | "none";
export interface RoomMember { agent: AgentId; wakeOn: WakeOn; addedAt: Ms }
/** One add or remove of a member, which the room's timeline shows as a system line, as Slack's "X added Y" (group-rooms.ts `memberLine`). */
export interface MemberChange { at: Ms; agent: AgentId; by: "owner" | AgentId; change: "added" | "removed" }

/** `test`: a walk's throwaway room (`POST /api/rooms {test: true}`), which no owner list, live event or badge shows. */
interface RoomBase { id: RoomId; createdAt: Ms; archived: boolean; test?: true }
/**
 * A room the chat server owns. A DM (`dm_<slug>`) is the owner and one agent. A channel (`ch_<8 hex>`, the ids channels had before phase 5)
 * is a named room whose members hear every post. A Solo room (`so_<8 hex>`) is a group chat of invited agents around one agenda; every
 * member hears every post, and a closed Solo room takes no posts and delivers nothing.
 */
export type RoomRow =
  | (RoomBase & { kind: "dm"; agent: AgentId })
  | (RoomBase & { kind: "channel"; name: string; purpose: string; homeChat?: string; members: RoomMember[]; memberLog?: MemberChange[] })
  | (RoomBase & { kind: "solo"; name: string; agenda: string; members: RoomMember[]; memberLog?: MemberChange[]; closedAt?: Ms });
export type GroupRoom = Exclude<RoomRow, { kind: "dm" }>;
export const isGroupRoom = (row: RoomRow): row is GroupRoom => row.kind !== "dm";

/** Where the feed stands in the thread it reads, conversation 1. */
export interface FeedCursor {
  /** The thread the feed reads: the agent's comm thread for its DM. Absent means the work thread. */
  thread?: string;
  /** The last entry id read. */
  entry: number;
  /** Speaking calls seen whose result has not landed yet. */
  open: Record<string, { text: string; entry: number; why?: string; replyTo?: string; named?: string[] }>;
  /**
   * The input that started the current turn, whether a channel post started it, the turn's newest post, the jobs the turn started before
   * it had a post, which go on its next one, and the post a refused post of the turn was for, which its resend answers.
   */
  turn?: { input: number; channel: boolean; lastPost?: string; jobs?: string[]; post?: string; hops?: number; named?: string[] };
}

/**
 * `feed` holds each agent's DM cursor by agent id. `commFeed` holds the cursor of each group room's comm thread by that thread's id; in it
 * `turn.post` and `turn.hops` are the room post whose delivery started the turn and its hops, so a post the turn makes carries hops + 1.
 */
export interface RoomsFile { v: 1; rooms: RoomRow[]; feed: Record<AgentId, FeedCursor>; commFeed?: Record<string, FeedCursor> }

export const slugOf = (name: string): string =>
  name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent";

/** A name pi-host gives a thread nobody named: empty, "New thread" or "Untitled". Such a root chat is no agent. */
export const isUntitled = (name: string | undefined): boolean => /^(new thread|untitled)?$/i.test((name ?? "").trim());

/** A slug no agent in `taken` uses: the name's, else with -2, -3 after it. */
export function freeSlug(name: string, taken: ReadonlySet<string>): string {
  const base = slugOf(name);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

interface StoreLookup {
  version: number;
  agents: AgentRecord[];
  agentCount: number;
  rooms: RoomRow[];
  roomCount: number;
  byId: Map<AgentId, AgentRecord>;
  byRoom: Map<RoomId, AgentRecord>;
  byWorkThread: Map<string, AgentRecord>;
  byComm: Map<string, { record: AgentRecord; room: RoomId }>;
  testRooms: Set<string>;
  aliases: Record<string, AgentId>;
  /** The channels and Solo rooms, in the rooms' order, and each by id (first match). */
  groups: GroupRoom[];
  groupById: Map<string, GroupRoom>;
  /** Each agent's aliased threads, in the aliases' order. */
  aliasedTo: Map<AgentId, string[]>;
  /** `hiddenThreads` and `heldThreads`, each built on its first read. */
  hidden?: string[];
  held?: string[];
}

export class AgentStore {
  /** agents.json and rooms.json, or their rows in chat.sqlite once the server keeps those kinds there (chat-records.ts). */
  private readonly agentsDoc: Doc<AgentsFile>;
  private readonly roomsDoc: Doc<RoomsFile>;
  /** Counts the saves of agents.json and rooms.json; what reads the records keys its caches on it. */
  version = 0;
  private index?: StoreLookup;
  /** Each room's posts: rows of chat.sqlite once the server keeps the `posts` kind there, else the room logs (post-log.ts). */
  private readonly posts: Posts;
  /** Hears each post added or changed, after it is written; search indexes it. */
  onPost: (post: RoomPost) => void = () => {};
  /** Hears each new post once, after `onPost`; the owner's notices read it (notices.ts). */
  onAppend: (post: RoomPost) => void = () => {};

  constructor(readonly dir: string, readonly records: ChatRecords = ChatRecords.standalone(dir)) {
    this.agentsDoc = records.doc(AGENTS);
    this.roomsDoc = records.doc(ROOMS);
    // Before 11-03 a channel member woke only on a mention; the owner asked that each one hear every post, so the old `mention` reads as `all`.
    for (const row of this.rooms.rooms) if (isGroupRoom(row)) for (const m of row.members) if ((m.wakeOn as string) === "mention") m.wakeOn = "all";
    this.posts = records.inDb(POSTS.kind) ? new PostLog(records.chat, dir, records.move(POSTS), { sync: records.syncSaves }) : new JsonPostLog(dir);
  }

  get agents(): AgentsFile {
    return this.agentsDoc.value;
  }
  set agents(value: AgentsFile) {
    this.agentsDoc.value = value;
  }
  get rooms(): RoomsFile {
    return this.roomsDoc.value;
  }
  set rooms(value: RoomsFile) {
    this.roomsDoc.value = value;
  }

  /** Off the main thread, as rooms are: a sync write of agents.json took up to 11 ms of each POST /api/agents on 11-23. */
  saveAgents(): void {
    this.version += 1;
    this.agentsDoc.save();
  }
  saveRooms(): void {
    this.version += 1;
    this.roomsDoc.save();
  }
  /** `test-sends.json`: the work-thread inputs that were a job's test send, which pi-history's search reads as the job's too. */
  saveTestSends(entries: { thread: string; entry: number; by: string; reason: string }[]): void {
    writeJson(join(this.dir, "test-sends.json"), { v: 1, entries });
  }

  /** The agent a thread id or agent id belongs to: its work thread, a root job thread aliased to it, or one of its comm threads. */
  agentOf(id: string): AgentRecord | undefined {
    const agentId = id.startsWith("ag_") ? id : this.agents.aliases[id];
    return (agentId ? this.lookup().byId.get(agentId) : undefined) ?? (agentId ? undefined : this.commOwner(id)?.record);
  }
  /**
   * The channels and Solo rooms, and one by id. A room's kind never changes and a new room changes the rooms' length, so the lookup's list
   * holds every group room; on 11-21 a filter of all 500 rooms for each agent's summary took 10 to 12 ms of each 2 s thread list read (p156).
   */
  groupRooms(): readonly GroupRoom[] {
    return this.lookup().groups;
  }
  groupRoom(id: string): GroupRoom | undefined {
    return this.lookup().groupById.get(id);
  }
  /** The threads aliased to the agent `id`, in the aliases' order; every alias change saves agents.json, which builds the lookup again. */
  aliasedTo(id: AgentId): readonly string[] {
    return this.lookup().aliasedTo.get(id) ?? [];
  }
  /** The agent and room whose comm thread `thread` is. */
  commOwner(thread: string): { record: AgentRecord; room: RoomId } | undefined {
    return this.lookup().byComm.get(thread);
  }
  agentByRoom(room: RoomId): AgentRecord | undefined {
    return this.lookup().byRoom.get(room);
  }
  /** The record whose main work thread is `thread`. */
  agentByWorkThread(thread: string): AgentRecord | undefined {
    return this.lookup().byWorkThread.get(thread);
  }

  /**
   * Maps over the records and rooms, built again after each save and whenever the record or room list is another array or another length.
   * Each map keeps the first match, as the scans it replaced did. On 11-03 the scans took 3.5 s of the server's 15 s busy time in 100 s, as
   * each 2 s thread list read and each board, duty and For you read asked them once per thread.
   */
  private lookup(): StoreLookup {
    const { agents } = this.agents;
    const { rooms } = this.rooms;
    const cached = this.index;
    const { aliases } = this.agents;
    if (cached && cached.version === this.version && cached.agents === agents && cached.agentCount === agents.length && cached.rooms === rooms && cached.roomCount === rooms.length && cached.aliases === aliases) {
      return cached;
    }
    const index: StoreLookup = {
      version: this.version, agents, agentCount: agents.length, rooms, roomCount: rooms.length, aliases,
      byId: new Map(), byRoom: new Map(), byWorkThread: new Map(), byComm: new Map(), testRooms: new Set(), aliasedTo: new Map(),
      groups: [], groupById: new Map(),
    };
    for (const [thread, id] of Object.entries(aliases)) {
      const threads = index.aliasedTo.get(id);
      if (threads) threads.push(thread);
      else index.aliasedTo.set(id, [thread]);
    }
    for (const record of agents) {
      if (!index.byId.has(record.id)) index.byId.set(record.id, record);
      if (!index.byRoom.has(record.room)) index.byRoom.set(record.room, record);
      if (!index.byWorkThread.has(record.workThread)) index.byWorkThread.set(record.workThread, record);
      for (const [room, comm] of Object.entries(record.comm ?? {})) if (!index.byComm.has(comm)) index.byComm.set(comm, { record, room });
    }
    for (const row of rooms) {
      if (row.test) index.testRooms.add(row.id);
      if (!isGroupRoom(row)) continue;
      index.groups.push(row);
      if (!index.groupById.has(row.id)) index.groupById.set(row.id, row);
    }
    this.index = index;
    return index;
  }

  /**
   * Whether an id belongs to a walk's test agent or test room: an agent id, any thread id of a test agent (work, job or comm thread, or a
   * conversation `<thread>:<n>` in one), any agent's comm thread in a test room, a test agent's DM room, or a test channel or Solo room.
   */
  isTest(id: string): boolean {
    const { testRooms } = this.lookup();
    if (testRooms.has(id)) return true;
    const thread = /^(.*):\d+$/.exec(id)?.[1] ?? id;
    const comm = this.commOwner(thread);
    if (comm && testRooms.has(comm.room)) return true;
    return !!(this.agentOf(thread)?.test || this.agentByRoom(id)?.test);
  }

  /**
   * The threads search leaves out unless it is scoped to one: every comm thread and every thread aliased to a walk's test agent. Built once
   * per lookup: on 11-23 each search built it again, 1,012 threads and an `isTest` per alias, 1.3 ms of its handler.
   */
  hiddenThreads(): readonly string[] {
    const index = this.lookup();
    return index.hidden ??= [
      ...index.agents.flatMap(record => Object.values(record.comm ?? {})),
      ...Object.keys(index.aliases).filter(thread => this.isTest(thread)),
    ];
  }

  /** Every work thread and aliased thread of an agent that is no walk's test agent, work threads first; built once per lookup. */
  heldThreads(): readonly string[] {
    const index = this.lookup();
    return index.held ??= [...new Set([
      ...index.agents.filter(record => !record.test).map(record => record.workThread),
      ...Object.entries(index.aliases).filter(([, id]) => !this.agentOf(id)?.test).map(([thread]) => thread),
    ])];
  }

  postsOf(room: RoomId): RoomPost[] {
    return this.posts.postsOf(room);
  }

  /** The post with this dedup key, if the room has one. */
  byRequestId(room: RoomId, requestId: string): RoomPost | undefined {
    return this.postsOf(room).find(p => p.requestId === requestId);
  }

  /**
   * Appends a post with the next seq, or answers the post that already has its requestId. Posts keep their seq order; a migrated post
   * keeps its original `at`, so a room is ordered by seq, not by time.
   */
  append(input: Omit<RoomPost, "id" | "seq">): { post: RoomPost; created: boolean } {
    const existing = this.byRequestId(input.room, input.requestId);
    if (existing) return { post: existing, created: false };
    const post = this.posts.add(input);
    this.onPost(post);
    this.onAppend(post);
    return { post, created: true };
  }

  /** Records when `post`'s input entered `thread` (`RoomPost.inputs`), once. */
  noteInput(post: RoomPost, thread: string, at: Ms): void {
    if (post.inputs?.some(i => i.thread === thread)) return;
    this.set(post, { inputs: [...(post.inputs ?? []), { thread, at }] });
  }

  set(post: RoomPost, patch: PostPatch): void {
    Object.assign(post, patch);
    this.posts.save(post, patch);
    this.onPost(post);
  }

  /** Settles once every post and change of the room so far is stored, as a send awaits before it answers. */
  written(room: RoomId): Promise<void> {
    return this.posts.written(room);
  }
}
