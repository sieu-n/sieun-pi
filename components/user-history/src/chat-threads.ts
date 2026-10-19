import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { DaemonAgentConnection, DaemonClient, SessionManager, type SessionEntry, type SessionSummary } from "prime-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Catalog } from "./chat-catalog.ts";
import type { SubagentDelete } from "./chat-sources.ts";
import { childrenStirred, Dormancy, type IdleDetach, showsWork, unsilent } from "./chat-dormancy.ts";
import "./daemon-snapshot-count.ts";
import { CHAT_FLAG } from "./chat-guard.ts";
import { UNKNOWN_ACTIVE } from "./chats.ts";
import { archiveSavedSession, resumeSince, type ResumeSince, ScheduledJobsLeft, ServicesStopPending, takesSavedArchive } from "./saved-archive.ts";
import { type CancelTry, type PendingCancel, SavedArchiveQueue } from "./saved-archive-queue.ts";
import { isReopenable } from "./reopen-send.ts";
import { afterMove, type StateAnswer } from "./worker-move.ts";
import { AttachQueue } from "./attach-queue.ts";
import { setFileSessionState } from "./session-state-file.ts";
import { userMessageAt } from "./send-once.ts";
import type { OutboxEntry } from "./shared/outbox.ts";
import { CHAT_NOTICE } from "./shared/chat-feed.ts";
import { findMessage, findToolCall, type FilePlace, FIRST_PAGE_MESSAGES, historyMessages, PAGE_MESSAGES, readBranchPage, shownMessage, TAIL_BYTES, TAIL_MESSAGES } from "./session-tail.ts";
import { formatCursor, keyIndex, type MessageKey, messageKey, parseCursor } from "./shared/message-key.ts";
import { FirstPages, firstPage, wireEvent } from "./first-page.ts";
import { DAEMON_WORKER_START_MS, timedWorkerStart } from "./daemon-worker-start.ts";
import { movedImages } from "./moved-images.ts";
import { ImageStore, Projector, projectChild, projectInfo, projectModel, sessionUsage } from "./chat-projection.ts";
import type { ChatImage } from "./chat-images.ts";
import { boardDelta, boardStep, type BoardStep, feedBoard } from "./shared/board-delta.ts";
import { applyThreadEvent, boardKey, isThreadBusy, isTurnRunning, runStartedAtFromMessages, threadStateFromSnapshot } from "./shared/thread-state.ts";
import type { ChatBoard, ChatDefaults, ChatWait, ChildAgent, Command, ModelCatalog, ModelInfo, OlderPage, ProjectedSessionEvent, SendMode, SessionRow, ThreadEvent, ThreadHave, ThreadInfo, ThreadMessage, ThreadStats, ThreadSnapshot, ThreadState, ThinkingLevel } from "./shared/types.ts";

type Listener = (event: ThreadEvent) => void;
/** What chats watch on the hub: each attach (with the children known then), every change of a thread's subagent list while attached, and each turn's end. */
export interface ThreadObserver { live(id: string, children: readonly ChildAgent[]): void; children(id: string, children: readonly ChildAgent[]): void; idle(id: string): void;
  /** The session finished a Prime compaction; `file` is its session file on this box. */
  compacted?(id: string, file: string | undefined): void }

/** Native session-owned slash commands (prime-agent SESSION_SLASH_COMMAND_NAMES). The session runs them from prompt text; getCommands does not list them. */
const SESSION_COMMANDS: Command[] = [
  { name: "compact", description: "Compact the session context; optional instructions focus the summary", argumentHint: "[instructions]", source: "session" },
  { name: "refine", description: "Refine continual harness prompt notes, skills, subagents, and memory", source: "session" },
  { name: "goal", description: "Set or view a persistent goal; supports pause, resume, and clear", argumentHint: "[objective]", source: "session" },
  { name: "autonomous", description: "Set or view autonomous mode", argumentHint: "[status|on|off]", source: "session" },
];
type NativeEvent = Parameters<Parameters<DaemonAgentConnection["subscribe"]>[0]>[0];
type NativeSnapshot = Awaited<ReturnType<DaemonAgentConnection["getInitialSnapshot"]>>;
type Live = { connection: DaemonAgentConnection; activeSessionId: string; unsubscribe: () => void };

/** The daemon's archive_saved_session answer for a file it cannot read: nothing is left to cancel. */
const UNKNOWN_SAVED = "Unknown saved session";
/** The daemon's kill answer when the worker outlived the stop window; the supervisor still finishes the stop. */
const STOP_PENDING = /^Session worker \S+ did not stop/;

export class ThreadError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/**
 * The page of `messages` before index `end`: `size` back, and never between two messages that share a timestamp, so a message key
 * (src/shared/message-key.ts) counts the same in any list that holds the page. `older` names what is before the page: a message cursor inside
 * the list, else `start`, the cursor of what is before the list.
 */
export function pageBefore(messages: readonly ThreadMessage[], end: number, start: string | undefined, size = PAGE_MESSAGES): OlderPage {
  let first = Math.max(0, end - size);
  while (first > 0 && messages[first - 1]!.timestamp === messages[first]!.timestamp) first--;
  const older = first > 0 ? formatCursor({ kind: "message", key: messageKey(messages, first) }) : start;
  return { messages: messages.slice(first, end), ...(older ? { older } : {}) };
}

/**
 * The messages a live snapshot adds to the ones read from the session file: those after the file's last. The daemon writes each message to the
 * file when it ends, so this is what landed between the file read and the snapshot, or a new session's messages before its file exists. A custom
 * entry is stamped by a second clock read, so it matches its live message within a few ms.
 */
export function liveGap(held: readonly ThreadMessage[], live: readonly ThreadMessage[]): ThreadMessage[] {
  const last = held.at(-1);
  if (!last) return [...live];
  const same = (message: ThreadMessage) => message.role === last.role && (message.timestamp === last.timestamp ||
    (message.role === "custom" && last.role === "custom" && Math.abs(message.timestamp - last.timestamp) <= 5 && JSON.stringify(message.content) === JSON.stringify(last.content)));
  for (let index = live.length - 1; index >= 0 && live[index]!.timestamp >= last.timestamp - 5; index--) if (same(live[index]!)) return live.slice(index + 1);
  return live.filter(message => message.timestamp > last.timestamp);
}

class Thread {
  state: ThreadState;
  live: Live | null = null;
  sessionFile: string | undefined;
  /** Settles when the open is done: the daemon attach landed, or the thread stays saved. A failed attach rejects it and closes the thread. */
  ready: Promise<void> = Promise.resolve();
  /** The open is not done yet (`ready`): eviction and the idle sweep leave the thread alone. */
  opening = false;
  readonly listeners = new Set<Listener>();
  touched = Date.now();
  /** The shell's JSON block made from `state` (ThreadHub.firstPage), so shells of an unchanged thread reuse it. */
  inlined: { state: ThreadState; text: string } | undefined;
  idleSince: number | null = Date.now();
  /** When the session last sent an event, or the attach; the server's hung-turn check reads it (`quietSince`). */
  lastEventAt = Date.now();
  /** The hub clock at the thread's last attach, session event, children change or tab close: its idle time for `rest` counts from here. */
  activeAt = Date.now();
  private pendingUpdate: { timer: ReturnType<typeof setTimeout>; event: ProjectedSessionEvent | null } | undefined;
  constructor(readonly id: string, snapshot: ThreadSnapshot, private readonly onChildren: (thread: Thread, before: readonly ChildAgent[]) => void) { this.state = threadStateFromSnapshot(snapshot); }
  /**
   * The state as a feed sends it: a snapshot with the newest page of messages and no board or children, then the children and, with `board`,
   * the board as their own events. Until 10-18 a snapshot carried about 1,000 messages, the board and the children, 0.45 to 1.28 MB per frame.
   * A new feed (`first`) gets `firstFrame` before that snapshot, which is left out when the first frame already held the whole page.
   */
  /** The newest message key each listener got in a snapshot, so a later snapshot sends it only the messages after it (`after`). */
  private readonly lastSent = new WeakMap<Listener, string>();
  send(listener: Listener, board: boolean, children = this.state.children.length > 0, first = false, have?: ThreadHave): void {
    const { connection: _connection, error: _error, board: _board, children: held, messages, older, ...rest } = this.state;
    const after = have?.last ?? this.lastSent.get(listener);
    const tail = after === undefined ? null : this.after(after);
    if (tail && after !== undefined) listener({ type: "snapshot", snapshot: { ...rest, messages: tail, after } });
    else {
      const page = pageBefore(messages, messages.length, older, FIRST_PAGE_MESSAGES);
      const small = first ? this.firstFrame() : null;
      if (small) listener(small);
      if (small?.type !== "snapshot" || small.snapshot.messages.length < page.messages.length || small.snapshot.messages.some((message, index) => message !== page.messages[index])) {
        listener({ type: "snapshot", snapshot: { ...rest, ...page } });
      }
    }
    if (messages.length) this.lastSent.set(listener, formatCursor({ kind: "message", key: messageKey(messages, messages.length - 1) }));
    if (children) listener({ type: "children", children: held });
    if (board) { if (have?.board) this.boardHeld.set(listener, have.board); this.sendBoard(listener); }
  }
  /** Listeners that take board deltas (`delta: true` on the feed), and the `boardKey` of the board each listener holds. */
  readonly deltas = new WeakSet<Listener>();
  private readonly boardHeld = new WeakMap<Listener, string>();
  /** The board changes since the thread opened, oldest first, so a page that holds an earlier board gets one delta (`boardDelta`). */
  private boardSteps: { from: string; to: string; step: BoardStep }[] = [];
  /**
   * The board to a listener: nothing when it holds this board, the items that changed since the one it holds when it takes deltas and the
   * thread saw every change since, and the whole board otherwise. On 10-18 every change sent the whole board, 456 KB for 01a1164b.
   */
  private sendBoard(listener: Listener): void {
    const board = this.state.board;
    if (!board) return;
    const key = boardKey(board), held = this.boardHeld.get(listener);
    if (held === key) return;
    const from = held === undefined || !this.deltas.has(listener) ? -1 : this.boardSteps.findIndex(step => step.from === held);
    listener(from < 0 ? { type: "board", board } : boardDelta(held!, board, this.boardSteps.slice(from).map(step => step.step)));
    this.boardHeld.set(listener, key);
  }
  private boardChanged(before: ChatBoard | null | undefined, after: ChatBoard): void {
    const step = before ? boardStep(before, after) : null;
    const from = before ? boardKey(before) : "";
    if (!step || this.boardSteps.at(-1)?.to !== from) this.boardSteps = [];
    if (step) this.boardSteps.push({ from, to: boardKey(after), step });
    if (this.boardSteps.length > BOARD_STEPS) this.boardSteps.shift();
  }
  /** The messages after the one `cursor` names, when the thread holds it and at most a page follows it; null otherwise. */
  private after(cursor: string): ThreadMessage[] | null {
    const parsed = parseCursor(cursor);
    const index = parsed?.kind === "message" ? keyIndex(this.state.messages, parsed.key) : -1;
    return index >= 0 && this.state.messages.length - 1 - index <= FIRST_PAGE_MESSAGES ? this.state.messages.slice(index + 1) : null;
  }

