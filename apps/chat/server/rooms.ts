/**
 * DM rooms (apps/chat/docs/agent-model.md, phase 2). A DM is a room of posts the chat server stores, as Slack does, never a view of a thread:
 *
 * 1. An owner post is written and shown at once, then delivered to the agent's work thread with retries; its delivery state is a `set` line.
 * 2. The feed reads the work thread's entries after its cursor and turns each speaking call (`tell_owner`, `send_message` with no `to`) whose
 *    result says it went out into an agent post, and the jobs its turn started into the post's job pills. Only these calls and the owner's own
 *    room posts become posts: a plain input a job, a script or another chat submits to the work thread is the thread's, not the room's. A turn
 *    a channel post started speaks to the channel (channels.ts), so it posts nothing here.
 * 3. A restart resumes each cursor and delivers every post still `sending` again with the same request id, which pi-host keeps once.
 *
 * Every post has one dedup key (`requestId`), so a repeated send or a re-read page lands nothing twice.
 */
import type { ConversationSummary, Delivery, ImageRef, ImageUpload, Item, JobRef, RunStatus, SendRequest, SendResult, TimelinePage } from "../web/src/lib/api/types.ts";
import { serverNote, TELL_OWNER_HELD, TELL_OWNER_TOOL } from "../web/src/lib/api/shared/chat-feed.ts";
import type { AgentRecord, AgentStore, FeedCursor, RoomId, RoomPost, TestSend } from "./agent-store.ts";
import type { Agents } from "./agents.ts";
import type { ContentBlock, EntryRecord, Host, Message, Submitted } from "./host/types.ts";
import { refusedForGood, retryWait } from "./outbox.ts";
import type { Store } from "./store.ts";
import { OWNER, type Threads } from "./threads.ts";
import { isInput, sentMessage } from "./timeline.ts";

const PAGE = 40;
/** Entries the feed reads per pi-host call. */
const FEED_PAGE = 200;

export interface RoomEvents {
  /** New or changed posts, for the room's watchers. */
  items(room: RoomId, items: Item[]): void;
  status(room: RoomId, status: RunStatus): void;
  /** A room's summary changed: a post, a read mark or a status. */
  changed(): void;
  /** pi-host took an owner post; its answer carries the run's place in pi-pool's turn queue. */
  submitted(record: AgentRecord, result: Submitted): void;
}

export interface RoomDeps {
  store: AgentStore;
  state: Store;
  host: Host;
  threads: Threads;
  agents: Agents;
  events: RoomEvents;
  saveUpload(image: ImageUpload): ImageRef;
  readUpload(ref: ImageRef): { data: string; mimeType: string } | undefined;
  log(line: string): void;
}

const blocks = (message: Message | undefined): ContentBlock[] =>
  !message ? [] : typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
const textOf = (message: Message | undefined): string => blocks(message).flatMap(b => (b.type === "text" ? [b.text] : [])).join("\n");

/** A channel delivery's input names its channel as `#<name>` (channels.ts); its turn speaks to the channel. */
export const isChannelVia = (via: unknown): boolean => typeof via === "string" && (via.startsWith("#") || via.startsWith("ch_"));

const SKILL_BLOCK = /<skill\b[^>]*>[\s\S]*?<\/skill>/g;
const withoutSkills = (text: string): string => text.replace(SKILL_BLOCK, " ").trim();

/**
 * The text the migration (`migrate.ts`) copies into a room for an old owner input, or undefined when the entry is not one. Only a `pi.user` entry
 * counts, and not a notice that a tool, a job or Prime wrote: a bracket tag such as `[job] ...`, or a note `serverNote` knows (check-ins,
 * `<provider_quota_resumed>`, Prime's restart line). Prime's skill expansions (`<skill name=...>...</skill>`) before his words drop out.
 */
export function ownerText(entry: EntryRecord): string | undefined {
  if (entry.kind !== "pi.user") return undefined;
  const message = entry.model?.[0];
  const raw = textOf(message).trim();
  if (/^\[[^\]\n]{1,80}\]/.test(raw) || serverNote(raw) !== undefined) return undefined;
  const text = withoutSkills(raw);
  return text || blocks(message).some(b => b.type === "image") ? text : undefined;
}

