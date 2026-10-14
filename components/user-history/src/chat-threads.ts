import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { DaemonAgentConnection, DaemonClient, SessionManager, type SessionEntry, type SessionSummary } from "prime-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Catalog } from "./chat-catalog.ts";
import type { SubagentDelete } from "./chat-sources.ts";
import { childrenStirred, Dormancy, type IdleDetach, unsilent } from "./chat-dormancy.ts";
import "./daemon-snapshot-count.ts";
import { CHAT_FLAG } from "./chat-guard.ts";
import { UNKNOWN_ACTIVE } from "./chats.ts";
import { CHAT_NOTICE } from "./shared/chat-feed.ts";
import { readBranchTail } from "./session-tail.ts";
import { DAEMON_WORKER_START_MS, timedWorkerStart } from "./daemon-worker-start.ts";
import { ImageStore, Projector, projectChild, projectInfo, projectModel, sessionUsage } from "./chat-projection.ts";
import type { ChatImage } from "./chat-images.ts";
import { applyThreadEvent, isThreadBusy, isTurnRunning, runStartedAtFromMessages, threadStateFromSnapshot } from "./shared/thread-state.ts";
import type { ChatBoard, ChatDefaults, ChatWait, ChildAgent, Command, ModelCatalog, ModelInfo, ProjectedSessionEvent, QueueState, SendMode, SessionRow, ThreadEvent, ThreadInfo, ThreadStats, ThreadSnapshot, ThreadState, ThinkingLevel } from "./shared/types.ts";

type Listener = (event: ThreadEvent) => void;
/** What chats watch on the hub: each attach (with the children known then), every change of a thread's subagent list while attached, and each turn's end. */
export interface ThreadObserver { live(id: string, children: readonly ChildAgent[]): void; children(id: string, children: readonly ChildAgent[]): void; idle(id: string): void }

/** Native session-owned slash commands (prime-agent SESSION_SLASH_COMMAND_NAMES). The session runs them from prompt text; getCommands does not list them. */
const SESSION_COMMANDS: Command[] = [
  { name: "compact", description: "Compact the session context; optional instructions focus the summary", argumentHint: "[instructions]", source: "session" },
  { name: "refine", description: "Refine continual harness prompt notes, skills, subagents, and memory", source: "session" },
  { name: "goal", description: "Set or view a persistent goal; supports pause, resume, and clear", argumentHint: "[objective]", source: "session" },
  { name: "autonomous", description: "Set or view autonomous mode", argumentHint: "[status|on|off]", source: "session" },
];
type NativeEvent = Parameters<Parameters<DaemonAgentConnection["subscribe"]>[0]>[0];
type Live = { connection: DaemonAgentConnection; activeSessionId: string; unsubscribe: () => void };

/** The daemon's kill answer when the worker outlived the stop window; the supervisor still finishes the stop. */
const STOP_PENDING = /^Session worker \S+ did not stop/;

/**
 * Display messages for stored branch entries, in file order: messages, custom messages (agent replies and notices), branch summaries, and a
 * compaction marker where each compaction happened.
 */
export function historyMessages(entries: readonly SessionEntry[]): AgentMessage[] {
  return entries.flatMap((entry): AgentMessage[] => {
    const timestamp = new Date(entry.timestamp).getTime();
    switch (entry.type) {
      case "message": return [entry.message];
      case "custom_message": return [{ role: "custom", customType: entry.customType, content: entry.content, display: entry.display, details: entry.details, timestamp }];
      case "branch_summary": return entry.summary ? [{ role: "branchSummary", summary: entry.summary, fromId: entry.fromId, timestamp }] : [];
      case "compaction": return [{ role: "compactionSummary", summary: entry.summary, tokensBefore: entry.tokensBefore, timestamp }];
      default: return [];
    }
  });
}

/**
 * The live context after a compaction starts at its summary, so the turns it replaced are only in the session file. These are the branch entries
 * before the latest compaction's first kept entry. `whole` false: the entries are the branch's tail, and one that does not reach back to the
 * first kept entry holds none of the replaced turns.
 */
export function compactedEntries(branch: readonly SessionEntry[], whole = true): SessionEntry[] {
  let compaction = -1;
  for (let index = branch.length - 1; index >= 0; index--) if (branch[index]!.type === "compaction") { compaction = index; break; }
  if (compaction < 0) return [];
  const entry = branch[compaction]!;
  const firstKept = entry.type === "compaction" ? branch.findIndex((candidate, index) => index < compaction && candidate.id === entry.firstKeptEntryId) : -1;
  if (firstKept < 0 && !whole) return [];
  return branch.slice(0, firstKept >= 0 ? firstKept : compaction);
}

/** Background daemon attaches that may run at once; a restart pins 10 chats, and at a load of 90 each attach took 16 to 41 s when all ran together. */
export const BACKGROUND_ATTACHES = 2;

/**
 * Daemon attaches (attach plus the first snapshot). A foreground one (a tab opening a thread, an owner send) starts at once. Background ones
 * (pinned chats coming back, stall checks) wait in order until fewer than `limit` attaches of either kind run. A foreground request for a key
 * still waiting promotes it, so an open chat never waits behind the others.
 */
export class AttachQueue {
  private active = 0;
  private readonly waiting: { key: string; start(): void }[] = [];
  constructor(private readonly limit = BACKGROUND_ATTACHES) {}

  async run<T>(key: string, background: boolean, task: () => Promise<T>): Promise<T> {
    if (!background || (this.active < this.limit && this.waiting.length === 0)) this.active++;
    else await new Promise<void>(start => { this.waiting.push({ key, start }); });
    try { return await task(); }
    finally { this.active--; this.next(); }
  }

  promote(key: string): void {
    const index = this.waiting.findIndex(entry => entry.key === key);
    if (index < 0) return;
    const [entry] = this.waiting.splice(index, 1);
    this.active++;
    entry!.start();
  }

  private next(): void {
    while (this.active < this.limit && this.waiting.length) { this.active++; this.waiting.shift()!.start(); }
  }
}

export class ThreadError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

class Thread {
  state: ThreadState;
  live: Live | null = null;
  sessionFile: string | undefined;
  /** The owner asked for older messages (`ThreadHub.older`): every later read of the session file takes the whole branch. */
  full = false;
  readonly listeners = new Set<Listener>();
  touched = Date.now();
  idleSince: number | null = Date.now();
  /** When the session last sent an event, or the attach; the server's hung-turn check reads it (`quietSince`). */
  lastEventAt = Date.now();
  /** The hub clock at the thread's last attach, session event, children change or tab close: its idle time for `rest` counts from here. */
  activeAt = Date.now();
  private pendingUpdate: { timer: ReturnType<typeof setTimeout>; event: ProjectedSessionEvent } | undefined;
  constructor(readonly id: string, snapshot: ThreadSnapshot, private readonly onChildren: (thread: Thread, before: readonly ChildAgent[]) => void) { this.state = threadStateFromSnapshot(snapshot); }
  broadcast(event: ThreadEvent): void {
    // A snapshot from the daemon carries no board or wait; a chat keeps both until their own events replace them.
    if (event.type === "snapshot" && event.snapshot.board === undefined && this.state.board !== undefined) event = { ...event, snapshot: { ...event.snapshot, board: this.state.board } };
    if (event.type === "snapshot" && event.snapshot.wait === undefined && this.state.wait) event = { ...event, snapshot: { ...event.snapshot, wait: this.state.wait } };
    const children = this.state.children;
    this.state = applyThreadEvent(this.state, event);
    for (const listener of [...this.listeners]) listener(event);
    if (this.state.children !== children) this.onChildren(this, children);
  }
  coalesce(event: ProjectedSessionEvent, delayMs: number): void {
    if (event.type !== "message_update") { this.flush(); this.broadcast({ type: "event", event }); return; }
    if (this.pendingUpdate) { this.pendingUpdate.event = event; return; }
    this.pendingUpdate = { event, timer: setTimeout(() => this.flush(), delayMs) };
  }
  flush(): void {
    if (!this.pendingUpdate) return;
    const { timer, event } = this.pendingUpdate;
    clearTimeout(timer);
    this.pendingUpdate = undefined;
    this.broadcast({ type: "event", event });
  }
}

