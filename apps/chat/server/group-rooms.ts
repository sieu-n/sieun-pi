/**
 * Channels and Solo rooms (apps/chat/docs/agent-model.md, phase 5). Both are group rooms the chat server owns: rows in `rooms.json` and
 * one post log per room under `rooms/`, written only through `AgentStore`. The owner is in every room; the member rows are registered
 * agents, each with a `wakeOn`.
 *
 * 1. A post wakes every member whose `wakeOn` is `all`, plus every member it mentions, minus its author; in a channel a thread reply wakes
 *    only the members it mentions. Each woken member gets one delivery to its comm thread for the room (`Agents.ensureComm`), never to its
 *    work thread, keyed `d:<room>:<post>:<agent>`, with retries; a restart resubmits every delivery still `sending` with the same key.
 *    Deliveries that waited for an offline box go as one bundled input per member when the box is back, keyed `b:<room>:<first post>:<agent>`.
 * 2. An owner post goes in as the owner's turn; an agent post goes in as an `agent.message` whose data names the author, the room, the post
 *    and its hops. A post `MAX_HOPS` agent hops from the owner's last post gets `stopped` deliveries and is never submitted.
 * 3. Each comm thread has a feed cursor in `rooms.commFeed`; the shared feed reader (rooms.ts `readFeedThread`) turns its speaking calls
 *    into the agent's posts here, with hops one more than the post that started its turn, and those posts are delivered on in turn.
 * 4. A closed Solo room, or an archived room, refuses the owner's posts, stores agent posts with no deliveries, and stops deliveries still
 *    on their way.
 * 5. As in Slack, the owner's mention of a registered agent that is not a member adds it to the room, as `addMembers` does, and delivers
 *    the post. A channel root post's delivery carries the root posts its target missed since its last one, with their images.
 */
import { randomUUID } from "node:crypto";
import type {
  AgentId, ConversationSummary, Delivery, ImageRef, ImageUpload, Item, Member, Room, RoomInput, RoomPatch, RunStatus, SendRequest, SendResult, TimelinePage,
} from "../web/src/lib/api/types.ts";
import { isGroupRoom, type AgentRecord, type AgentStore, type FeedCursor, type GroupRoom, type RoomDelivery, type RoomId, type RoomMember, type RoomPost, type WakeOn } from "./agent-store.ts";
import type { Agents } from "./agents.ts";
import { isHostAway, type EntryRecord, type Host, type Submitted } from "./host/types.ts";
import { refusedForGood, retryWait } from "./outbox.ts";
import { agedPost, agentPostParts, queuedNote, readFeedThread, type FeedSide, type Spoken } from "./rooms.ts";
import type { Store } from "./store.ts";
import { OWNER, type Threads } from "./threads.ts";

/** Hard: money, an agent loop runs paid model turns nobody reads (channels.md 4.3). */
export const MAX_HOPS = 6;
const CONTEXT_POSTS = 5;
const CONTEXT_CLIP = 2048;
const AGENDA_CLIP = 300;
const PAGE = 50;

/**
 * A LIKE pattern for the copy of a channel post that the router before phase 5 sent into a work thread; search finds the post itself in its
 * room. It matches both tails such copies had.
 */
export const CHANNEL_COPY_LIKE = "[#% · post % from % · %posted back into this thread]%";

export interface GroupEvents {
  items(room: RoomId, items: Item[]): void;
  /** A room's row, members or name changed. */
  room(room: Room): void;
  conversations(changed: ConversationSummary[]): void;
  status(room: RoomId, status: RunStatus): void;
  /** The room's posts reach `thread` from now on; resolves once the room's watchers watch it. */
  thread(room: RoomId, thread: string): Promise<void>;
  /** pi-host took a delivery into `thread`; its answer carries the run's place in pi-pool's turn queue. */
  submitted(thread: string, result: Submitted): void;
}

export interface GroupDeps {
  store: AgentStore;
  state: Store;
  host: Host;
  threads: Threads;
  agents: Agents;
  events: GroupEvents;
  saveUpload(image: ImageUpload): ImageRef;
  readUpload(ref: ImageRef): { data: string; mimeType: string } | undefined;
  log(line: string): void;
  /** Whether the server has a live link to a box; absent on a server with one box. */
  linkOf?(box: string): "up" | "away";
}

type Draft = Omit<RoomPost, "id" | "seq" | "room" | "deliveries"> & { hops: number };

const channelName = (name: string): string => name.trim().replace(/^#/, "").toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "");
const WAKE_ON: readonly WakeOn[] = ["all", "mention", "none"];

/** A Solo room's default name: the agenda's first line, cut at a word near 48 characters. */
function nameFromAgenda(agenda: string): string {
  const line = agenda.trim().split("\n")[0]!.trim();
  if (line.length <= 48) return line;
  const cut = line.slice(0, 48);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : 48)}…`;
}

/** `#name` for a channel, `Solo "name"` for a Solo room. */
export const roomLabel = (row: GroupRoom): string => (row.kind === "channel" ? `#${row.name}` : `Solo "${row.name}"`);

