import { api, ApiError, requestId } from "./api.ts";
import { hasUnsentDrafts } from "./drafts.ts";
import { buildReload, onLeave } from "./build-reload.ts";
import { retryFeeds } from "./feeds.ts";
import { applyThreadEvent, threadStateFromSnapshot } from "../shared/thread-state.ts";
import { messageKey } from "../shared/message-key.ts";
import { rememberAccounts } from "./accounts.ts";
import { dutiesFeed } from "./duties.svelte.ts";
import { childUsage, pushedAccounts } from "./thread-side.svelte.ts";
import type { ThreadSide } from "../shared/thread-side.ts";
import { keepOlder, newestPage, prependOlder, trimToNewest, type NewestPage } from "./thread-pages.ts";
import type { PendingSend } from "../shared/chat-feed.ts";
import type { BoardOp, ChatBoard, ImageInput, NewChatAccount, SendMode, SessionRow, SlackChannelSetup, SlackChatInput, SlackView, Tag, ThreadEvent, ThreadState } from "../shared/types.ts";
import { hashFor, pageTarget, searchFor } from "./permalink.ts";
import { readerAction, type ReaderView } from "./reader.ts";
import type { ArtifactTarget } from "../shared/artifact-link.ts";
import type { PromptTarget } from "../shared/prompt-view.ts";
import type { SettingsSection } from "./settings-sections.ts";

export interface Toast { id: number; text: string; kind: "error" | "info"; action?: { label: string; run: () => void } }
/** `kind` "chat" creates a chat thread (the server marks the session and lists it under Chats); absent means a normal thread. */
export interface PendingChat { cwd: string; host?: string; name?: string; kind?: "chat"; slack?: SlackChannelSetup; message: string; images: ImageInput[]; provider?: string; modelId?: string; thinkingLevel?: string; account?: NewChatAccount; startedAt: number }
/** How long `createChat` waits for the sessions stream to list a new chat before showing it, so the chat view opens instead of the thread view. */
const NEW_ROW_WAIT_MS = 3000;

/** `lastEventAt` is when this tab last got a live event from the thread stream (0 until the first one after the snapshot). */
/**
 * `newest` is where the newest page of the last snapshot starts, so a thread left alone can drop the older pages loaded since. `olderLoading`
 * is set while an older page is on its way.
 */
type ThreadEntry = { state: ThreadState | null; error: string | null; loading: boolean; close: (() => void) | null; lastReadAt: number; lastEventAt: number;
  newest: NewestPage | null; olderLoading: boolean };

/** The next frame, or the next task in a hidden tab, which draws no frames. */
const afterPaint = (run: () => void): void => { if (document.visibilityState === "hidden") setTimeout(run, 0); else requestAnimationFrame(run); };

function bootJump(): { id: string; at: number } | null {
  const target = pageTarget();
  return target && target.at !== null ? { id: target.id, at: target.at } : null;
}

