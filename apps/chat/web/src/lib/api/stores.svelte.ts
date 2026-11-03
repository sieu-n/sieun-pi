/**
 * Svelte 5 live stores over the one /api/live socket. Global stores (`me`, `sidebar`, `agents`, `jobs`, `conversations`, `forYou`) start on
 * first use; per-view stores (`timeline`, `replies`, `boardStore`) start with their factory call and stop with `close()`.
 * Every item update is an upsert by id, so a turn's new entries replace the item in place.
 * A send shows at once as the owner's message `r:<requestId>` (sending, then sent), as in Slack, and the real message replaces it when it
 * lands; nothing waits on the network before the composer takes the next message. An attached image shows from its preview while its
 * upload ends, and the post names the uploaded ref.
 */
import { api, ApiError, roomOf, type Attached } from "./client.ts";
import { live } from "./live.svelte.ts";
import type {
  AgentId, AgentSummary, BoardOp, BoardView, ConversationHeader, ConversationId, ConversationSummary, ForYouItem, Item, Me,
  RunStatus, SendRequest, SendResult, Sidebar, TurnPlace,
} from "./types.ts";

const byTime = (a: Item, b: Item) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

type SendOpts = { images?: Attached[]; mentions?: AgentId[]; threadRoot?: string; whenBusy?: "steer" | "followUp" };
/** A send as the page holds it: a `SendRequest` whose images may still be uploading. */
type SendDraft = Omit<SendRequest, "images"> & { images?: Attached[] };
/** Tries after the first when the chat server cannot be reached, each with the same requestId, so a send lands once. */
const SEND_RETRIES = 3;
/** A real owner message replaces a pending send with its text only if it is no older than this before it, so history never does. */
const LAND_SLACK_MS = 60_000;
const isPending = (item: Item): boolean => item.id.startsWith("r:");
/** A DM room (`dm_<slug>`): its items are stored posts, and an owner post's delivery to the agent's work thread is its send line. */
const isRoom = (id: ConversationId): boolean => id.startsWith("dm_");
const sameText = (a: string, b: string): boolean => a.trim() === b.trim();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function optimistic(request: SendDraft): Item {
  return {
    kind: "message", id: `r:${request.requestId}`, at: Date.now(), author: global.me?.owner ?? { id: "owner", kind: "owner", name: "You", avatar: { initials: "Me", hue: 210 } },
    text: request.text, images: (request.images ?? []).map(image => ({ url: image.preview, mimeType: image.mimeType })),
    mentions: request.mentions ?? [], deliveries: [], pending: true, send: "sending", requestId: request.requestId,
    ...(request.threadRoot ? { threadRoot: request.threadRoot } : {}),
  };
}

/**
 * A DM owner post's delivery as the line under it: Sending… while the chat server has not handed it to the work thread, Not delivered once
 * that failed, and nothing once delivered. The delivery leaves `deliveries`, whose notes are for channel mentions.
 */
function roomPost(item: Item): Item {
  if (item.kind !== "message" || item.author.id !== "owner" || isPending(item)) return item;
  const delivery = item.deliveries[0];
  const { send: _send, sendError: _error, ...rest } = item;
  return {
    ...rest,
    deliveries: [],
    ...(delivery?.state === "queued" ? { send: "sending" as const } : delivery?.state === "failed" ? { send: "failed" as const } : {}),
    ...(delivery?.error ? { sendError: delivery.error } : {}),
    ...(delivery?.queue ? { queue: delivery.queue } : {}),
  };
}

/**
 * Upserts items by id, oldest first. A pending send never steps back from sent to sending and never comes back once it landed, and the
 * owner's real message (a post with its requestId, or an input with its text) replaces the pending send it came from.
 */
