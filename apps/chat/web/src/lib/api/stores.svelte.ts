/**
 * Svelte 5 live stores over the one /api/live socket. Global stores (`me`, `sidebar`, `agents`, `conversations`, `forYou`) start on first
 * use; per-view stores (`timeline`, `replies`, `boardStore`, `jobsStore`) start with their factory call and stop with `close()`.
 * Every item update is an upsert by id, so streaming text replaces the item in place.
 */
import { api } from "./client.ts";
import { live } from "./live.svelte.ts";
import type {
  AgentId, AgentSummary, BoardOp, BoardView, ConversationHeader, ConversationId, ConversationSummary, ForYouItem, ImageUpload, Item, JobNode, LivePartial, Me,
  RunStatus, SendRequest, Sidebar, TurnPlace,
} from "./types.ts";

const byTime = (a: Item, b: Item) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

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

/** One conversation's timeline: the newest page, older pages on demand, live upserts, partial text, status, send and Stop. */
export class Timeline {
  items = $state<Item[]>([]);
  older = $state<string | undefined>(undefined);
  header = $state<ConversationHeader | null>(null);
  partial = $state<LivePartial | null>(null);
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

  constructor(readonly id: ConversationId, opts: { around?: string } = {}) {
    this.isChannel = id.startsWith("ch_");
    this.stopListen = live.on(event => {
      if (event.type === "items" && event.conversation === id) this.upsert(event.items);
      else if (event.type === "partial" && event.conversation === id) this.partial = event.partial;
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
      this.partial = header.partial ?? null;
      this.queue = header.queue ?? null;
      this.upsert(page.items);
      this.older = page.older;
      this.focus = page.focus;
      this.stopWatch = live.watch(this.id, () => this.items.findLast(i => !i.id.startsWith("r:"))?.id);
    } catch (error) {
      this.error = message(error);
    } finally {
      this.loading = false;
    }
  }

  /** Adds or replaces items by id. A pending send drops when the real message with its text lands. */
  upsert(incoming: Item[]): void {
    const next = [...this.items];
    for (const item of incoming) {
      if (this.isChannel && item.kind === "message" && item.threadRoot) continue;
      if (item.kind === "message" && item.author.id === "owner" && !item.id.startsWith("r:")) {
        const pending = next.findIndex(i => i.id.startsWith("r:") && i.kind === "message" && i.text === item.text);
        if (pending >= 0) next.splice(pending, 1);
      }
      const index = next.findIndex(i => i.id === item.id);
      if (index >= 0) next[index] = item;
      else next.push(item);
    }
    this.items = next.sort(byTime);
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

  /** Sends text and images; mentions route as agent messages. The item shows at once as pending. */
  async send(text: string, opts: { images?: ImageUpload[]; mentions?: AgentId[]; threadRoot?: string; whenBusy?: "steer" | "followUp" } = {}): Promise<void> {
    const request: SendRequest = { text, requestId: crypto.randomUUID(), ...opts };
    const optimistic: Item = {
      kind: "message", id: `r:${request.requestId}`, at: Date.now(), author: global.me?.owner ?? { id: "owner", kind: "owner", name: "You", avatar: { initials: "Me", hue: 210 } },
      text, images: [], mentions: opts.mentions ?? [], deliveries: [], pending: true,
    };
    if (!opts.threadRoot) this.upsert([optimistic]);
    try {
      const result = await api.send(this.id, request);
      if (result.queue !== undefined) this.queue = result.queue;
      if (this.isChannel) this.upsert(opts.threadRoot ? [] : [result.item]);
      if (this.isChannel) this.items = this.items.filter(i => i.id !== optimistic.id);
    } catch (error) {
      this.items = this.items.filter(i => i.id !== optimistic.id);
      this.error = message(error);
      throw error;
    }
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

/** A channel thread (root post and replies), live. */
export class Replies {
  root = $state<Item | null>(null);
  items = $state<Item[]>([]);
  loading = $state(true);
  error = $state<string | null>(null);
  private stopWatch: (() => void) | undefined;
  private stopListen: (() => void) | undefined;

  constructor(readonly channel: ConversationId, readonly rootId: string) {
    this.stopListen = live.on(event => {
      if (event.type !== "items" || event.conversation !== channel) return;
      for (const item of event.items) {
        if (item.id === rootId) this.root = item;
        else if (item.kind === "message" && item.threadRoot === rootId) {
          const index = this.items.findIndex(i => i.id === item.id);
          if (index >= 0) this.items[index] = item;
          else this.items = [...this.items, item].sort(byTime);
        }
      }
    });
    this.stopWatch = live.watch(channel);
    void api.replies(channel, rootId).then(page => {
      this.root = page.root;
      this.items = page.items;
    }).catch(error => (this.error = message(error))).finally(() => (this.loading = false));
  }

  send(text: string, opts: { images?: ImageUpload[]; mentions?: AgentId[] } = {}): Promise<unknown> {
    return api.send(this.channel, { text, requestId: crypto.randomUUID(), threadRoot: this.rootId, ...opts });
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