class Store {
  /**
   * Raw, because every sessions frame replaces the whole list. A deep $state wrapped all of its ~2,700 rows in new proxies on each frame, about
   * one frame a second, which held the idle renderer near 10% CPU on its own (10-18).
   */
  sessions = $state.raw<SessionRow[]>([]);
  tags = $state<Tag[]>([]);
  daemon = $state<"up" | "down" | "unknown">("unknown");
  daemonError = $state<string | null>(null);
  /** Read from the hash at once, so the first render on a thread URL never mounts the new-chat screen and its five requests. */
  selectedId = $state<string | null>(pageTarget()?.id ?? null);
  threads = $state.raw<Record<string, ThreadEntry>>({});
  pending = $state<PendingChat | null>(null);
  toasts = $state<Toast[]>([]);
  sidebarOpen = $state(window.innerWidth >= 900);
  /** The open Settings tab, or null when the dialog is closed. */
  drawer = $state<SettingsSection | null>(null);
  /** Bumped when Settings saves new defaults, so the new-chat screen reads them again. */
  defaultsRevision = $state(0);
  /** Chat sends each thread has not echoed back yet, by thread id, oldest first. */
  pendingSends = $state.raw<Record<string, PendingSend[]>>({});
  /** The job drawer: a job of a chat, by the name the chat gave it (a job key or session id also works). Null when closed. */
  jobDrawer = $state.raw<{ chat: string; job: string } | null>(null);
  /** A message link to land on (`#<id>@<ms>`): the open thread scrolls to it and clears this. */
  jump = $state.raw<{ id: string; at: number } | null>(bootJump());
  /** A Reply the owner started (`replyExcerpt` of the message): the chat's composer takes it as its quote and clears this. */
  replyQuote = $state.raw<{ chat: string; text: string } | null>(null);
  /** The reader modal: a job's report, a file, a wiki page or one message. Null when closed. */
  reader = $state.raw<ReaderView | null>(null);
  /** The session whose Prompt view is open: a thread or chat from its header, a job from its drawer, report or duty run, or a duty's next run. Null when closed. */
  prompt = $state.raw<PromptTarget | null>(null);
  /** The plan view modal of a chat: its whole board as a tree, scrolled to `focus` (a plan step or note id) when set. Null when closed. */
  planView = $state.raw<{ chat: string; focus: string | null } | null>(null);
  /** The Slack bridge as the chat header and the new-chat screen show it; null when this instance runs none, undefined until read. */
  slack = $state.raw<SlackView | null | undefined>(undefined);
  private toastId = 0;
  /** Threads with a read mark on its way: one in flight per thread (10-18: each switch sent it twice, and each took 10 to 27 s). */
  private reading = new Set<string>();
  private sessionsStop: (() => void) | null = null;

  start(): void {
    void this.loadSlack();
    this.readHash();
    window.addEventListener("hashchange", () => this.readHash());
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") { if (this.selectedId) this.seenAt.set(this.selectedId, this.hides); this.trimHidden(); } });
    this.sessionsStop = api.sessionsStream(event => {
      this.sessions = event.sessions;
      this.tags = event.tags;
      this.daemon = event.daemon;
      this.daemonError = event.error ?? null;
    }, () => { if (this.daemon === "unknown") this.daemon = "down"; }, version => this.onBuild(version));
  }

  private updateOffered = false;
  /** A restarted service with new client code: `buildReload` picks a reload now, one when the owner leaves the page, or a Reload offer. */
  private onBuild(version: string): void {
    if (!version || version === document.body.dataset.build || this.updateOffered) return;
    this.updateOffered = true;
    const unsent = () => this.pending !== null || hasUnsentDrafts();
    const plan = buildReload({ hidden: document.visibilityState === "hidden", focused: document.hasFocus(), unsent: unsent() });
    if (plan === "now") location.reload();
    else if (plan === "on-leave") onLeave(() => { if (unsent()) this.offerReload(); else location.reload(); });
    else this.offerReload();
  }

  private offerReload(): void {
    this.toast("A new version of this page is ready.", "info", { label: "Reload", run: () => location.reload() }, null);
  }

  retry(): void {
    this.sessionsStop?.();
    this.start();
    retryFeeds();
  }

  private readHash(): void {
    const target = pageTarget();
    const search = searchFor(target?.id ?? null, location.search);
    if (search !== location.search) history.replaceState(history.state, "", location.pathname + search + location.hash);
    this.choose(target?.id ?? null);
    this.jump = target && target.at !== null ? { id: target.id, at: target.at } : null;
  }

  /**
   * Selects a thread and opens it in the same moment, before the view mounts, so the view finds the feed's side frames expected and asks for
   * none of them itself.
   */
  private choose(id: string | null): void {
    if (this.selectedId) this.seenAt.set(this.selectedId, this.hides);
    if (id && id !== this.selectedId) { performance.clearMarks("thread-switch:" + id); performance.mark("thread-switch:" + id); }
    if (id) this.open(id);
    this.selectedId = id;
  }

  /** Opens a thread, and with `at` lands on the message with that `timestamp` once the thread shows. */
  select(id: string | null, at: number | null = null): void {
    const next = id ? hashFor(id, at) : "";
    const search = searchFor(id, location.search);
    if (location.hash !== next || location.search !== search) history.pushState(null, "", location.pathname + search + next);
    this.choose(id);
    this.jump = id && at !== null ? { id, at } : null;
  }

  /** Opens the job drawer in its chat, switching to the chat first when another thread is open. */
  openJob(chat: string, job: string): void {
    if (this.selectedId !== chat) this.select(chat);
    this.jobDrawer = { chat, job };
  }

