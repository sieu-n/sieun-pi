import { api, ApiError, requestId } from "./api.ts";
import { hasUnsentDrafts } from "./drafts.ts";
import { applyThreadEvent, isThreadBusy } from "../shared/thread-state.ts";
import type { ImageInput, NewChatAccount, SendMode, SessionRow, Tag, ThreadState } from "../shared/types.ts";

export interface Toast { id: number; text: string; kind: "error" | "info"; action?: { label: string; run: () => void } }
export interface PendingChat { cwd: string; message: string; images: ImageInput[]; provider?: string; modelId?: string; thinkingLevel?: string; account?: NewChatAccount; startedAt: number }

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
  drawer = $state<"accounts" | "defaults" | "remote" | null>(null);
  /** Bumped when Settings saves new defaults, so the new-chat screen reads them again. */
  defaultsRevision = $state(0);
  private toastId = 0;
  private sessionsStop: (() => void) | null = null;

  start(): void {
    this.selectedId = decodeURIComponent(location.hash.slice(1)) || null;
    window.addEventListener("hashchange", () => { this.selectedId = decodeURIComponent(location.hash.slice(1)) || null; });
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

  select(id: string | null): void {
    const next = id ? "#" + encodeURIComponent(id) : "";
    if (location.hash !== next) history.pushState(null, "", location.pathname + location.search + next);
    this.selectedId = id;
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

  markRead(id: string): void {
    const entry = this.threads[id];
    if (!entry?.state || isThreadBusy(entry.state)) return;
    const row = this.session(id);
    if (!row?.unread && entry.lastReadAt > 0) return;
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

  /** Creates the native session, opens it, and returns its id; null when the create failed (the error is a toast). */
  async createChat(input: Omit<PendingChat, "startedAt">): Promise<string | null> {
    this.pending = { ...input, startedAt: Date.now() };
    const result = await this.run(api.createThread({ ...input, requestId: requestId() }));
    if (!result) { this.pending = null; return null; }
    this.open(result.id);
    this.select(result.id);
    this.pending = null;
    return result.id;
  }
}

export const store = new Store();