  /**
   * What a new feed paints first, and what the page shell inlines: a snapshot of the newest messages that fit FIRST_PAGE_BYTES, with what only
   * an opened work row shows cut to previews (src/first-page.ts). From Korea the full page of 100 messages took more than one round trip.
   */
  firstFrame(): ThreadEvent {
    const { connection: _connection, error: _error, board: _board, children: _children, messages, older, ...rest } = this.state;
    const floor = messages.length - pageBefore(messages, messages.length, older, FIRST_PAGE_MESSAGES).messages.length;
    return { type: "snapshot", snapshot: { ...rest, ...firstPage(messages, older, floor) } };
  }
  broadcast(event: ThreadEvent): void {
    const children = this.state.children;
    if (event.type === "board") { event = { type: "board", board: feedBoard(event.board) }; this.boardChanged(this.state.board, event.board); }
    this.state = applyThreadEvent(this.state, event);
    for (const listener of [...this.listeners]) {
      if (event.type === "snapshot") this.send(listener, false, this.state.children.length > 0 || children.length > 0);
      else if (event.type === "board") this.sendBoard(listener);
      else listener(event);
    }
    if (this.state.children !== children) this.onChildren(this, children);
  }
  /** Older messages read after the first page went out: the thread holds them for the chat's own reads, and the feed's cursor still names them. */
  prepend(messages: readonly ThreadMessage[], older: string | undefined): void {
    const { older: _older, ...state } = this.state;
    this.state = { ...state, messages: [...messages, ...state.messages], ...(older ? { older } : {}) };
  }

  /**
   * Stream updates go out at most once per `delayMs`. The first update of a quiet stream goes out at once and opens the window, so the first
   * token reaches the page with no wait; updates inside the window keep only the latest, which goes out when the window ends and opens the next.
   */
  coalesce(event: ProjectedSessionEvent, delayMs: number): void {
    if (event.type !== "message_update") { this.flush(); this.broadcast({ type: "event", event }); return; }
    if (this.pendingUpdate) { this.pendingUpdate.event = event; return; }
    this.broadcast({ type: "event", event });
    this.openWindow(delayMs);
  }
  private openWindow(delayMs: number): void {
    const window: { timer: ReturnType<typeof setTimeout>; event: ProjectedSessionEvent | null } = { event: null, timer: setTimeout(() => {
      if (this.pendingUpdate !== window) return;
      this.pendingUpdate = undefined;
      if (!window.event) return;
      this.broadcast({ type: "event", event: window.event });
      this.openWindow(delayMs);
    }, delayMs) };
    this.pendingUpdate = window;
  }
  flush(): void {
    if (!this.pendingUpdate) return;
    const { timer, event } = this.pendingUpdate;
    clearTimeout(timer);
    this.pendingUpdate = undefined;
    if (event) this.broadcast({ type: "event", event });
  }
}

/** How many unpinned threads with no tab open stay attached (`MAX_LIVE`) or stay read from their saved file (`MAX_SAVED`); pinned chats do not count. */
const MAX_LIVE = 8;
const MAX_SAVED = 16;
const IDLE_MS = 3 * 60 * 1000;
const UPDATE_COALESCE_MS = 40;
/** The board changes a thread keeps for `Thread.sendBoard`: a page that holds an older board than these gets the whole board. */
const BOARD_STEPS = 64;
/**
 * The id to attach, or undefined when the session must be opened from its saved file. A worker that died leaves its sessions listed with the dead
 * worker's active id and workerState "failed"; attaching that id fails with "Session worker is failed" forever, while opening the saved file
 * makes the daemon drop the dead registration and start the session on a new worker.
 */
function liveSessionId(summary: SessionSummary): string | undefined {
  return summary.workerState === "failed" ? undefined : summary.activeSessionId;
}

/** A user message's text parts, joined and trimmed. */
function userText(message: { content: string | readonly { type: string; text?: string }[] }): string {
  return (typeof message.content === "string" ? message.content : message.content.map(part => part.type === "text" ? part.text ?? "" : "").join("")).trim();
}

/** What a thread shows of a resident session before its file or the daemon said more: the catalog's name, folder and usage. */
function emptyInfo(summary: SessionSummary): ThreadInfo {
  const name = summary.sessionName?.trim();
  return { sessionId: summary.sessionId, ...(name ? { name } : {}), cwd: summary.cwd, model: null, thinkingLevel: summary.thinkingLevel ?? "off", availableThinkingLevels: [],
    isStreaming: false, isCompacting: false, isBashRunning: false, retryAttempt: 0, messageCount: summary.messageCount ?? 0, context: null, usage: sessionUsage(summary.usage),
    sessionAction: null, queuedActions: 0 };
}

/** A pinned thread whose resume failed (a daemon timeout, a refused attach) is tried again after 15 s, doubling per failure up to 5 min. */
const PIN_RETRY_MS = 15000;
const PIN_RETRY_MAX_MS = 5 * 60_000;
/**
 * How long another box's attach snapshot may take to arrive. The snapshot is the whole context since the last compaction, images included, and
 * the SDK's 30 s (DAEMON_SNAPSHOT_TIMEOUT_MS) fit only this box's socket: on 10-18 frontend bro's 9.9 MB came from the Mac at 0.26 to 1.4 MB/s
 * as the link was busy or not, and from 07:38Z to 08:01Z its attach timed out 17 times, each pin retry pulling the same bytes again.
 */
const REMOTE_SNAPSHOT_MS = 5 * 60_000;
/**
 * Another box's attach reconnects through the SDK's own loop when its link drops (`recoverDaemon`: the bridge socket stays up, so there is
 * nothing to restart): the page shows "Reconnecting" and the feed resyncs from its cursor. Without it a dropped link ended the feed. On 10-19
 * after the 15:19:50Z restart an open Mac thread showed the red "Lost connection to the Prime Agent daemon" bar for 7 minutes and more, until
 * someone pressed Retry, while the Mac relay answered in 0.19 s.
 */
const reconnectRemote = async (): Promise<void> => {};
/** The client each attach opened, so a dispose can close it (`disposeConnection`). */
export const attachClients = new WeakMap<DaemonAgentConnection, DaemonClient>();

/**
 * A connection with `recoverDaemon` keeps a request whose link drops until the link is back, and a disposed connection never reconnects, so
 * its detach would wait for good. Closing the client while the link is down, or once it drops during the detach, ends that wait.
 */
export async function disposeConnection(connection: DaemonAgentConnection): Promise<void> {
  const client = attachClients.get(connection);
  const off = client?.onClose(() => client.close());
  if (client && !client.isConnected) client.close();
  await connection.dispose().catch(() => {});
  off?.();
}
/**
 * How long an attach to this box's daemon waits for its hello, as long as the attach request after it may take (the SDK's 30 s
 * DEFAULT_DAEMON_REQUEST_TIMEOUT_MS). The supervisor writes the hello as it takes the connection: 20 tries at 17:23Z on 10-18, load 57, got it
 * in 0 to 6 ms. The old 3 s failed two job wakes outright, 01a14f62 near 16:14:33Z and 01a14fef near 17:09:25Z ("Timed out after 3000ms
 * waiting for the Prime Agent daemon handshake"), each while the supervisor was between a worker's crash and its "Recovered worker" line (19 s
 * and 25 s). Another box's bridge keeps its 3 s: while the Mac's relay did not answer on 10-18, its hello never came (open 01a11ba8 on mac).
 */