function merge(items: readonly Item[], incoming: readonly Item[], landed: Set<string>, removed: readonly string[] = []): Item[] {
  for (const id of removed) landed.add(id);
  const next = items.filter(item => !removed.includes(item.id));
  for (const item of incoming) {
    const index = next.findIndex(i => i.id === item.id);
    const old = index >= 0 ? next[index] : undefined;
    if (isPending(item)) {
      if (landed.has(item.id)) continue;
      if (old?.kind === "message" && item.kind === "message" && old.send === "sent" && item.send === "sending") continue;
    } else if (item.kind === "message" && item.author.id === "owner") {
      const pending = next.findIndex(i => i.kind === "message" && isPending(i) &&
        (item.requestId ? i.id === `r:${item.requestId}` : sameText(i.text, item.text) && item.at >= i.at - LAND_SLACK_MS));
      if (pending >= 0) {
        landed.add(next[pending]!.id);
        next.splice(pending, 1);
      }
    }
    const at = next.findIndex(i => i.id === item.id);
    if (at >= 0) next[at] = item;
    else next.push(item);
  }
  return next.sort(byTime);
}

/**
 * Posts a send once its images are uploaded, trying again with the same requestId while the chat server cannot be reached; a refused send
 * throws at once.
 */
async function post(conversation: ConversationId, draft: SendDraft): Promise<SendResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      const images = await Promise.all((draft.images ?? []).map(image => image.ref()));
      return await api.send(conversation, { ...draft, images });
    } catch (error) {
      const unreachable = !(error instanceof ApiError) || error.status >= 500;
      if (!unreachable || attempt >= SEND_RETRIES) throw error;
      await sleep(400 * 2 ** attempt);
    }
  }
}

/** The optimistic side of sending, shared by a timeline and a channel thread: requests by id, landed ids, and failure marks. */
class Sends {
  readonly requests = new Map<string, SendDraft>();
  readonly landed = new Set<string>();

  constructor(private readonly conversation: ConversationId, private readonly read: () => Item[], private readonly write: (items: Item[]) => void) {}

  merge(incoming: readonly Item[], removed: readonly string[] = []): void {
    this.write(merge(this.read(), incoming, this.landed, removed));
    for (const id of this.landed) this.requests.delete(id.slice(2));
  }

  /** Shows the send at once and posts it behind; the promise settles when the chat server has it or it failed. */
  async send(request: SendDraft, show = true): Promise<SendResult | undefined> {
    this.requests.set(request.requestId, request);
    if (show) this.merge([optimistic(request)]);
    try {
      return await post(this.conversation, request);
    } catch (error) {
      this.fail(`r:${request.requestId}`, message(error));
      return undefined;
    }
  }

  private patch(id: string, change: Partial<Extract<Item, { kind: "message" }>>): void {
    this.write(this.read().map(item => (item.id === id && item.kind === "message" ? { ...item, ...change } : item)));
  }

  fail(id: string, error: string): void {
    this.patch(id, { send: "failed", sendError: error });
  }

  /**
   * Sends a failed message again: from the request the page still holds, or through the server after a reload or once it is a stored
   * DM post, by its requestId.
   */
  async retry(id: string): Promise<SendResult | undefined> {
    const item = this.read().find(i => i.id === id);
    const requestId = (item?.kind === "message" && item.requestId) || id.slice(2);
    this.patch(id, { send: "sending", sendError: undefined });
    const request = this.requests.get(requestId);
    try {
      return request ? await post(this.conversation, request) : await api.retrySend(this.conversation, requestId);
    } catch (error) {
      this.fail(id, message(error));
      return undefined;
    }
  }

  discard(id: string): void {
    this.merge([], [id]);
    void api.discardSend(this.conversation, id.slice(2)).catch(() => undefined);
  }
}

/** Replaces the summary with the same id in place, or puts a new one first, so the newest stays on top. */
const upsert = (list: AgentSummary[], next: AgentSummary): AgentSummary[] =>
  list.some(a => a.id === next.id) ? list.map(a => (a.id === next.id ? next : a)) : [next, ...list];