/** The child conversations a tool result names: `details.conversationId`, and each id in `details.conversations` (rlm.spawn). */
function jobsIn(thread: string, message: Message): string[] {
  const ids = [message.details?.conversationId, ...(Array.isArray(message.details?.conversations) ? message.details.conversations : [])];
  return [...new Set(ids.filter((id): id is number => typeof id === "number").map(id => `${thread}:${id}`))];
}

const held = (message: Message): boolean => message.toolName === TELL_OWNER_TOOL && textOf(message).startsWith(TELL_OWNER_HELD);

/** The `via` of a test send's agent message: the post itself, delivered after its mark, and the notice for one the owner's delivery took. */
export const TEST_SEND_VIA = "test-send";

/** The agent message that tells an agent a post in its DM came from a job's test, not from the owner. */
export function testSendNotice(post: RoomPost, mark: TestSend, by: string): string {
  const quoted = post.text.length > 200 ? `${post.text.slice(0, 200)}…` : post.text;
  return `[test send from ${by}] Post ${post.id} in your DM, "${quoted}", came from ${by}'s test, not from the owner. ${mark.reason.trim()}\n\n` +
    "It asked you for nothing. Drop anything you did or planned because of it, and do not answer it.";
}

export class Rooms {
  /** The wait before the next try of a delivery; a test shortens it. */
  backoff: (attempts: number) => number = retryWait;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly inflight = new Set<string>();
  private stopped = true;
  /** The feed read going per agent, and whether another must follow it. */
  private readonly reading = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  /** The work thread's `updatedAt` at the last feed read per agent. */
  private readonly seen = new Map<string, number>();
  private readonly statuses = new Map<RoomId, RunStatus>();
  /** `testSendsOf` per work thread, dropped when a mark changes. */
  private readonly testSends = new Map<string, Map<number, { by: string; reason: string }>>();
  private readonly settleTries = new Map<string, number>();

  constructor(private readonly deps: RoomDeps) {}

  private get store(): AgentStore {
    return this.deps.store;
  }