const LOCAL_HELLO_MS = 30_000;
/** A prompt's wait for the session to take it, as long as the native connection's (DAEMON_LONG_RUNNING_REQUEST_TIMEOUT_MS, 24 h). */
const PROMPT_REQUEST_MS = 24 * 60 * 60 * 1000;

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
  /** Archives through this server under way, and when the last one started or ended, so `keepListed` never undoes one (an explicit archive wins). */
  private readonly archiving = new Map<string, number>();
  private readonly archivedAt = new Map<string, number>();
  /** When the last archive through this server began, so an owner send that came in before it does not go (`archivedSince`). */
  private readonly archiveStarts = new Map<string, number>();
  /** Pinned chats detached by `rest`. They stay pinned and keep their last state until `resume` wakes them. */
  private readonly dormant: Dormancy;
  private unwatchCatalog: (() => void) | undefined;
  /** Each pinned chat's row from the last catalog update, so `rest` never detaches a chat the catalog would wake at once (`atWork`). */
  private readonly catalogRows = new Map<string, SessionRow>();
  private readonly attaches = new AttachQueue();
  private readonly observers = new Set<ThreadObserver>();
  /** Each thread's owner sends not delivered yet (`setOutbox`), for the threads that open later. */
  private readonly outboxes = new Map<string, OutboxEntry[]>();
  private closed = false;

  /**
   * `board` reads a chat's board when the thread opens: null for a chat with no board yet, undefined for a thread that is not a chat.
   * `readOnly` (a scratch serve) opens every thread from its session file and never attaches or resumes one: at 12:17Z on 10-18 a scratch
   * serve's attach of the live chat 01a14d31 ran its build-change reload, which rebuilt that chat's Python kernel.
   */
  /**
   * The owner archives whose scheduled-job cancel is not confirmed yet (`<data dir>/saved-archive-queue.json`), retried until it is or the
   * owner reopens the session. Null when the hub was given no file (tests): such an archive only reports that its jobs may still run.
   */
  readonly cancels: SavedArchiveQueue | null;

  constructor(private readonly socketPath: string, private readonly catalog: Catalog, private readonly defaults: () => ChatDefaults,
    private readonly board: (id: string) => Promise<ChatBoard | null | undefined> = async () => undefined, idle: IdleDetach = {},
    private readonly firstPages = new FirstPages(null), private readonly readOnly = false, pendingCancels: string | null = null) {
    this.dormant = new Dormancy(idle);
    this.cancels = pendingCancels ? new SavedArchiveQueue({ path: pendingCancels, attempt: entry => this.retryCancel(entry), reachable: host => this.catalog.reachable(host),
      log: line => process.stderr.write(`${new Date().toISOString()} ${line}\n`), ...readOnly ? { tickMs: 0 } : {} }) : null;
    this.sweeper = setInterval(() => this.sweep(), 30000);
    this.sweeper.unref();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, thread] of this.threads) {
      if (!this.pinned.has(id) && !thread.opening && thread.listeners.size === 0 && thread.idleSince !== null && now - thread.idleSince > IDLE_MS) void this.dispose(id);
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
      await this.detach(id, thread, "detached");
    }
    await this.dormant.save([...this.pinned].flatMap(id => { const thread = this.threads.get(id); return thread?.live ? [[id, thread.activeAt] as const] : []; }));
  }

  /** `rest`'s detach of one resting chat, after the notices for its silent children; false when the chat is at work by its catalog row or stirred meanwhile. */
  private async detach(id: string, thread: Thread, how: "detached" | "detached to recycle its worker"): Promise<boolean> {
    const row = this.catalogRows.get(id);
    if (row && this.dormant.atWork(row)) return false;
    for (const line of this.dormant.silentLines(thread.state.children, thread.state.messages)) {
      await this.notice(id, line).catch(error => { process.stderr.write(`rest ${id.slice(0, 8)}: silent child notice: ${error instanceof Error ? error.message : String(error)}\n`); });
    }
    const live = thread.live;
    if (!live || !this.resting(thread) || this.threads.get(id) !== thread) return false;
    this.dormant.sleep(id, this.dormant.now() - thread.activeAt, how);
    thread.flush();
    thread.live = null;
    live.unsubscribe();
    await disposeConnection(live.connection);
    return true;
  }

  /**
   * Detaches a pinned chat whose whole tree has rested for `quietMs`, without waiting out idleEvictionMinutes, so the idle unload can stop
   * every session on its worker and the worker exits (src/idle-unload.ts `recyclePlan`). A duty that holds the chat keeps it attached. True
   * when the chat is detached now.
   */
  async restNow(id: string, quietMs: number): Promise<boolean> {
    const thread = this.threads.get(id);
    if (!this.pinned.has(id) || !thread?.live || !this.resting(thread) || this.dormant.now() - thread.activeAt < quietMs || await this.dormant.held(id)) return false;
    return await this.detach(id, thread, "detached to recycle its worker");
  }

  /**
   * Lets go of a pinned chat asleep in its provider retry right before the idle unload stops it (src/idle-unload.ts `retrying`), and keeps it
   * dormant until a send, an open, an agent message or its revive needs it: the kill would close the session under the attach, and the closed
   * attach would open it again at once (`keepPinnedLive`). A chat with no thread in the hub opens saved first, so `Chats.revive` reads its
   * failed turn and reopens it once pi-pool admits its tree. A duty that holds the chat, or an open or resume under way, keeps it. True when the
   * chat is let go now.
   */
  async restAsleep(id: string): Promise<boolean> {
    if (!this.pinned.has(id) || this.resuming.has(id) || this.opening.has(id) || await this.dormant.held(id)) return false;
    const thread = this.threads.get(id) ?? await this.open(id, true, false);
    if (this.resuming.has(id) || this.threads.get(id) !== thread) return false;
    const live = thread.live;
    this.dormant.sleep(id, this.dormant.now() - thread.activeAt, "detached asleep in its provider retry");
    if (live) {
      thread.flush();
      thread.live = null;
      live.unsubscribe();
      await disposeConnection(live.connection);
    }
    return true;
  }

  /** Closes the oldest unpinned threads of `kind` with no tab open over MAX_LIVE or MAX_SAVED; pinned threads do not count, so pins never push other threads out. */
  private evict(kind: "live" | "saved"): void {
    const candidates = [...this.threads.values()].filter(thread => (thread.live !== null) === (kind === "live") && thread.listeners.size === 0 && !thread.opening && !this.pinned.has(thread.id))
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
    this.firstPage(thread);
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
    const response = await timedWorkerStart(`reload ${id.slice(0, 8)}`, async () => (await this.daemon(activeSessionId)).request({ type: "reload", activeSessionId }, DAEMON_WORKER_START_MS, { recoverable: false }));
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

  private async stateOf(activeSessionId: string): Promise<StateAnswer> {
    return (await this.daemon(activeSessionId)).request({ type: "get_state", activeSessionId }, undefined, { recoverable: false });
  }

  private async daemonBusy(activeSessionId: string): Promise<boolean> {
    const state = await this.stateOf(activeSessionId);
    if (!state.success) throw new ThreadError(502, state.error);
    const now = state.data as Partial<Pick<SessionSummary, "isSessionActive" | "isStreaming" | "isCompacting" | "isBashRunning">>;
    return now.isSessionActive !== false || now.isStreaming === true || now.isCompacting === true || now.isBashRunning === true;
  }

  /**
   * On every catalog update with the daemon up, a pinned thread that lost its attachment (daemon restart, worker exit) is resumed again, as a
   * background attach (`AttachQueue`), so after a restart the pins come back two at a time per box and an open tab or an owner send goes first. A
   * failed resume waits PIN_RETRY_MS, doubling per failure. One archived outside this server (the terminal agents view) is unpinned instead,
   * so the pin never brings an archived session back. A dormant chat is skipped, and one that rested on disk (`restedOnDisk`) opens saved, also
   * when an open tab already opened its thread: api portal vp and launch main bro, paused and idle 19 to 58 min, each got a new worker at the
   * service starts of 23:16Z, 23:34Z and 23:55Z on 10-17, because their tabs reopened the threads first.
   */
  private keepPinnedLive(): void {
    if (this.closed || this.readOnly) return;
    const now = Date.now();
    for (const id of this.pinned) {
      if (this.threads.get(id)?.live || this.dormant.has(id) || this.pinning.has(id) || now < (this.pinRetry.get(id)?.at ?? 0)) continue;
      this.pinning.add(id);
      void (async () => {
        const summary = await this.catalog.summary(id);
        if (!summary || summary.lifecycle === "archived") { this.unpin(id); return; }
        const rested = await this.dormant.restedOnDisk(summary, () => this.catalog.childActivity(id));
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
    this.firstPage(thread);
    this.threads.delete(id);
    this.dormant.forget(id);
    thread.flush();
    if (thread.live) {
      thread.live.unsubscribe();
      await disposeConnection(thread.live.connection);
      thread.live = null;
    }
  }

  /** A connected client for the named hosts.json box, this box's own when the name is null. */
  private async hostDaemon(host: string | null): Promise<DaemonClient> {
    if (host) return this.catalog.hostClient(host);
    await this.catalog.connect();
    return this.catalog.client;
  }

  /** A connected client of the daemon that runs `id`, a session id or an active session id. */
  private daemon(id: string): Promise<DaemonClient> { return this.hostDaemon(this.catalog.hostOf(id)); }

  private async summary(id: string): Promise<SessionSummary> {
    const summary = await this.catalog.summary(id);
    if (!summary) throw new ThreadError(404, "This thread is not in the Prime Agent catalog.");
    return summary;
  }

  /** `host` names the box for a session the catalog does not list yet (just created or resumed); else the catalog's row says which box runs it. */
  private async attach(activeSessionId: string, host: string | null = this.catalog.hostOf(activeSessionId)): Promise<DaemonAgentConnection> {
    const client = new DaemonClient(host ? this.catalog.socketPathFor(host) : this.socketPath);
    try {
      await client.connect(3000);
      await client.waitForHello(host ? 3000 : LOCAL_HELLO_MS);
      // Events wait until `bind`, so `liveSnapshot` reads the attach snapshot as it came. Otherwise one event between the two made
      // getInitialSnapshot fetch get_messages and get_session_context, each the whole context with every image.
      const connection = await DaemonAgentConnection.attach(client, activeSessionId, { directTransport: false, supportsExtensionUi: false, sendClientEnv: false, ownedSession: false,
        closeClientOnDispose: true, deferSessionEvents: true, ...(host ? { snapshotTimeoutMs: REMOTE_SNAPSHOT_MS, recoverDaemon: reconnectRemote } : {}) });
      attachClients.set(connection, client);
      return connection;
    } catch (error) { client.close(); throw error; }
  }

  /** The daemon's side of an attached session: its state, queue, streaming message, children, and its live context's messages for `liveGap`. */
  private async liveSnapshot(connection: DaemonAgentConnection, summary: SessionSummary | undefined, given?: NativeSnapshot): Promise<ThreadSnapshot> {
    const [snapshot, queue] = await Promise.all([given ?? connection.getInitialSnapshot(), connection.getQueue()]);
    const messages = this.projector.messages(snapshot.messages);
    const streaming = snapshot.streamingMessage?.role === "assistant" ? this.projector.assistant(snapshot.streamingMessage) : null;
    return { kind: "live", info: projectInfo(snapshot.state, summary, this.catalogModel(snapshot.state.model ?? null)), messages, streaming, queue: { steering: [...queue.steering], followUp: [...queue.followUp] },
      children: (snapshot.children ?? []).map(projectChild), tools: [], retry: null, runStartedAt: snapshot.state.isStreaming ? runStartedAtFromMessages(messages) : null };
  }

  /** The live snapshot over the messages the thread read from its session file: those, then what the file did not have yet (`liveGap`). */
  private merged(thread: Thread, live: ThreadSnapshot): ThreadSnapshot {
    const held = thread.state.messages;
    return { ...live, messages: [...held, ...liveGap(held, live.messages)], ...(thread.state.older ? { older: thread.state.older } : {}) };
  }

  private branch(summary: SessionSummary, file: string): SessionEntry[] {
    const manager = SessionManager.inMemory(summary.cwd);
    manager.setSessionFile(file);
    if (manager.getSessionId() !== summary.sessionId) throw new ThreadError(409, "The saved thread file changed. Refresh the list.");
    return manager.getBranch();
  }

  /** The session file on this disk; another box's session reads a copy the catalog keeps current through that box's relay. */
  private async sessionFile(summary: SessionSummary): Promise<string> {
    if (!summary.sessionFile) throw new ThreadError(409, "This saved thread has no session file.");
    const host = this.catalog.hostOf(summary.sessionId);
    const file = !host ? summary.sessionFile : await this.catalog.localFile(summary).catch(error => {
      // A 404 from the relay: the file left that box (a chat moved to another box, or its parent deleted the job), so the thread is gone.
      // Until 10-18 it read as a 502, and the job wake retried 23 moved subagents a stale Mac row still listed 786 times.
      const gone = (error as { status?: unknown }).status === 404;
      throw new ThreadError(gone ? 404 : 502, `The session file on ${host} ${gone ? "is gone" : "did not read"}: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (!file || !existsSync(file)) {
      void this.catalog.refresh().catch(() => {});
      throw new ThreadError(404, "The session file for this thread was moved or deleted after Prime Agent scanned it: " + summary.sessionFile);
    }
    return file;
  }

  /**
   * Branch entries back from `from` (the leaf when null), read backwards from the end of the file (`readBranchPage`), so a read costs the same
   * for a 171 MB transcript as for a small one. `older` is the cursor of the entries before them. A file at another version is read whole
   * through SessionManager, which migrates it: those are the files from before version 3, 3,432 files and 91 MB in all on 10-18.
   */
  private async entries(summary: SessionSummary, from: FilePlace | null, limits: { messages: number; bytes: number }): Promise<{ entries: SessionEntry[]; older: string | undefined; whole: boolean }> {
    const file = await this.sessionFile(summary);
    const page = await readBranchPage(file, from, limits);
    if (!page) return { entries: this.linked(from ? [] : this.branch(summary, file), file), older: undefined, whole: true };
    if (page.sessionId !== summary.sessionId) throw new ThreadError(409, "The saved thread file changed. Refresh the list.");
    return { entries: this.linked(page.entries, file), older: page.before ? formatCursor({ kind: "file", ...page.before }) : undefined, whole: page.whole };
  }

  /** The entries, with each image that `scripts/session-compact.ts` moved out of `file` linked in the image store, so its URL serves the file. */
  private linked(entries: SessionEntry[], file: string): SessionEntry[] {
    for (const image of movedImages(entries, file)) this.images.link(image.key, image.mimeType, image.path);
    return entries;
  }

  /** A saved thread's snapshot from its newest `limit` messages, with what the file says of its name, model and effort. */
  private async savedSnapshot(summary: SessionSummary, limit = FIRST_PAGE_MESSAGES): Promise<ThreadSnapshot> {
    const { entries, older } = await this.entries(summary, null, { messages: limit, bytes: TAIL_BYTES });
    const messages = this.projector.messages(historyMessages(entries));
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
    return { kind: "saved", info, messages, streaming: null, queue: { steering: [], followUp: [] }, children: [], tools: [], retry: null, runStartedAt: null, ...(older ? { older } : {}) };
  }

  /**
   * After the first page went out, the thread reads back to TAIL_MESSAGES in all, the depth the chat's own reads (job notices, agent rows,
   * unread counts) had before pages, and holds them in front of the page. The feed does not resend: its cursor already names them.
   */
  private async fill(thread: Thread, summary: SessionSummary): Promise<void> {
    const cursor = thread.state.older ? parseCursor(thread.state.older) : null;
    const want = TAIL_MESSAGES - thread.state.messages.length;
    if (cursor?.kind !== "file" || want <= 0) return;
    const { entries, older } = await this.entries(summary, { end: cursor.end, id: cursor.id }, { messages: want, bytes: TAIL_BYTES });
    if (this.threads.get(thread.id) !== thread || thread.state.older !== formatCursor(cursor)) return;
    thread.prepend(this.projector.messages(historyMessages(entries)), older);
  }

  /** The newest TAIL_MESSAGES from the file, for a snapshot after a compaction or a reconnect; none for a session whose file is not written yet. */
  private async fileTail(summary: SessionSummary | undefined): Promise<{ messages: ThreadMessage[]; older?: string }> {
    if (!summary?.sessionFile) return { messages: [] };
    try {
      const { entries, older } = await this.entries(summary, null, { messages: TAIL_MESSAGES, bytes: TAIL_BYTES });
      return { messages: this.projector.messages(historyMessages(entries)), ...(older ? { older } : {}) };
    } catch (error) {
      process.stderr.write(`history ${summary.sessionId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}\n`);
      return { messages: [] };
    }
  }

  /**
   * The owner scrolled up: the page before `cursor`. A message cursor inside what the thread holds answers from memory; otherwise the server
   * reads that page back from the session file, and never the whole file. Until 10-18 Show earlier read the whole branch through SessionManager,
   * 171 MB for the biggest chat, and kept it for every later snapshot.
   */
  async olderPage(id: string, text: string): Promise<OlderPage> {
    let cursor = parseCursor(text);
    if (!cursor) throw new ThreadError(400, "Choose where the earlier messages start.");
    const thread = this.threads.get(id);
    if (cursor.kind === "message" && thread) {
      const index = keyIndex(thread.state.messages, cursor.key);
      if (index > 0) return pageBefore(thread.state.messages, index, thread.state.older);
      if (index === 0) {
        if (!thread.state.older) return { messages: [] };
        cursor = parseCursor(thread.state.older)!;
      }
    }
    const summary = await this.summary(id);
    let from: FilePlace;
    if (cursor.kind === "file") from = { end: cursor.end, id: cursor.id };
    else {
      const file = await this.sessionFile(summary);
      const found = await findMessage(file, cursor.key.at, cursor.key.n);
      if (found === undefined) {
        const messages = this.projector.messages(historyMessages(this.branch(summary, file)));
        const index = keyIndex(messages, cursor.key);
        if (index < 0) throw new ThreadError(409, "That message is no longer in the thread. Open it again.");
        return pageBefore(messages, index, undefined);
      }
      if (!found) throw new ThreadError(409, "That message is no longer in the thread. Open it again.");
      if (!found.before) return { messages: [] };
      from = found.before;
    }
    const { entries, older } = await this.entries(summary, from, { messages: PAGE_MESSAGES, bytes: TAIL_BYTES });
    return { messages: this.projector.messages(historyMessages(entries)), ...(older ? { older } : {}) };
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
    void connection.flushBufferedSessionEvents();
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

  /** A compaction, a resync or a session switch: the newest messages again from the file, with the daemon's state and what the file lacks. */
  private async resnapshot(thread: Thread, given?: NativeSnapshot): Promise<void> {
    const live = thread.live;
    if (!live) return;
    const summary = await this.catalog.summary(thread.id);
    const [snapshot, tail] = await Promise.all([this.liveSnapshot(live.connection, summary, given), this.fileTail(summary)]);
    if (thread.live !== live) return;
    thread.flush();
    const { older: _older, ...rest } = snapshot;
    thread.broadcast({ type: "snapshot", snapshot: { ...rest, messages: [...tail.messages, ...liveGap(tail.messages, snapshot.messages)], ...(tail.older ? { older: tail.older } : {}) } });
  }

  private async onNativeEvent(thread: Thread, event: NativeEvent): Promise<void> {
    try {
      switch (event.type) {
        case "session_event": {
          thread.lastEventAt = Date.now();
          // Only work moves the idle clock (`showsWork`). A child's entry changes it through `childrenChanged`: the daemon unloading an idle
          // job or a deleted job's cancel is an rlm_child_update too, and it reset the clock of every VP chat, so none detached (10-14).
          if (showsWork(event.event)) thread.activeAt = this.dormant.now();
          const projected = this.projector.event(event.event);
          if (projected) thread.coalesce(projected, UPDATE_COALESCE_MS);
          const native = event.event.type;
          if (native === "agent_end") this.turnEnded(thread);
          if (native === "agent_start" || native === "agent_end" || (native === "message_end" && event.event.message.role === "user")) await this.refreshQueue(thread);
          if (native === "compaction_end" && !event.event.aborted) { for (const observer of [...this.observers]) observer.compacted?.(thread.id, thread.sessionFile); await this.resnapshot(thread); }
          if (native === "agent_end" || native === "compaction_end" || native === "auto_retry_end" || native === "thinking_level_changed" || native === "session_info_changed") await this.refreshInfo(thread);
          return;
        }
        // A resync carries the snapshot the connection just took; asking for it again went to get_messages once any event had come since. A
        // reconnect sends its resync before "connected", so "connected" takes no snapshot of its own.
        case "session_resynced":
          await this.resnapshot(thread, event.snapshot);
          return;
        case "session_replaced":
          await this.resnapshot(thread);
          return;
        case "connection_status":
          thread.broadcast({ type: "status", connection: event.status === "connected" ? "connected" : "reconnecting", ...(event.error ? { error: event.error } : {}) });
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
   * false reads the saved file even when the session is resident. A dormant chat comes back as its cached thread with no attach. Resolves once
   * the open is done (`Thread.ready`); `subscribe` takes the thread as soon as its first page is read.
   */
  async open(id: string, background = false, attach = true): Promise<Thread> {
    const thread = await this.start(id, background, attach);
    await thread.ready;
    return thread;
  }

  /**
   * The thread as soon as it holds its newest page from the session file; the daemon attach goes on behind it (`finish`). Until 10-18 a feed got
   * nothing until the attach and the live snapshot landed: 7.8 to 20.3 s on a cold open after a service restart, and those restarts are the
   * common case. A session the daemon has not written to its file yet starts with no messages and gets them from the live snapshot.
   */
  private start(id: string, background: boolean, attach: boolean): Promise<Thread> {
    if (this.closed) return Promise.reject(new ThreadError(410, "Chat is stopping."));
    const cached = this.threads.get(id);
    if (cached) { cached.touched = Date.now(); if (!background) this.attaches.promote(id); return Promise.resolve(cached); }
    const pending = this.opening.get(id);
    if (pending) { if (!background) this.attaches.promote(id); return pending; }
    const promise = (async () => {
      const started = performance.now();
      const marks: string[] = [];
      const mark = (label: string, from: number) => { marks.push(`${label} ${Math.round(performance.now() - from)}ms`); return performance.now(); };
      const summary = await this.summary(id);
      const at = mark("catalog", started);
      const activeSessionId = attach && !this.readOnly ? liveSessionId(summary) : undefined;
      const board = this.board(id).catch(error => { process.stderr.write(`board ${id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}\n`); return undefined; });
      const first = activeSessionId === undefined ? await this.savedSnapshot(summary)
        : await this.savedSnapshot(summary).catch(error => { marks.push(`no file page (${error instanceof Error ? error.message : String(error)})`); return null; });
      const snapshot: ThreadSnapshot = first ? { ...first, kind: activeSessionId === undefined ? "saved" : "live" } : { kind: "live", info: emptyInfo(summary), messages: [], streaming: null,
        queue: { steering: [], followUp: [] }, children: [], tools: [], retry: null, runStartedAt: null };
      this.evict("saved");
      const outbox = this.outboxes.get(id);
      const thread = new Thread(id, outbox ? { ...snapshot, outbox } : snapshot, (candidate, before) => this.childrenChanged(candidate, before));
      thread.sessionFile = summary.sessionFile;
      thread.opening = true;
      this.threads.set(id, thread);
      if (first) this.firstPage(thread);
      mark("first page", at);
      void board.then(found => {
        if (found === undefined || this.threads.get(id) !== thread) return;
        if (found === null) thread.state = { ...thread.state, board: null };
        else thread.broadcast({ type: "board", board: found });
      });
      thread.ready = this.finish(thread, summary, activeSessionId, background, marks, started).finally(() => { thread.opening = false; });
      thread.ready.catch(() => {});
      return thread;
    })().finally(() => { this.opening.delete(id); });
    this.opening.set(id, promise);
    return promise;
  }

  /**
   * The rest of an open: the older messages the thread holds (`fill`), and for a resident session the attach, whose live snapshot replaces the
   * first page's state. A failed attach closes the thread and tells its tabs, as a failed open did before.
   */
  private async finish(thread: Thread, summary: SessionSummary, activeSessionId: string | undefined, background: boolean, marks: string[], started: number): Promise<void> {
    const id = thread.id;
    let at = performance.now();
    const mark = (label: string) => { marks.push(`${label} ${Math.round(performance.now() - at)}ms`); at = performance.now(); };
    const filled = this.fill(thread, summary).catch(error => { process.stderr.write(`history ${id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}\n`); });
    const host = this.catalog.hostOf(id);
    const log = () => process.stderr.write(`open ${id.slice(0, 8)}${host ? ` on ${host}` : ""} ${thread.live ? "live" : "saved"} ${thread.state.messages.length} messages: ${marks.join(", ")}, total ${Math.round(performance.now() - started)}ms\n`);
    try {
      // A worker that is stopping or starting is waited out outside the attach queue, then attached once (src/worker-move.ts).
      const live = activeSessionId === undefined ? null : await afterMove(() => this.attaches.run(id, background, async () => {
        mark("queue");
        const connection = await this.attach(activeSessionId).catch(error => {
          if (!isReopenable(error)) throw error;
          marks.push(`listed active but the daemon has no live ${activeSessionId}: read saved`);
          return null;
        });
        if (!connection) return null;
        mark("attach");
        try { return { connection, snapshot: await this.liveSnapshot(connection, summary) }; }
        catch (error) { await disposeConnection(connection); throw error; }
      }, host ?? ""), () => this.stateOf(activeSessionId), doing => mark(`worker ${doing}, waited`));
      await filled;
      if (this.threads.get(id) !== thread) {
        await (live ? disposeConnection(live.connection) : undefined);
        throw new ThreadError(409, "This thread was closed while it was opening.");
      }
      if (!live) {
        if (thread.state.kind === "live") {
          // The catalog listed it running but the daemon has none: the thread is saved, and a session with no file page reads its file once more.
          const saved = thread.state.messages.length ? { ...thread.state, kind: "saved" as const } : await this.savedSnapshot(summary, TAIL_MESSAGES);
          thread.broadcast({ type: "snapshot", snapshot: { ...saved, kind: "saved" } });
        }
        log();
        return;
      }
      mark("snapshot+project");
      this.evict("live");
      this.bind(thread, live.connection, activeSessionId!);
      thread.broadcast({ type: "snapshot", snapshot: this.merged(thread, live.snapshot) });
      this.firstPage(thread);
      log();
      this.attached(thread);
    } catch (error) {
      marks.push(`failed: ${error instanceof Error ? error.message : String(error)}`);
      log();
      if (this.threads.get(id) === thread) {
        thread.broadcast({ type: "status", connection: "closed", error: error instanceof Error ? error.message : String(error) });
        await this.dispose(id);
      }
      throw error;
    }
  }

  /**
   * `background` for a listener no person waits on (the Slack bridge): its attach waits its turn in the queue, and it neither wakes a dormant
   * chat nor counts as activity. A tab's open and close count as activity, so the chat rests its idle time from the later one. The tab gets
   * the newest page at once, from what the thread holds or from the session file, and the live snapshot when the attach lands.
   */
  /** `have` is what a reconnecting page holds (chat-socket.ts `ThreadHave`): it gets the messages after its newest, and the board only when it changed. */
  async subscribe(id: string, listener: Listener, background = false, have?: ThreadHave, delta = false): Promise<() => void> {
    const thread = await this.start(id, background, true);
    thread.listeners.add(listener);
    if (delta) thread.deltas.add(listener);
    if (!background) thread.activeAt = this.dormant.now();
    thread.idleSince = null;
    thread.send(listener, true, undefined, have === undefined, have);
    if (thread.state.connection !== "connected") listener({ type: "status", connection: thread.state.connection, ...(thread.state.error ? { error: thread.state.error } : {}) });
    if (!background && this.dormant.has(id)) void this.resume(id, false, "open").catch(error => { process.stderr.write(`wake ${id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}\n`); });
    return () => {
      thread.listeners.delete(listener);
      if (thread.listeners.size === 0) thread.idleSince = Date.now();
      if (!background) thread.activeAt = this.dormant.now();
    };
  }

  /**
   * The JSON block the page shell carries for `id` (chat-server.ts `inlineFrames`): the small first snapshot a new feed gets (`Thread.firstFrame`)
   * and nothing else, since the page's own feed brings the board and the children right after it. Until 10-18 the block held them too: 496 KB
   * of HTML, 147 KB packed, for the biggest chat, of which the board was 414 KB, and the feed sent them again. A thread in memory makes the block
   * from its state; one that is not answers from `firstPages`, made when its last turn ended, and opens in the background for the page's feed.
   */
  async firstFrames(id: string): Promise<string> {
    const held = this.threads.get(id);
    if (held) return this.firstPage(held);
    const saved = await this.firstPages.get(id);
    if (saved === undefined) return this.firstPage(await this.start(id, false, true));
    void this.start(id, false, true).catch(() => {});
    return saved;
  }

  /**
   * The first frame a sidebar row's prefetch gets (`GET api/threads/<id>/first-frame`): the held thread's, else the last one made, even when the
   * session file grew since, else one made from the session file. It holds and attaches nothing, so prefetching the rows on screen starts no
   * session; the click's own feed does that.
   */
  async prefetchFrames(id: string): Promise<string> {
    const held = this.threads.get(id);
    if (held) return this.firstPage(held);
    const saved = await this.firstPages.get(id, true);
    if (saved !== undefined) return saved;
    const summary = await this.summary(id);
    const snapshot = await this.savedSnapshot(summary);
    return this.firstPages.put(id, [wireEvent(new Thread(id, snapshot, () => {}).firstFrame())], summary.sessionFile ?? null);
  }

  /** The thread's first frame as the shell inlines it, made once per state and kept in `firstPages`. */
  private firstPage(thread: Thread): string {
    if (thread.inlined?.state !== thread.state) thread.inlined = { state: thread.state, text: this.firstPages.put(thread.id, [wireEvent(thread.firstFrame())], thread.sessionFile ?? null) };
    return thread.inlined.text;
  }

  state(id: string): ThreadState | undefined { return this.threads.get(id)?.state; }

  /** A chat's board changed (either writer): its open thread's listeners get a board event. A closed thread reads the file when it opens. */
  setBoard(id: string, board: ChatBoard): void {
    const thread = this.threads.get(id);
    const current = thread?.state.board;
    if (!thread || (current && current.rev === board.rev && current.updatedAt === board.updatedAt)) return;
    thread.broadcast({ type: "board", board });
  }

  /**
   * The thread's owner sends not delivered yet (src/outbox.ts). The open thread's listeners get an outbox event, with `left`, the send just
   * delivered, listed once as it leaves; a thread opened later starts with the list.
   */
  setOutbox(id: string, outbox: OutboxEntry[], left?: OutboxEntry): void {
    if (outbox.length) this.outboxes.set(id, outbox); else this.outboxes.delete(id);
    const thread = this.threads.get(id);
    if (!thread || (!left && JSON.stringify(thread.state.outbox ?? []) === JSON.stringify(outbox))) return;
    thread.broadcast({ type: "outbox", outbox: left ? [...outbox, left] : outbox });
    thread.state = { ...thread.state, outbox };
  }

  /**
   * Where an owner send that began at `since` and may have reached the daemon is: a user message with its text in the session file (or the
   * open thread, for another box's session), its text in the worker's queue, neither, or unknown when the daemon did not answer.
   */
  async copyOf(id: string, text: string, imageCount: number, since: number): Promise<"landed" | "queued" | "absent" | "unknown"> {
    const summary = await this.summary(id).catch(() => null);
    if (!summary) return "unknown";
    const said = text.trim();
    const file = this.catalog.hostOf(id) ? undefined : summary.sessionFile;
    const inFile = async () => file ? await userMessageAt(file, said, imageCount, since) !== null
      : (this.threads.get(id)?.state.messages ?? []).some(message => message.role === "user" && message.timestamp >= since - 1_000 && userText(message) === said &&
        (typeof message.content === "string" ? 0 : message.content.filter(part => part.type === "image").length) === imageCount);
    if (await inFile()) return "landed";
    const active = this.threads.get(id)?.live?.activeSessionId ?? liveSessionId(summary);
    if (active) {
      const response = await (await this.daemon(id)).request({ type: "get_state", activeSessionId: active }, undefined, { recoverable: false }).catch(() => null);
      if (!response || (!response.success && !isReopenable(response.error))) return "unknown";
      const actions = response.success ? (response.data as { sessionActions?: { steering?: unknown; followUps?: unknown } } | undefined)?.sessionActions : undefined;
      if ([actions?.steering, actions?.followUps].some(list => Array.isArray(list) && list.some(item => typeof item === "string" && item.trim() === said))) return "queued";
    }
    // The worker may have written it between the file read and the queue read.
    return await inFile() ? "landed" : "absent";
  }

  /** What the server waits for before it restarts a chat's failed owner turn; the open thread's listeners get a wait event when it changes. */
  setWait(id: string, wait: ChatWait | null): void {
    const thread = this.threads.get(id);
    if (!thread || JSON.stringify(thread.state.wait ?? null) === JSON.stringify(wait)) return;
    thread.broadcast({ type: "wait", wait });
  }

  /**
   * The thread's state for a stall check, attaching it first; null for a thread that is not live. A dormant chat stays detached and reads null.
   * A thread this read opened lets go of its daemon client once the read is done, unless it is pinned, a tab or feed subscribed, or a resume
   * took it, so the check holds no job attached. Before, it stayed attached until the 3 min sweep: at 19:16:17Z on 10-14 the job checks
   * attached 3 VP of CI jobs, Prime's 19:20:23Z sweep skipped the tree for that client, and it evicted the 7.5 GB worker only at 19:23:57Z.
   */
  async view(id: string): Promise<ThreadState | null> {
    if (this.dormant.has(id)) return null;
    const opened = !this.threads.has(id) && !this.opening.has(id);
    const thread = await this.open(id, true);
    const state = thread.live ? thread.state : null;
    if (opened) {
      setTimeout(() => {
        if (this.threads.get(id) === thread && thread.listeners.size === 0 && !this.pinned.has(id) && !this.resuming.has(id) && !this.opening.has(id)) void this.dispose(id);
      }, 0);
    }
    return state;
  }

  /** `trigger` names the call in the wake line when it attaches a dormant chat. */
  private async requireLive(id: string, trigger: string): Promise<{ thread: Thread; live: Live }> {
    const thread = await this.current(id, trigger);
    if (!thread.live) throw new ThreadError(409, "Reply to resume this thread first.");
    return { thread, live: thread.live };
  }

  /** The thread as it is now; a saved one has no live binding, since no worker runs it. A dormant chat is attached first. */
  private async current(id: string, trigger: string): Promise<Thread> {
    return this.dormant.has(id) ? await this.resume(id, false, trigger) : await this.open(id);
  }

  /**
   * Makes a saved thread live, once per thread at a time: a pinned chat coming back after a daemon restart and the chat's turn restart (or an
   * owner send) can ask together, and two attaches would both subscribe, so every later event reached the thread twice and the feed drew each
   * message twice. A foreground ask joins a background one and moves it ahead in the attach queue. `trigger` names the caller in the wake
   * line a dormant chat logs.
   */
  resume(id: string, background = false, trigger = "resume"): Promise<Thread> {
    if (this.readOnly) return Promise.reject(new ThreadError(409, "A scratch serve only reads: it does not resume a thread."));
    this.dormant.wake(id, trigger);
    if (!background) this.attaches.promote(id);
    const running = this.resuming.get(id);
    if (running) { if (!background) running.ask.foreground = true; return running.promise; }
    const ask = { foreground: !background };
    const promise = this.resumeOnce(id, ask).finally(() => { this.resuming.delete(id); });
    this.resuming.set(id, { ask, promise });
    return promise;
  }

  /**
   * Opens `id` again after the daemon listed its worker as failed: the hub's binding to the dead worker goes first, so the resume attaches or
   * opens the file with a daemon create. The binding outlives the worker and the catalog's row too: after a SIGKILL of chat 01a14ec0's worker
   * on 10-18 at 11:29:49Z the hub read the chat "connected" and the catalog read it "ready" on the dead pid, so the interrupted-job pass's
   * resume returned at once, nothing reopened the chat, and its cut job got `skipped: worker_failed`. The supervisor's "Recovered worker" line
   * at 11:29:49Z was journal recovery, not a ready worker: the record stayed failed until the chat's own revive started a new one at 11:38:19Z.
   */
  async reopenFailed(id: string): Promise<void> {
    if (this.readOnly) throw new ThreadError(409, "A scratch serve only reads: it does not reopen a thread.");
    const thread = this.threads.get(id);
    const stale = thread?.live;
    if (thread && stale) { thread.live = null; stale.unsubscribe(); await disposeConnection(stale.connection); }
    await this.resume(id);
  }

  private async resumeOnce(id: string, ask: { foreground: boolean }): Promise<Thread> {
    const thread = await this.open(id, !ask.foreground);
    if (thread.live) return thread;
    const summary = await this.summary(id);
    const attachLive = (activeSessionId: string) => afterMove(() => this.attaches.run(id, !ask.foreground, async () => {
      const connection = await this.attach(activeSessionId, this.catalog.hostOf(id));
      try { return { connection, activeSessionId, snapshot: await this.liveSnapshot(connection, summary) }; }
      catch (error) { await disposeConnection(connection); throw error; }
    }, this.catalog.hostOf(id) ?? ""), () => this.stateOf(activeSessionId));
    // A row the catalog has not seen fail yet still names the dead worker's id, whose attach answers "Session worker is failed".
    const listed = liveSessionId(summary);
    const live = (listed === undefined ? null : await attachLive(listed).catch(error => { if (!isReopenable(error)) throw error; return null; }))
      ?? await attachLive(await this.reopen(id, summary));
    const { connection, activeSessionId, snapshot } = live;
    if (this.threads.get(id) !== thread) {
      await disposeConnection(connection);
      throw new ThreadError(409, "This thread was closed while it was resuming.");
    }
    this.evict("live");
    this.bind(thread, connection, activeSessionId);
    thread.broadcast({ type: "snapshot", snapshot: this.merged(thread, snapshot) });
    this.attached(thread);
    return thread;
  }

  /** Opens a saved or failed session from its file with a daemon create, which drops a dead worker's registration; resolves the new active id. */
  private async reopen(id: string, summary: SessionSummary): Promise<string> {
    if (!summary.sessionFile) throw new ThreadError(409, "This thread has no session file to resume.");
    const client = await this.daemon(id);
    // The session's own folder: without it the daemon starts the worker in the daemon's folder and the thread reports that as its workspace.
    // A folder that is gone resumes in the daemon's folder rather than not at all. Another box's folder is that box's to check.
    const config = this.catalog.hostOf(id) ? { cwd: summary.cwd } : await stat(summary.cwd).then(found => found.isDirectory() ? { cwd: summary.cwd } : {}, () => ({}));
    const sessionPath = this.catalog.daemonPath(summary) ?? summary.sessionFile;
    const response = await timedWorkerStart(`resume ${id.slice(0, 8)}`, () => client.request({ type: "create", lifecycle: "resident", sessionPath, config }, DAEMON_WORKER_START_MS, { recoverable: false }));
    if (!response.success) throw new ThreadError(502, response.error);
    const data = response.data;
    if (typeof data !== "object" || data === null || !("sessionId" in data) || data.sessionId !== id ||
      !("activeSessionId" in data) || typeof data.activeSessionId !== "string" || !data.activeSessionId) {
      throw new ThreadError(502, "Prime Agent returned no matching session for the resumed thread.");
    }
    return data.activeSessionId;
  }

  /** `kind: "chat"` sets the extension flag the user-history extension turns into the session's chat marker at its first session_start. */
  /** `host` is the hosts.json box whose daemon runs the new session; absent means this box. */
  async create(input: { cwd: string; provider?: string; modelId?: string; thinkingLevel?: ThinkingLevel; name?: string; kind?: "chat"; host?: string }): Promise<Thread> {
    const client = await this.hostDaemon(input.host ?? null);
    const response = await timedWorkerStart(`create ${input.name ?? input.cwd}`, () => client.request({ type: "create", lifecycle: "resident", ...(input.name ? { name: input.name } : {}), config: { cwd: input.cwd,
      ...(input.provider && input.modelId ? { provider: input.provider, model: input.modelId } : {}), ...(input.thinkingLevel ? { thinking: input.thinkingLevel } : {}),
      ...(input.kind === "chat" ? { extensionFlagValues: { [CHAT_FLAG]: true } } : {}) } }, DAEMON_WORKER_START_MS, { recoverable: false }));
    if (!response.success) throw new ThreadError(502, response.error);
    const data = response.data;
    if (typeof data !== "object" || data === null || !("sessionId" in data) || typeof data.sessionId !== "string" || !("activeSessionId" in data) || typeof data.activeSessionId !== "string") {
      throw new ThreadError(502, "Prime Agent returned no session for the new thread.");
    }
    if (input.host && this.catalog.isOtherHost(input.host)) this.catalog.place(input.host, data.sessionId, data.activeSessionId);
    this.evict("live");
    const connection = await this.attach(data.activeSessionId, input.host ?? null);
    let thread: Thread;
    try {
      thread = new Thread(data.sessionId, await this.liveSnapshot(connection, data as SessionSummary), (candidate, before) => this.childrenChanged(candidate, before));
      this.bind(thread, connection, data.activeSessionId);
    } catch (error) { await disposeConnection(connection); throw error; }
    this.threads.set(thread.id, thread);
    void this.catalog.refresh().catch(() => {});
    this.attached(thread);
    return thread;
  }

  /**
   * `ready` (the owner-turn mark) runs while the thread resumes and lands before the prompt goes. The prompt goes by the session's active id on
   * the box's shared daemon client and does not wait for the thread's attach, which goes on behind it: on 10-18 the owner's "did you miss?" to
   * frontend bro on the Mac never left the box, because each attach streams the whole context since the last compaction (9.9 MB, 7.75 MB of it
   * screenshots) over a relay that moves about 0.43 MB/s, and 17 attaches from 07:38Z timed out at 30 s. Over a kept link a send is one round
   * trip (230 ms to the Mac). Only a session with no live worker, or one whose listed worker is gone, waits for the resume to start it again.
   */
  async prompt(id: string, input: { message: string; images: ChatImage[]; mode: SendMode; ready?: Promise<void> | undefined; sending?: () => Promise<void> }, trigger = "prompt"): Promise<void> {
    const resumed = this.resume(id, false, trigger);
    resumed.catch(() => {});
    const held = this.threads.get(id)?.live?.activeSessionId;
    const listed = held ?? liveSessionId(await this.summary(id));
    const ask = async <T>(activeSessionId: string, type: "get_state" | "get_model_catalog" | "prompt", fields: Record<string, unknown> = {}): Promise<T> => {
      const response = await (await this.hostDaemon(this.catalog.hostOf(id))).request({ type, activeSessionId, ...fields } as never, type === "prompt" ? PROMPT_REQUEST_MS : undefined, { recoverable: false });
      if (!response.success) throw new Error(response.error);
      return response.data as T;
    };
    let activeSessionId = listed ?? (await resumed).live!.activeSessionId;
    await input.ready;
    if (input.images.length) {
      const [state, catalog] = await Promise.all([ask<{ model?: { provider: string; id: string } | null }>(activeSessionId, "get_state"),
        ask<{ models: { provider: string; id: string; input: string[] }[] }>(activeSessionId, "get_model_catalog")]);
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
    const fields = { message: input.message, source: "interactive", streamingBehavior: input.mode, queueIfBusy: true, ...(input.images.length ? { images: input.images } : {}) };
    // `sending` marks the outbox entry as maybe delivered from here on (src/outbox.ts): a failure after it is looked for before a resend.
    await input.sending?.();
    try { await ask(activeSessionId, "prompt", fields); } catch (error) {
      if (activeSessionId !== listed || held || !isReopenable(error)) throw error;
      activeSessionId = (await resumed).live!.activeSessionId;
      await input.sending?.();
      await ask(activeSessionId, "prompt", fields);
    }
    const thread = this.threads.get(id);
    if (thread?.live) void this.refreshQueue(thread).catch(() => {});
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

  /**
   * Resolves once the thread's turn reads ended (no stream, retry, bash or compaction), polling its state every 250 ms; throws when it still
   * runs after `timeoutMs`, the daemon's own 30 s request timeout, so a caller never sends a continue into a run its abort did not stop.
   */
  async settled(id: string, timeoutMs = 30_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const { live } = await this.current(id, "settled");
      if (!live) return;
      const state = await live.connection.getState();
      if (!state.isStreaming && !state.retryAttempt && !state.isBashRunning && !state.isCompacting) return;
      if (Date.now() >= until) throw new ThreadError(504, `the turn of ${id.slice(0, 8)} still runs ${Math.round(timeoutMs / 1000)} s after its abort`);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  /**
   * A saved thread runs no turn, so its abort has nothing to stop and returns. Before, it answered 409 "Reply to resume this thread first", and
   * on 10-19 the check-in and job-steer restarts of saved jobs failed with it (7 jobs of chat 01a115e2 from 11:0xZ, and the metal box owner).
   */
  async abort(id: string, trigger = "abort"): Promise<void> {
    const { live } = await this.current(id, trigger);
    if (!live) return;
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
    const { live } = await this.requireResumed(id, "resume_queue");
    const response = await (await this.daemon(live.activeSessionId)).request({ type: "resume_queue", activeSessionId: live.activeSessionId }, undefined, { recoverable: false });
    if (!response.success && response.error !== "No queued work to resume") throw new ThreadError(502, response.error);
  }

  /**
   * Deletes a finished subagent of the thread the way `rlm.delete_subagent` does, so its worker and Python kernel stop holding memory. A dormant
   * chat refuses: on 10-14 the job cleanup after a service start woke slack green guy 7 s after it was left detached, 236 min idle.
   */
  async deleteSubagent(id: string, childId: string): Promise<SubagentDelete> {
    if (this.dormant.has(id)) throw new ThreadError(409, "The chat is dormant; its finished jobs go with its worker, or at the next service start after it wakes.");
    const { live } = await this.requireLive(id, "delete_subagent");
    const response = await (await this.daemon(live.activeSessionId)).request({ type: "delete_rlm_subagent", activeSessionId: live.activeSessionId, childId }, 30000, { recoverable: false });
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
   * Archive the way the terminal agents view deactivates an agent (Ctrl+X): tell open tabs, drop this server's own attachment, stop the session
   * and its scheduled jobs, record the native archived state in its session file, and hide the row at once. A resident session gets a kill; one
   * no worker holds, or one the kill finds already ended ("Unknown active session"), gets `archiveSaved`. When its daemon did not confirm the
   * stop, the archive still holds here and it throws ScheduledJobsLeft. When the daemon archived it and cancelled its jobs but holds the stop of
   * a handed-off service for a receipt it could not read, it throws ServicesStopPending and queues nothing, since Prime finishes that stop itself.
   */
  async archive(id: string): Promise<void> {
    this.archiveStarts.set(id, Date.now());
    this.archiving.set(id, (this.archiving.get(id) ?? 0) + 1);
    this.archivedAt.set(id, Date.now());
    try { await this.archiveNow(id); } finally {
      const left = (this.archiving.get(id) ?? 1) - 1;
      if (left > 0) this.archiving.set(id, left); else this.archiving.delete(id);
      this.archivedAt.set(id, Date.now());
    }
  }

  private async archiveNow(id: string): Promise<void> {
    const archivedAt = Date.now();
    const summary = await this.catalog.summary(id);
    if (!summary) throw new ThreadError(404, "Thread not found.");
    this.unpin(id);
    this.threads.get(id)?.broadcast({ type: "status", connection: "closed", error: "This thread was archived." });
    await this.dispose(id);
    const killed = summary.activeSessionId !== undefined && await this.archiveKill(id, summary.activeSessionId) === "stopped";
    const host = this.catalog.hostOf(id), sessionPath = this.catalog.daemonPath(summary);
    const saved = killed || !sessionPath ? undefined : await this.archiveSaved(id, host, sessionPath);
    this.setSessionState(summary, "archived");
    this.catalog.holdLifecycle(id, "archived");
    if (summary.lifecycle !== "archived" || summary.activeSessionId) void this.catalog.refresh().catch(() => {});
    if (saved === undefined || "services" in saved) await this.cancels?.done(id);
    if (saved === undefined) return;
    if ("services" in saved) {
      throw new ServicesStopPending(`The thread is archived and its scheduled jobs are cancelled. A service it handed off still runs, because ${host ?? "this box"}'s ` +
        `Prime could not read its receipt (${saved.services}). Prime keeps that stop and finishes it at its next start or owner stop, archive or delete.`);
    }
    const left = saved.jobs;
    if (!this.cancels || !sessionPath) throw new ScheduledJobsLeft(`The thread is archived, but its scheduled jobs may still run: ${left}.`);
    const queued = await this.cancels.add({ id, host, sessionPath, archivedAt, error: left }).then(() => true, () => false);
    throw new ScheduledJobsLeft(queued
      ? `The thread is archived. Its scheduled jobs are not cancelled yet (${left}). The chat service retries the cancel until ${host ?? "this box"} answers, ` +
        "unless the thread is reopened first. If a typed prompt or a message from the chat service reaches the thread before then, the retry cannot tell " +
        "who sent it and waits until you archive or reopen the thread again."
      : `The thread is archived, but its scheduled jobs may still run (${left}), and the retry could not be recorded.`);
  }

  /** A bare kill, which a kill_origin daemon records as the owner's stop, so it ends the session's scheduled jobs. "gone": the daemon no longer holds it. */
  private async archiveKill(id: string, activeSessionId: string): Promise<"stopped" | "gone"> {
    const response = await (await this.daemon(activeSessionId)).request({ type: "kill", activeSessionId }, 30000, { recoverable: false });
    if (response.success) return "stopped";
    if (response.error.startsWith(UNKNOWN_ACTIVE)) return "gone";
    if (!STOP_PENDING.test(response.error)) throw new ThreadError(502, response.error);
    this.finishKill(id, activeSessionId);
    return "stopped";
  }

  /**
   * The owner's archive of a session no worker holds, on the daemon of `host` (null: this box), by the path that daemon knows its file by. A
   * daemon whose last hello lacks saved_session_archive (mem.2, mem.3, mem.4) gets nothing, as before, even while it is down: there an idle
   * unload's kill already ended the jobs. The command goes out only under the hello of its own connection, and a daemon with it cancels the
   * saved tree's jobs. When it refuses the session as resident at the owner's archive, the archive kills that session's own active session,
   * as it kills any resident session, and asks once more if the kill finds it gone again. A session loaded after a confirmed archive is left
   * alone: an archived thread may answer a later agent message. Returns why the jobs may still be armed (`jobs`), the receipts whose service
   * stop Prime still holds (`services`), or undefined.
   */
  private async archiveSaved(id: string, host: string | null, sessionPath: string): Promise<{ jobs: string } | { services: string } | undefined> {
    const where = host ? `${host}'s daemon` : "this box's daemon";
    const known = this.catalog.helloOf(host);
    if (known && !takesSavedArchive(known)) return undefined;
    if (!known) {
      try {
        const client = await this.hostDaemon(host);
        if (!takesSavedArchive(client.hello ?? await client.waitForHello(host ? 3000 : LOCAL_HELLO_MS))) return undefined;
      } catch (error) { return { jobs: `${where} did not answer (${error instanceof Error ? error.message : String(error)})` }; }
    }
    for (let round = 0; round < 2; round++) {
      const answer = await archiveSavedSession(this.catalog.socketPathFor(host), sessionPath, 30000);
      if (answer.kind === "unsupported" || answer.kind === "archived") return undefined;
      if (answer.kind === "stopPending") return { services: answer.unresolved };
      if (answer.kind === "failed") return { jobs: `${where} answered: ${answer.error}` };
      await this.catalog.refresh().catch(() => {});
      const active = (await this.catalog.summary(id))?.activeSessionId;
      if (!active) return { jobs: `${where} holds the session in a worker it does not list as this thread's` };
      if (await this.archiveKill(id, active) === "stopped") return undefined;
    }
    return { jobs: `the session loaded and stopped again on ${where} during the archive` };
  }

  /**
   * One retry of an unconfirmed cancel, by the box and path the archive recorded, read against that box's own row, since `summary` shows a
   * held archive with no active session. It never kills and never opens the session, because an archived thread may still answer an agent
   * message (Chats.archive): a session loaded now waits for its unload. Before the cancel goes out, the session file says what started turns
   * since the archive (`resumeSince`). A message another agent session sent is accepted work, which the cancel must not end, so the entry
   * ends there with a log line. A user prompt may be a plain cron run or a person's message, an agent message with no sending session may be
   * the chat service's own wake or a held send older than the archive, and a file that does not read says nothing, so the entry stays and
   * nothing is sent until the owner reopens the thread. Heartbeat prompts alone are the kept jobs firing, so the cancel goes out. Another
   * box's entries carry that box's clock, which NTP keeps within the archive's own timing.
   */
  private async retryCancel(entry: PendingCancel): Promise<CancelTry> {
    const row = (entry.host ? this.catalog.remoteRows() : this.catalog.daemonRows()).find(candidate => candidate.sessionId === entry.id);
    if (row?.activeSessionId) return { outcome: "again", error: "the session is loaded, so the cancel waits until it is unloaded" };
    let since: ResumeSince;
    try {
      const file = entry.host ? row && await this.catalog.localFile(row) : entry.sessionPath;
      if (!file) return { outcome: "again", error: `${entry.host} does not list the session, so its file cannot say what woke it since the archive` };
      since = existsSync(file) || entry.host ? await resumeSince(file, entry.archivedAt, entry.id) : "none";
    } catch (error) {
      return { outcome: "again", error: `the session file did not read, so nothing tells an accepted message from a scheduled wake (${error instanceof Error ? error.message : String(error)})` };
    }
    if (since === "accepted") return { outcome: "done", note: "the session answered a message another agent session sent after the archive, so the cancel would end authorized work" };
    if (since === "unproven") return { outcome: "again", error: "a user prompt or a service-sent message came in after the archive, which may be a cron run or a wake, so the cancel waits for the owner to archive or reopen the thread" };
    const answer = await archiveSavedSession(this.catalog.socketPathFor(entry.host), entry.sessionPath, 30000);
    if (answer.kind === "archived") return { outcome: "done" };
    if (answer.kind === "stopPending") return { outcome: "done", note: `its jobs are cancelled, and Prime keeps the stop of the handed-off services whose receipts it could not read (${answer.unresolved})` };
    if (answer.kind === "unsupported") return { outcome: "done", note: "its daemon no longer lists saved_session_archive" };
    if (answer.kind === "resident") return { outcome: "again", error: "the daemon holds the session in a worker" };
    if (answer.error.startsWith(UNKNOWN_SAVED)) return { outcome: "done", note: answer.error };
    return { outcome: "again", error: answer.error };
  }

  /** The owner unarchived or reopened the thread: an unconfirmed cancel of its archive ends before anything opens it again. */
  async supersedeArchive(id: string): Promise<void> { await this.cancels?.supersede(id); }

  /** The supervisor gave up waiting (its graceful window is 2 s) and keeps stopping the worker; if it is still listed a little later, ask once more. */
  private finishKill(id: string, activeSessionId: string): void {
    setTimeout(() => {
      void (async () => {
        await this.catalog.refresh().catch(() => {});
        if ((await this.catalog.summary(id))?.activeSessionId !== activeSessionId) return;
        await (await this.daemon(activeSessionId)).request({ type: "kill", activeSessionId }, 30000, { recoverable: false }).catch(() => {});
        await this.catalog.refresh().catch(() => {});
      })().catch(() => {});
    }, 5000).unref();
  }

  /** Whether an archive through this server began at or after `since`. */
  archivedSince(id: string, since: number): boolean { return (this.archiveStarts.get(id) ?? -Infinity) >= since; }

  /** Undo an archive: the thread comes back as a saved thread that resumes on the next reply. */
  async unarchive(id: string): Promise<void> {
    await this.supersedeArchive(id);
    const summary = await this.catalog.summary(id);
    if (!summary) throw new ThreadError(404, "Thread not found.");
    this.reactivate(id, summary);
    await this.catalog.refresh();
  }

  /**
   * After the idle unload's kill, which writes the archived state: the thread stays on the owner's list as a saved thread, unless an archive
   * through this server ran at any point from `since` (when the unload began that stop), which wins. On 10-18 the unload's kill hid the plain
   * thread 01a14c31 at 05:39:42Z, 3 min after it was restored, because only chats were unarchived after it. A thread whose archive still waits for
   * its cancel stays archived, since that stop is no reopen. False when it left the thread as is.
   */
  async keepListed(id: string, since: number): Promise<boolean> {
    const summary = await this.catalog.summary(id);
    if (await this.cancels?.has(id)) return false;
    if (!summary || this.archiving.has(id) || (this.archivedAt.get(id) ?? -Infinity) >= since) return false;
    this.reactivate(id, summary);
    void this.catalog.refresh().catch(() => {});
    return true;
  }

  /** Synchronous, so an archive cannot interleave between the check in `keepListed` and these writes. */
  private reactivate(id: string, summary: SessionSummary): void {
    this.setSessionState(summary, "active");
    this.catalog.holdLifecycle(id, "active");
    this.catalog.forget(id);
  }

  /** Skips a file deleted since the listing: SessionManager.open would recreate a stub at the old path. */
  private setSessionState(summary: SessionSummary, status: "archived" | "active"): void {
    // Another box's file is that box's to write; the catalog names it by a local copy, which a write here would only fork.
    if (!summary.sessionFile || this.catalog.hostOf(summary.sessionId) || !existsSync(summary.sessionFile)) return;
    setFileSessionState(summary.sessionFile, status);
  }

  async rename(id: string, name: string): Promise<void> {
    const thread = this.dormant.has(id) ? await this.resume(id, false, "rename") : await this.open(id);
    if (thread.live) { await thread.live.connection.setSessionName(name); await this.refreshInfo(thread); return; }
    if (!thread.sessionFile) throw new ThreadError(409, "This thread has no session file to rename.");
    const owner = [...this.threads.values()].find(candidate => candidate.live) ?? null;
    if (!owner?.live) throw new ThreadError(409, "Open a live thread first, then rename saved threads.");
    await owner.live.connection.renameSavedSession(this.catalog.daemonPath({ sessionId: id, sessionFile: thread.sessionFile }) ?? thread.sessionFile, name);
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
    try { return await use(connection, null); } finally { await disposeConnection(connection); }
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

  /**
   * A message the feed shows, whole, by its key (src/shared/message-key.ts): found in the session file walking back from the newest entry, so it
   * works for any page; a message the file does not hold yet comes from the live context. Until 10-18 `part` took an index into the messages
   * the server held, which pointed at another message once older pages loaded.
   */
  private async rawMessage(id: string, key: MessageKey): Promise<AgentMessage> {
    const summary = await this.summary(id);
    if (summary.sessionFile) {
      const file = await this.sessionFile(summary);
      const found = await findMessage(file, key.at, key.n);
      if (found) return found.message;
      if (found === undefined) {
        const messages = historyMessages(this.branch(summary, file)).filter(shownMessage);
        const index = keyIndex(messages, key);
        if (index >= 0) return messages[index]!;
      }
    }
    const live = this.threads.get(id)?.live;
    if (live) {
      const messages = (await live.connection.getMessages()).filter(shownMessage);
      const index = keyIndex(messages, key);
      if (index >= 0) return messages[index]!;
    }
    throw new ThreadError(404, "This message is not in the thread.");
  }

  /** A tool call and its whole output by the call's id, from the session file walking back from the newest entry, else from the live context. */
  async toolOutput(id: string, toolCallId: string): Promise<{ toolCallId: string; toolName: string; arguments: unknown; output: string; isError: boolean | null }> {
    const summary = await this.summary(id);
    let messages: AgentMessage[] = [];
    if (summary.sessionFile) {
      const file = await this.sessionFile(summary);
      const found = await findToolCall(file, toolCallId);
      messages = found === undefined ? historyMessages(this.branch(summary, file)) : [found.call, found.result].filter(message => message !== undefined);
    }
    const live = this.threads.get(id)?.live;
    if (!messages.length && live) messages = await live.connection.getMessages();
    let call: { name: string; arguments: unknown } | undefined;
    let result: { text: string; isError: boolean } | undefined;
    for (const message of messages) {
      if (message.role === "assistant") for (const part of message.content) if (part.type === "toolCall" && part.id === toolCallId) call = { name: part.name, arguments: part.arguments };
      if (message.role === "toolResult" && message.toolCallId === toolCallId) result = { text: message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n"), isError: message.isError };
    }
    if (!call && !result) throw new ThreadError(404, "This tool call is not in the thread.");
    return { toolCallId, toolName: call?.name ?? "", arguments: call?.arguments ?? {}, output: result?.text ?? "", isError: result?.isError ?? null };
  }

  async part(id: string, key: MessageKey, partIndex: number): Promise<{ text: string }> {
    const message = await this.rawMessage(id, key);
    const content = "content" in message ? message.content : undefined;
    if (typeof content === "string") return { text: content };
    const part = Array.isArray(content) ? content[partIndex] : undefined;
    if (!part) throw new ThreadError(404, "This part is not in the thread.");
    if (part.type === "text") return { text: part.text };
    if (part.type === "thinking") return { text: part.thinking };
    throw new ThreadError(400, "This part has no text.");
  }

  async warm(id: string): Promise<void> { await this.open(id); }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.sweeper);
    this.cancels?.close();
    this.unwatchCatalog?.();
    await Promise.all([...this.threads.keys()].map(id => this.dispose(id)));
    await this.firstPages.flush();
  }
}