/** The list with `item` swapped for a copy that has `status`, or the same list when there is no change. */
const withStatus = <T extends { status: RunStatus }>(list: T[], item: T | undefined, status: RunStatus): T[] =>
  item && item.status !== status ? list.map(x => (x === item ? { ...x, status } : x)) : list;

const indexBy = <T extends { id: string }>(list: readonly T[]): Map<string, T> => new Map(list.map(item => [item.id, item]));

/**
 * The hello snapshot and its live updates. The lists are raw state, replaced whole on each change: on 11-03 the hello held 349 jobs and
 * 485 conversations (363 KB), and deep proxies over them made each message row's job and agent lookups cost up to 1.1 s of a thread open.
 */
class Global {
  me = $state<Me | null>(null);
  sidebar = $state.raw<Sidebar | null>(null);
  agents = $state.raw<AgentSummary[]>([]);
  jobs = $state.raw<AgentSummary[]>([]);
  conversations = $state.raw<ConversationSummary[]>([]);
  readonly agentsById = $derived(indexBy(this.agents));
  readonly jobsById = $derived(indexBy(this.jobs));
  readonly conversationsById = $derived(indexBy(this.conversations));
  readonly jobsByAgent = $derived.by(() => {
    const out = new Map<string, AgentSummary[]>();
    for (const job of this.jobs) {
      const agent = job.agent?.id;
      if (!agent) continue;
      const list = out.get(agent);
      if (list) list.push(job);
      else out.set(agent, [job]);
    }
    return out;
  });
  forYouCount = $state(0);
  ready = $state(false);
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    live.on(event => {
      switch (event.type) {
        case "hello":
          this.me = event.me;
          document.body.dataset.wiki = event.me.wikiBase;
          this.sidebar = event.sidebar;
          this.agents = event.agents;
          this.jobs = event.jobs;
          this.conversations = event.conversations;
          this.forYouCount = event.sidebar.forYou;
          this.ready = true;
          break;
        case "sidebar":
          this.sidebar = event.sidebar;
          this.forYouCount = event.sidebar.forYou;
          break;
        case "agent":
          this.agents = upsert(this.agents, event.agent);
          break;
        case "agent_removed":
          this.agents = this.agents.filter(a => a.id !== event.id);
          break;
        case "job":
          this.jobs = upsert(this.jobs, event.job);
          break;
        case "job_removed":
          this.jobs = this.jobs.filter(j => j.id !== event.id);
          break;
        case "conversation": {
          const next = event.conversation;
          this.conversations = this.conversationsById.has(next.id) ? this.conversations.map(c => (c.id === next.id ? next : c)) : [...this.conversations, next];
          break;
        }
        case "status": {
          const { conversation: id, status } = event;
          // A split agent's DM status counts its comm thread too, so only its work thread's own status moves the agent's.
          this.agents = withStatus(this.agents, this.agents.find(a => a.id === id || a.thread === id || (a.room === id && !a.comm?.length)), status);
          this.jobs = withStatus(this.jobs, this.jobsById.get(id), status);
          this.conversations = withStatus(this.conversations, this.conversationsById.get(id), status);
          break;
        }
        case "for_you":
          this.forYouCount = event.count;
          break;
        default:
          break;
      }
    });
  }
}

const global = new Global();

/** The owner, this box and whether the server runs in fixture mode. */
export const me = {
  get value() {
    global.start();
    return global.me;
  },
};

/** Solo threads, channels and DMs for the sidebar, live. */
export const sidebar = {
  get value() {
    global.start();
    return global.sidebar;
  },
  get ready() {
    global.start();
    return global.ready;
  },
};

