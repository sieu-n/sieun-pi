/**
 * Svelte 5 live stores over the one /api/live socket. Global stores (`me`, `sidebar`, `agents`, `conversations`, `forYou`) start on first
 * use; per-view stores (`timeline`, `replies`, `boardStore`, `jobsStore`) start with their factory call and stop with `close()`.
 * Every item update is an upsert by id, so a turn's new entries replace the item in place.
 * A send shows at once as the owner's message `r:<requestId>` (sending, then sent), as in Slack, and the real message replaces it when it
 * lands; nothing waits on the network before the composer takes the next message.
 */
import { api, ApiError } from "./client.ts";
import { live } from "./live.svelte.ts";
import type {
  AgentId, AgentSummary, BoardOp, BoardView, ConversationHeader, ConversationId, ConversationSummary, ForYouItem, ImageUpload, Item, JobNode, Me,
  RunStatus, SendRequest, SendResult, Sidebar, TurnPlace,
} from "./types.ts";

const byTime = (a: Item, b: Item) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

type SendOpts = { images?: ImageUpload[]; mentions?: AgentId[]; threadRoot?: string; whenBusy?: "steer" | "followUp" };
/** Tries after the first when the chat server cannot be reached, each with the same requestId, so a send lands once. */
const SEND_RETRIES = 3;
/** A real owner message replaces a pending send with its text only if it is no older than this before it, so history never does. */
const LAND_SLACK_MS = 60_000;
const isPending = (item: Item): boolean => item.id.startsWith("r:");
const sameText = (a: string, b: string): boolean => a.trim() === b.trim();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function optimistic(request: SendRequest): Item {
  return {
    kind: "message", id: `r:${request.requestId}`, at: Date.now(), author: global.me?.owner ?? { id: "owner", kind: "owner", name: "You", avatar: { initials: "Me", hue: 210 } },
    text: request.text, images: (request.images ?? []).map(image => ({ url: `data:${image.mimeType};base64,${image.data}`, mimeType: image.mimeType })),
    mentions: request.mentions ?? [], deliveries: [], pending: true, send: "sending", requestId: request.requestId,
    ...(request.threadRoot ? { threadRoot: request.threadRoot } : {}),
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

/** Posts a send, trying again with the same requestId while the chat server cannot be reached; a refused send throws at once. */
async function post(conversation: ConversationId, request: SendRequest): Promise<SendResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api.send(conversation, request);
    } catch (error) {
      const unreachable = !(error instanceof ApiError) || error.status >= 500;
      if (!unreachable || attempt >= SEND_RETRIES) throw error;
      await sleep(400 * 2 ** attempt);
    }
  }
}

/** The optimistic side of sending, shared by a timeline and a channel thread: requests by id, landed ids, and failure marks. */
class Sends {
  readonly requests = new Map<string, SendRequest>();
  readonly landed = new Set<string>();

  constructor(private readonly conversation: ConversationId, private readonly read: () => Item[], private readonly write: (items: Item[]) => void) {}

  merge(incoming: readonly Item[], removed: readonly string[] = []): void {
    this.write(merge(this.read(), incoming, this.landed, removed));
    for (const id of this.landed) this.requests.delete(id.slice(2));
  }