/** Why the room takes no owner post, or undefined when it does. */
function refusal(row: GroupRoom): string | undefined {
  if (row.archived) return `An archived room takes no posts; unarchive ${roomLabel(row)} to post in it.`;
  if (row.kind === "solo" && row.closedAt !== undefined) return `A closed Solo room takes no posts; reopen ${roomLabel(row)} to post in it.`;
  return undefined;
}

export class GroupRooms {
  /** The wait before the next try of a delivery; a test shortens it. */
  backoff: (attempts: number) => number = retryWait;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly inflight = new Set<string>();
  private stopped = true;
  /** The feed read going per comm thread, and whether another must follow it. */
  private readonly reading = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  /** Each comm thread's `updatedAt` at its last feed read. */
  private readonly seen = new Map<string, number>();
  private readonly statuses = new Map<RoomId, RunStatus>();

  constructor(private readonly deps: GroupDeps) {}

  private get store(): AgentStore {
    return this.deps.store;
  }

  start(): void {
    this.stopped = false;
    for (const row of this.rows()) {
      for (const post of this.store.postsOf(row.id)) for (const d of post.deliveries ?? []) if (d.state === "sending") this.schedule(post, d.target, 0);
    }
    this.poll();
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  // Rooms

  rows(): GroupRoom[] {
    return this.store.rooms.rooms.filter(isGroupRoom);
  }

  /** A room by id, or a channel by its name with or without `#`. */
  row(id: string): GroupRoom | undefined {
    const rows = this.rows();
    return rows.find(r => r.id === id) ?? rows.find(r => r.kind === "channel" && !r.archived && r.name === channelName(id));
  }

  require(id: string): GroupRoom {
    const row = this.row(id);
    if (!row) throw new Error(`No room ${id}.`);
    return row;
  }

  /** The open rooms; a walk's test rooms only with `test`. */
  list(opts: { test?: boolean } = {}): Room[] {
    return this.rows().filter(r => !r.archived && (opts.test || !r.test)).map(r => this.view(r));
  }

  view(row: GroupRoom): Room {
    return {
      id: row.id, kind: row.kind, name: row.name, agenda: row.kind === "solo" ? row.agenda : row.purpose, ...(row.kind === "channel" && row.homeChat ? { homeChat: row.homeChat } : {}),
      createdAt: row.createdAt, archived: row.archived, ...(row.kind === "solo" && row.closedAt !== undefined ? { closedAt: row.closedAt } : {}),
      members: this.members(row), lastSeq: this.store.postsOf(row.id).at(-1)?.seq ?? 0,
    };
  }

  /** The owner first, then each member row; a member no agent holds any more shows as `threads.principal` names it. */
  members(row: GroupRoom): Member[] {
    return [
      { principal: OWNER, role: "owner", wakeOn: "all" },
      ...row.members.map((m): Member => {
        const agent = this.deps.threads.agent(m.agent);
        return { principal: this.deps.threads.principal(m.agent), role: "member", wakeOn: m.wakeOn, ...(agent ? { status: agent.status } : {}) };
      }),
    ];
  }

  /** The rooms an agent is a member of, not archived. */
  memberRooms(agent: AgentId): GroupRoom[] {
    return this.rows().filter(r => !r.archived && r.members.some(m => m.agent === agent));
  }

  /** The comm threads the room's members have for it. */
  commThreads(row: GroupRoom): { agent: AgentRecord; thread: string }[] {
    return row.members.flatMap(m => {
      const record = this.deps.agents.record(m.agent);
      const thread = record?.comm?.[row.id];
      return record && thread ? [{ agent: record, thread }] : [];
    });
  }

  /** Working while a member's comm thread for the room answers. */
  status(row: GroupRoom): RunStatus {
    return this.commThreads(row).some(c => this.deps.threads.statusOfConversation(c.thread, 1) === "working") ? "working" : "idle";
  }

  summary(row: GroupRoom): ConversationSummary {
    const posts = this.store.postsOf(row.id);
    const mark = this.deps.state.state.reads[row.id]?.seq ?? 0;
    const last = posts.at(-1);
    const unseen = posts.filter(p => p.seq > mark && p.author !== "owner");
    const working = this.commThreads(row).filter(c => this.deps.threads.statusOfConversation(c.thread, 1) === "working")
      .map(c => ({ id: c.agent.id, name: this.deps.threads.principal(c.agent.id).name }));
    // In a Solo room every post is about the owner's agenda; in a channel only a post that names him counts as unread.
    const unread = row.kind === "solo" ? unseen.length : unseen.filter(p => p.mentions?.includes("owner")).length;
    return {
      id: row.id, kind: row.kind, name: row.name, status: working.length ? "working" : "idle", archived: row.archived,
      lastActivityAt: last?.at ?? row.createdAt,
      preview: last ? `${this.deps.threads.principal(last.author).name}: ${last.text}`.slice(0, 200) : (row.kind === "solo" ? row.agenda : row.purpose).slice(0, 200),
      unread, hasNew: unseen.length > 0, working,
      ...(row.kind === "solo" ? { agenda: row.agenda, ...(row.closedAt !== undefined ? { closedAt: row.closedAt } : {}) } : {}),
    };
  }

  summaries(): ConversationSummary[] {
    return this.rows().map(row => this.summary(row));
  }

  /**
   * A new channel or Solo room. A Solo room needs an agenda and an agent, its members wake on every post, and its agenda becomes the owner's
   * first post, delivered to each member. A channel needs a name no open channel has, and its members wake on a mention.
   */
  create(input: RoomInput): Room {
    if (input?.kind !== "channel" && input?.kind !== "solo") throw new Error("A room's kind is channel or solo.");
    const now = Date.now();
    const agents = [...new Set((input.members ?? []).map(id => this.memberId(id)))];
    let row: GroupRoom;
    if (input.kind === "channel") {
      const name = channelName(input.name ?? "");
      if (!name) throw new Error("A channel needs a name.");
      if (this.rows().some(r => r.kind === "channel" && r.name === name && !r.archived)) throw new Error(`A channel named #${name} already exists.`);
      row = {
        id: `ch_${randomUUID().slice(0, 8)}`, kind: "channel", name, purpose: input.agenda?.trim() ?? "", ...(input.homeChat ? { homeChat: input.homeChat } : {}),
        createdAt: now, archived: false, members: agents.map(agent => ({ agent, wakeOn: "mention", addedAt: now })),
      };
    } else {
      const agenda = input.agenda?.trim() ?? "";
      if (!agenda) throw new Error("A Solo room needs an agenda.");
      if (!agents.length) throw new Error("A Solo room needs at least one agent.");
      row = {
        id: `so_${randomUUID().slice(0, 8)}`, kind: "solo", name: input.name?.trim() || nameFromAgenda(agenda), agenda, createdAt: now, archived: false,
        members: agents.map(agent => ({ agent, wakeOn: "all", addedAt: now })),
      };
    }
    if (input.test === true) row.test = true;
    this.store.rooms.rooms.push(row);
    this.store.saveRooms();
    this.changed(row);
    if (row.kind === "solo") this.ownerPost(row, { text: row.agenda, requestId: `agenda:${row.id}` });
    return this.view(row);
  }

  update(id: string, patch: RoomPatch): Room {
    const row = this.require(id);
    if (patch.name !== undefined) {
      const name = row.kind === "channel" ? channelName(patch.name) : patch.name.trim();
      if (!name) throw new Error(row.kind === "channel" ? "A channel needs a name with a letter or digit in it." : "A room's name is not blank.");
      if (row.kind === "channel" && this.clash(name, row)) throw new Error(`A channel named #${name} already exists.`);
      row.name = name;
    }
    if (patch.agenda !== undefined) {
      if (row.kind === "solo") {
        if (!patch.agenda.trim()) throw new Error("A Solo room's agenda is not blank.");
        row.agenda = patch.agenda.trim();
      } else row.purpose = patch.agenda;
    }
    if (patch.closed !== undefined) {
      if (row.kind !== "solo") throw new Error("A channel is not closed; archive it instead.");
      if (patch.closed) row.closedAt ??= Date.now();
      else delete row.closedAt;
    }
    if (patch.archived === false && row.archived && row.kind === "channel" && this.clash(row.name, row)) {
      throw new Error(`A channel named #${row.name} is open; rename one of them before you unarchive this one.`);
    }
    if (patch.archived !== undefined) row.archived = patch.archived;
    if (patch.homeChat !== undefined) {
      if (row.kind !== "channel") throw new Error("A Solo room shows its members' boards; only a channel has a home chat.");
      if (patch.homeChat === null) delete row.homeChat;
      else row.homeChat = patch.homeChat;
    }
    this.store.saveRooms();
    this.changed(row);
    return this.view(row);
  }

  /** Whether an open channel other than `row` has `name`. */
  private clash(name: string, row: GroupRoom): boolean {
    return this.rows().some(r => r !== row && r.kind === "channel" && !r.archived && r.name === name);
  }

  /** Adds registered agents; a Solo room's wake on every post, a channel's on a mention unless `wakeOn` says otherwise. */
  addMembers(id: string, agents: string[], wakeOn?: WakeOn): Room {
    const row = this.require(id);
    if (!Array.isArray(agents) || !agents.length) throw new Error("A member add needs agents, a list of agent ids.");
    if (wakeOn !== undefined && !WAKE_ON.includes(wakeOn)) throw new Error(`A member's wakeOn is one of ${WAKE_ON.join(", ")}.`);
    const now = Date.now();
    for (const agent of agents.map(given => this.memberId(given))) {
      if (!row.members.some(m => m.agent === agent)) row.members.push({ agent, wakeOn: wakeOn ?? (row.kind === "solo" ? "all" : "mention"), addedAt: now } satisfies RoomMember);
    }
    this.store.saveRooms();
    this.changed(row);
    return this.view(row);
  }

  removeMember(id: string, agent: string): Room {
    const row = this.require(id);
    const key = this.deps.threads.registered(agent)?.id ?? agent;
    row.members = row.members.filter(m => m.agent !== key);
    this.store.saveRooms();
    this.changed(row);
    return this.view(row);
  }

  /** The agent id of a registered agent; a job, a work thread no agent holds or a comm thread is refused. */
  private memberId(id: string): AgentId {
    const record = this.deps.agents.ofComm(id) ? undefined : this.deps.threads.registered(id);
    if (!record) throw new Error(`No agent ${id}: only a registered agent joins a room, not a job or a thread.`);
    return record.id;
  }

  private changed(row: GroupRoom): void {
    this.deps.events.room(this.view(row));
    this.deps.events.conversations([this.summary(row)]);
  }

  // Owner posts

  /** Writes the owner's post and starts its deliveries; the same requestId again answers the first post and retries its failed deliveries. */
  post(id: string, request: SendRequest): SendResult {
    const row = this.require(id);
    const existing = this.store.byRequestId(row.id, request.requestId);
    if (existing) return existing.deliveries?.some(d => d.state === "failed") ? this.retry(row.id, existing.requestId) : this.result(row, existing);
    const refused = refusal(row);
    if (refused) throw new Error(refused);
    if (request.threadRoot && (row.kind !== "channel" || !this.store.postsOf(row.id).some(p => p.id === request.threadRoot && !p.threadRoot))) {
      throw new Error(`No thread ${request.threadRoot} in ${roomLabel(row)}.`);
    }
    const mentions = [...new Set((request.mentions ?? []).flatMap(m => {
      if (m === "owner") return [];
      const record = this.deps.threads.registered(m);
      return record ? [record.id] : [];
    }))];
    const joining = mentions.filter(agent => !row.members.some(m => m.agent === agent));
    if (joining.length) this.addMembers(row.id, joining);
    const images = (request.images ?? []).map(image => this.deps.saveUpload(image));
    return this.ownerPost(row, { text: request.text ?? "", requestId: request.requestId, images, mentions, ...(request.threadRoot ? { threadRoot: request.threadRoot } : {}) });
  }

  private ownerPost(row: GroupRoom, input: { text: string; requestId: string; images?: ImageRef[]; mentions?: AgentId[]; threadRoot?: string }): SendResult {
    const post = this.write(row, {
      author: "owner", text: input.text, images: input.images ?? [], at: Date.now(), requestId: input.requestId, hops: 0, mentions: input.mentions ?? [],
      ...(input.threadRoot ? { threadRoot: input.threadRoot } : {}),
    });
    this.deps.state.state.reads[row.id] = { at: post.at, seq: post.seq };
    this.deps.state.saveState();
    this.emit(row, [post]);
    return this.result(row, post);
  }

  /** Tries the post's failed deliveries again now, unless the room takes no posts. */
  retry(id: string, requestId: string): SendResult {
    const row = this.require(id);
    const post = this.store.byRequestId(row.id, requestId);
    if (!post) throw new Error(`No post ${requestId} in ${roomLabel(row)}.`);
    const refused = refusal(row);
    if (refused) throw new Error(refused);
    const failed = (post.deliveries ?? []).filter(d => d.state === "failed");
    if (failed.length) {
      this.store.set(post, { deliveries: post.deliveries!.map(d => {
        if (d.state !== "failed") return d;
        const { error: _error, ...rest } = d;
        return { ...rest, state: "sending", at: Date.now() };
      }) });
      for (const d of failed) this.schedule(post, d.target, 0);
      this.emit(row, [post]);
    }
    return this.result(row, post);
  }

  private result(row: GroupRoom, post: RoomPost): SendResult {
    const item = this.item(row, post);
    return { item, deliveries: item.kind === "message" ? item.deliveries : [] };
  }

  /**
   * Appends a post with its deliveries in the same log line, so a crash leaves no post without them, and schedules each delivery. The same
   * requestId again answers the post it wrote.
   */
  private write(row: GroupRoom, draft: Draft): RoomPost {
    const existing = this.store.byRequestId(row.id, draft.requestId);
    if (existing) return existing;
    const id = `p${(this.store.postsOf(row.id).at(-1)?.seq ?? 0) + 1}`;
    const deliveries = this.deliveriesFor(row, id, draft);
    const { post, created } = this.store.append({ ...draft, room: row.id, deliveries });
    if (created) for (const d of deliveries) if (d.state === "sending") this.schedule(post, d.target, 0);
    return post;
  }

  /**
   * One delivery per member the post wakes: `stopped` at `MAX_HOPS` agent hops, none at all in a room that takes no posts. A member no
   * agent holds (an old thread id a migrated channel kept) gets none.
   */
  private deliveriesFor(row: GroupRoom, id: string, draft: Draft): RoomDelivery[] {
    if (refusal(row)) return [];
    const now = Date.now();
    return this.wakes(row, draft).map(target => ({
      target, attempts: 0, at: now, requestId: `d:${row.id}:${id}:${target}`,
      ...(draft.hops >= MAX_HOPS ? { state: "stopped" as const, error: `Stopped after ${MAX_HOPS} agent-to-agent hops with no post from you.` } : { state: "sending" as const }),
    }));
  }

  /** Who a post wakes: every `all` member, and every member it mentions, minus its author; a channel thread reply wakes only its mentions. */
  private wakes(row: GroupRoom, draft: Draft): AgentId[] {
    const reply = row.kind === "channel" && draft.threadRoot !== undefined;
    return row.members.filter(m =>
      m.agent !== draft.author && m.wakeOn !== "none" && ((m.wakeOn === "all" && !reply) || draft.mentions?.includes(m.agent)) && this.deps.agents.record(m.agent) !== undefined,
    ).map(m => m.agent);
  }

  // Delivery

  private schedule(post: RoomPost, target: AgentId, delay: number): void {
    if (this.stopped) return;
    const key = `${post.room}/${post.id}/${target}`;
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => void this.deliver(post, target), delay));
  }

  private setDelivery(post: RoomPost, target: AgentId, next: RoomDelivery): void {
    this.store.set(post, { deliveries: (post.deliveries ?? []).map(d => (d.target === target ? next : d)) });
  }

  /** The posts a bundle to `target` names, oldest first; a member the log lacks drops out. */
  private bundleMembers(post: RoomPost, target: AgentId): RoomPost[] {
    const bundle = post.deliveries?.find(d => d.target === target)?.bundle;
    if (!bundle) return [post];
    const posts = this.store.postsOf(post.room);
    return bundle.members.flatMap(id => posts.find(p => p.id === id) ?? []);
  }

  private async deliver(post: RoomPost, target: AgentId): Promise<void> {
    const bundle = post.deliveries?.find(d => d.target === target)?.bundle;
    // A bundle goes as its first post's delivery; any other member's turn hands over to it.
    if (bundle && bundle.members[0] !== post.id) {
      const head = this.store.postsOf(post.room).find(p => p.id === bundle.members[0]);
      if (head && head !== post) return this.deliver(head, target);
    }
    const key = `${post.room}/${post.id}/${target}`;
    this.timers.delete(key);
    const delivery = post.deliveries?.find(d => d.target === target);
    const row = this.row(post.room);
    if (this.stopped || !delivery || delivery.state !== "sending" || this.inflight.has(key) || !row) return;
    const members = this.bundleMembers(post, target);
    const set = (patch: (d: RoomDelivery) => RoomDelivery) => {
      for (const member of members) {
        const d = member.deliveries?.find(x => x.target === target);
        if (d) this.setDelivery(member, target, patch(d));
      }
    };
    const record = this.deps.agents.record(target);
    const refused = refusal(row);
    if (!record || refused) {
      set(d => ({ ...d, state: record ? "stopped" : "failed", at: Date.now(), error: refused ?? `No agent ${target}.` }));
      this.emit(row, members);
      return;
    }
    this.inflight.add(key);
    const missed = this.missed(row, post, target);
    const images = [...missed, ...members].flatMap(p => p.images).map(ref => this.deps.readUpload(ref)).filter((image): image is { data: string; mimeType: string } => !!image);
    try {
      const thread = await this.commThread(row, record);
      const last = members.at(-1)!;
      // A bundle with any owner post goes as the owner's turn; one of agent posts only goes as an agent message that names its newest post.
      const from = members.some(p => p.author === "owner")
        ? { ownerTurn: true, whenBusy: "steer" as const }
        : {
          whenBusy: "followUp" as const,
          entry: { kind: "agent.message" as const, data: { from: last.author, via: row.id, post: last.id, hops: Math.max(...members.map(p => p.hops ?? 0)) } },
        };
      const now = Date.now();
      const text = bundle
        ? this.bundleText(row, members, missed, record.host, now)
        : delivery.waited ? agedPost(this.envelope(row, post, missed), post.at, record.host, now) : this.envelope(row, post, missed);
      const requestId = bundle?.requestId ?? delivery.requestId;
      const result = await this.deps.host.submit(thread, { text, ...(images.length ? { images } : {}), requestId, ...from });
      set(d => ({
        target, state: "delivered", attempts: d.attempts + 1, at: Date.now(), requestId: d.requestId, submission: result.submission, thread,
        ...(d.waited ? { waited: true as const } : {}), ...(d.bundle ? { bundle: d.bundle } : {}),
      }));
      this.deps.events.submitted(thread, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempts = delivery.attempts + 1;
      const away = isHostAway(error) ? error.box : this.deps.linkOf?.(record.host) === "away" ? record.host : undefined;
      if (away) {
        // It waits with no timer until the box's link comes back (`release`).
        this.deps.log(`rooms: ${row.id} ${post.id} to ${target} waits, ${away} is offline`);
        set(d => ({ ...d, at: Date.now(), away, error: queuedNote(away) }));
      } else if (refusedForGood(message)) {
        this.deps.log(`rooms: ${row.id} ${post.id} to ${target} refused: ${message}`);
        set(d => ({ ...d, state: "failed", attempts, at: Date.now(), error: message }));
      } else {
        const wait = this.backoff(attempts);
        this.deps.log(`rooms: ${row.id} ${post.id} to ${target} attempt ${attempts} failed, retry in ${wait} ms: ${message}`);
        set(d => {
          const { away: _away, error: _error, ...rest } = d;
          return { ...rest, attempts, at: Date.now(), ...(attempts >= 3 ? { error: message } : {}) };
        });
        this.schedule(post, target, wait);
      }
    } finally {
      this.inflight.delete(key);
    }
    this.emit(row, members);
  }

  /**
   * The posts of one bundle in one input, as rooms.ts `bundlePosts` writes a DM's: a line that says how many, then each post's envelope under
   * its place and age. The channel posts its target missed before the first one go with that first envelope.
   */
  private bundleText(row: GroupRoom, members: RoomPost[], missed: RoomPost[], box: string, now: number): string {
    return [`[${members.length} posts in ${roomLabel(row)} waited while ${box} was offline and go together in this one input, oldest first]`,
      ...members.map((p, index) => `${agedPost(this.envelope(row, p, index === 0 ? missed : []), p.at, box, now).replace(/^\[written /, `[${index + 1} of ${members.length}, written `)}`)].join("\n\n");
  }

  /**
   * `box`'s link came back: per room and member, the deliveries that waited for it go again in post order. A bundle saved before goes again as
   * it is; the other waiting posts go as one new bundle, `b:<room>:<first post>:<agent>`, saved on each member before the submit, or alone
   * when only one waits.
   */
  async release(box: string): Promise<void> {
    const now = Date.now();
    for (const row of this.rows()) {
      const waiting = new Map<AgentId, RoomPost[]>();
      for (const post of this.store.postsOf(row.id)) {
        for (const d of post.deliveries ?? []) if (d.state === "sending" && d.away === box) waiting.set(d.target, [...(waiting.get(d.target) ?? []), post]);
      }
      for (const [target, posts] of waiting) {
        const delivery = (post: RoomPost) => post.deliveries!.find(d => d.target === target)!;
        const fresh = posts.filter(p => !delivery(p).bundle);
        const bundle = fresh.length > 1 ? { requestId: `b:${row.id}:${fresh[0]!.id}:${target}`, members: fresh.map(p => p.id) } : undefined;
        for (const post of posts) {
          const { away: _away, error: _error, ...rest } = delivery(post);
          this.setDelivery(post, target, { ...rest, waited: true, at: now, ...(bundle && fresh.includes(post) ? { bundle } : {}) });
        }
        const heads = posts.filter(p => {
          const b = delivery(p).bundle;
          return !b || b.members[0] === p.id;
        });
        for (const head of heads) await this.deliver(head, target);
      }
    }
  }

  /** The member's comm thread for the room, made on its first delivery, with its feed cursor set before the thread gets an input. */
  private async commThread(row: GroupRoom, record: AgentRecord): Promise<string> {
    const thread = await this.deps.agents.ensureComm(record, row.id);
    const feed = (this.store.rooms.commFeed ??= {});
    if (!feed[thread]) {
      feed[thread] = { thread, entry: 0, open: {} };
      this.store.saveRooms();
    }
    await this.deps.events.thread(row.id, thread);
    return thread;
  }

  /**
   * A channel's root posts before a root post that `target` has not had: those after the last root post it wrote or got, at most the last
   * few, so an agent a mention just added reads what the channel said before.
   */
  private missed(row: GroupRoom, post: RoomPost, target: AgentId): RoomPost[] {
    if (row.kind !== "channel" || post.threadRoot) return [];
    const roots = this.store.postsOf(row.id).filter(p => !p.threadRoot && p.seq < post.seq);
    const last = roots.findLastIndex(p => p.author === target || p.deliveries?.some(d => d.target === target));
    return roots.slice(last + 1).slice(-CONTEXT_POSTS);
  }

  /**
   * The text a member reads: `[<label> · post <seq> from <author>[ (owner)] · hops <n>]`, a blank line and the post. A Solo room's label
   * carries its agenda and members; a channel root post adds the root posts its target missed, and a channel reply adds up to five earlier
   * posts of its thread.
   */
  envelope(row: GroupRoom, post: RoomPost, missed: RoomPost[] = []): string {
    const author = this.deps.threads.principal(post.author);
    const label = row.kind === "channel"
      ? `#${row.name}`
      : `Solo "${row.name}" (${row.id}): ${row.agenda.length > AGENDA_CLIP ? `${row.agenda.slice(0, AGENDA_CLIP)}…` : row.agenda} · with ${row.members.map(m => this.deps.threads.principal(m.agent).name).join(", ")}`;
    const lines = [`[${label.replace(/\n+/g, " ")} · post ${post.seq} from ${author.name}${author.kind === "owner" ? " (owner)" : ""} · hops ${post.hops ?? 0}]`, "", post.text];
    const context = (p: RoomPost) => {
      const images = p.images.length ? ` [${p.images.length} image${p.images.length > 1 ? "s" : ""} attached]` : "";
      return `${p.seq} ${this.deps.threads.principal(p.author).name}: ${p.text.slice(0, CONTEXT_CLIP)}${images}`;
    };
    if (missed.length) lines.push("", "(channel before this post)", ...missed.map(context));
    if (row.kind === "channel") {
      const rootId = post.threadRoot ?? post.id;
      const thread = this.store.postsOf(row.id).filter(p => (p.id === rootId || p.threadRoot === rootId) && p.seq < post.seq).slice(-CONTEXT_POSTS);
      if (thread.length) lines.push("", "(thread so far)", ...thread.map(context));
    }
    return lines.join("\n");
  }

  // The feed

  /** After each thread list read: each group comm thread whose `updatedAt` changed gets a feed read, and room status changes go out. */
  poll(): void {
    for (const record of this.deps.agents.list()) {
      for (const [room, thread] of Object.entries(record.comm ?? {})) {
        if (!this.row(room)) continue;
        const updatedAt = this.deps.threads.thread(thread)?.updatedAt;
        if (updatedAt !== undefined && this.seen.get(thread) !== updatedAt) void this.feed(thread, updatedAt);
      }
    }
    const changed: ConversationSummary[] = [];
    for (const row of this.rows()) {
      const status = this.status(row);
      const before = this.statuses.get(row.id);
      this.statuses.set(row.id, status);
      if (before === undefined || before === status) continue;
      this.deps.events.status(row.id, status);
      changed.push(this.summary(row));
    }
    if (changed.length) this.deps.events.conversations(changed);
  }

  /** Reads a group comm thread after its cursor; a read asked for while one runs follows it. Any other thread is ignored. */
  feed(thread: string, seen?: number): Promise<void> {
    if (seen !== undefined) this.seen.set(thread, seen);
    const going = this.reading.get(thread);
    if (going) {
      this.again.add(thread);
      return going;
    }
    const run = (async () => {
      do {
        this.again.delete(thread);
        await this.readComm(thread);
      } while (this.again.has(thread) && !this.stopped);
    })()
      .catch(error => {
        this.seen.delete(thread);
        this.deps.log(`rooms: feed of ${thread} failed: ${String(error)}`);
      })
      .finally(() => this.reading.delete(thread));
    this.reading.set(thread, run);
    return run;
  }

  private async readComm(thread: string): Promise<void> {
    const owner = this.deps.agents.ofComm(thread);
    const row = owner && this.rows().find(r => r.id === owner.room);
    if (!owner || !row) return;
    const cursor = ((this.store.rooms.commFeed ??= {})[thread] ??= { thread, entry: 0, open: {} });
    await readFeedThread(this.deps.host, this.store, this.side(row, owner.record, thread), thread, cursor, posts => this.emit(row, posts));
  }

  /**
   * The group room's side of the feed. An owner input names its post in its header; an agent message from this room carries its post and
   * hops; any other input, such as a work-done notice, keeps the turn's. Every speaking call posts here with the turn's hops plus one.
   */
  private side(row: GroupRoom, record: AgentRecord, thread: string): FeedSide {
    return {
      room: row.id,
      turn: (entry, previous) => {
        const data = entry.data as { via?: unknown; post?: unknown; hops?: unknown } | undefined;
        if (entry.kind === "pi.user") {
          const post = this.ownerPostOf(row, record, thread, entry);
          return { input: entry.id, channel: false, hops: 0, ...(post ? { post } : {}) };
        }
        if (entry.kind === "agent.message" && data?.via === row.id) {
          return { input: entry.id, channel: false, ...(typeof data.post === "string" ? { post: data.post } : {}), hops: typeof data.hops === "number" ? data.hops : 0 };
        }
        return { input: entry.id, channel: false, ...(previous?.post ? { post: previous.post } : {}), ...(previous?.hops !== undefined ? { hops: previous.hops } : {}) };
      },
      speaks: () => true,
      aimedHere: to => {
        const name = to.trim().replace(/^#/, "").toLowerCase();
        return name === row.id.toLowerCase() || name === row.name.toLowerCase();
      },
      post: (spoken: Spoken, turn: FeedCursor["turn"]) => {
        const posts = this.store.postsOf(row.id);
        const started = turn?.post ? posts.find(p => p.id === turn.post) : undefined;
        const threadRoot = row.kind === "channel" && started ? started.threadRoot ?? started.id : undefined;
        return this.write(row, {
          author: record.id, images: [], ...spoken, hops: (turn?.hops ?? 0) + 1, mentions: this.mentionsIn(row, spoken.text, record.id),
          ...(threadRoot ? { threadRoot } : {}),
        });
      },
    };
  }

  /**
   * The owner post a `pi.user` input in a comm thread carries: by the seq in its header (the newest owner header of a bundle), else the newest
   * owner post delivered there.
   */
  private ownerPostOf(row: GroupRoom, record: AgentRecord, thread: string, entry: EntryRecord): string | undefined {
    const content = entry.model?.[0]?.content;
    const text = typeof content === "string" ? content : (content ?? []).flatMap(b => (b.type === "text" ? [b.text] : [])).join("\n");
    const header = /· post (\d+) from [^\n]* · hops \d+\]$/;
    const lines = text.split("\n");
    // A post that waited for its box, alone or in a bundle, opens with its age; then its newest owner envelope names the post.
    const seqs = header.test(lines[0] ?? "") ? [lines[0]!] : /^\[(written |\d+ posts in )/.test(lines[0] ?? "") ? lines.filter(line => header.test(line)).reverse() : [];
    const posts = this.store.postsOf(row.id);
    for (const line of seqs) {
      const named = posts.find(p => p.seq === Number(header.exec(line)![1]) && p.author === "owner");
      if (named) return named.id;
    }
    return posts.findLast(p => p.author === "owner" && p.deliveries?.some(d => d.target === record.id && d.thread === thread))?.id;
  }

  /** The members, and the owner, an agent's post names as `@<name>`. */
  private mentionsIn(row: GroupRoom, text: string, author: AgentId): (AgentId | "owner")[] {
    const out: (AgentId | "owner")[] = [];
    for (const member of row.members) {
      if (member.agent !== author && text.includes(`@${this.deps.threads.principal(member.agent).name}`)) out.push(member.agent);
    }
    if (/@(owner|You)\b/.test(text)) out.push("owner");
    return out;
  }

  // Reading

  private emit(row: GroupRoom, posts: RoomPost[]): void {
    const all = this.store.postsOf(row.id);
    const ids = new Set(posts.map(p => p.id));
    for (const post of posts) if (post.threadRoot && !ids.has(post.threadRoot)) ids.add(post.threadRoot);
    const items = all.filter(p => ids.has(p.id)).map(p => this.item(row, p, all));
    this.deps.events.items(row.id, items);
    this.deps.events.conversations([this.summary(row)]);
  }

  /** A delivery as the page shows it: `sending` reads as queued, and a delivered one reads as answered once its member posted after it. */
  private publicDelivery(row: GroupRoom, post: RoomPost, d: RoomDelivery, all: RoomPost[]): Delivery {
    const answer = d.state === "delivered"
      ? all.find(p => p.author === d.target && p.seq > post.seq && (d.thread === undefined || p.source?.thread === d.thread)
        && (row.kind !== "channel" || (p.threadRoot ?? p.id) === (post.threadRoot ?? post.id)))
      : undefined;
    return {
      target: d.target, name: this.deps.threads.principal(d.target).name, state: d.state === "sending" ? "queued" : answer ? "answered" : d.state, at: d.at,
      ...(answer ? { answer: answer.id } : {}), ...(d.error ? { error: d.error } : {}),
    };
  }

  item(row: GroupRoom, post: RoomPost, all = this.store.postsOf(row.id)): Item {
    const replies = row.kind === "channel" && !post.threadRoot ? all.filter(p => p.threadRoot === post.id) : [];
    const authors = [...new Set(replies.map(r => r.author))].slice(0, 3).map(a => this.deps.threads.principal(a));
    return {
      kind: "message", id: post.id, seq: post.seq, at: post.at, author: this.deps.threads.principal(post.author), text: post.text, images: post.images,
      mentions: (post.mentions ?? []) as AgentId[], ...(post.threadRoot ? { threadRoot: post.threadRoot } : {}),
      ...(post.author === "owner" ? { requestId: post.requestId } : agentPostParts(this.deps.threads, post)),
      ...(replies.length ? { thread: { replies: replies.length, lastAt: replies.at(-1)!.at, authors } } : {}),
      deliveries: (post.deliveries ?? []).map(d => this.publicDelivery(row, post, d, all)),
    };
  }

  /** A page of the room's root posts, oldest first; `before`, `after` and `around` are post ids, and `around` a reply opens its root. */
  timeline(id: string, opts: { before?: string; after?: string; around?: string; limit?: number }): TimelinePage {
    const row = this.require(id);
    const all = this.store.postsOf(row.id);
    const roots = all.filter(p => !p.threadRoot);
    const limit = Math.min(Math.max(opts.limit ?? PAGE, 1), 200);
    let start: number;
    let end: number;
    let focus: string | undefined;
    if (opts.around) {
      const target = all.find(p => p.id === opts.around);
      focus = target?.threadRoot ?? target?.id;
      const at = Math.max(0, roots.findIndex(p => p.id === focus));
      start = Math.max(0, at - Math.ceil(limit / 2));
      end = Math.min(roots.length, start + limit);
    } else if (opts.after) {
      start = roots.findIndex(p => p.id === opts.after) + 1;
      end = Math.min(roots.length, start + limit);
    } else {
      const at = opts.before ? roots.findIndex(p => p.id === opts.before) : roots.length;
      end = at < 0 ? roots.length : at;
      start = Math.max(0, end - limit);
    }
    const items = roots.slice(start, end).map(p => this.item(row, p, all));
    return { items, ...(start > 0 ? { older: roots[start]!.id } : {}), ...(end < roots.length ? { newer: roots[end - 1]!.id } : {}), ...(focus ? { focus } : {}) };
  }

  /** A channel thread: the root post and every reply, oldest first. */
  replies(id: string, root: string): { root: Item; items: Item[] } {
    const row = this.require(id);
    const all = this.store.postsOf(row.id);
    const rootPost = all.find(p => p.id === root);
    if (!rootPost) throw new Error(`No post ${root} in ${roomLabel(row)}.`);
    return { root: this.item(row, rootPost, all), items: all.filter(p => p.threadRoot === root).map(p => this.item(row, p, all)) };
  }

  markRead(id: string, seq?: number): void {
    const row = this.require(id);
    const last = this.store.postsOf(row.id).at(-1)?.seq ?? 0;
    this.deps.state.state.reads[row.id] = { at: Date.now(), seq: Math.min(seq ?? last, last) };
    this.deps.state.saveState();
    this.deps.events.conversations([this.summary(row)]);
  }

  readSeq(row: GroupRoom): number | undefined {
    return this.deps.state.state.reads[row.id]?.seq;
  }

  /** Every post of every group room, for search. */
  allPosts(): { row: GroupRoom; post: RoomPost }[] {
    return this.rows().flatMap(row => this.store.postsOf(row.id).map(post => ({ row, post })));
  }

  /** Stops each member's comm thread turn in the room. */
  async abort(id: string): Promise<void> {
    const row = this.require(id);
    await Promise.all(this.commThreads(row).map(c => this.deps.host.abort(c.thread).catch(() => undefined)));
  }
}
