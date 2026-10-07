import { api, ApiError, requestId } from "./api.ts";
import { hasUnsentDrafts } from "./drafts.ts";
import { applyThreadEvent } from "../shared/thread-state.ts";
import type { PendingSend } from "../shared/chat-feed.ts";
import type { BoardOp, ChatBoard, ImageInput, NewChatAccount, SendMode, SessionRow, Tag, ThreadState } from "../shared/types.ts";
import { hashFor, parseHash } from "./permalink.ts";

export interface Toast { id: number; text: string; kind: "error" | "info"; action?: { label: string; run: () => void } }
/** `kind` "chat" creates a chat thread (the server marks the session and lists it under Chats); absent means a normal thread. */
export interface PendingChat { cwd: string; name?: string; kind?: "chat"; message: string; images: ImageInput[]; provider?: string; modelId?: string; thinkingLevel?: string; account?: NewChatAccount; startedAt: number }
/** How long `createChat` waits for the sessions stream to list a new chat before showing it, so the chat view opens instead of the thread view. */
const NEW_ROW_WAIT_MS = 3000;

/** `lastEventAt` is when this tab last got a live event from the thread stream (0 until the first one after the snapshot). */
type ThreadEntry = { state: ThreadState | null; error: string | null; loading: boolean; close: (() => void) | null; lastReadAt: number; lastEventAt: number };

class Store {
  sessions = $state<SessionRow[]>([]);
  tags = $state<Tag[]>([]);
  daemon = $state<"up" | "down" | "unknown">("unknown");
  daemonError = $state<string | null>(null);
  selectedId = $state<string | null>(null);
  threads = $state.raw<Record<string, ThreadEntry>>({});
  pending = $state<PendingChat | null>(null);
  toasts = $state<Toast[]>([]);
  sidebarOpen = $state(window.innerWidth >= 900);
  drawer = $state<"accounts" | "defaults" | "remote" | "versions" | null>(null);
  /** Bumped when Settings saves new defaults, so the new-chat screen reads them again. */
  defaultsRevision = $state(0);
  /** Chat sends each thread has not echoed back yet, by thread id, oldest first. */
  pendingSends = $state.raw<Record<string, PendingSend[]>>({});
  /** The job drawer: a job of a chat, by the name the chat gave it (a job key or session id also works). Null when closed. */
  jobDrawer = $state.raw<{ chat: string; job: string } | null>(null);
  /** A message link to land on (`#<id>@<ms>`): the open thread scrolls to it and clears this. */
  jump = $state.raw<{ id: string; at: number } | null>(null);
  private toastId = 0;
  private sessionsStop: (() => void) | null = null;

  start(): void {
    this.readHash();
    window.addEventListener("hashchange", () => this.readHash());
    this.sessionsStop = api.sessionsStream(event => {
      this.sessions = event.sessions;
      this.tags = event.tags;
      this.daemon = event.daemon;
      this.daemonError = event.error ?? null;
    }, () => { if (this.daemon === "unknown") this.daemon = "down"; }, version => this.onBuild(version));
  }

  private updateOffered = false;
  /** A restarted service with new client code: reload at once unless that would drop an unsent draft or a starting chat, then offer it instead. */
  private onBuild(version: string): void {
    if (!version || version === document.body.dataset.build || this.updateOffered) return;
    if (!this.pending && !hasUnsentDrafts()) { location.reload(); return; }
    this.updateOffered = true;
    this.toast("A new version of this page is ready.", "info", { label: "Reload", run: () => location.reload() }, null);
  }

  retry(): void {
    this.sessionsStop?.();
    this.start();
  }

  private readHash(): void {
    const target = parseHash(location.hash);
    this.selectedId = target?.id ?? null;
    this.jump = target && target.at !== null ? { id: target.id, at: target.at } : null;
  }

  /** Opens a thread, and with `at` lands on the message with that `timestamp` once the thread shows. */
  select(id: string | null, at: number | null = null): void {
    const next = id ? hashFor(id, at) : "";
    if (location.hash !== next) history.pushState(null, "", location.pathname + location.search + next);
    this.selectedId = id;
    this.jump = id && at !== null ? { id, at } : null;
  }

  /** Opens the job drawer in its chat, switching to the chat first when another thread is open. */
  openJob(chat: string, job: string): void {
    if (this.selectedId !== chat) this.select(chat);
    this.jobDrawer = { chat, job };
  }

  session(id: string | null): SessionRow | undefined {
    return id ? this.sessions.find(row => row.id === id) : undefined;
  }

  thread(id: string): ThreadEntry | undefined { return this.threads[id]; }

  private patch(id: string, change: Partial<ThreadEntry>): void {
    const current = this.threads[id] ?? { state: null, error: null, loading: false, close: null, lastReadAt: 0, lastEventAt: 0 };
    this.threads = { ...this.threads, [id]: { ...current, ...change } };
  }

  open(id: string): void {
    const entry = this.threads[id];
    if (entry?.close) return;
    this.patch(id, { loading: true, error: null });
    performance.mark("thread-open:" + id);
    const close = api.threadStream(id, event => {
      const current = this.threads[id];
      if (!current) return;
      if (event.type === "snapshot") {
        performance.measure("thread-snapshot:" + id, "thread-open:" + id);
        this.patch(id, { state: applyThreadEvent({ ...event.snapshot, connection: "connected" }, event), loading: false, error: null });
      }
      else if (event.type === "status" && event.connection === "closed" && event.error) this.patch(id, { loading: false, error: event.error, close: null, ...(current.state ? { state: applyThreadEvent(current.state, event) } : {}) });
      else if (current.state) this.patch(id, { state: applyThreadEvent(current.state, event), ...(event.type === "event" ? { lastEventAt: Date.now() } : {}) });
    }, () => {
      const current = this.threads[id];
      if (current && !current.state) this.patch(id, { loading: false, error: current.error ?? "The thread stream is not reachable." });
    });
    this.patch(id, { close });
  }

  release(id: string): void {
    const entry = this.threads[id];
    if (!entry?.close) return;
    entry.close();
    this.patch(id, { close: null });
  }

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
    this.patch(id, { lastReadAt: Date.now() });
    void api.read(id).catch(() => {});
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

  /** Creates the native session, opens it, and returns its id; null when the create failed (the error is a toast). */
  async createChat(input: Omit<PendingChat, "startedAt">): Promise<string | null> {
    this.pending = { ...input, startedAt: Date.now() };
    const result = await this.run(api.createThread({ ...input, requestId: requestId() }));
    if (!result) { this.pending = null; return null; }
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