/** Registered agents (`ag_<slug>`), newest first, live: the Agents cards and every agent picker. Archived ones come from `api.agents({ archived: true })`. */
export const agents = {
  get list() {
    global.start();
    return global.agents;
  },
  byId(id: AgentId): AgentSummary | undefined {
    global.start();
    return global.agentsById.get(id);
  },
  /**
   * The conversation that opens for an agent: its DM room, from its summary or, before the page has it, from its id. Any other id (a root
   * thread no agent owns, a job) opens as itself.
   */
  room(id: AgentId): ConversationId {
    global.start();
    return global.agentsById.get(id)?.room ?? roomOf(id);
  },
  get ready() {
    global.start();
    return global.ready;
  },
};

/** Each job that works for a registered agent, newest first, live. A job shows only inside its agent; archived ones come from `api.jobs({ archived: true })`. */
export const jobs = {
  get list() {
    global.start();
    return global.jobs;
  },
  byId(id: AgentId): AgentSummary | undefined {
    global.start();
    return global.jobsById.get(id);
  },
  /** The jobs of one registered agent, nested ones included. */
  of(agent: AgentId): readonly AgentSummary[] {
    global.start();
    return global.jobsByAgent.get(agent) ?? [];
  },
};

/** Every solo thread, DM, job and channel, live, for search, typeahead and headers. */
export const conversations = {
  get list() {
    global.start();
    return global.conversations;
  },
  byId(id: ConversationId): ConversationSummary | undefined {
    global.start();
    return global.conversationsById.get(id);
  },
};

/** Whether the live socket is open. */
export const connection = {
  get connected() {
    return live.connected;
  },
};

/**
 * The last page each thread showed, kept when its view closes so the next open shows it at once and reads it again behind, and the read
 * a thread pill click starts before the pane mounts. It keeps the newest 20 threads: a job page measured 434 KB on 11-03
 * (work/fast-thread/before.md), so 20 hold under 9 MB.
 */
class PageCache<Raw, Shown> {
  private readonly shown = new Map<string, Shown>();
  private readonly reads = new Map<string, { read: Promise<Raw>; at: number }>();

  constructor(private readonly keep: number) {}

  /** Starts the read now; the store that opens this thread next takes it instead of reading again. */
  prefetch(key: string, read: () => Promise<Raw>): void {
    const pending = read();
    pending.catch(() => undefined);
    this.reads.set(key, { read: pending, at: Date.now() });
  }

  /**
   * The prefetched read, or a new one. A prefetch counts for 2 s: the slowest click to pane mount measured 817 ms on 11-03
   * (work/fast-thread/before.md), and an older one may miss changes made since.
   */
  take(key: string, read: () => Promise<Raw>): Promise<Raw> {
    const prefetched = this.reads.get(key);
    this.reads.delete(key);
    return prefetched && Date.now() - prefetched.at < 2_000 ? prefetched.read : read();
  }

  last(key: string): Shown | undefined {
    return this.shown.get(key);
  }

  remember(key: string, value: Shown): void {
    this.shown.delete(key);
    this.shown.set(key, value);
    for (const oldest of this.shown.keys()) {
      if (this.shown.size <= this.keep) break;
      this.shown.delete(oldest);
    }
  }
}

type TimelineRead = { page: Awaited<ReturnType<typeof api.items>>; header: ConversationHeader };
type TimelineShown = { items: Item[]; older: string | undefined; header: ConversationHeader };
const readTimeline = async (id: ConversationId, around?: string): Promise<TimelineRead> => {
  const [page, header] = await Promise.all([api.items(id, around ? { around } : {}), api.header(id)]);
  return { page, header };
};
const timelinePages = new PageCache<TimelineRead, TimelineShown>(20);

type RepliesRead = Awaited<ReturnType<typeof api.replies>>;
type RepliesShown = { root: Item | null; items: Item[] };
const repliesPages = new PageCache<RepliesRead, RepliesShown>(20);
const repliesKey = (channel: ConversationId, root: string) => `${channel}\u0000${root}`;

/**
 * Starts reading a side thread on the click that opens it, so the read runs while the router, the side panel and the pane mount: a
 * channel post's replies with `channel`, else the job's or thread's newest page and header.
 */