  start(): void {
    this.stopped = false;
    for (const record of this.deps.agents.list()) {
      for (const post of this.store.postsOf(record.room)) {
        if (post.testSend && (post.testSend.entry === undefined || post.testSend.notice === undefined)) void this.settleTestSend(record, post);
        if (post.author !== "owner" || post.imported || /^[hi]:/.test(post.requestId)) continue;
        // A post written just before a crash may have no delivery line yet.
        if (!post.delivery) this.store.set(post, { delivery: this.newDelivery(post, record) });
        if (post.delivery!.state === "sending") this.schedule(post, 0);
      }
    }
    this.store.saveTestSends(this.allTestSends());
    this.poll();
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** After each thread list read: status changes go out, and each agent whose work thread changed gets a feed read. */
  poll(): void {
    let changed = false;
    for (const record of this.deps.agents.list()) {
      const status = this.status(record);
      if (this.statuses.get(record.room) !== status) {
        if (this.statuses.has(record.room)) changed = true;
        this.statuses.set(record.room, status);
        this.deps.events.status(record.room, status);
      }
      const row = this.deps.threads.thread(record.workThread);
      if (row && this.seen.get(record.id) !== row.updatedAt) void this.feed(record, row.updatedAt);
    }
    if (changed) this.deps.events.changed();
  }

  status(record: AgentRecord): RunStatus {
    return this.deps.threads.agent(record.id)?.status ?? "idle";
  }

  // Owner posts

  /** Writes the owner's post, shows it, and starts its delivery; the same requestId again answers the first post. */
  post(record: AgentRecord, request: SendRequest): SendResult {
    const existing = this.store.byRequestId(record.room, request.requestId);
    if (existing) return existing.delivery?.state === "failed" ? this.retry(record, existing.requestId) : this.result(existing);
    const images = (request.images ?? []).map(image => this.deps.saveUpload(image));
    const { post } = this.store.append({ room: record.room, author: "owner", text: request.text ?? "", images, at: Date.now(), requestId: request.requestId });
    this.store.set(post, { delivery: this.newDelivery(post, record) });
    this.deps.state.state.reads[record.room] = { at: post.at, seq: post.seq };
    this.deps.state.saveState();
    this.changed(record, [post]);
    this.schedule(post, 0);
    return this.result(post);
  }

  /** Tries a post's delivery again now. */
  retry(record: AgentRecord, requestId: string): SendResult {
    const post = this.store.byRequestId(record.room, requestId);
    if (!post?.delivery) throw new Error(`No post ${requestId} in ${record.room} waits for delivery.`);
    if (post.delivery.state !== "delivered") {
      const { error: _error, ...rest } = post.delivery;
      this.store.set(post, { delivery: { ...rest, state: "sending", at: Date.now() } });
      this.changed(record, [post]);
      this.schedule(post, 0);
    }
    return this.result(post);
  }

  private newDelivery(post: RoomPost, record: AgentRecord): NonNullable<RoomPost["delivery"]> {
    return { target: record.id, state: "sending", attempts: 0, at: post.at, requestId: `d:${post.id}:${record.id}` };
  }

  private result(post: RoomPost): SendResult {
    const item = this.item(post);
    return { item, deliveries: item.kind === "message" ? item.deliveries : [] };
  }

  private schedule(post: RoomPost, delay: number): void {
    if (this.stopped) return;
    const key = `${post.room}/${post.id}`;
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => void this.deliver(post), delay));
  }

  private async deliver(post: RoomPost): Promise<void> {
    const key = `${post.room}/${post.id}`;
    this.timers.delete(key);
    const delivery = post.delivery;
    const record = delivery && this.deps.agents.record(delivery.target);
    if (this.stopped || !delivery || !record || delivery.state !== "sending" || this.inflight.has(key)) return;
    this.inflight.add(key);
    const images = post.images.map(ref => this.deps.readUpload(ref)).filter((image): image is { data: string; mimeType: string } => !!image);
    try {
      // A test send reaches the agent as the job's agent message, so the agent never reads it as the owner's words.
      const asTest = post.testSend;
      const from = asTest ? { entry: { kind: "agent.message" as const, data: { from: asTest.by, via: TEST_SEND_VIA } } } : { ownerTurn: true };
      const result = await this.deps.host.submit(record.workThread, {
        text: post.text, ...(images.length ? { images } : {}), requestId: delivery.requestId, whenBusy: "steer", ...from,
      });
      this.store.set(post, { delivery: {
        target: delivery.target, state: "delivered", attempts: delivery.attempts + 1, at: Date.now(), requestId: delivery.requestId, submission: result.submission,
        ...(asTest ? { testSend: true } : {}),
      } });
      // A mark that came while the owner's input was on its way: the agent got it as the owner's, so it gets the notice.
      if (post.testSend && !asTest) void this.settleTestSend(record, post);
      this.changed(record, [post]);
      this.deps.events.submitted(record, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempts = delivery.attempts + 1;
      if (refusedForGood(message)) {
        this.deps.log(`rooms: ${record.room} ${post.id} refused: ${message}`);
        this.store.set(post, { delivery: { ...delivery, state: "failed", attempts, at: Date.now(), error: message } });
      } else {
        const wait = this.backoff(attempts);
        this.deps.log(`rooms: ${record.room} ${post.id} attempt ${attempts} failed, retry in ${wait} ms: ${message}`);
        // The post stays `sending`; after a few tries the page shows the reason, so a long pi-host restart is visible.
        this.store.set(post, { delivery: { ...delivery, attempts, at: Date.now(), ...(attempts >= 3 ? { error: message } : {}) } });
        this.schedule(post, wait);
      }
      this.changed(record, [post]);
    } finally {
      this.inflight.delete(key);
    }
  }

  // Test sends

  /**
   * Marks an owner post as job `by`'s test send, with the reason. The post reads as the job's from now on. A post still on its way goes to
   * the agent as the job's agent message; for one the owner's delivery already took, `settleTestSend` tells the agent and finds its entry.
   */
  markTestSend(record: AgentRecord, postId: string, input: { by?: unknown; reason?: unknown }): SendResult {
    const by = typeof input.by === "string" ? input.by.trim() : "";
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    if (!by || !reason) throw new Error("A test send needs `by`, the job that sent it, and `reason`, both strings that are not blank.");
    const post = this.store.postsOf(record.room).find(p => p.id === postId);
    if (!post) throw new Error(`No post ${postId} in ${record.room}.`);
    if (post.author !== "owner" || post.imported) throw new Error(`A test send is an owner post typed in the room; ${postId} in ${record.room} is not one.`);
    if (post.testSend?.by !== by || post.testSend.reason !== reason) {
      this.store.set(post, { testSend: { ...post.testSend, by, reason, at: Date.now() } });
      this.testSends.delete(record.workThread);
      this.changed(record, [post]);
    }
    void this.settleTestSend(record, post);
    return this.result(post);
  }

  /** The test sends the owner's delivery took to the work thread: the agent gets the notice once, then the post's entry is found. */
  private async settleTestSend(record: AgentRecord, post: RoomPost): Promise<void> {
    const mark = post.testSend;
    const delivery = post.delivery;
    const key = `t:${post.room}/${post.id}`;
    if (this.stopped || !mark || delivery?.state !== "delivered" || delivery.testSend || this.inflight.has(key)) return;
    this.inflight.add(key);
    try {
      if (mark.notice === undefined) {
        const text = testSendNotice(post, mark, this.deps.threads.principal(mark.by).name);
        await this.deps.host.submit(record.workThread, {
          text, requestId: `t:${post.id}:${record.id}`, whenBusy: "steer", entry: { kind: "agent.message", data: { from: mark.by, via: TEST_SEND_VIA } },
        });
        this.store.set(post, { testSend: { ...post.testSend!, notice: Date.now() } });
      }
      if (post.testSend!.entry === undefined && delivery.submission !== undefined) {
        const { entry } = await this.deps.host.wait(record.workThread, delivery.submission);
        if (entry !== undefined) {
          this.store.set(post, { testSend: { ...post.testSend!, entry } });
          this.testSends.delete(record.workThread);
          this.store.saveTestSends(this.allTestSends());
        }
      }
      this.settleTries.delete(key);
    } catch (error) {
      const tries = (this.settleTries.get(key) ?? 0) + 1;
      this.settleTries.set(key, tries);
      const wait = this.backoff(tries);
      this.deps.log(`rooms: test send ${record.room} ${post.id} attempt ${tries} failed, retry in ${wait} ms: ${error instanceof Error ? error.message : String(error)}`);
      if (!this.stopped) setTimeout(() => void this.settleTestSend(record, post), wait);
    } finally {
      this.inflight.delete(key);
    }
  }

  /** The work-thread inputs that were test sends, by entry id, for search and the thread's timeline. */
  testSendsOf(thread: string): ReadonlyMap<number, { by: string; reason: string }> {
    let found = this.testSends.get(thread);
    if (found) return found;
    found = new Map();
    const record = this.deps.agents.ofWorkThread(thread);
    for (const post of record ? this.store.postsOf(record.room) : []) {
      if (post.testSend?.entry !== undefined) found.set(post.testSend.entry, { by: post.testSend.by, reason: post.testSend.reason });
    }
    this.testSends.set(thread, found);
    return found;
  }

  /** Every room's test sends whose entry is known, for search. */
  allTestSends(): { thread: string; entry: number; by: string; reason: string }[] {
    return this.deps.agents.list().flatMap(record => [...this.testSendsOf(record.workThread)].map(([entry, mark]) => ({ thread: record.workThread, entry, ...mark })));
  }

  private changed(record: AgentRecord, posts: RoomPost[]): void {
    this.deps.events.items(record.room, posts.map(post => this.item(post)));
    this.deps.events.changed();
  }

  // The feed

  /** Reads the agent's work thread after its cursor; a read asked for while one runs follows it. */
  feed(record: AgentRecord, updatedAt?: number): Promise<void> {
    if (updatedAt !== undefined) this.seen.set(record.id, updatedAt);
    const going = this.reading.get(record.id);
    if (going) {
      this.again.add(record.id);
      return going;
    }
    const run = (async () => {
      do {
        this.again.delete(record.id);
        await this.readFeed(record);
      } while (this.again.has(record.id) && !this.stopped);
    })()
      .catch(error => {
        // pi-host is away; the next poll that sees the thread change reads again.
        this.seen.delete(record.id);
        this.deps.log(`rooms: feed of ${record.id} failed: ${String(error)}`);
      })
      .finally(() => this.reading.delete(record.id));
    this.reading.set(record.id, run);
    return run;
  }

  private async readFeed(record: AgentRecord): Promise<void> {
    let cursor = this.store.rooms.feed[record.id];
    if (!cursor) {
      // The migrate CLI sets the cursor of each agent it makes; a record without one starts at the thread's newest entry.
      const newest = (await this.deps.host.entries(record.workThread, { conversation: 1, limit: 1 })).entries[0]?.id ?? 0;
      cursor = this.store.rooms.feed[record.id] ??= { entry: newest, open: {} };
      this.store.saveRooms();
    }
    for (;;) {
      const page = await this.deps.host.entries(record.workThread, { conversation: 1, after: cursor.entry, limit: FEED_PAGE });
      const touched = new Map<string, RoomPost>();
      for (const entry of page.entries) {
        if (entry.id <= cursor.entry) continue;
        this.read(record, cursor, entry, touched);
        cursor.entry = entry.id;
      }
      this.store.saveRooms();
      if (touched.size) this.changed(record, [...touched.values()]);
      if (!page.more || !page.entries.length) return;
    }
  }

  private read(record: AgentRecord, cursor: FeedCursor, entry: EntryRecord, touched: Map<string, RoomPost>): void {
    const message = entry.model?.[0];
    const thread = record.workThread;
    if (isInput(entry)) {
      cursor.turn = { input: entry.id, channel: entry.kind === "agent.message" && isChannelVia((entry.data as { via?: unknown } | undefined)?.via) };
      return;
    }
    if (cursor.turn?.channel) return;
    if (message?.role === "assistant") {
      for (const block of blocks(message)) {
        const sent = sentMessage(block);
        if (!sent || sent.to || block.type !== "toolCall") continue;
        const why = typeof block.arguments?.why === "string" && block.arguments.why.trim() ? block.arguments.why.trim() : undefined;
        cursor.open[sent.id] = { text: sent.text, entry: entry.id, ...(why ? { why } : {}) };
      }
      return;
    }
    if (message?.role !== "toolResult") return;
    const call = message.toolCallId ? cursor.open[message.toolCallId] : undefined;
    if (call && message.toolCallId) {
      delete cursor.open[message.toolCallId];
      if (!message.isError && !held(message)) {
        const pending = cursor.turn?.jobs;
        const { post } = this.store.append({
          room: record.room, author: record.id, text: call.text, images: [], at: message.timestamp ?? Date.now(), requestId: `m:${thread}:${message.toolCallId}`,
          ...(call.why ? { why: call.why } : {}), source: { thread, conversation: 1, entry: call.entry }, ...(pending?.length ? { jobs: pending } : {}),
        });
        touched.set(post.id, post);
        if (cursor.turn) {
          cursor.turn.lastPost = post.id;
          delete cursor.turn.jobs;
        }
      }
    }
    const jobs = jobsIn(thread, message);
    if (!jobs.length) return;
    cursor.turn ??= { input: entry.id, channel: false };
    const last = cursor.turn.lastPost ? this.store.postsOf(record.room).find(p => p.id === cursor.turn!.lastPost) : undefined;
    if (last) {
      const all = [...new Set([...(last.jobs ?? []), ...jobs])];
      if (all.length !== (last.jobs ?? []).length) {
        this.store.set(last, { jobs: all });
        touched.set(last.id, last);
      }
    } else cursor.turn.jobs = [...new Set([...(cursor.turn.jobs ?? []), ...jobs])];
  }

  // Reading

  item(post: RoomPost): Item {
    const record = this.deps.agents.record(post.room);
    const base = { kind: "message" as const, id: post.id, seq: post.seq, at: post.at, text: post.text, images: post.images, mentions: [] };
    if (post.author === "owner") {
      const d = post.delivery;
      const test = post.testSend ? { by: this.deps.threads.principal(post.testSend.by), reason: post.testSend.reason } : undefined;
      const deliveries: Delivery[] = d
        ? [{ target: d.target, name: record?.name ?? d.target, state: d.state === "sending" ? "queued" : d.state, at: d.at, ...(d.error ? { error: d.error } : {}) }]
        : [];
      return {
        ...base, author: test?.by ?? OWNER, deliveries, requestId: post.requestId, ...(test ? { testSend: test } : {}),
        ...(d ? { send: d.state === "delivered" ? "sent" as const : d.state, ...(d.error ? { sendError: d.error } : {}) } : {}),
      };
    }
    const thread = post.source?.thread ?? record?.workThread;
    const tree = thread ? this.deps.threads.tree(thread) : [];
    const jobs: JobRef[] = (post.jobs ?? []).map(id => {
      const [jobThread, n] = [id.slice(0, id.lastIndexOf(":")), Number(id.slice(id.lastIndexOf(":") + 1))];
      const node = (jobThread === thread ? tree : this.deps.threads.tree(jobThread)).find(x => x.id === n);
      return { conversation: id, name: node?.name ?? `job ${n}`, status: this.deps.threads.statusOfConversation(jobThread, n), replies: 0, lastAt: node?.createdAt ?? post.at };
    });
    return {
      ...base, author: this.deps.threads.principal(post.author), deliveries: [],
      ...(post.why ? { why: post.why } : {}),
      ...(post.source ? { work: { conversation: post.source.conversation === 1 ? post.source.thread : `${post.source.thread}:${post.source.conversation}`, around: `e${post.source.entry}` } } : {}),
      ...(jobs.length ? { jobs } : {}),
    };
  }

  /** A page of the room's posts, oldest first; `before`, `after` and `around` are post ids. */
  timeline(record: AgentRecord, opts: { before?: string; after?: string; around?: string; limit?: number }): TimelinePage {
    const posts = this.store.postsOf(record.room);
    const limit = Math.min(Math.max(opts.limit ?? PAGE, 1), 200);
    const index = (id: string) => {
      const at = posts.findIndex(p => p.id === id);
      if (at < 0) throw new Error(`No post ${id} in ${record.room}.`);
      return at;
    };
    let start: number;
    let end: number;
    let focus: string | undefined;
    if (opts.around) {
      const at = index(opts.around);
      start = Math.max(0, at - Math.ceil(limit / 2));
      end = Math.min(posts.length, at + Math.floor(limit / 2) + 1);
      focus = opts.around;
    } else if (opts.after) {
      start = index(opts.after) + 1;
      end = Math.min(posts.length, start + limit);
    } else {
      end = opts.before ? index(opts.before) : posts.length;
      start = Math.max(0, end - limit);
    }
    const page = posts.slice(start, end);
    return {
      items: page.map(post => this.item(post)),
      ...(start > 0 && page[0] ? { older: page[0].id } : {}),
      ...(end < posts.length && page.at(-1) ? { newer: page.at(-1)!.id } : {}),
      ...(focus ? { focus } : {}),
    };
  }

  summary(record: AgentRecord): ConversationSummary {
    const agent = this.deps.threads.agent(record.id);
    const posts = this.store.postsOf(record.room);
    const last = posts.at(-1);
    const mark = this.deps.state.state.reads[record.room]?.seq ?? 0;
    const unread = posts.filter(p => p.seq > mark && p.author !== "owner").length;
    const status = agent?.status ?? "idle";
    const name = agent?.name ?? record.name;
    return {
      id: record.room, kind: "dm", name, status, archived: agent?.archived ?? record.archived,
      lastActivityAt: posts.reduce((max, p) => Math.max(max, p.at), record.createdAt), preview: last ? last.text.slice(0, 200) : "",
      unread, hasNew: unread > 0, working: status === "working" ? [{ id: record.id, name }] : [], agent: record.id,
    };
  }

  summaries(): ConversationSummary[] {
    return this.deps.agents.list().map(record => this.summary(record));
  }

  markRead(record: AgentRecord, seq?: number): void {
    const last = this.store.postsOf(record.room).at(-1)?.seq ?? 0;
    this.deps.state.state.reads[record.room] = { at: Date.now(), seq: Math.min(seq ?? last, last) };
    this.deps.state.saveState();
    this.deps.events.changed();
  }

  readSeq(record: AgentRecord): number | undefined {
    return this.deps.state.state.reads[record.room]?.seq;
  }
}