  /** Shows the send at once and posts it behind; the promise settles when the chat server has it or it failed. */
  async send(request: SendRequest, show = true): Promise<SendResult | undefined> {
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

  /** Sends a failed message again: from the request the page still holds, or through the server's outbox after a reload. */
  async retry(id: string): Promise<SendResult | undefined> {
    const requestId = id.slice(2);
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

class Global {
  me = $state<Me | null>(null);
  sidebar = $state<Sidebar | null>(null);
  agents = $state<AgentSummary[]>([]);
  conversations = $state<ConversationSummary[]>([]);
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
          this.sidebar = event.sidebar;
          this.agents = event.agents;
          this.conversations = event.conversations;
          this.forYouCount = event.sidebar.forYou;
          this.ready = true;
          break;
        case "sidebar":
          this.sidebar = event.sidebar;
          this.forYouCount = event.sidebar.forYou;
          break;
        case "agent": {
          const index = this.agents.findIndex(a => a.id === event.agent.id);
          if (index >= 0) this.agents[index] = event.agent;
          else this.agents = [event.agent, ...this.agents];
          break;
        }
        case "agent_removed":
          this.agents = this.agents.filter(a => a.id !== event.id);
          break;
        case "conversation": {
          const index = this.conversations.findIndex(c => c.id === event.conversation.id);
          if (index >= 0) this.conversations[index] = event.conversation;
          else this.conversations = [...this.conversations, event.conversation];
          break;
        }
        case "status": {
          const agent = this.agents.find(a => a.id === event.conversation);
          if (agent) agent.status = event.status;
          const conversation = this.conversations.find(c => c.id === event.conversation);
          if (conversation) conversation.status = event.status;
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

/** Every chat and job as an Agents card, newest first, live. Archived ones come from `api.agents({ archived: true })`. */
export const agents = {
  get list() {
    global.start();
    return global.agents;
  },
  byId(id: AgentId): AgentSummary | undefined {
    global.start();
    return global.agents.find(a => a.id === id);
  },
  get ready() {
    global.start();
    return global.ready;
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
    return global.conversations.find(c => c.id === id);
  },
};

/** Whether the live socket is open. */
export const connection = {
  get connected() {
    return live.connected;
  },
};

/** One conversation's timeline: the newest page, older pages on demand, live upserts, status, send and Stop. Nothing streams. */
export class Timeline {
  items = $state<Item[]>([]);
  older = $state<string | undefined>(undefined);
  header = $state<ConversationHeader | null>(null);
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
  private readonly sends: Sends;

  constructor(readonly id: ConversationId, opts: { around?: string } = {}) {
    this.isChannel = id.startsWith("ch_");
    this.sends = new Sends(id, () => this.items, items => (this.items = items));
    this.stopListen = live.on(event => {
      if (event.type === "items" && event.conversation === id) this.upsert(event.items, event.removed);
      else if (event.type === "status" && event.conversation === id) this.status = event.status;
      else if (event.type === "queue" && event.conversation === id) this.queue = event.place;
    });
    void this.load(opts.around);
  }

  private async load(around?: string): Promise<void> {
    try {
      const [page, header] = await Promise.all([api.items(this.id, around ? { around } : {}), api.header(this.id)]);
      this.header = header;
      this.status = header.summary.status;
      this.queue = header.queue ?? null;
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

  /** Adds or replaces items by id and drops `removed`. A pending send drops when the real message it became lands. */
  upsert(incoming: Item[], removed: string[] = []): void {
    this.sends.merge(incoming.filter(item => !(this.isChannel && item.kind === "message" && item.threadRoot)), removed);
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
    const request: SendRequest = { text, requestId: crypto.randomUUID(), ...opts };
    void this.sends.send(request, !opts.threadRoot).then(result => this.sent(result, request));
    return Promise.resolve();
  }

  private sent(result: SendResult | undefined, request: SendRequest): void {
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
  }
}

export const timeline = (id: ConversationId, opts: { around?: string } = {}): Timeline => new Timeline(id, opts);

/** A channel thread (root post and replies), live. A reply shows at once as sending, as in the main timeline. */
export class Replies {
  root = $state<Item | null>(null);
  items = $state<Item[]>([]);
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
    void api.replies(channel, rootId).then(page => {
      this.root = page.root;
      this.sends.merge(page.items);
    }).catch(error => (this.error = message(error))).finally(() => (this.loading = false));
  }

  send(text: string, opts: { images?: ImageUpload[]; mentions?: AgentId[] } = {}): Promise<void> {
    const request: SendRequest = { text, requestId: crypto.randomUUID(), threadRoot: this.rootId, ...opts };
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
  }
}

export const replies = (channel: ConversationId, root: string): Replies => new Replies(channel, root);

/** A thread's job tree, live. */
export class JobsStore {
  jobs = $state<JobNode[]>([]);
  private stopListen: () => void;
  constructor(readonly thread: string) {
    this.stopListen = live.on(event => {
      if (event.type === "jobs" && event.thread === thread) this.jobs = event.jobs;
    });
    void api.jobs(thread).then(jobs => (this.jobs = jobs)).catch(() => undefined);
  }
  close(): void {
    this.stopListen();
  }
}
export const jobsStore = (thread: string): JobsStore => new JobsStore(thread);

/** One chat's board, live: the server sends the whole board on each change, so the store replaces it. */
export class BoardStore {
  view = $state<BoardView | null>(null);
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
    void this.refresh();
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