export function prefetchThread(channel: ConversationId | null, key: string): void {
  if (channel) repliesPages.prefetch(repliesKey(channel, key), () => api.replies(channel, key));
  else timelinePages.prefetch(key, () => readTimeline(key));
}

/** One conversation's timeline: the newest page, older pages on demand, live upserts, status, send and Stop. Nothing streams. */
export class Timeline {
  /** Raw state: each change replaces the list, and a job page measured 434 KB on 11-03, too big to proxy deeply. */
  items = $state.raw<Item[]>([]);
  older = $state<string | undefined>(undefined);
  header = $state.raw<ConversationHeader | null>(null);
  status = $state<RunStatus>("idle");
  /** While the run waits for a working slot: its place in pi-pool's turn queue ("queued, 3 of 7"); null once it works. */
  queue = $state<TurnPlace | null>(null);
  loading = $state(true);
  loadingOlder = $state(false);
  error = $state<string | null>(null);
  /** With `around`: the item that holds the asked message, to scroll to. */
  focus = $state<string | undefined>(undefined);
  private stopWatch: (() => void) | undefined;
  private stopListen: (() => void) | undefined;
  readonly isChannel: boolean;
  readonly isRoom: boolean;
  private readonly sends: Sends;
  /** The newest delivery time seen per DM owner post, so a send answer that lands after a newer live update cannot roll it back. */
  private readonly deliveredAt = new Map<string, number>();

  constructor(readonly id: ConversationId, opts: { around?: string } = {}) {
    this.isChannel = id.startsWith("ch_");
    this.isRoom = isRoom(id);
    this.sends = new Sends(id, () => this.items, items => (this.items = items));
    this.stopListen = live.on(event => {
      if (event.type === "items" && event.conversation === id) this.upsert(event.items, event.removed);
      else if (event.type === "status" && event.conversation === id) this.status = event.status;
      else if (event.type === "queue" && event.conversation === id) this.queue = event.place;
      else if (event.type === "room" && event.room.id === id) void this.refreshHeader();
    });
    void this.load(opts.around);
  }

  private around: string | undefined;

  private async load(around?: string): Promise<void> {
    this.around = around;
    const last = around ? undefined : timelinePages.last(this.id);
    if (last) {
      this.header = last.header;
      this.status = last.header.summary.status;
      this.items = last.items;
      this.older = last.older;
      this.loading = false;
    }
    try {
      const { page, header } = around ? await readTimeline(this.id, around) : await timelinePages.take(this.id, () => readTimeline(this.id));
      this.header = header;
      this.status = header.summary.status;
      this.queue = header.queue ?? null;
      if (last) {
        const kept = new Set(page.items.map(item => item.id));
        const gone = new Set(last.items.map(item => item.id).filter(itemId => !kept.has(itemId)));
        this.items = this.items.filter(item => !gone.has(item.id));
      }
      this.upsert(page.items);
      this.older = page.older;
      this.focus = page.focus;
      this.stopWatch = live.watch(this.id, () => this.items.findLast(i => !isPending(i))?.id);
    } catch (error) {
      this.error = message(error);
    } finally {
      this.loading = false;
    }
  }

  /** Reads the header again, after a room's name, agenda, members or closed state changed. */
  async refreshHeader(): Promise<void> {
    try {
      this.header = await api.header(this.id);
    } catch (error) {
      this.error = message(error);
    }
  }

  /** Adds or replaces items by id and drops `removed`. A pending send drops when the real message it became lands. */
  upsert(incoming: Item[], removed: string[] = []): void {
    const shown = incoming.filter(item => !(this.isChannel && item.kind === "message" && item.threadRoot));
    this.sends.merge(this.isRoom ? shown.filter(item => this.newest(item)).map(roomPost) : shown, removed);
  }

