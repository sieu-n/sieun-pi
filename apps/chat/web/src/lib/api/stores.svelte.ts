/**
 * Svelte 5 live stores over the one /api/live socket. Global stores (`me`, `sidebar`, `agents`, `jobs`, `conversations`, `forYou`) start on
 * first use; per-view stores (`timeline`, `replies`, `boardStore`) start with their factory call and stop with `close()`.
 * Every item update is an upsert by id, so a turn's new entries replace the item in place.
 * A send shows at once as the owner's message `r:<requestId>` (sending, then sent), as in Slack, and the real message replaces it when it
 * lands; nothing waits on the network before the composer takes the next message. An attached image shows from its preview while its
 * upload ends, and the post names the uploaded ref.
 */
import { api, ApiError, attach, reads, reportNotDelivered, roomOf, type Attached, type Read, type Wait } from "./client.ts";
import { kept, type Kept } from "./kept.svelte.ts";
import { heldImages } from "./held-images.ts";
import { heldSends, type HeldSend } from "./held-sends.ts";
import { holdReload, releaseReload } from "./reload.ts";
import { live } from "./live.svelte.ts";
import type {
  AgentId, AgentSummary, BoardOp, BoardView, ConversationHeader, ConversationId, ConversationSummary, ForYouItem, ImageRef, Item, Me,
  RunStatus, SendRequest, SendResult, Sidebar, TurnPlace,
} from "./types.ts";

const byTime = (a: Item, b: Item) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

type SendOpts = { images?: Attached[]; mentions?: AgentId[]; threadRoot?: string; whenBusy?: "steer" | "followUp" };
/** A send as the page holds it: a `SendRequest` whose images may still be uploading. */
type SendDraft = Omit<SendRequest, "images"> & { images?: Attached[] };
/**
 * Tries after the first when the chat server cannot be reached, each with the same requestId, so a send lands once. The waits double from
 * 400 ms, so 5 tries wait 12.4 s in all. A release restart leaves :5184 closed from its stop until the new server listens, which took 1.3 to
 * 3.0 s over the 14 restarts on 11-03 and 11-04 (journal: Started to "apps/chat on"), longer than the 2.8 s that 3 tries waited.
 */