  /** Opens the plan view of a chat, switching to the chat first when another thread is open. */
  openPlan(chat: string, focus: string | null = null): void {
    if (this.selectedId !== chat) this.select(chat);
    this.planView = { chat, focus };
  }

  /** Opens an artifact link from `thread`: a web URL in a new tab, a bare thread link as the thread, everything else in the reader. */
  openArtifact(target: ArtifactTarget, thread: string): void {
    const action = readerAction(target, thread);
    if (action.open === "tab") window.open(action.url, "_blank", "noopener");
    else if (action.open === "thread") { this.reader = null; this.select(action.sessionId); }
    else this.reader = action.view;
  }

  session(id: string | null): SessionRow | undefined {
    return id ? this.sessions.find(row => row.id === id) : undefined;
  }

  thread(id: string): ThreadEntry | undefined { return this.threads[id]; }

  private patch(id: string, change: Partial<ThreadEntry>): void {
    const current = this.threads[id] ?? { state: null, error: null, loading: false, close: null, lastReadAt: 0, lastEventAt: 0, newest: null, olderLoading: false };
    this.threads = { ...this.threads, [id]: { ...current, ...change } };
  }

  /**
   * Opens a thread. A new subscription brings the snapshot and, pushed right after it, everything the view draws beside the messages (job
   * costs, a chat's duties, the account chip), so the view sends no request of its own. On 10-18 a switch sent the account and duties requests
   * only after the snapshot landed, three round trips from Korea before the view was whole.
   */
  open(id: string): void {
    const entry = this.threads[id];
    if (entry?.close && !entry.error) return;
    // Retry after an error: drop the failed subscription and start a fresh one on a socket that reconnects now.
    entry?.close?.();
    if (entry?.error) retryFeeds();
    this.patch(id, { loading: true, error: null });
    performance.mark("thread-open:" + id);
    // A subscribe answers a preview snapshot and the full newest page right behind it, often in one socket read: the preview paints first,
    // and the full page and every event after it wait for the next frame, in order.
    let painting = false;
    let held: ThreadEvent[] | null = null;
    const close = api.threadStream(id, event => {
      if (held) { held.push(event); return; }
      if (event.type === "snapshot" && painting) {
        held = [event];
        afterPaint(() => { const events = held ?? []; held = null; for (const next of events) apply(next); });
        return;
      }
      if (event.type === "snapshot") { painting = true; afterPaint(() => { painting = false; }); }
      apply(event);
    }, () => {
      this.dropSide(id);
      const current = this.threads[id];
      if (current && !current.state) this.patch(id, { loading: false, error: current.error ?? "The thread stream is not reachable." });
    }, side => this.side(id, side));
    const apply = (event: ThreadEvent) => {
      const current = this.threads[id];
      if (!current) return;
      if (event.type === "snapshot") {
        if (performance.getEntriesByName("thread-open:" + id, "mark").length) performance.measure("thread-snapshot:" + id, "thread-open:" + id);
        const page = current.state ? applyThreadEvent({ ...current.state, connection: "connected" }, event) : threadStateFromSnapshot(event.snapshot);
        this.patch(id, { state: keepOlder(current.state, page), newest: newestPage(page), loading: false, error: null });
      }
      else if (event.type === "status" && event.connection === "closed" && event.error) {
        this.dropSide(id);
        this.patch(id, { loading: false, error: event.error, close: null, ...(current.state ? { state: applyThreadEvent(current.state, event) } : {}) });
      }
      else if (current.state) this.patch(id, { state: applyThreadEvent(current.state, event), ...(event.type === "event" ? { lastEventAt: Date.now() } : {}) });
    };
    this.expectSide(id);
    this.patch(id, { close });
  }

  /** What the feed pushes beside a thread's messages after a new subscription: job costs, a chat's duties and the account chip's view. */
  private side(id: string, side: ThreadSide): void {
    if (side.childUsage) childUsage.set(id, side.childUsage);
    if (side.duties) dutiesFeed.set(id, side.duties);
    if (side.accounts) { rememberAccounts(id, side.accounts.view, side.accounts.model); pushedAccounts.landed(id); }
  }