  private newest(item: Item): boolean {
    const at = item.kind === "message" && item.author.id === "owner" ? item.deliveries[0]?.at : undefined;
    if (at === undefined) return true;
    if (at < (this.deliveredAt.get(item.id) ?? -Infinity)) return false;
    this.deliveredAt.set(item.id, at);
    return true;
  }

  async loadOlder(): Promise<void> {
    if (!this.older || this.loadingOlder) return;
    this.loadingOlder = true;
    try {
      const page = await api.items(this.id, { before: this.older });
      this.upsert(page.items);
      this.older = page.older;
    } catch (error) {
      this.error = message(error);
    } finally {
      this.loadingOlder = false;
    }
  }

  /**
   * Sends text and images; mentions route as agent messages. The message shows at once as sending and the call returns; the post runs
   * behind with retries, and a send that cannot reach the chat server stays on screen as failed, with Retry and Discard.
   */
  send(text: string, opts: SendOpts = {}): Promise<void> {
    const request: SendDraft = { text, requestId: crypto.randomUUID(), ...opts };
    void this.sends.send(request, !opts.threadRoot).then(result => this.sent(result, request));
    return Promise.resolve();
  }

  private sent(result: SendResult | undefined, request: SendDraft): void {
    if (!result) return;
    if (result.queue !== undefined) this.queue = result.queue;
    if (!request.threadRoot) this.upsert([result.item]);
  }

  /** Retry on a failed send. */
  retrySend(id: string): void {
    const request = this.sends.requests.get(id.slice(2));
    void this.sends.retry(id).then(result => this.sent(result, request ?? { text: "", requestId: id.slice(2) }));
  }

  /** Discard on a failed send. */
  discardSend(id: string): void {
    this.sends.discard(id);
  }

  stop(): Promise<unknown> {
    return api.abort(this.id);
  }

  markRead(): Promise<unknown> {
    const seq = this.items.findLast(i => i.kind === "message" && i.seq !== undefined);
    return api.read(this.id, seq?.kind === "message" ? seq.seq : undefined);
  }

  close(): void {
    this.stopWatch?.();
    this.stopListen?.();
    if (!this.around && this.header && !this.error) timelinePages.remember(this.id, { items: this.items.filter(item => !isPending(item)), older: this.older, header: this.header });
  }
}

export const timeline = (id: ConversationId, opts: { around?: string } = {}): Timeline => new Timeline(id, opts);

/** A channel thread (root post and replies), live. A reply shows at once as sending, as in the main timeline. */
export class Replies {
  root = $state.raw<Item | null>(null);
  items = $state.raw<Item[]>([]);
  loading = $state(true);
  error = $state<string | null>(null);
  private stopWatch: (() => void) | undefined;
  private stopListen: (() => void) | undefined;
  private readonly sends: Sends;

  constructor(readonly channel: ConversationId, readonly rootId: string) {
    this.sends = new Sends(channel, () => this.items, items => (this.items = items));
    this.stopListen = live.on(event => {
      if (event.type !== "items" || event.conversation !== channel) return;
      const root = event.items.find(item => item.id === rootId);
      if (root) this.root = root;
      this.sends.merge(event.items.filter(item => item.kind === "message" && item.threadRoot === rootId), event.removed ?? []);
    });
    this.stopWatch = live.watch(channel);
    const key = repliesKey(channel, rootId);
    const last = repliesPages.last(key);
    if (last) {
      this.root = last.root;
      this.items = last.items;
      this.loading = false;
    }
    void repliesPages.take(key, () => api.replies(channel, rootId)).then(page => {
      this.root = page.root;
      if (last) {
        const kept = new Set(page.items.map(item => item.id));
        this.items = this.items.filter(item => isPending(item) || kept.has(item.id) || !last.items.some(old => old.id === item.id));
      }
      this.sends.merge(page.items);
    }).catch(error => (this.error = message(error))).finally(() => (this.loading = false));
  }