/** How many unpinned threads with no tab open stay attached (`MAX_LIVE`) or stay read from their saved file (`MAX_SAVED`); pinned chats do not count. */
const MAX_LIVE = 8;
const MAX_SAVED = 16;
const IDLE_MS = 3 * 60 * 1000;
const UPDATE_COALESCE_MS = 40;
/**
 * The id to attach, or undefined when the session must be opened from its saved file. A worker that died leaves its sessions listed with the dead
 * worker's active id and workerState "failed"; attaching that id fails with "Session worker is failed" forever, while opening the saved file
 * makes the daemon drop the dead registration and start the session on a new worker.
 */
function liveSessionId(summary: SessionSummary): string | undefined {
  return summary.workerState === "failed" ? undefined : summary.activeSessionId;
}

/** A pinned thread whose resume failed (a daemon timeout, a refused attach) is tried again after 15 s, doubling per failure up to 5 min. */
const PIN_RETRY_MS = 15000;
const PIN_RETRY_MAX_MS = 5 * 60_000;

export class ThreadHub {
  readonly images = new ImageStore();
  readonly projector = new Projector(this.images);
  private readonly threads = new Map<string, Thread>();
  private readonly opening = new Map<string, Promise<Thread>>();
  /** Resumes in flight, so a second ask for the same thread waits on the first instead of attaching again. */
  private readonly resuming = new Map<string, { ask: { foreground: boolean }; promise: Promise<Thread> }>();
  /** Every model the last catalog read listed, by "provider/id", so a saved thread can name the model it last ran. */
  private readonly knownModels = new Map<string, ModelInfo>();
  private readonly sweeper: ReturnType<typeof setInterval>;
  /** Threads kept attached and resident while the service runs: never swept or evicted, resumed again when the daemon comes back. */
  private readonly pinned = new Set<string>();
  /** Pins being resumed now (queued or attaching), and the failed ones with when to try next. */
  private readonly pinning = new Set<string>();
  private readonly pinRetry = new Map<string, { at: number; failures: number }>();
  /** Pinned chats detached by `rest`. They stay pinned and keep their last state until `resume` wakes them. */
  private readonly dormant: Dormancy;
  private unwatchCatalog: (() => void) | undefined;
  /** Each pinned chat's row from the last catalog update, so `rest` never detaches a chat the catalog would wake at once (`atWork`). */
  private readonly catalogRows = new Map<string, SessionRow>();
  private readonly attaches = new AttachQueue();
  private readonly observers = new Set<ThreadObserver>();
  private closed = false;