const SEND_RETRIES = 5;
/** A real owner message replaces a pending send with its text only if it is no older than this before it, so history never does. */
const LAND_SLACK_MS = 60_000;
const isPending = (item: Item): boolean => item.id.startsWith("r:");
/** A DM room (`dm_<slug>`): its items are stored posts, and an owner post's delivery to the agent's work thread is its send line. */
const isRoom = (id: ConversationId): boolean => id.startsWith("dm_");
const sameText = (a: string, b: string): boolean => a.trim() === b.trim();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A send as its own message until the real one lands: sending, or Not delivered with `failed`, as a kept send shows after a reload. */
function optimistic(request: SendDraft, failed?: { at: number; error: string }): Item {
  return {
    kind: "message", id: `r:${request.requestId}`, at: failed?.at ?? Date.now(), author: global.me?.owner ?? { id: "owner", kind: "owner", name: "You", avatar: { initials: "Me", hue: 210 } },
    text: request.text, images: (request.images ?? []).filter(image => image.preview).map(image => ({ url: image.preview, mimeType: image.mimeType })),
    mentions: request.mentions ?? [], deliveries: [], pending: true, requestId: request.requestId,
    ...(failed ? { send: "failed" as const, sendError: failed.error } : { send: "sending" as const }),
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
 * The preview of each image of a send that landed from this page, by the url the server gave it. The landed message draws the bytes the
 * page already holds, where on 11-19 the owner's page fetched the 1.76 MB PNG it had just uploaded back from the box to draw it.
 */
const previews = new Map<string, string>();
const withPreviews = (item: Item): Item =>
  item.kind === "message" && item.images.some(image => previews.has(image.url))
    ? { ...item, images: item.images.map(image => ({ ...image, url: previews.get(image.url) ?? image.url })) }
    : item;

/**
 * Upserts items by id, oldest first. A pending send never steps back from sent to sending and never comes back once it landed, and the
 * owner's real message (a post with its requestId, or an input with its text) replaces the pending send it came from. An image of that
 * send keeps showing from the preview (`previews`).
 */
function merge(items: readonly Item[], incoming: readonly Item[], landed: Set<string>, removed: readonly string[] = []): Item[] {
  for (const id of removed) landed.add(id);
  const next = items.filter(item => !removed.includes(item.id));
  for (const arrived of incoming) {
    let item = withPreviews(arrived);
    const index = next.findIndex(i => i.id === item.id);
    const old = index >= 0 ? next[index] : undefined;
    if (isPending(item)) {
      if (landed.has(item.id)) continue;
      if (old?.kind === "message" && item.kind === "message" && old.send === "sent" && item.send === "sending") continue;
      if (old?.kind === "message" && item.kind === "message" && old.images.length === item.images.length) item = { ...item, images: old.images };
    } else if (item.kind === "message" && item.author.id === "owner") {
      const real = item;
      const pending = next.findIndex(i => i.kind === "message" && isPending(i) &&
        (real.requestId ? i.id === `r:${real.requestId}` : sameText(i.text, real.text) && real.at >= i.at - LAND_SLACK_MS));
      if (pending >= 0) {
        const sent = next[pending]!;
        if (sent.kind === "message" && sent.images.length === real.images.length) {
          for (const [i, image] of real.images.entries()) if (sent.images[i]!.url.startsWith("blob:")) previews.set(image.url, sent.images[i]!.url);
          item = withPreviews(real);
        }
        landed.add(sent.id);
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
 * Runs the sends of one conversation one after the other, in the order of his Enters, so a text sent while the image send before it still
 * uploads reaches the server after it. A send that failed does not hold the next.
 */
const tails = new Map<ConversationId, Promise<unknown>>();
function inOrder<T>(conversation: ConversationId, run: () => Promise<T>): Promise<T> {
  const result = (tails.get(conversation) ?? Promise.resolve()).then(run);
  const tail = result.catch(() => undefined);
  tails.set(conversation, tail);
  void tail.then(() => {
    if (tails.get(conversation) === tail) tails.delete(conversation);
  });
  return result;
}

/**
 * Posts a send once its images are uploaded, trying again with the same requestId while the chat server cannot be reached; a refused send
 * throws at once. The send is kept in localStorage (held-sends.ts) until it lands, so a reload cannot lose it: with its images' refs once
 * they are uploaded, and before that as `Sends.send` kept it, with their bytes.
 */
async function post(conversation: ConversationId, draft: SendDraft, wait?: Wait): Promise<SendResult> {
  let kept = heldSends.hasRefs(draft.requestId);
  for (let attempt = 0; ; attempt++) {
    try {
      const images = await Promise.all((draft.images ?? []).map(image => image.ref()));
      if (!kept) {
        const { images: _files, ...rest } = draft;
        heldSends.keep({ ...rest, conversation, images, at: Date.now() });
        void heldImages.drop(draft.requestId);
      }
      kept = true;
      return await api.send(conversation, { ...draft, images }, wait);
    } catch (error) {
      const unreachable = !(error instanceof ApiError) || error.status >= 500;
      if (!unreachable || attempt >= SEND_RETRIES) throw error;
      await sleep(400 * 2 ** attempt);
    }
  }
}

/**
 * An image of a kept send whose upload had not ended (`HeldSend.uploading`): its bytes come back from held-images.ts and upload again when
 * the send asks for the ref. Bytes that did not reach IndexedDB before the page went fail the send at once, so it shows Not delivered with
 * the reason and never goes out without its image.
 */
function heldImage(files: Promise<Blob[] | undefined>, index: number): Attached {
  let again: Promise<Attached> | undefined;
  const ref = (): Promise<ImageRef> => (again ??= files.then(list => {
    const file = list?.[index];
    if (!file) throw new ApiError(400, "Its image was not kept before the page reloaded");
    return attach(file);
  })).then(image => image.ref());
  return { preview: "", mimeType: "image/png", file: new Blob(), ref };
}

/** A kept send as the page holds it again: its images already uploaded, or their bytes read back from `files`. */
const draftOf = (held: HeldSend, files: Promise<Blob[] | undefined>): SendDraft => ({
  text: held.text, requestId: held.requestId,
  images: held.uploading
    ? Array.from({ length: held.uploading }, (_, index) => heldImage(files, index))
    : held.images.map(ref => ({ preview: ref.url, mimeType: ref.mimeType, file: new Blob(), ref: () => Promise.resolve(ref) })),
  ...(held.mentions ? { mentions: held.mentions } : {}), ...(held.threadRoot ? { threadRoot: held.threadRoot } : {}),
  ...(held.whenBusy ? { whenBusy: held.whenBusy } : {}),
});

/**
 * The first message of a chat made a moment ago, by its room: the room's timeline sends it as it opens, through the same path as any
 * other send, and its wait counts from `since`, the Enter that also made the chat.
 */
const firstSends = new Map<ConversationId, { text: string; opts: SendOpts; since: number }>();
export function sendFirst(room: ConversationId, text: string, opts: SendOpts, since: number): void {
  firstSends.set(room, { text, opts, since });
}

/** The requestIds a live view shows, so a second view of the same conversation does not show or send them again. */
const shownSends = new Set<string>();

/**
 * The optimistic side of sending, shared by a timeline and a channel thread: requests by id, landed ids, and failure marks. Each send holds
 * the page's reload after a release (reload.ts) while it is on its way.
 */
class Sends {
  readonly requests = new Map<string, SendDraft>();
  readonly landed = new Set<string>();
  private readonly flying = new Set<string>();
  private closed = false;

  constructor(
    private readonly conversation: ConversationId, private readonly read: () => Item[], private readonly write: (items: Item[]) => void,
    private readonly threadRoot?: string,
  ) {}

  /**
   * Shows the sends an earlier page or a closed view of this conversation kept and no live view shows: Not delivered ones with Retry, and
   * the ones that were on their way are returned, for the view to send again.
   */
  restore(): string[] {
    const resend: string[] = [];
    for (const held of heldSends.of(this.conversation, this.threadRoot)) {
      if (shownSends.has(held.requestId)) continue;
      shownSends.add(held.requestId);
      const files = held.uploading ? heldImages.get(held.requestId) : Promise.resolve(undefined);
      const draft = draftOf(held, files);
      this.requests.set(held.requestId, draft);
      this.merge([optimistic(draft, { at: held.at, error: held.error ?? "Not sent before the page reloaded" })]);
      void files.then(list => {
        if (list) this.patch(`r:${held.requestId}`, { images: list.map(file => ({ url: URL.createObjectURL(file), mimeType: file.type || "image/png" })) });
      });
      if (held.error === undefined) resend.push(`r:${held.requestId}`);
    }
    return resend;
  }

  merge(incoming: readonly Item[], removed: readonly string[] = []): void {
    this.write(merge(this.read(), incoming, this.landed, removed));
    for (const id of this.landed) {
      const requestId = id.slice(2);
      if (this.requests.delete(requestId)) this.settle(requestId);
    }
  }

  /**
   * Shows the send at once and posts it behind, after the sends before it (`inOrder`); the promise settles when the chat server has it or
   * it failed. A send with images is kept at once with their bytes, so a reload while they upload sends it again. Every send's timing
   * line counts from `since`, his Enter, to the painted bubble (`Wait.shownMs`).
   */
  async send(request: SendDraft, show = true, since = performance.now()): Promise<SendResult | undefined> {
    this.requests.set(request.requestId, request);
    shownSends.add(request.requestId);
    const files = request.images ?? [];
    const wait: Wait = { since };
    if (show) this.merge([optimistic(request)]);
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(() => (wait.shownMs = performance.now() - since)));
    if (files.length) {
      const { images: _files, ...rest } = request;
      heldSends.keep({ ...rest, conversation: this.conversation, images: [], uploading: files.length, at: Date.now() });
      void heldImages.put(request.requestId, files.map(image => image.file));
    }
    return this.fly(request.requestId, () => inOrder(this.conversation, () => post(this.conversation, request, wait)), `r:${request.requestId}`);
  }

  private async fly(requestId: string, call: () => Promise<SendResult>, id: string): Promise<SendResult | undefined> {
    this.flying.add(requestId);
    holdReload(`send:${requestId}`);
    try {
      const result = await call();
      this.settle(requestId);
      return result;
    } catch (error) {
      this.fail(id, requestId, error);
      return undefined;
    } finally {
      this.flying.delete(requestId);
      if (this.closed) shownSends.delete(requestId);
      if (heldSends.has(requestId) || !this.requests.has(requestId) || this.closed) releaseReload(`send:${requestId}`);
    }
  }

  /** The send landed or was discarded: nothing keeps it any more. */
  private settle(requestId: string): void {
    if (heldSends.has(requestId)) void heldImages.drop(requestId);
    heldSends.drop(requestId);
    releaseReload(`send:${requestId}`);
  }

  private patch(id: string, change: Partial<Extract<Item, { kind: "message" }>>): void {
    this.write(this.read().map(item => (item.id === id && item.kind === "message" ? { ...item, ...change } : item)));
  }

  /** Marks the send Not delivered, keeps the error with the kept send, and tells the server's log why (`reportNotDelivered`). */
  private fail(id: string, requestId: string, error: unknown): void {
    this.patch(id, { send: "failed", sendError: message(error) });
    heldSends.fail(requestId, message(error));
    reportNotDelivered(this.conversation, error instanceof ApiError ? error.status : 0, message(error));
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
    return this.fly(requestId, () => inOrder(this.conversation, () => (request ? post(this.conversation, request) : api.retrySend(this.conversation, requestId))), id);
  }

  discard(id: string): void {
    const requestId = id.slice(2);
    this.requests.delete(requestId);
    this.settle(requestId);
    shownSends.delete(requestId);
    this.merge([], [id]);
    void api.discardSend(this.conversation, requestId).catch(() => undefined);
  }

  /**
   * The view closed: its kept sends show in the next view that opens, and a send on its way still lands or fails here. A failed send that
   * was never kept is gone from the screen with the view, so it no longer holds the reload.
   */
  close(): void {
    this.closed = true;
    for (const requestId of this.requests.keys()) {
      if (this.flying.has(requestId)) continue;
      shownSends.delete(requestId);
      releaseReload(`send:${requestId}`);
    }
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
          roomsAhead(event.sidebar);
          for (const queue of panelQueues.values()) queue.again();
          boardsAhead(this.agents);
          break;
        case "sidebar":
          this.sidebar = event.sidebar;
          this.forYouCount = event.sidebar.forYou;
          roomsAhead(event.sidebar);
          break;
        case "agent":
          this.agents = upsert(this.agents, event.agent);
          boardsAhead(this.agents);
          break;
        case "agent_removed":
          this.agents = this.agents.filter(a => a.id !== event.id);
          boardsAhead(this.agents);
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
          boardsAhead(this.agents);
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
 * a thread pill click starts before the pane mounts. `warm` fills it before the first open: on 11-19 the owner, 197 ms from the box,
 * waited 403 to 455 ms for a room's first page and 648 ms for a thread's replies, each time with nothing on the screen. It keeps the
 * newest `keep` pages: a job page measured 434 KB on 11-03 (work/fast-thread/before.md), so the 40 timelines hold under 18 MB.
 */
class PageCache<Raw, Shown> {
  private readonly shown = new Map<string, Shown>();
  private readonly reads = new Map<string, { read: Promise<Raw>; at: number; wait?: Wait }>();
  private readonly views = new Map<string, number>();

  constructor(readonly keep: number) {}

  /** Starts the read now; the store that opens this thread next takes it instead of reading again. */
  prefetch(key: string, read: () => Promise<Raw>): void {
    const pending = read();
    pending.catch(() => undefined);
    this.reads.set(key, { read: pending, at: Date.now() });
  }

  /**
   * Reads a page nobody has opened yet and keeps it as the page to show, unless a view of it is open or a read of it is on its way.
   * Its calls are logged as ahead of any view, until a view takes the read while it runs and so waits on it.
   */
  warm(key: string, read: (wait: Wait) => Promise<Raw>, show: (raw: Raw) => Shown): Promise<void> {
    if (this.views.has(key) || this.reads.has(key)) return Promise.resolve();
    const wait: Wait = { background: "ahead" };
    const entry = { read: read(wait), at: Date.now(), wait };
    this.reads.set(key, entry);
    return entry.read.then(raw => {
      if (wait.background && !this.views.has(key)) this.remember(key, show(raw));
    }, () => undefined).finally(() => {
      if (this.reads.get(key) === entry) this.reads.delete(key);
    });
  }

  /**
   * The prefetched or warming read, or a new one. A read counts for 2 s: the slowest click to pane mount measured 817 ms on 11-03
   * (work/fast-thread/before.md), and an older one may miss changes made since.
   */
  take(key: string, read: () => Promise<Raw>): Promise<Raw> {
    const prefetched = this.reads.get(key);
    this.reads.delete(key);
    if (!prefetched || Date.now() - prefetched.at >= 2_000) return read();
    if (prefetched.wait) prefetched.wait.background = undefined;
    return prefetched.read;
  }

  last(key: string): Shown | undefined {
    return this.shown.get(key);
  }

  has(key: string): boolean {
    return this.shown.has(key) || this.reads.has(key);
  }

  /** A view of the page opened; while it is open the view keeps the page current, so `warm` leaves it alone. */
  open(key: string): void {
    this.views.set(key, (this.views.get(key) ?? 0) + 1);
  }

  /** The view closed and leaves the page it showed. */
  close(key: string, value?: Shown): void {
    const left = (this.views.get(key) ?? 1) - 1;
    if (left > 0) this.views.set(key, left);
    else this.views.delete(key);
    if (value !== undefined) this.remember(key, value);
  }

  viewing(key: string): boolean {
    return this.views.has(key);
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
/** `limit` is set on a short page read ahead (`JOB_PAGE`), so its open refreshes it at that size. */
type TimelineShown = { items: Item[]; older: string | undefined; header: ConversationHeader; limit?: number };
const readTimeline = async (id: ConversationId, around?: string, wait?: Wait, limit?: number): Promise<TimelineRead> => {
  const [page, header] = await Promise.all([api.items(id, around ? { around } : limit ? { limit } : {}, wait), api.header(id, wait)]);
  return { page, header };
};
/** How many sidebar rooms and how many job pills of the open timeline are read ahead; the cache keeps both sets. */
const ROOMS_AHEAD = 20;
const JOBS_AHEAD = 20;
const timelinePages = new PageCache<TimelineRead, TimelineShown>(ROOMS_AHEAD + JOBS_AHEAD);

/** A page's items as a timeline of `id` shows them: a channel without its thread replies, a DM's owner posts with their send line. */
/** Whether `fresh` holds an item the screen's `shown` lacks or shows differently, so the owner waited for the read that brought it. */
const brought = (shown: readonly Item[], fresh: readonly Item[]): boolean => {
  const old = new Map(shown.map(item => [item.id, item]));
  return fresh.some(item => JSON.stringify(old.get(item.id)) !== JSON.stringify(item));
};

const shownItems = (id: ConversationId, items: readonly Item[]): Item[] => {
  const visible = id.startsWith("ch_") ? items.filter(item => !(item.kind === "message" && item.threadRoot)) : items;
  return merge([], isRoom(id) ? visible.map(roomPost) : visible, new Set());
};

type RepliesRead = Awaited<ReturnType<typeof api.replies>>;
type RepliesShown = { root: Item | null; items: Item[] };
const repliesPages = new PageCache<RepliesRead, RepliesShown>(20);
const repliesKey = (channel: ConversationId, root: string) => `${channel}\u0000${root}`;

/**
 * Starts reading a side thread on the click that opens it, so the read runs while the router, the side panel and the pane mount: a
 * channel post's replies with `channel`, else the job's or thread's newest page and header.
 */
export function prefetchThread(channel: ConversationId | null, key: string): void {
  if (channel) {
    if (!repliesPages.has(repliesKey(channel, key))) repliesPages.prefetch(repliesKey(channel, key), () => api.replies(channel, key));
  } else if (!timelinePages.has(key)) timelinePages.prefetch(key, () => readTimeline(key));
}

/** What a read ahead needs to know of a conversation or a chat: when it last changed, and whether a run is changing it now. */
type Ahead = { id: string; at: number; working: boolean };

/**
 * Reads conversations and panels before the owner opens them, one at a time, so a first open shows from the page's cache with no call in
 * front of it. One is read again when it shows activity newer than what the page kept, once it is idle: a working one changes with every
 * step, and its open view reads it live. A hidden page reads nothing until it shows again; those first reads also open the connection
 * again after a sleep, where on 11-19 a lone replies call 29 min after the last one took 3 round trips.
 */
class ReadAhead<Wanted extends Ahead = Ahead> {
  /** Each one's `at` when its kept answer was read. */
  private readonly readAt = new Map<string, number>();
  private wanted: Wanted[] = [];
  private running = false;

  /** `warm` reads one and keeps the answer; one that `viewing` names has an open view, which keeps it current itself. */
  constructor(private readonly warm: (wanted: Wanted) => Promise<unknown>, private readonly viewing: (id: string) => boolean = () => false) {
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => void this.run());
  }

  /** What to keep read, the first one first. */
  want(list: Wanted[]): void {
    this.wanted = list;
    void this.run();
  }

  /** A view of the conversation closed with its page current as of its newest activity. */
  seen(id: string): void {
    const found = this.wanted.find(c => c.id === id);
    if (found) this.readAt.set(id, found.at);
  }

  /** The socket came back, so what the page kept may have missed changes: everything wanted is read again. */
  again(): void {
    this.readAt.clear();
  }

  private next(): Wanted | undefined {
    return this.wanted.find(c => {
      const readAt = this.readAt.get(c.id);
      return !this.viewing(c.id) && (readAt === undefined || (!c.working && c.at > readAt));
    });
  }

  private async run(): Promise<void> {
    if (this.running || typeof document === "undefined") return;
    this.running = true;
    try {
      for (let c = this.next(); c && document.visibilityState === "visible"; c = this.next()) {
        this.readAt.set(c.id, c.at);
        await this.warm(c).catch(() => undefined);
      }
    } finally {
      this.running = false;
    }
  }
}

/** Reads a conversation's newest page ahead and keeps it as the page to show; `limit` is the page size, the server's own when absent. */
const warmTimeline = (limit?: number) => ({ id }: Ahead): Promise<void> =>
  timelinePages.warm(id, wait => readTimeline(id, undefined, wait, limit),
    ({ page, header }) => {
      sawHeader(header);
      return { items: shownItems(id, page.items), older: page.older, header, ...(limit ? { limit } : {}) };
    });
const viewingTimeline = (id: string): boolean => timelinePages.viewing(id);

/** A panel to keep read: the reads it shows when it opens (`reads` in client.ts). */
type PanelAhead = Ahead & { reads: Read<unknown>[] };
const panelQueues = new Map<string, ReadAhead<PanelAhead>>();

/**
 * Keeps the panels of one screen read ahead, the first one first, each read kept in kept.svelte.ts; `screen` names the list, and a new
 * list replaces the last one of that screen.
 */
export function panelsAhead(screen: string, list: PanelAhead[]): void {
  let queue = panelQueues.get(screen);
  if (!queue) {
    queue = new ReadAhead<PanelAhead>(async panel => {
      for (const read of panel.reads) await kept(read).ahead();
    });
    panelQueues.set(screen, queue);
  }
  queue.want(list);
}

/**
 * What a chat's board shows when it opens: the board and the duties, which every room of the chat also reads for its board id chips, then
 * the check-in and the jobs. On 11-20 the four were 47 KB, and 142, 54, 0.1 and 55 KB before brotli, for ag_vent, the largest of 8 agents.
 */
export const boardReads = (chat: string): Read<unknown>[] => [reads.board(chat), reads.duties(chat), reads.checkIn(chat), reads.chatAgents(chat)];
/** As many chats as kept.svelte.ts holds the four reads of beside the Agents page's own. */
const BOARDS_AHEAD = 20;
/** The home chats of the channels whose headers the page read, which no agent's summary names. */
const homeChats = new Set<string>();

/** A header the page read: a channel's names its home chat, whose board the channel's board pane shows. */
function sawHeader(header: ConversationHeader): void {
  if (!header.homeChat || homeChats.has(header.homeChat)) return;
  homeChats.add(header.homeChat);
  boardsAhead();
}

/** Every registered agent's board panel and each channel's home chat's, the agent that worked last first. */
function boardsAhead(agents: readonly AgentSummary[] = global.agents): void {
  const chats = agents.filter(agent => agent.kind === "chat" && !agent.archived).sort((a, b) => b.updatedAt - a.updatedAt)
    .map(agent => ({ id: agent.id, at: agent.updatedAt, working: agent.status === "working" }));
  const homes = [...homeChats].filter(chat => !chats.some(agent => agent.id === chat)).map(chat => ({ id: chat, at: 0, working: false }));
  panelsAhead("boards", [...chats, ...homes].slice(0, BOARDS_AHEAD).map(chat => ({ ...chat, reads: boardReads(chat.id) })));
}

/** The sidebar's rooms: unread ones first, then the newest, `ROOMS_AHEAD` of them. */
const rooms = new ReadAhead(warmTimeline(), viewingTimeline);
function roomsAhead(sidebar: Sidebar): void {
  const unread = (room: ConversationSummary) => Number(room.unread > 0 || room.hasNew);
  rooms.want([...sidebar.solo, ...sidebar.channels, ...sidebar.dms]
    .sort((a, b) => unread(b) - unread(a) || b.lastActivityAt - a.lastActivityAt).slice(0, ROOMS_AHEAD)
    .map(room => ({ id: room.id, at: room.lastActivityAt, working: room.status === "working" })));
}

/**
 * The jobs whose pills the open timeline shows, the newest `JOBS_AHEAD` first, each as a short page of its newest 10 entries. On 11-20
 * that page was 2.1 to 5.4 KB as brotli for three jobs, where the server's own page of 40 entries was 8.1 to 16.9 KB. A pill's open
 * shows the short page and refreshes it at the same size; the entries above it load when the owner scrolls up.
 */
const JOB_PAGE = 10;
const jobPills = new ReadAhead(warmTimeline(JOB_PAGE), viewingTimeline);
function jobsAhead(items: readonly Item[]): void {
  const refs = items.flatMap(item => (item.kind === "turn" ? item.jobs : item.kind === "message" ? item.jobs ?? [] : []));
  jobPills.want(refs.reverse().slice(0, JOBS_AHEAD).map(job => ({ id: job.conversation, at: job.lastAt, working: job.status === "working" })));
}

/** A channel root post's thread as its pill shows it; a change means the kept replies are old. */
const threadMark = (item: Item): string | undefined => (item.kind === "message" && item.thread?.replies ? `${item.thread.replies}:${item.thread.lastAt}` : undefined);
const warmedThreads = new Map<string, string>();

/**
 * Reads the replies of each thread a channel page shows, so its pill opens with the replies on the screen. The reads go out together, for the
 * newest threads the cache keeps: the replies handler took 1.2 ms on 11-19, and on one HTTP/2 connection they share the round trip.
 */
function warmReplies(channel: ConversationId, items: readonly Item[]): void {
  const threads = items.filter(item => threadMark(item) !== undefined).slice(-repliesPages.keep);
  for (const item of threads) {
    const mark = threadMark(item)!;
    const key = repliesKey(channel, item.id);
    if (warmedThreads.get(key) === mark || repliesPages.viewing(key)) continue;
    warmedThreads.set(key, mark);
    void repliesPages.warm(key, wait => api.replies(channel, item.id, wait), page => ({ root: page.root, items: merge([], page.items, new Set()) }));
  }
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
  /** The newest item when the page last posted /read. */
  private marked: Item | undefined;

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
    timelinePages.open(id);
    void this.load(opts.around);
    for (const id of this.sends.restore()) this.retrySend(id);
    const first = firstSends.get(id);
    if (first) {
      firstSends.delete(id);
      void this.send(first.text, first.opts, first.since);
    }
  }

  private around: string | undefined;
  /** The size of the short page this view opened from, kept with the page it leaves. */
  private limit: number | undefined;

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
      // With the kept page on the screen, this read is a refresh behind it, unless it changes what the screen shows.
      const wait: Wait = last ? { background: "shown" } : {};
      this.limit = last?.limit;
      const { page, header } = around ? await readTimeline(this.id, around) : await timelinePages.take(this.id, () => readTimeline(this.id, undefined, wait, last?.limit));
      this.header = header;
      sawHeader(header);
      this.status = header.summary.status;
      this.queue = header.queue ?? null;
      if (last) {
        const kept = new Set(page.items.map(item => item.id));
        const gone = new Set(last.items.map(item => item.id).filter(itemId => !kept.has(itemId)));
        if (gone.size || brought(this.items, shownItems(this.id, page.items))) wait.background = undefined;
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
    if (this.isChannel) warmReplies(this.id, shown);
    else jobsAhead(this.items.concat(shown));
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
  send(text: string, opts: SendOpts = {}, since?: number): Promise<void> {
    const request: SendDraft = { text, requestId: crypto.randomUUID(), ...opts };
    void this.sends.send(request, !opts.threadRoot, since).then(result => this.sent(result, request));
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

  /**
   * Marks the conversation read up to its newest item, once per item. The server marks it read when it stores an owner send, so after the
   * open's first mark the page posts nothing while the newest item is the owner's own, and a send posts /read at most once, for the reply.
   */
  markRead(): Promise<unknown> {
    const newest = this.items.at(-1);
    const own = newest?.kind === "message" && newest.author.id === "owner";
    if (!newest || newest === this.marked || (own && this.marked)) return Promise.resolve();
    this.marked = newest;
    const seq = this.items.findLast(i => i.kind === "message" && i.seq !== undefined);
    return api.read(this.id, seq?.kind === "message" ? seq.seq : undefined).catch(error => {
      if (this.marked === newest) this.marked = undefined;
      throw error;
    });
  }

  close(): void {
    this.stopWatch?.();
    this.stopListen?.();
    this.sends.close();
    const keep = !this.around && this.header && !this.error;
    timelinePages.close(this.id, keep ? { items: this.items.filter(item => !isPending(item)), older: this.older, header: this.header!, ...(this.limit ? { limit: this.limit } : {}) } : undefined);
    if (keep) {
      rooms.seen(this.id);
      jobPills.seen(this.id);
    }
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
    this.sends = new Sends(channel, () => this.items, items => (this.items = items), rootId);
    this.stopListen = live.on(event => {
      if (event.type !== "items" || event.conversation !== channel) return;
      const root = event.items.find(item => item.id === rootId);
      if (root) this.root = root;
      this.sends.merge(event.items.filter(item => item.kind === "message" && item.threadRoot === rootId), event.removed ?? []);
    });
    this.stopWatch = live.watch(channel);
    const key = repliesKey(channel, rootId);
    const last = repliesPages.last(key);
    repliesPages.open(key);
    if (last) {
      this.root = last.root;
      this.items = last.items;
      this.loading = false;
    }
    // With the kept replies on the screen, this read is a refresh behind them, unless it changes what the screen shows.
    const wait: Wait = last ? { background: "shown" } : {};
    void repliesPages.take(key, () => api.replies(channel, rootId, wait)).then(page => {
      if (last && (brought(this.items, page.items) || this.items.some(item => !isPending(item) && !page.items.some(fresh => fresh.id === item.id)))) wait.background = undefined;
      this.root = page.root;
      if (last) {
        const kept = new Set(page.items.map(item => item.id));
        this.items = this.items.filter(item => isPending(item) || kept.has(item.id) || !last.items.some(old => old.id === item.id));
      }
      this.sends.merge(page.items);
    }).catch(error => (this.error = message(error))).finally(() => (this.loading = false));
    for (const id of this.sends.restore()) this.retrySend(id);
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
    this.sends.close();
    repliesPages.close(repliesKey(this.channel, this.rootId), !this.loading && !this.error ? { root: this.root, items: this.items.filter(item => !isPending(item)) } : undefined);
  }
}

export const replies = (channel: ConversationId, root: string): Replies => new Replies(channel, root);

/** One chat's board as a view holds it until `close()`: the kept answer (kept.svelte.ts), which the socket's board events keep current. */
export class BoardStore {
  private readonly kept: Kept<BoardView>;
  private readonly leave: () => void;

  constructor(readonly chatId: string) {
    this.kept = kept(reads.board(chatId));
    this.leave = this.kept.open();
  }

  get view(): BoardView | null {
    return this.kept.value;
  }

  get loading(): boolean {
    return this.kept.loading;
  }

  get error(): string | null {
    return this.kept.error;
  }

  refresh(): Promise<void> {
    return this.kept.read();
  }

  async apply(ops: BoardOp[]): Promise<void> {
    this.kept.set(await api.boardOps(this.chatId, ops));
  }

  close(): void {
    this.leave();
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