  /** A new subscription: the view asks for none of what the feed pushes beside the messages, so the first paint costs one round trip. */
  private expectSide(id: string): void {
    childUsage.expect(id);
    const row = this.session(id);
    if (!row || row.chat) dutiesFeed.expect(id);
    pushedAccounts.expect(id);
  }

  /** The subscription ended: what it did not push yet is asked for by the view. */
  private dropSide(id: string): void {
    childUsage.drop(id);
    dutiesFeed.drop(id);
    pushedAccounts.landed(id);
  }

  /**
   * Leaving a thread. A chat keeps its subscription, so switching back paints the state it holds and needs no new snapshot (10-18: each
   * switch back waited 2.5 to 16 s for one under a busy server). An open tab never holds a chat's session attached (chat-threads.ts
   * `resting`). Any other thread closes it, since a listener keeps a plain thread attached on the server (`sweep`).
   */
  release(id: string): void {
    const entry = this.threads[id];
    if (!entry?.close || this.session(id)?.chat) return;
    entry.close();
    this.dropSide(id);
    this.patch(id, { close: null });
  }

  /** Part `part` of the message at `index` in the thread's loaded messages, whole: the snapshot clips long parts. */
  part(id: string, index: number, part: number): Promise<{ text: string }> {
    const messages = this.threads[id]?.state?.messages;
    if (!messages?.[index]) return Promise.reject(new Error("That message is not loaded any more."));
    return api.part(id, messageKey(messages, index), part);
  }