  send(text: string, opts: { images?: Attached[]; mentions?: AgentId[] } = {}): Promise<void> {
    const request: SendDraft = { text, requestId: crypto.randomUUID(), threadRoot: this.rootId, ...opts };
    void this.sends.send(request).then(result => {
      if (result) this.sends.merge([result.item]);
    });
    return Promise.resolve();
  }

  retrySend(id: string): void {
    void this.sends.retry(id).then(result => {
      if (result) this.sends.merge([result.item]);
    });
  }

  discardSend(id: string): void {
    this.sends.discard(id);
  }

  close(): void {
    this.stopWatch?.();
    this.stopListen?.();
    if (!this.loading && !this.error) repliesPages.remember(repliesKey(this.channel, this.rootId), { root: this.root, items: this.items.filter(item => !isPending(item)) });
  }
}

export const replies = (channel: ConversationId, root: string): Replies => new Replies(channel, root);

/** One chat's board, live: the server sends the whole board on each change, so the store replaces it. */
export class BoardStore {
  /** Raw state, replaced whole on each change; a board measured 60 KB on 11-03. */
  view = $state.raw<BoardView | null>(null);
  loading = $state(true);
  error = $state<string | null>(null);
  private stopListen: () => void;

  constructor(readonly chatId: string) {
    this.stopListen = live.on(event => {
      if (event.type === "board" && event.chatId === chatId) this.view = { board: event.board, awaitingGo: event.awaitingGo };
      if (event.type === "hello") void this.refresh();
    });
    void this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      this.view = await api.board(this.chatId);
      this.error = null;
    } catch (error) {
      this.error = message(error);
    } finally {
      this.loading = false;
    }
  }

  async apply(ops: BoardOp[]): Promise<void> {
    this.view = await api.boardOps(this.chatId, ops);
  }

  close(): void {
    this.stopListen();
  }
}
export const boardStore = (chatId: string): BoardStore => new BoardStore(chatId);

/** How long For you waits for /api/for-you before it shows an error with Retry; with board reads cached it answered in 10 to 680 ms during searches on 10-28. */
export const FOR_YOU_DEADLINE_MS = 10_000;

class ForYouStore {
  items = $state<ForYouItem[]>([]);
  loading = $state(true);
  error = $state<string | null>(null);
  private started = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private latest = 0;

  start(): void {
    if (this.started) return;
    this.started = true;
    live.on(event => {
      if (event.type === "board" || event.type === "for_you" || event.type === "hello") {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.refresh(), 100);
      }
    });
    // The first read can come from a $derived, where refresh's write to `loading` would throw, so the first load starts after it.
    queueMicrotask(() => void this.refresh());
  }

  /** Only the newest call writes, so a slow answer never replaces a newer one or ends its loading. */
  async refresh(): Promise<void> {
    const mine = ++this.latest;
    if (!this.items.length) this.loading = true;
    const signal = AbortSignal.timeout(FOR_YOU_DEADLINE_MS);
    try {
      const items = (await api.forYou(signal)).items;
      if (mine !== this.latest) return;
      this.items = items;
      this.error = null;
    } catch (error) {
      if (mine !== this.latest) return;
      this.error = signal.aborted ? `For you did not answer in ${FOR_YOU_DEADLINE_MS / 1000} s.` : message(error);
    } finally {
      if (mine === this.latest) this.loading = false;
    }
  }
}
const forYouStore = new ForYouStore();

/** Every chat's todos, open and done, newest first, live. */
export const forYou = {
  get items() {
    forYouStore.start();
    return forYouStore.items;
  },
  get loading() {
    forYouStore.start();
    return forYouStore.loading;
  },
  get error() {
    return forYouStore.error;
  },
  refresh: () => forYouStore.refresh(),
  /** Open todos across every chat, from the sidebar count. */
  get count() {
    global.start();
    return global.forYouCount;
  },
};