  /** `board` reads a chat's board when the thread opens: null for a chat with no board yet, undefined for a thread that is not a chat. */
  constructor(private readonly socketPath: string, private readonly catalog: Catalog, private readonly defaults: () => ChatDefaults,
    private readonly board: (id: string) => Promise<ChatBoard | null | undefined> = async () => undefined, idle: IdleDetach = {}) {
    this.dormant = new Dormancy(idle);
    this.sweeper = setInterval(() => this.sweep(), 30000);
    this.sweeper.unref();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, thread] of this.threads) {
      if (!this.pinned.has(id) && thread.listeners.size === 0 && thread.idleSince !== null && now - thread.idleSince > IDLE_MS) void this.dispose(id);
    }
    void this.rest().catch(error => { process.stderr.write(`rest: ${error instanceof Error ? error.message : String(error)}\n`); });
  }

  /**
   * Nothing in the thread's tree runs or waits: no turn, tool or session action, no queued input, no running or queued child but a silent one
   * (`silentSince`). At 08:17 KST on 10-14, 8 of 9 chat trees held a running or stale "working" child, so they never detached. An open tab
   * does not hold the chat: its open and close count as activity (`subscribe`), and it gets the snapshot when the chat attaches again. A tab
   * left open on frontend bro from 16:02Z on 10-14 held its 4.3 GB worker through a 74 min idle spell, and the worker stayed up 31 h.
   */
  private resting(thread: Thread): boolean {
    const { queue } = thread.state;
    return !isThreadBusy({ ...thread.state, children: unsilent(thread.state.children, this.dormant.now()) }) &&
      queue.steering.length === 0 && queue.followUp.length === 0 &&
      !this.resuming.has(thread.id) && !this.opening.has(thread.id);
  }

  /**
   * Detaches each pinned chat whose whole tree rested for the daemon's idleEvictionMinutes; it keeps its last state for `state` and `revive`.
   * A chat whose last catalog row is at work stays: the hub's own child records can miss a job the daemon shows running, and the catalog wake
   * then attached the chat again 0 min after the detach (SEO guy 22:56 and slack green guy 23:09 KST on 10-14, 6 of the last 10 detaches).
   * Just before the detach, the chat gets one notice line per silent child it was not told of (`silentLines`). A notice starts no turn, and it
   * lands before the detach time `woken` compares the session's activity with, so it does not wake the chat again. Then it saves each attached
   * chat's idle clock for the next service start.
   */
  private async rest(): Promise<void> {
    for (const id of this.pinned) {
      const thread = this.threads.get(id);
      if (!thread?.live || !this.resting(thread) || !await this.dormant.due(id, thread.activeAt)) continue;
      const row = this.catalogRows.get(id);
      if (row && this.dormant.atWork(row)) continue;
      for (const line of this.dormant.silentLines(thread.state.children, thread.state.messages)) {
        await this.notice(id, line).catch(error => { process.stderr.write(`rest ${id.slice(0, 8)}: silent child notice: ${error instanceof Error ? error.message : String(error)}\n`); });
      }
      const live = thread.live;
      if (!live || !this.resting(thread) || this.threads.get(id) !== thread) continue;
      this.dormant.sleep(id, this.dormant.now() - thread.activeAt, "detached");
      thread.flush();
      thread.live = null;
      live.unsubscribe();
      await live.connection.dispose().catch(() => {});
    }
    await this.dormant.save([...this.pinned].flatMap(id => { const thread = this.threads.get(id); return thread?.live ? [[id, thread.activeAt] as const] : []; }));
  }

  /** Closes the oldest unpinned threads of `kind` with no tab open over MAX_LIVE or MAX_SAVED; pinned threads do not count, so pins never push other threads out. */
  private evict(kind: "live" | "saved"): void {
    const candidates = [...this.threads.values()].filter(thread => (thread.live !== null) === (kind === "live") && thread.listeners.size === 0 && !this.pinned.has(thread.id))
      .sort((left, right) => left.touched - right.touched);
    const total = [...this.threads.values()].filter(thread => (thread.live !== null) === (kind === "live") && !this.pinned.has(thread.id)).length;
    const limit = kind === "live" ? MAX_LIVE : MAX_SAVED;
    for (const thread of candidates) {
      if (total - (candidates.indexOf(thread)) <= limit) break;
      void this.dispose(thread.id);
    }
  }

  /**
   * Keeps the thread attached while the service runs and resumes it after each daemon restart. Every chat is pinned, with no count limit:
   * the old cap of MAX_LIVE (8) left the 9th chat, Crawler VP, unpinned from 10-08 on, so after the 10-13 10:06Z daemon restart nothing
   * resumed it, its failed turn got no restart (`revive` reads only an attached thread), and it sat 1.8 h until an agent message woke it.
   */
  pin(id: string): void {
    this.pinned.add(id);
    this.unwatchCatalog ??= this.catalog.subscribe(event => {
      if (event.daemon !== "up") return;
      for (const row of event.sessions ?? []) if (this.pinned.has(row.id)) this.catalogRows.set(row.id, row);
      this.keepPinnedLive();
      for (const id of this.dormant.woken(event.sessions ?? [])) {
        void this.resume(id, true, "catalog").catch(error => { process.stderr.write(`wake ${id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}\n`); });
      }
    });
  }

  unpin(id: string): void {
    this.pinned.delete(id);
    this.pinRetry.delete(id);
    this.catalogRows.delete(id);
    this.dormant.forget(id);
  }

  /** Whether `rest` detached the pinned chat and nothing has woken it since. */
  isDormant(id: string): boolean { return this.dormant.has(id); }

  observe(observer: ThreadObserver): () => void {
    this.observers.add(observer);
    return () => { this.observers.delete(observer); };
  }

  private attached(thread: Thread): void {
    for (const observer of [...this.observers]) observer.live(thread.id, thread.state.children);
  }

  /** A change that shows work restarts the idle time; a silent child's repeated entry does not (`childrenStirred`), or its chat would never detach. */
  private childrenChanged(thread: Thread, before: readonly ChildAgent[]): void {
    if (childrenStirred(before, thread.state.children, this.dormant.now())) thread.activeAt = this.dormant.now();
    for (const observer of [...this.observers]) observer.children(thread.id, thread.state.children);
  }

  private turnEnded(thread: Thread): void {
    for (const observer of [...this.observers]) observer.idle(thread.id);
  }

  isLive(id: string): boolean { return Boolean(this.threads.get(id)?.live); }

  /** Whether the thread itself is mid-turn (streaming, a tool or command running, compacting, retrying). Running jobs alone do not count. */
  busy(id: string): boolean {
    const state = this.threads.get(id)?.state;
    return state ? isThreadBusy({ ...state, children: [] }) : false;
  }

  /**
   * Whether the thread runs a turn now. Unlike `busy`, input waiting in its queue does not count: after a failed turn that input can sit there
   * with nothing running, and the chat then needs a restart, not more waiting.
   */
  running(id: string): boolean {
    const state = this.threads.get(id)?.state;
    return state ? isTurnRunning(state.info) : false;
  }

  /** When an attached thread's streaming turn last sent an event; null when no turn streams or it compacts, runs a bash or waits on a provider retry. */
  quietSince(id: string): number | null {
    const thread = this.threads.get(id);
    const info = thread?.live ? thread.state.info : undefined;
    return info && info.isStreaming && !info.isCompacting && !info.isBashRunning && !(info.retryAttempt > 0) ? thread!.lastEventAt : null;
  }

  /** Re-runs the session's extensions and rebuilds its tools and prompt, so a long-lived chat picks up a newer extension build. */
  async reload(id: string): Promise<void> {
    const { live } = await this.requireLive(id, "reload");
    await live.connection.reload();
  }

  /**
   * `reload` for a job, attached or not, through the daemon: only when the daemon shows its session doing nothing (`isSessionActive` is false:
   * no turn, retry, compaction, queued action or background work in its Python kernel, which the reload's kernel rebuild would drop).
   */
  async reloadIdle(id: string): Promise<"reloaded" | "busy" | "saved"> {
    const activeSessionId = this.threads.get(id)?.live?.activeSessionId ?? (await this.summary(id)).activeSessionId;
    if (activeSessionId === undefined) return "saved";
    if (await this.daemonBusy(activeSessionId)) return "busy";
    const response = await timedWorkerStart(`reload ${id.slice(0, 8)}`, () => this.catalog.client.request({ type: "reload", activeSessionId }, DAEMON_WORKER_START_MS, { recoverable: false }));
    if (!response.success) throw new ThreadError(502, response.error);
    return "reloaded";
  }

  /**
   * Whether the daemon shows the resident session doing anything now: a turn, a tool call, a retry, a compaction, queued input, or a
   * background bash in its Python kernel (`isSessionActive`). False for a session that is not resident.
   */
  async sessionActive(id: string): Promise<boolean> {
    const activeSessionId = this.threads.get(id)?.live?.activeSessionId ?? (await this.summary(id)).activeSessionId;
    return activeSessionId !== undefined && await this.daemonBusy(activeSessionId);
  }

  private async daemonBusy(activeSessionId: string): Promise<boolean> {
    await this.catalog.connect();
    const state = await this.catalog.client.request({ type: "get_state", activeSessionId }, undefined, { recoverable: false });
    if (!state.success) throw new ThreadError(502, state.error);
    const now = state.data as Partial<Pick<SessionSummary, "isSessionActive" | "isStreaming" | "isCompacting" | "isBashRunning">>;
    return now.isSessionActive !== false || now.isStreaming === true || now.isCompacting === true || now.isBashRunning === true;
  }

  /**
   * On every catalog update with the daemon up, a pinned thread that lost its attachment (daemon restart, worker exit) is resumed again, as a
   * background attach (`AttachQueue`), so after a restart the pins come back two at a time and an open tab or an owner send goes first. A
   * failed resume waits PIN_RETRY_MS, doubling per failure. One archived outside this server (the terminal agents view) is unpinned instead,
   * so the pin never brings an archived session back. A dormant chat is skipped, and one that rested on disk (`restedOnDisk`) opens saved.
   */
  private keepPinnedLive(): void {
    if (this.closed) return;
    const now = Date.now();
    for (const id of this.pinned) {
      if (this.threads.get(id)?.live || this.dormant.has(id) || this.pinning.has(id) || now < (this.pinRetry.get(id)?.at ?? 0)) continue;
      this.pinning.add(id);
      void (async () => {
        const summary = await this.catalog.summary(id);
        if (!summary || summary.lifecycle === "archived") { this.unpin(id); return; }
        const rested = this.threads.has(id) ? null : await this.dormant.restedOnDisk(summary, () => this.catalog.childActivity(id));
        if (rested !== null) {
          await this.open(id, true, false);
          this.dormant.sleep(id, rested, "left detached");
          this.pinRetry.delete(id);
          return;
        }
        await this.resume(id, true, "pin");
        this.pinRetry.delete(id);
      })().catch(error => {
        const failures = (this.pinRetry.get(id)?.failures ?? 0) + 1;
        const wait = Math.min(PIN_RETRY_MS * 2 ** (failures - 1), PIN_RETRY_MAX_MS);
        this.pinRetry.set(id, { at: Date.now() + wait, failures });
        process.stderr.write(`pin ${id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}; next try in ${Math.round(wait / 1000)} s\n`);
      }).finally(() => { this.pinning.delete(id); });
    }
  }

  private async dispose(id: string): Promise<void> {
    const thread = this.threads.get(id);
    if (!thread) return;
    this.threads.delete(id);
    this.dormant.forget(id);
    thread.flush();
    if (thread.live) {
      thread.live.unsubscribe();
      await thread.live.connection.dispose().catch(() => {});
      thread.live = null;
    }
  }

  private async summary(id: string): Promise<SessionSummary> {
    const summary = await this.catalog.summary(id);
    if (!summary) throw new ThreadError(404, "This thread is not in the Prime Agent catalog.");
    return summary;
  }

  private async attach(activeSessionId: string): Promise<DaemonAgentConnection> {
    const client = new DaemonClient(this.socketPath);
    try {
      await client.connect(3000);
      await client.waitForHello(3000);
      return await DaemonAgentConnection.attach(client, activeSessionId, { directTransport: false, supportsExtensionUi: false, sendClientEnv: false, ownedSession: false, closeClientOnDispose: true });
    } catch (error) { client.close(); throw error; }
  }

  private async liveSnapshot(connection: DaemonAgentConnection, summary: SessionSummary | undefined, full = false): Promise<ThreadSnapshot> {
    const [snapshot, queue] = await Promise.all([connection.getInitialSnapshot(), connection.getQueue()]);
    const history = await this.compactedHistory(snapshot.messages, summary, full);
    const messages = this.projector.messages([...history.messages, ...snapshot.messages]);
    const streaming = snapshot.streamingMessage?.role === "assistant" ? this.projector.assistant(snapshot.streamingMessage) : null;
    return { kind: "live", info: projectInfo(snapshot.state, summary, this.catalogModel(snapshot.state.model ?? null)), messages, streaming, queue: { steering: [...queue.steering], followUp: [...queue.followUp] },
      children: (snapshot.children ?? []).map(projectChild), tools: [], retry: null,
      runStartedAt: snapshot.state.isStreaming ? runStartedAtFromMessages(messages) : null, ...(history.older ? { older: true } : {}) };
  }

  private branch(summary: SessionSummary): SessionEntry[] {
    const manager = SessionManager.inMemory(summary.cwd);
    manager.setSessionFile(this.sessionFile(summary));
    if (manager.getSessionId() !== summary.sessionId) throw new ThreadError(409, "The saved thread file changed. Refresh the list.");
    return manager.getBranch();
  }

  private sessionFile(summary: SessionSummary): string {
    if (!summary.sessionFile) throw new ThreadError(409, "This saved thread has no session file.");
    if (!existsSync(summary.sessionFile)) {
      void this.catalog.refresh().catch(() => {});
      throw new ThreadError(404, "The session file for this thread was moved or deleted after Prime Agent scanned it: " + summary.sessionFile);
    }
    return summary.sessionFile;
  }

  /**
   * The branch a thread shows: its tail (`readBranchTail`), so an open costs the same for a 64 MB transcript as for a small one, or the whole
   * branch once the owner asked for older messages (`older`). `older` in the result: the file holds entries before the ones returned.
   */
  private async history(summary: SessionSummary, full: boolean): Promise<{ entries: SessionEntry[]; older: boolean }> {
    const file = this.sessionFile(summary);
    const tail = full ? undefined : await readBranchTail(file);
    if (!tail) return { entries: this.branch(summary), older: false };
    if (tail.sessionId !== summary.sessionId) throw new ThreadError(409, "The saved thread file changed. Refresh the list.");
    return { entries: tail.entries, older: !tail.whole };
  }

  /** Turns a compaction removed from a live context, read back from the session file: the ones in its tail, or all of them after `older`. */
  private async compactedHistory(live: readonly AgentMessage[], summary: SessionSummary | undefined, full: boolean): Promise<{ messages: AgentMessage[]; older: boolean }> {
    if (live[0]?.role !== "compactionSummary" || !summary?.sessionFile) return { messages: [], older: false };
    try {
      const { entries, older } = await this.history(summary, full);
      return { messages: historyMessages(compactedEntries(entries, !older)), older };
    } catch (error) {
      process.stderr.write(`history ${summary.sessionId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}\n`);
      return { messages: [], older: false };
    }
  }

  private async savedMessages(summary: SessionSummary, full: boolean): Promise<{ messages: AgentMessage[]; info: ThreadInfo; older: boolean }> {
    const { entries, older } = await this.history(summary, full);
    const messages = historyMessages(entries);
    let name: string | undefined;
    let thinkingLevel: ThinkingLevel = "off";
    let ran: { provider: string; id: string } | null = null;
    for (const entry of entries) {
      if (entry.type === "session_info" && entry.name?.trim()) name = entry.name;
      if (entry.type === "thinking_level_change") thinkingLevel = entry.thinkingLevel as ThinkingLevel;
      if (entry.type === "model_change") ran = { provider: entry.provider, id: entry.modelId };
      if (entry.type === "message" && entry.message.role === "assistant" && entry.message.provider && entry.message.model) ran = { provider: entry.message.provider, id: entry.message.model };
    }
    name ??= summary.sessionName?.trim() || undefined;
    const info: ThreadInfo = { sessionId: summary.sessionId, ...(name ? { name } : {}), cwd: summary.cwd, model: this.catalogModel(summary.model ?? ran),
      thinkingLevel: summary.thinkingLevel ?? thinkingLevel, availableThinkingLevels: [], isStreaming: false, isCompacting: false, isBashRunning: false, retryAttempt: 0,
      messageCount: older ? Math.max(summary.messageCount ?? 0, messages.length) : messages.length, context: null, usage: sessionUsage(summary.usage), sessionAction: null, queuedActions: 0 };
    return { messages, info, older };
  }

  private async savedSnapshot(summary: SessionSummary, full: boolean): Promise<ThreadSnapshot> {
    const { messages, info, older } = await this.savedMessages(summary, full);
    return { kind: "saved", info, messages: this.projector.messages(messages), streaming: null, queue: { steering: [], followUp: [] }, children: [], tools: [], retry: null,
      runStartedAt: null, ...(older ? { older: true } : {}) };
  }

  /** The owner's Show earlier: the thread reads its whole session file once, and keeps the whole branch on every later snapshot until it closes. */
  async older(id: string): Promise<void> {
    const thread = await this.open(id);
    if (thread.full) return;
    thread.full = true;
    if (thread.live) { await this.resnapshot(thread); return; }
    const snapshot = await this.savedSnapshot(await this.summary(id), true);
    if (thread.live) return;
    thread.broadcast({ type: "snapshot", snapshot });
  }

  /**
   * A model's full entry by provider and id. The 0.10.0 daemon names a session's model (state and summary) by id, name and provider only, and
   * a saved session's summary may carry none, so the session file's last model stands in. The entry comes from the last model catalog read,
   * else from a full model (a 0.9.8 daemon sends one), else the id stands in.
   */
  private catalogModel(ran: { provider: string; id: string; name?: string } | null): ModelInfo | null {
    if (!ran) return null;
    const known = this.knownModels.get(ran.provider + "/" + ran.id);
    if (known) return known;
    if (Array.isArray((ran as { input?: unknown }).input)) return projectModel(ran as Parameters<typeof projectModel>[0]);
    if (!this.knownModels.size) void this.models(null).catch(() => {});
    return { provider: ran.provider, id: ran.id, name: ran.name ?? ran.id, input: ["text"], contextWindow: 0, reasoning: false };
  }

  /**
   * An attach restarts the quiet time: a chat that woke from dormancy mid-turn read as hung for its dormant minutes and lost that turn (10-14 00:47Z).
   * Its idle clock restarts too, except at the first attach after a service start, which keeps the clock saved before it (`attachedAt`).
   */
  private bind(thread: Thread, connection: DaemonAgentConnection, activeSessionId: string): void {
    thread.activeAt = this.dormant.attachedAt(thread.id);
    thread.lastEventAt = Date.now();
    const unsubscribe = connection.subscribe(event => { void this.onNativeEvent(thread, event); });
    thread.live = { connection, activeSessionId, unsubscribe };
  }

  private async refreshInfo(thread: Thread): Promise<void> {
    const live = thread.live;
    if (!live) return;
    const [state, summary] = await Promise.all([live.connection.getState(), this.catalog.summary(thread.id)]);
    if (thread.live !== live) return;
    thread.broadcast({ type: "info", info: projectInfo(state, summary, this.catalogModel(state.model ?? null)) });
  }

  private async refreshQueue(thread: Thread): Promise<void> {
    const live = thread.live;
    if (!live) return;
    const queue = await live.connection.getQueue();
    if (thread.live !== live) return;
    thread.broadcast({ type: "queue", queue: { steering: [...queue.steering], followUp: [...queue.followUp] } });
  }

  private async resnapshot(thread: Thread): Promise<void> {
    const live = thread.live;
    if (!live) return;
    const snapshot = await this.liveSnapshot(live.connection, await this.catalog.summary(thread.id), thread.full);
    if (thread.live !== live) return;
    thread.flush();
    thread.broadcast({ type: "snapshot", snapshot });
  }

  private async onNativeEvent(thread: Thread, event: NativeEvent): Promise<void> {
    try {
      switch (event.type) {
        case "session_event": {
          thread.lastEventAt = Date.now();
          // A child's entry changes its chat's idle time only through `childrenChanged`: the daemon unloading an idle job or a deleted job's
          // cancel is an rlm_child_update too, and it reset the clock of every VP chat, so none detached (10-14).
          if (event.event.type !== "rlm_child_update") thread.activeAt = this.dormant.now();
          const projected = this.projector.event(event.event);
          if (projected) thread.coalesce(projected, UPDATE_COALESCE_MS);
          const native = event.event.type;
          if (native === "agent_end") this.turnEnded(thread);
          if (native === "agent_start" || native === "agent_end" || (native === "message_end" && event.event.message.role === "user")) await this.refreshQueue(thread);
          if (native === "compaction_end" && !event.event.aborted) await this.resnapshot(thread);
          if (native === "agent_end" || native === "compaction_end" || native === "auto_retry_end" || native === "thinking_level_changed" || native === "session_info_changed") await this.refreshInfo(thread);
          return;
        }
        case "session_resynced":
        case "session_replaced":
          await this.resnapshot(thread);
          return;
        case "connection_status":
          thread.broadcast({ type: "status", connection: event.status === "connected" ? "connected" : "reconnecting", ...(event.error ? { error: event.error } : {}) });
          if (event.status === "connected") await this.resnapshot(thread);
          return;
        case "closed":
          thread.broadcast({ type: "status", connection: "closed", ...(event.error ? { error: event.error } : {}) });
          await this.dispose(thread.id);
          this.catalog.forget(thread.id);
          void this.catalog.refresh().catch(() => {});
          return;
        default: return;
      }
    } catch (error) {
      thread.broadcast({ type: "status", connection: thread.state.connection, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * `background` (a pin coming back, a stall check) waits its turn in the attach queue; a foreground open promotes a waiting one. `attach`
   * false reads the saved file even when the session is resident. A dormant chat comes back as its cached thread with no attach.
   */
  async open(id: string, background = false, attach = true): Promise<Thread> {
    if (this.closed) throw new ThreadError(410, "Chat is stopping.");
    const cached = this.threads.get(id);
    if (cached) { cached.touched = Date.now(); return cached; }
    const pending = this.opening.get(id);
    if (pending) { if (!background) this.attaches.promote(id); return pending; }
    const promise = (async () => {
      const started = performance.now();
      const summary = await this.summary(id);
      let thread: Thread;
      const marks: string[] = [];
      const mark = (label: string, from: number) => { marks.push(`${label} ${Math.round(performance.now() - from)}ms`); return performance.now(); };
      let at = mark("catalog", started);
      const activeSessionId = attach ? liveSessionId(summary) : undefined;
      const live = activeSessionId === undefined ? null : await this.attaches.run(id, background, async () => {
        at = mark("queue", at);
        const connection = await this.attach(activeSessionId).catch(error => {
          if (!(error instanceof Error && error.message.startsWith(UNKNOWN_ACTIVE))) throw error;
          marks.push(`listed active but the daemon has no ${activeSessionId}: read saved`);
          return null;
        });
        if (!connection) return null;
        at = mark("attach", at);
        try { return { connection, snapshot: await this.liveSnapshot(connection, summary) }; }
        catch (error) { await connection.dispose().catch(() => {}); throw error; }
      });
      if (activeSessionId !== undefined && live) {
        this.evict("live");
        thread = new Thread(id, live.snapshot, (candidate, before) => this.childrenChanged(candidate, before));
        at = mark("snapshot+project", at);
        this.bind(thread, live.connection, activeSessionId);
      } else {
        this.evict("saved");
        thread = new Thread(id, await this.savedSnapshot(summary, false), (candidate, before) => this.childrenChanged(candidate, before));
        mark("read+project", at);
        thread.sessionFile = summary.sessionFile;
      }
      const board = await this.board(id).catch(error => { process.stderr.write(`board ${id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}\n`); return undefined; });
      if (board !== undefined) thread.state = { ...thread.state, board };
      this.threads.set(id, thread);
      process.stderr.write(`open ${id.slice(0, 8)} ${thread.live ? "live" : "saved"} ${thread.state.messages.length} messages: ${marks.join(", ")}, total ${Math.round(performance.now() - started)}ms\n`);
      if (thread.live) this.attached(thread);
      return thread;
    })().finally(() => { this.opening.delete(id); });
    this.opening.set(id, promise);
    return promise;
  }

  /**
   * `background` for a listener no person waits on (the Slack bridge): its attach waits its turn in the queue, and it neither wakes a dormant
   * chat nor counts as activity. A tab's open and close count as activity, so the chat rests its idle time from the later one.
   */
  async subscribe(id: string, listener: Listener, background = false): Promise<() => void> {
    const thread = await this.open(id, background);
    thread.listeners.add(listener);
    if (!background) thread.activeAt = this.dormant.now();
    thread.idleSince = null;
    const { connection: _connection, error: _error, ...snapshot } = thread.state;
    listener({ type: "snapshot", snapshot });
    if (thread.state.connection !== "connected") listener({ type: "status", connection: thread.state.connection, ...(thread.state.error ? { error: thread.state.error } : {}) });
    if (!background && this.dormant.has(id)) void this.resume(id, false, "open").catch(error => { process.stderr.write(`wake ${id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}\n`); });
    return () => {
      thread.listeners.delete(listener);
      if (thread.listeners.size === 0) thread.idleSince = Date.now();
      if (!background) thread.activeAt = this.dormant.now();
    };
  }

  state(id: string): ThreadState | undefined { return this.threads.get(id)?.state; }

  /** A chat's board changed (either writer): its open thread's listeners get a board event. A closed thread reads the file when it opens. */
  setBoard(id: string, board: ChatBoard): void {
    const thread = this.threads.get(id);
    const current = thread?.state.board;
    if (!thread || (current && current.rev === board.rev && current.updatedAt === board.updatedAt)) return;
    thread.broadcast({ type: "board", board });
  }

  /** What the server waits for before it restarts a chat's failed owner turn; the open thread's listeners get a wait event when it changes. */
  setWait(id: string, wait: ChatWait | null): void {
    const thread = this.threads.get(id);
    if (!thread || JSON.stringify(thread.state.wait ?? null) === JSON.stringify(wait)) return;
    thread.broadcast({ type: "wait", wait });
  }

  /** The thread's state for a stall check, attaching it first; null for a thread that is not live. A dormant chat stays detached and reads null. */
  async view(id: string): Promise<ThreadState | null> {
    if (this.dormant.has(id)) return null;
    const thread = await this.open(id, true);
    return thread.live ? thread.state : null;
  }

  /** `trigger` names the call in the wake line when it attaches a dormant chat. */
  private async requireLive(id: string, trigger: string): Promise<{ thread: Thread; live: Live }> {
    const thread = this.dormant.has(id) ? await this.resume(id, false, trigger) : await this.open(id);
    if (!thread.live) throw new ThreadError(409, "Reply to resume this thread first.");
    return { thread, live: thread.live };
  }

  /**
   * Makes a saved thread live, once per thread at a time: a pinned chat coming back after a daemon restart and the chat's turn restart (or an
   * owner send) can ask together, and two attaches would both subscribe, so every later event reached the thread twice and the feed drew each
   * message twice. A foreground ask joins a background one and moves it ahead in the attach queue. `trigger` names the caller in the wake
   * line a dormant chat logs.
   */
  resume(id: string, background = false, trigger = "resume"): Promise<Thread> {
    this.dormant.wake(id, trigger);
    if (!background) this.attaches.promote(id);
    const running = this.resuming.get(id);
    if (running) { if (!background) running.ask.foreground = true; return running.promise; }
    const ask = { foreground: !background };
    const promise = this.resumeOnce(id, ask).finally(() => { this.resuming.delete(id); });
    this.resuming.set(id, { ask, promise });
    return promise;
  }

  private async resumeOnce(id: string, ask: { foreground: boolean }): Promise<Thread> {
    const thread = await this.open(id, !ask.foreground);
    if (thread.live) return thread;
    const summary = await this.summary(id);
    if (liveSessionId(summary) === undefined) {
      if (!summary.sessionFile) throw new ThreadError(409, "This thread has no session file to resume.");
      await this.catalog.connect();
      // The session's own folder: without it the daemon starts the worker in the daemon's folder and the thread reports that as its workspace.
      // A folder that is gone resumes in the daemon's folder rather than not at all.
      const config = await stat(summary.cwd).then(found => found.isDirectory() ? { cwd: summary.cwd } : {}, () => ({}));
      const sessionPath = summary.sessionFile;
      const response = await timedWorkerStart(`resume ${id.slice(0, 8)}`, () => this.catalog.client.request({ type: "create", lifecycle: "resident", sessionPath, config }, DAEMON_WORKER_START_MS, { recoverable: false }));
      if (!response.success) throw new ThreadError(502, response.error);
    }
    await this.catalog.refresh();
    const resumed = await this.summary(id);
    const activeSessionId = liveSessionId(resumed);
    if (activeSessionId === undefined) throw new ThreadError(502, "Prime Agent did not resume this thread.");
    const { connection, snapshot } = await this.attaches.run(id, !ask.foreground, async () => {
      const connection = await this.attach(activeSessionId);
      try { return { connection, snapshot: await this.liveSnapshot(connection, resumed, thread.full) }; }
      catch (error) { await connection.dispose().catch(() => {}); throw error; }
    });
    this.evict("live");
    this.bind(thread, connection, activeSessionId);
    thread.broadcast({ type: "snapshot", snapshot });
    this.attached(thread);
    return thread;
  }

  /** `kind: "chat"` sets the extension flag the user-history extension turns into the session's chat marker at its first session_start. */
  async create(input: { cwd: string; provider?: string; modelId?: string; thinkingLevel?: ThinkingLevel; name?: string; kind?: "chat" }): Promise<Thread> {
    await this.catalog.connect();
    const response = await timedWorkerStart(`create ${input.name ?? input.cwd}`, () => this.catalog.client.request({ type: "create", lifecycle: "resident", ...(input.name ? { name: input.name } : {}), config: { cwd: input.cwd,
      ...(input.provider && input.modelId ? { provider: input.provider, model: input.modelId } : {}), ...(input.thinkingLevel ? { thinking: input.thinkingLevel } : {}),
      ...(input.kind === "chat" ? { extensionFlagValues: { [CHAT_FLAG]: true } } : {}) } }, DAEMON_WORKER_START_MS, { recoverable: false }));
    if (!response.success) throw new ThreadError(502, response.error);
    const data = response.data;
    if (typeof data !== "object" || data === null || !("sessionId" in data) || typeof data.sessionId !== "string" || !("activeSessionId" in data) || typeof data.activeSessionId !== "string") {
      throw new ThreadError(502, "Prime Agent returned no session for the new thread.");
    }
    this.evict("live");
    const connection = await this.attach(data.activeSessionId);
    let thread: Thread;
    try {
      thread = new Thread(data.sessionId, await this.liveSnapshot(connection, data as SessionSummary), (candidate, before) => this.childrenChanged(candidate, before));
      this.bind(thread, connection, data.activeSessionId);
    } catch (error) { await connection.dispose().catch(() => {}); throw error; }
    this.threads.set(thread.id, thread);
    void this.catalog.refresh().catch(() => {});
    this.attached(thread);
    return thread;
  }

  async prompt(id: string, input: { message: string; images: ChatImage[]; mode: SendMode }, trigger = "prompt"): Promise<void> {
    const thread = await this.resume(id, false, trigger);
    const live = thread.live!;
    if (input.images.length) {
      const [state, catalog] = await Promise.all([live.connection.getState(), live.connection.getModelCatalog()]);
      const model = state.model && catalog.models.find(candidate => candidate.provider === state.model!.provider && candidate.id === state.model!.id);
      if (!model?.input.includes("image")) throw new ThreadError(400, "Choose a model that accepts images.");
    }
    if (input.message.trimStart().startsWith("/")) {
      const invocation = input.message.trimStart().split(/\s/, 1)[0]?.slice(1);
      const commands = await this.commands(id);
      const command = commands.find(command => command.name === invocation);
      if (!command) throw new ThreadError(400, "Unknown slash command. The draft was kept.");
      if (command.source === "extension") throw new ThreadError(400, "Use this extension command in the Prime Agent terminal. Browser dialogs are unavailable.");
    }
    await live.connection.prompt(input.message, { source: "interactive", streamingBehavior: input.mode, queueIfBusy: true, ...(input.images.length ? { images: input.images } : {}) });
    void this.refreshQueue(thread).catch(() => {});
  }

  /**
   * A new turn for a chat whose last turn failed. `abort` first stops a provider retry that holds the turn (and suspends the input pump, which
   * the resume reopens). After a failed turn a steer can sit in the session's queue with its input pump stopped, so the
   * check-ins and notices sent to it wait unseen until the owner writes. This sends the text as a steer, then resumes the queued input, so the
   * text (and anything queued before it) starts a turn now.
   */
  async restart(id: string, message: string, abort = false): Promise<void> {
    if (abort) await this.abort(id, "restart");
    await this.prompt(id, { message, images: [], mode: "steer" }, "restart");
    await this.resumeQueue(id);
  }

  /** A line in the transcript that starts no turn (the feed shows it as a notice). Sent only between turns: in a running turn it would join it as input. */
  async notice(id: string, text: string): Promise<void> {
    const { live } = await this.requireLive(id, "notice");
    await live.connection.appendCustomMessage({ customType: CHAT_NOTICE, content: text, display: true });
  }

  async abort(id: string, trigger = "abort"): Promise<void> {
    const { live } = await this.requireLive(id, trigger);
    const state = await live.connection.getState();
    if (state.isCompacting) await live.connection.abortCompaction();
    if (state.isBashRunning) await live.connection.abortBash();
    if (state.retryAttempt) await live.connection.abortRetry();
    await live.connection.abort();
  }

  /**
   * A native abort suspends the session's input pump until the next human prompt, and an agent message to an idle suspended session is refused.
   * A chat gets this right after Stop, so job reports keep arriving; "No queued work to resume" means the pump is open with nothing waiting.
   */
  async resumeQueue(id: string): Promise<void> {
    const { live } = await this.requireLive(id, "resume_queue");
    await this.catalog.connect();
    const response = await this.catalog.client.request({ type: "resume_queue", activeSessionId: live.activeSessionId }, undefined, { recoverable: false });
    if (!response.success && response.error !== "No queued work to resume") throw new ThreadError(502, response.error);
  }

  /**
   * Deletes a finished subagent of the thread the way `rlm.delete_subagent` does, so its worker and Python kernel stop holding memory. A dormant
   * chat refuses: on 10-14 the job cleanup after a service start woke slack green guy 7 s after it was left detached, 236 min idle.
   */
  async deleteSubagent(id: string, childId: string): Promise<SubagentDelete> {
    if (this.dormant.has(id)) throw new ThreadError(409, "The chat is dormant; its finished jobs go with its worker, or at the next service start after it wakes.");
    const { live } = await this.requireLive(id, "delete_subagent");
    await this.catalog.connect();
    const response = await this.catalog.client.request({ type: "delete_rlm_subagent", activeSessionId: live.activeSessionId, childId }, 30000, { recoverable: false });
    if (!response.success) throw new ThreadError(502, response.error);
    const data = response.data as { deleted?: boolean; reason?: string } | undefined;
    if (data?.reason === "running") return "running";
    return data?.deleted === true ? "deleted" : "not_held";
  }

  /** `all` batches every queued steer into one turn; `one-at-a-time` runs each as its own turn. Runtime state: it resets on every re-create. */
  async setSteeringMode(id: string, mode: "all" | "one-at-a-time"): Promise<void> {
    const { live } = await this.requireResumed(id, "steering");
    await live.connection.setSteeringMode(mode);
  }

  /** The attached session's heartbeat prompt; undefined when it has none. */
  async heartbeat(id: string): Promise<string | undefined> {
    const { live } = await this.requireLive(id, "heartbeat");
    return (await live.connection.getHeartbeat())?.prompt;
  }

  async clearHeartbeat(id: string): Promise<void> {
    const { live } = await this.requireLive(id, "heartbeat");
    await live.connection.updateHeartbeat("clear");
  }

  /**
   * Archive the way the terminal agents view deactivates an agent (Ctrl+X): tell open tabs, drop this server's own attachment, kill the resident
   * session ("Unknown active session" means it already ended), record the native archived state in its session file, and hide the row at once.
   */
  async archive(id: string): Promise<void> {
    const summary = await this.catalog.summary(id);
    if (!summary) throw new ThreadError(404, "Thread not found.");
    this.unpin(id);
    this.threads.get(id)?.broadcast({ type: "status", connection: "closed", error: "This thread was archived." });
    await this.dispose(id);
    if (summary.activeSessionId) {
      await this.catalog.connect();
      const response = await this.catalog.client.request({ type: "kill", activeSessionId: summary.activeSessionId }, 30000, { recoverable: false });
      if (!response.success && !response.error.startsWith(UNKNOWN_ACTIVE)) {
        if (!STOP_PENDING.test(response.error)) throw new ThreadError(502, response.error);
        this.finishKill(id, summary.activeSessionId);
      }
    }
    this.setSessionState(summary, "archived");
    this.catalog.holdLifecycle(id, "archived");
    this.catalog.forget(id);
    await this.catalog.refresh();
  }

  /** The supervisor gave up waiting (its graceful window is 2 s) and keeps stopping the worker; if it is still listed a little later, ask once more. */
  private finishKill(id: string, activeSessionId: string): void {
    setTimeout(() => {
      void (async () => {
        await this.catalog.refresh().catch(() => {});
        if ((await this.catalog.summary(id))?.activeSessionId !== activeSessionId) return;
        await this.catalog.client.request({ type: "kill", activeSessionId }, 30000, { recoverable: false }).catch(() => {});
        await this.catalog.refresh().catch(() => {});
      })();
    }, 5000).unref();
  }

  /** Undo an archive: the thread comes back as a saved thread that resumes on the next reply. */
  async unarchive(id: string): Promise<void> {
    const summary = await this.catalog.summary(id);
    if (!summary) throw new ThreadError(404, "Thread not found.");
    this.setSessionState(summary, "active");
    this.catalog.holdLifecycle(id, "active");
    this.catalog.forget(id);
    await this.catalog.refresh();
  }

  /** Skips a file deleted since the listing: SessionManager.open would recreate a stub at the old path. */
  private setSessionState(summary: SessionSummary, status: "archived" | "active"): void {
    if (!summary.sessionFile || !existsSync(summary.sessionFile)) return;
    const manager = SessionManager.open(summary.sessionFile);
    const current = manager.getSessionState()?.status;
    if (status === "archived" ? current !== "archived" : current === "archived") manager.appendSessionState({ status });
  }

  async rename(id: string, name: string): Promise<void> {
    const thread = this.dormant.has(id) ? await this.resume(id, false, "rename") : await this.open(id);
    if (thread.live) { await thread.live.connection.setSessionName(name); await this.refreshInfo(thread); return; }
    if (!thread.sessionFile) throw new ThreadError(409, "This thread has no session file to rename.");
    const owner = [...this.threads.values()].find(candidate => candidate.live) ?? null;
    if (!owner?.live) throw new ThreadError(409, "Open a live thread first, then rename saved threads.");
    await owner.live.connection.renameSavedSession(thread.sessionFile, name);
    thread.broadcast({ type: "info", info: { ...thread.state.info, name } });
    void this.catalog.refresh().catch(() => {});
  }

  /** A saved thread resumes first, so its model and effort can change before the next reply. A running one changes at once and the next request uses it. */
  private async requireResumed(id: string, trigger: string): Promise<{ thread: Thread; live: Live }> {
    const thread = await this.resume(id, false, trigger);
    if (!thread.live) throw new ThreadError(502, "Prime Agent did not resume this thread.");
    return { thread, live: thread.live };
  }

  async setModel(id: string, provider: string, modelId: string): Promise<void> {
    const { thread, live } = await this.requireResumed(id, "model");
    await live.connection.setModel(provider, modelId);
    await this.refreshInfo(thread);
  }

  async setThinking(id: string, level: string): Promise<void> {
    const { thread, live } = await this.requireResumed(id, "thinking");
    const state = await live.connection.getState();
    const nativeLevel = state.availableThinkingLevels.find(value => value === level);
    if (!nativeLevel) throw new ThreadError(400, "Choose an effort level this model supports.");
    await live.connection.setThinkingLevel(nativeLevel);
    await this.refreshInfo(thread);
  }

  async mutateQueue(id: string, input: { lane: "steering" | "followUp"; index: number; expectedText: string; text?: string }): Promise<string> {
    const { thread, live } = await this.requireLive(id, "queue_edit");
    const status = await live.connection.mutateQueuedMessage(input.lane, input.index, input.expectedText,
      input.text === undefined ? { type: "delete" } : { type: "replace", text: input.text, lane: input.lane });
    await this.refreshQueue(thread);
    return status;
  }

  async models(id: string | null): Promise<ModelCatalog> {
    return this.withConnection(id, (connection, thread) => this.catalogFrom(connection, thread));
  }

  /** The thread's own connection, or any live one so the new-chat screen and saved threads can read the catalog and commands. */
  private async withConnection<T>(id: string | null, use: (connection: DaemonAgentConnection, thread: Thread | null) => Promise<T>): Promise<T> {
    const thread = id ? await this.open(id) : null;
    const live = thread?.live ?? [...this.threads.values()].find(candidate => candidate.live)?.live ?? null;
    if (live) return use(live.connection, thread?.live ? thread : null);
    const first = (await this.liveSummaries())[0];
    if (!first?.activeSessionId) throw new ThreadError(409, "Open a live thread once so models and commands can load.");
    const connection = await this.attach(first.activeSessionId);
    try { return await use(connection, null); } finally { await connection.dispose().catch(() => {}); }
  }

  private async liveSummaries(): Promise<SessionSummary[]> {
    await this.catalog.refresh();
    const rows = await this.catalog.rows();
    const summaries: SessionSummary[] = [];
    for (const row of rows) if (row.kind === "live") { const summary = await this.catalog.summary(row.id); if (summary?.activeSessionId) summaries.push(summary); }
    return summaries;
  }

  /** A thread reports its own model and effort. With no thread the catalog carries the Prime Agent defaults, which a new session starts with. */
  private async catalogFrom(connection: DaemonAgentConnection, thread: Thread | null): Promise<ModelCatalog> {
    const [catalog, state] = await Promise.all([connection.getModelCatalog(), connection.getState()]);
    const models = catalog.models.map(projectModel);
    for (const model of models) this.knownModels.set(model.provider + "/" + model.id, model);
    const shared = { models, configuredProviders: [...catalog.configuredProviders] };
    if (thread) return { ...shared, current: this.catalogModel(state.model ?? null), thinkingLevel: state.thinkingLevel, availableThinkingLevels: [...state.availableThinkingLevels] };
    const defaults = this.defaults();
    const current = models.find(model => model.provider === defaults.provider && model.id === defaults.modelId) ?? null;
    const availableThinkingLevels = current?.thinkingLevels ?? [];
    return { ...shared, current, thinkingLevel: defaults.thinkingLevel && availableThinkingLevels.includes(defaults.thinkingLevel) ? defaults.thinkingLevel : null, availableThinkingLevels };
  }

  async commands(id: string | null): Promise<Command[]> {
    return this.withConnection(id, async connection => {
      const [commands, resources] = await Promise.all([connection.getCommands(), connection.getResourceSnapshot()]);
      const result: Command[] = [...SESSION_COMMANDS, ...commands.map(({ name, description, source, argumentHint }): Command => ({ name, source, ...(description ? { description } : {}), ...(argumentHint ? { argumentHint } : {}) }))];
      for (const skill of resources.skills) if (!result.some(command => command.source === "skill" && command.name === "skill:" + skill.name)) {
        result.push({ name: "skill:" + skill.name, ...(skill.description ? { description: skill.description } : {}), source: "skill" });
      }
      return result;
    });
  }

  async stats(id: string): Promise<ThreadStats> {
    const { live } = await this.requireLive(id, "stats");
    const stats = await live.connection.getSessionStats();
    return { tokens: { ...stats.tokens }, cost: stats.cost };
  }

  private async rawMessages(id: string): Promise<AgentMessage[]> {
    const thread = await this.open(id);
    if (thread.live) return thread.live.connection.getMessages();
    return (await this.savedMessages(await this.summary(id), thread.full)).messages;
  }

  async toolOutput(id: string, toolCallId: string): Promise<{ toolCallId: string; toolName: string; arguments: unknown; output: string; isError: boolean | null }> {
    const messages = await this.rawMessages(id);
    let call: { name: string; arguments: unknown } | undefined;
    let result: { text: string; isError: boolean } | undefined;
    for (const message of messages) {
      if (message.role === "assistant") for (const part of message.content) if (part.type === "toolCall" && part.id === toolCallId) call = { name: part.name, arguments: part.arguments };
      if (message.role === "toolResult" && message.toolCallId === toolCallId) result = { text: message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n"), isError: message.isError };
    }
    if (!call && !result) throw new ThreadError(404, "This tool call is not in the thread.");
    return { toolCallId, toolName: call?.name ?? "", arguments: call?.arguments ?? {}, output: result?.text ?? "", isError: result?.isError ?? null };
  }

  async part(id: string, messageIndex: number, partIndex: number): Promise<{ text: string }> {
    const messages = await this.rawMessages(id);
    let seen = -1;
    for (const message of messages) {
      const projected = this.projector.message(message);
      if (!projected) continue;
      seen++;
      if (seen !== messageIndex) continue;
      const content = "content" in message ? message.content : undefined;
      if (typeof content === "string") return { text: content };
      const part = Array.isArray(content) ? content[partIndex] : undefined;
      if (!part) throw new ThreadError(404, "This part is not in the thread.");
      if (part.type === "text") return { text: part.text };
      if (part.type === "thinking") return { text: part.thinking };
      throw new ThreadError(400, "This part has no text.");
    }
    throw new ThreadError(404, "This message is not in the thread.");
  }

  async warm(id: string): Promise<void> { await this.open(id); }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.sweeper);
    this.unwatchCatalog?.();
    await Promise.all([...this.threads.keys()].map(id => this.dispose(id)));
  }
}