  /** The page before the oldest loaded message, put in front of it; true when it was. A session file that changed under the cursor (409) opens the thread again. */
  async loadOlder(id: string): Promise<boolean> {
    const entry = this.threads[id];
    const cursor = entry?.state?.older;
    if (!entry || cursor === undefined || entry.olderLoading) return false;
    this.patch(id, { olderLoading: true });
    try {
      const page = await api.olderPage(id, cursor);
      const current = this.threads[id];
      if (!current?.state || current.state.older !== cursor) return false;
      this.patch(id, { state: prependOlder(current.state, page) });
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) { this.threads[id]?.close?.(); this.patch(id, { close: null }); this.open(id); }
      else this.toast(error instanceof Error ? error.message : String(error));
      return false;
    } finally { this.patch(id, { olderLoading: false }); }
  }

  /**
   * A thread the owner did not open between the last two times the tab went hidden drops its older pages, so threads he scrolled through
   * once do not stay in memory; a thread he goes back to keeps them. Its newest page and live state stay.
   */
  private trimHidden(): void {
    this.hides++;
    let threads = this.threads;
    for (const [id, entry] of Object.entries(threads)) {
      if (id === this.selectedId || !entry.state || this.hides - (this.seenAt.get(id) ?? 0) < 2) continue;
      const state = trimToNewest(entry.state, entry.newest);
      if (state !== entry.state) threads = { ...threads, [id]: { ...entry, state } };
    }
    if (threads !== this.threads) this.threads = threads;
  }
  private hides = 0;
  /** The `hides` count when each thread was last open. */
  private seenAt = new Map<string, number>();

  warm(id: string): void {
    if (this.threads[id]?.state) return;
    void api.warm(id).catch(() => {});
  }

  /**
   * Leaving a thread marks everything up to now read, busy or not. The server keeps the later of now and the last activity, so output that
   * arrives after you leave still counts as unread. Skipped only when nothing happened since this page last marked it.
   */
  markRead(id: string): void {
    const entry = this.threads[id];
    const row = this.session(id);
    if (!entry?.state || !row) return;
    const activity = Date.parse(row.lastActivityAt ?? "") || 0;
    if (!row.unread && entry.lastReadAt > 0 && entry.lastReadAt >= activity) return;
    if (this.reading.has(id)) return;
    this.reading.add(id);
    this.patch(id, { lastReadAt: Date.now() });
    void api.read(id).catch(() => {}).finally(() => this.reading.delete(id));
  }

  /** `ttl` null keeps the toast until its action runs or it is dismissed. */
  toast(text: string, kind: Toast["kind"] = "error", action?: Toast["action"], ttl: number | null = kind === "error" ? 7000 : action ? 6000 : 3500): void {
    const id = ++this.toastId;
    this.toasts = [...this.toasts, { id, text, kind, ...(action ? { action } : {}) }];
    if (ttl !== null) setTimeout(() => this.dismiss(id), ttl);
  }

  dismiss(id: number): void { this.toasts = this.toasts.filter(toast => toast.id !== id); }

  async run<T>(work: Promise<T>): Promise<T | undefined> {
    try { return await work; }
    catch (error) { this.toast(error instanceof ApiError || error instanceof Error ? error.message : String(error)); return undefined; }
  }

  async send(id: string, message: string, images: ImageInput[], mode: SendMode): Promise<boolean> {
    const result = await this.run(api.prompt(id, { message, images, mode, requestId: requestId() }));
    return result !== undefined;
  }

  /**
   * A chat send: the bubble appears at once as pending and the box is free again; the message steers the thread so it lands
   * even while it is busy. A refused send drops the bubble and shows the error; the composer gets its text back.
   */
  async sendChat(id: string, text: string, images: ImageInput[]): Promise<boolean> {
    const send: PendingSend = { id: requestId(), text, at: Date.now(),
      images: images.map(image => ({ type: "image", mimeType: image.mimeType, url: "data:" + image.mimeType + ";base64," + image.data })) };
    this.pendingSends = { ...this.pendingSends, [id]: [...(this.pendingSends[id] ?? []), send] };
    const ok = await this.send(id, text, images, "steer");
    if (!ok) this.settleSends(id, new Set([send.id]));
    return ok;
  }

  /**
   * An owner's board change: the board updates at once with `next` and the ops go to the server, which also tells the chat. A refused change
   * puts the previous board back and shows the error. The server's board event lands after and wins either way.
   */
  async boardOps(id: string, next: ChatBoard, ops: BoardOp[]): Promise<boolean> {
    const entry = this.threads[id];
    if (!entry?.state) return false;
    const previous = entry.state.board ?? null;
    this.patch(id, { state: { ...entry.state, board: next } });
    const result = await this.run(api.board(id, ops));
    if (result) return true;
    const current = this.threads[id];
    if (current?.state && current.state.board === next) this.patch(id, { state: { ...current.state, board: previous } });
    return false;
  }

  /** Forget pending sends the thread has echoed back (the chat view reports them), so the list never grows. */
  settleSends(id: string, ids: ReadonlySet<string>): void {
    const sends = this.pendingSends[id] ?? [];
    if (!sends.some(send => ids.has(send.id))) return;
    const left = sends.filter(send => !ids.has(send.id));
    const { [id]: _dropped, ...rest } = this.pendingSends;
    this.pendingSends = left.length ? { ...rest, [id]: left } : rest;
  }

  private slackLoad: Promise<void> | null = null;
  /** One read in flight: the page start and a chat header that mounts before it answers share it. */
  loadSlack(): Promise<void> {
    this.slackLoad ??= api.slack().then(view => { this.slack = view; }, () => { /* the header keeps its last view; Settings shows the error */ })
      .finally(() => { this.slackLoad = null; });
    return this.slackLoad;
  }

  /** A chat's Slack dialog action (connect, rename, stop); false when the server refused (the error is a toast). */
  async slackChat(id: string, input: SlackChatInput): Promise<boolean> {
    const view = await this.run(api.slackChat(id, input));
    if (view) this.slack = view;
    return view !== undefined;
  }

  /** Creates the native session, opens it, and returns its id; null when the create failed (the error is a toast). */
  async createChat(input: Omit<PendingChat, "startedAt">): Promise<string | null> {
    this.pending = { ...input, startedAt: Date.now() };
    const result = await this.run(api.createThread({ ...input, requestId: requestId() }));
    if (!result) { this.pending = null; return null; }
    if (result.notice) this.toast(result.notice);
    if (input.slack) void this.loadSlack();
    this.open(result.id);
    if (input.kind === "chat") await this.awaitRow(result.id);
    this.select(result.id);
    this.pending = null;
    return result.id;
  }

  /** Resolves once the sessions stream lists `id`, or after NEW_ROW_WAIT_MS. */
  private awaitRow(id: string): Promise<void> {
    return new Promise(resolve => {
      const started = Date.now();
      const check = () => { if (this.session(id) || Date.now() - started > NEW_ROW_WAIT_MS) resolve(); else setTimeout(check, 50); };
      check();
    });
  }
}

export const store = new Store();
