/**
 * The typed HTTP client for every endpoint in apps/chat/API.md. Each call returns the parsed body or throws `ApiError` with the server's
 * message. Paths are relative, so the page works behind Vite's proxy on :5185 and from the server on :5184 alike.
 */
import type {
  AgentConfig, AgentFolder, AgentHostList, AgentPrompt, AgentId, AgentSummary, BoardOp, BoardRow, BoardView, BoardWrite, CheckInPatch, CheckInView, ChatAgent, ConversationHeader, ConversationId,
  ConversationPatch, ConversationSummary, DutyAction, DutyRow, ForMeItem, ForMeList, ForMeStatus, ForYouItem, HarnessEntryView, HostsReport, HostThreadFilter, ImageRef, Item, JobNode, Me, Member, MemoryInput, ModelCatalog, OpenedPage, ProjectList, SearchQuery, SearchResult, SendRequest, WikiPages,
  LaterItem, LaterList, LaterPatch, LaterRequest, LaterState, ReactionRequest, ReadAllRequest, ReadPoint, Room, RoomInput, RoomPatch, SendResult, Sidebar, StepOutputRef, ThinkingLevel, ThreadDoneRequest, TimelinePage, UsageBucket, UsageRange, UsageReport, AccountsView,
} from "./types.ts";
import type {
  AdoptBody, ApplyBody, ApplyResult, InstallBody, MergeBody, MoveBody, OwnBody, RemoveBody, SkillDoc, SkillMoves, SkillScan, SkillsChange, SkillsCheck,
  SkillsView, UndoBody,
} from "./shared/skills.ts";
import type { ConsolesReport } from "./shared/consoles.ts";
import type { OwnerSettings, SavedSettings } from "./shared/owner-settings.ts";
import type { ReviewDecideBody, ReviewItem, ReviewReport, ReviewResult, ReviewUndoBody } from "./shared/skills-review.ts";
import type { PinRequest } from "./types.ts";
import type { SavedLayout, SidebarLayout } from "./types.ts";
import type { ConversationPrefs, PrefsPatch } from "./types.ts";
import { pageReloading } from "./reload.ts";
import { shrink } from "./shrink.ts";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}


const enc = encodeURIComponent;

/** The DM room of an agent id: `ag_<slug>` has `dm_<slug>`. A job's or a root thread's id names its own conversation. */
export const roomOf = (id: AgentId): ConversationId => (id.startsWith("ag_") ? `dm_${id.slice(3)}` : id);

/** A Solo room (`so_<id>`): a group chat of invited agents around one agenda. An untitled root chat in the Solo group is not one. */
export const isSoloRoom = (id: ConversationId): boolean => id.startsWith("so_");

/**
 * Where a board, its duties and its check-in live: `/api/agents/<id>` for an agent (`ag_<slug>`), and `/api/threads/<id>` for a root
 * thread that no agent owns yet.
 */
const boardBase = (chat: string): string => (chat.startsWith("ag_") ? `/api/agents/${enc(chat)}` : `/api/threads/${enc(chat)}`);

/**
 * How long the page waited for each call, posted in batches to POST /api/timings for the daily speed duty (server/request-log.ts). It holds
 * what the server's own timing misses: the network and the wait while another request blocks the server. `net` is the browser's own
 * network time for the call (Resource Timing, start to the last byte), so the duty can tell it from the time the page's main thread was
 * busy before it could send the call or read the answer: on 11-03 a thread open in the box Chrome waited 2,135 ms for /api/rooms, of which
 * the network and the server took 29 ms.
 */
type Timing = { m: string; p: string; s: number; ms: number; net?: number; enc?: number; stored?: number; err?: string; shown?: true; page?: PageState; hid?: number; wait?: Wait };

/**
 * The page's hidden spells as [start, end) in `performance.now()`, the one going on with end Infinity. A call's line names in `hid` the ms
 * of its `ms` the page was hidden, which the speed duty takes off the wait (scripts/duties/api-speed.ts), since the owner saw none of it: a
 * page reloads for a newer build while it is hidden or out of focus (reload.ts), as after a Mac wakes, and its first reads then wait while
 * nobody looks.
 */
const hiddenSpells: [number, number][] = [];
const hiddenWithin = (from: number, to: number): number => hiddenSpells.reduce((sum, [start, end]) => sum + Math.max(0, Math.min(end, to) - Math.max(start, from)), 0);
if (typeof document !== "undefined") {
  if (document.visibilityState === "hidden") hiddenSpells.push([0, Infinity]);
  document.addEventListener("visibilitychange", () => {
    const now = performance.now();
    const open = hiddenSpells.at(-1);
    if (document.visibilityState === "hidden") {
      if (!open || open[1] !== Infinity) hiddenSpells.push([now, Infinity]);
      if (hiddenSpells.length > 20) hiddenSpells.shift();
    } else if (open && open[1] === Infinity) open[1] = now;
  });
}

/**
 * What the page was doing when a call failed, logged beside the failure so duty d2 counts only failures the owner could see (scripts/
 * restart-walk-hits.ts): `leaving` once the page began to reload for a newer build (reload.ts) or to unload, since its own reload aborts
 * its calls, `hidden` for a hidden tab, else `visible`. On 11-22, 49 of 50 failed calls after a restart were a hidden page's calls aborted
 * by its own reload, which the owner never saw.
 */
type PageState = "visible" | "hidden" | "leaving";
let leaving = false;
const pageState = (): PageState => (leaving || pageReloading() ? "leaving" : document.visibilityState === "hidden" ? "hidden" : "visible");

/**
 * What the owner saw while a call ran, which its caller sets and may change until the batch is posted. `ahead` is a read ahead of any
 * view, such as a room's page before he opens it; the caller clears it when a view starts to wait on the read. `shown` is a refresh behind
 * a page the screen already showed from the page's cache; the caller clears it when the answer changed what the screen showed, since he
 * waited for that. Without one the screen waited on the call. The speed duty reads it as `bg` (request-log.ts).
 */
export type Wait = {
  background?: "ahead" | "shown";
  /**
   * What the owner looks at now: a read ahead of the rows Cmd K lists or the thread and job pills of the open room, which the lane sends
   * before the sidebar's reads ahead, or the refresh behind the room or thread he opened, which it sends before a panel's refresh.
   */
  first?: true;
  /**
   * A send: `since` is his Enter and `shownMs` the time from it until the message's bubble was painted. The bubble, with Sending and any
   * image from the page, is all he waits for, so the line's `ms` is `shownMs`; the time from Enter until the server stored the message,
   * its uploads included, goes beside it as `stored` and is no wait of his.
   */
  since?: number;
  shownMs?: number;
  /** The ms an image's encode took before its upload (shrink.ts), logged beside the call as `enc`. */
  encodeMs?: number;
  /**
   * When the call last left the page (`performance.now()`), which `send` sets. A kept answer whose read left after the live socket opened
   * missed no event of it, so the socket's hello reads it no more (kept.svelte.ts `missed`).
   */
  sent?: number;
};

/**
 * The page's round trip to the server: the least network time of its last 20 calls, since the fastest handlers answer in about 1 ms
 * (replies 1.2 ms and read 2.3 ms in the 11-20 duty run).
 */
const recentNet: number[] = [];
const roundTripMs = (): number | undefined => (recentNet.length ? Math.min(...recentNet) : undefined);
const timings: Timing[] = [];
let timingsTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Posts the batch. A batch that did not reach the server goes back in the queue, so a failure seen while the server restarts reaches the log
 * once it is back; the page's last batch goes as a beacon on pagehide.
 */
function sendTimings(beacon = false): void {
  clearTimeout(timingsTimer);
  timingsTimer = undefined;
  if (!timings.length) return;
  const samples = timings.splice(0);
  const body = JSON.stringify({ samples: samples.map(({ wait, ...sample }) => (wait?.background ? { ...sample, bg: wait.background } : sample)) });
  // The browser keeps 250 resource entries by default and then drops new ones, so each batch empties the buffer.
  performance.clearResourceTimings();
  if (beacon && navigator.sendBeacon?.("/api/timings", new Blob([body], { type: "application/json" }))) return;
  const requeue = () => {
    timings.unshift(...samples);
    timingsTimer ??= setTimeout(sendTimings, 10_000);
  };
  void fetch("/api/timings", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true })
    .then(response => (response.status >= 500 ? requeue() : undefined), requeue);
}

/** The network time of the call to `path` that started at `started`, from its Resource Timing entry, if the browser has one. */
function networkMs(path: string, started: number): number | undefined {
  const entries = performance.getEntriesByName(new URL(path, location.href).href, "resource") as PerformanceResourceTiming[];
  const entry = entries.findLast(e => e.startTime >= started - 1);
  return entry && entry.responseEnd > 0 ? Math.round(entry.responseEnd - entry.startTime) : undefined;
}

/**
 * Records one call; a failed call names its error and goes out at once, so the server log holds it beside the request it failed on. A call
 * a view asked for counts from `asked`, so a refresh that waited in the lane and then changed the screen counts that wait too.
 */
function recordTiming(m: string, path: string, s: number, started: number, err?: string, wait?: Wait, asked?: number, first = started): void {
  if (typeof window === "undefined") return;
  const net = networkMs(path, started);
  if (net !== undefined && s > 0) {
    recentNet.push(net);
    if (recentNet.length > 20) recentNet.shift();
  }
  const now = performance.now();
  const from = wait?.since ?? (wait?.background === "ahead" ? first : asked ?? first);
  const hid = wait?.shownMs === undefined ? Math.round(hiddenWithin(from, now)) : 0;
  timings.push({
    m, p: path.split("?")[0]!, s, ms: Math.round(wait?.shownMs ?? now - from), ...(net === undefined ? {} : { net }), ...(hid > 0 ? { hid } : {}),
    ...(wait?.encodeMs === undefined ? {} : { enc: wait.encodeMs }), ...(wait?.since === undefined ? {} : { stored: Math.round(now - wait.since) }),
    ...(err ? { err, page: pageState() } : {}), ...(wait ? { wait } : {}),
  });
  if (err) sendTimings();
  else timingsTimer ??= setTimeout(sendTimings, 10_000);
}

if (typeof window !== "undefined") addEventListener("pagehide", () => {
  leaving = true;
  sendTimings(true);
});

/**
 * A send the page gave up on and showed as Not delivered, with the last call's status (0 when it never reached the server) and error. Each
 * failed call already has its own line, and a send that lands on a later try is no failure, so the speed duty counts only these lines.
 */
export function reportNotDelivered(conversation: ConversationId, status: number, err: string): void {
  if (typeof window === "undefined") return;
  timings.push({ m: "POST", p: `/api/c/${enc(conversation)}/send`, s: status, ms: 0, err, shown: true });
  sendTimings();
}

/**
 * The lane that every read ahead (`Wait.background` "ahead") and every refresh behind a shown page ("shown") goes through, so neither
 * delays a call the owner waits on. On 11-21 at 06:30 KST his page fired about 90 reads ahead at each load, and his POST /read, a 4 ms
 * handler, waited 1.1 to 4.7 s behind them, his GET /api/later up to 1.2 s (d2 findings, requests/2026-11-20.jsonl). While a call he
 * waits on is on its way, the lane starts nothing but the refresh of the page he opened, and it stops the other calls on their way and
 * sends them again once his calls end. Refreshes
 * go before reads ahead and stop the reads ahead on their way; a read ahead goes only when no refresh is on its way, what he looks at now
 * (`Wait.first`) before the rest, and at most `AHEAD_LANE` at once. Every call in the lane goes at fetch priority low.
 *
 * A stopped read ahead's bytes already in the pipe still arrive before his answer, so fewer at once serve him better. In a walk of live
 * data over HTTP/2 and TLS at a 200 ms round trip, MTU 1280 and TCP slow start after idle (~/work/p155-readahead/lane-summary.md, 12 page
 * loads each, box load 31 to 238), his read mark took p50 207 / p90 216 ms with 2 at once, 280 / 306 with 4 and 211 / 284 with 8,
 * against 369 / 387 before the lane. With 2 the page's reads ahead settle 11.5 s after a load, as before the lane (11.2 s).
 */
export const AHEAD_LANE = 2;

/** One call's place in the lane: waiting, on its way and stoppable, taken over by a view that waits on it and so his, or settled. */
type TicketState = { kind: "queued" } | { kind: "flying"; controller: AbortController } | { kind: "taken" } | { kind: "settled" };
type Ticket = {
  readonly wait: Wait;
  state: TicketState;
  /** When a view asked for the answer, from which a refresh that changed the screen counts his wait; unset for a read ahead. */
  asked: number | undefined;
  readonly send: (signal: AbortSignal | undefined) => void;
  readonly drop: () => void;
};

const queued: Ticket[] = [];
const flying = new Set<Ticket>();
/** The calls on their way that the owner waits on, a read ahead or refresh a view took over included. */
let busy = 0;

const refresh = (ticket: Ticket): boolean => ticket.wait.background === "shown";
/** The refresh of the room or thread he opened (`Wait.first`), which is as much his as the calls he waits on. */
const pageRefresh = (ticket: Ticket): boolean => refresh(ticket) && !!ticket.wait.first;

/**
 * The queued call to send next, or -1. The refresh of the page he looks at goes first, also while one of his calls is on its way, the
 * other refreshes, such as a panel's, once it ended and none of his calls is on its way, and a read ahead once no refresh is on its way and
 * the lane has room. On 11-21 in the walk of lane-summary.md, a board refresh (42 KB) sent beside the room's refresh was still arriving
 * when the room's read mark went 26 ms after the room's answer, and held the mark 375 ms. On 11-21 at 21:47 UTC the refresh of the work
 * thread he opened waited 218 ms behind the Hosts page's 2 s poll of GET /api/hosts and then changed the screen, a wait of 431 ms where
 * the network took 213 (requests/2026-11-21.jsonl).
 */
function next(): number {
  const sent = [...flying];
  const page = queued.findIndex(pageRefresh);
  if (page >= 0) return page;
  if (busy || expected || sent.some(pageRefresh)) return -1;
  const shown = queued.findIndex(refresh);
  if (shown >= 0 || !queued.length) return shown;
  if (sent.some(refresh) || sent.length >= AHEAD_LANE) return -1;
  return Math.max(queued.findIndex(ticket => ticket.wait.first), 0);
}

/**
 * The calls he is about to make, such as the read mark a room posts 400 ms after he reaches its bottom (Conversation.svelte). Until they
 * go, only the refresh of the page he looks at leaves the lane, which the read mark waits on.
 */
let expected = 0;

/** Holds the lane for a call he is about to make; the returned function, called once the call went or will not go, lets it go on. */
export function expectCall(): () => void {
  expected += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    expected -= 1;
    pump();
  };
}

let pumping = false;

/**
 * Sends what the lane lets go, after the next paint: the calls a render starts, such as the read mark a room posts once its refresh shows,
 * are then his calls on their way, which the lane waits behind.
 */
function pump(): void {
  if (pumping) return;
  pumping = true;
  const run = () => {
    pumping = false;
    drain();
  };
  if (typeof requestAnimationFrame === "function" && typeof document !== "undefined" && !document.hidden) requestAnimationFrame(() => setTimeout(run));
  else setTimeout(run);
}

function drain(): void {
  for (let at = next(); at >= 0; at = next()) {
    const [ticket] = queued.splice(at, 1);
    if (refresh(ticket!)) stop(ticket => !refresh(ticket));
    const controller = new AbortController();
    ticket!.state = { kind: "flying", controller };
    flying.add(ticket!);
    ticket!.send(controller.signal);
  }
  if (!busy && !expected && ![...queued, ...flying].some(pageRefresh)) for (const show of afterHis.splice(0)) show();
}

/** What waits for the calls he waits on (`afterOwnCalls`). */
const afterHis: (() => void)[] = [];

/**
 * Runs `show` after the next paint once none of his calls is on its way or about to go (`expectCall`), and no refresh of the page he looks
 * at is: the images a page draws wait here (held-images.ts), so their bytes never share his link with the open's own calls.
 */
export function afterOwnCalls(show: () => void): void {
  afterHis.push(show);
  pump();
}

/** Stops the calls on their way that `which` picks and puts them back at the front of the queue, in their order. */
function stop(which: (ticket: Ticket) => boolean): void {
  const stopped = [...flying].filter(which);
  for (const ticket of stopped) {
    flying.delete(ticket);
    if (ticket.state.kind === "flying") ticket.state.controller.abort();
    ticket.state = { kind: "queued" };
  }
  queued.unshift(...stopped);
}

function settle(ticket: Ticket): void {
  const { kind } = ticket.state;
  ticket.state = { kind: "settled" };
  if (kind === "taken") busy -= 1;
  else if (kind === "flying") flying.delete(ticket);
  else if (kind === "queued") queued.splice(queued.indexOf(ticket), 1);
  pump();
}

async function waited<T>(send: () => Promise<T>, write: boolean): Promise<T> {
  busy += 1;
  stop(ticket => !pageRefresh(ticket));
  try {
    return await send();
  } finally {
    busy -= 1;
    if (write) wrote();
    pump();
  }
}

/**
 * Whether one of the owner's writes (any call but a GET) answered in the page's current task. A read asked then is the refetch that shows
 * him what his write changed, such as the member list after Add, which a view starts in the write's own promise chain, so it goes as his
 * call: at once, before the reads ahead, which hold behind it. A Work tab remove reads the agent's rooms again through a kept panel's read
 * (AgentConfigPanel.svelte `load`), which before this waited in the lane as a panel refresh at fetch priority low.
 */
let wroteNow = false;
/** When his last write answered (`performance.now()`): a read that left before it may have missed the write (kept.svelte.ts). */
let wroteAt = -Infinity;
/** The address his last write answered on. */
let wroteOn = "";
const address = (): string => (typeof location === "undefined" ? "" : location.hash);

function wrote(): void {
  wroteAt = performance.now();
  wroteOn = address();
  if (wroteNow) return;
  wroteNow = true;
  setTimeout(() => (wroteNow = false));
}

/**
 * Whether a read asked now is the refetch of his write: asked in the write's task, on the address it answered on. The timer above ends
 * that task at the next task, and a hashchange the write's chain queued, such as the open of a room he just made, can run before it. The
 * page that change opens reads its own pages, behind the page the create call sent. On 11-23 such a new channel's refresh went as his call
 * and was logged as his wait in 6 spec runs on a loaded box; in probes the timer ran 0 to 5 ms before the hashchange 6 of 6 times, and
 * after it every time the probe held the timer 40 ms (work/chat-specs-red/specs-red-channel-kept-pages/notes.md).
 */
const refetch = (): boolean => wroteNow && address() === wroteOn;

/** Whether a read asked now must leave after his last write answered, and so may not take the answer of a read on its way since before. */
export const afterWrite = (wait: Wait): boolean => refetch() && (wait.sent ?? Infinity) < wroteAt;

/** A call sent when the lane lets it; one the lane stopped is sent again from the start, and its stop is no error. */
function laned<T>(wait: Wait, attempt: (signal: AbortSignal | undefined, asked: number | undefined) => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const ticket: Ticket = {
      wait,
      state: { kind: "queued" },
      asked: wait.background === "shown" ? performance.now() : undefined,
      send: signal => void attempt(signal, ticket.asked).then(value => {
        if (ticket.state.kind === "settled") return;
        settle(ticket);
        resolve(value);
      }, (error: unknown) => {
        if (signal?.aborted || ticket.state.kind === "settled") return;
        settle(ticket);
        reject(error);
      }),
      drop: () => {
        settle(ticket);
        reject(new DOMException("The read ahead was dropped before it was sent", "AbortError"));
      },
    };
    queued.push(ticket);
    pump();
  });
}

/** How much a call is his: a read ahead, a refresh behind a shown page, or a call he waits on. */
const rank = (background: Wait["background"]): number => (background === "ahead" ? 0 : background === "shown" ? 1 : 2);

/**
 * A view takes over a read ahead: it shows the answer behind a page it already shows (`background` "shown"), and then the read waits in
 * the lane as a refresh, or it waits on it, and then its calls leave the lane at once: a queued one is sent now and one on its way is
 * never stopped, and each counts as his call until it ends. A refresh asked as his write answered is one he waits on (`wroteNow`). A take
 * over never makes a call less his: on 11-22 all 8 Work tab rooms reads after a remove or Undo in a live walk, his calls, were logged as
 * refreshes, because a later read of the same panel took each over as one (work/p155-write-refetch/walk-after.log, write-refetch.spec.ts).
 */
export function takeOver(wait: Wait, background: Wait["background"]): void {
  const next = refetch() && background === "shown" ? undefined : background;
  if (rank(next) <= rank(wait.background)) return;
  wait.background = next;
  const mine = [...queued, ...flying].filter(ticket => ticket.wait === wait);
  for (const ticket of mine) ticket.asked ??= performance.now();
  if (wait.background === "shown") return pump();
  if (!mine.length) return;
  const unsent = mine.filter(ticket => ticket.state.kind === "queued");
  for (const ticket of mine) {
    if (ticket.state.kind === "queued") queued.splice(queued.indexOf(ticket), 1);
    else flying.delete(ticket);
    ticket.state = { kind: "taken" };
    busy += 1;
  }
  stop(ticket => !pageRefresh(ticket));
  for (const ticket of unsent) ticket.send(undefined);
}

/** Drops the queued calls of a read ahead nobody wants any more, which then fails as aborted and is logged nowhere; sent ones finish. */
export function dropAhead(wait: Wait): void {
  for (const ticket of queued.filter(ticket => ticket.wait === wait)) ticket.drop();
}


/**
 * A Blob body goes as its own bytes with its own type, any other body as JSON. A call that fails, refused by the server or never reaching
 * it, posts its error with its timing (`recordTiming`), so the server's log holds every failure the page shows, such as a Not delivered send.
 * A GET read ahead or refresh goes through the lane; every other call is one he waits on, and so is a refresh asked as his write answered.
 */
function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, wait?: Wait, safeTwice = false): Promise<T> {
  if (refetch() && wait?.background === "shown") wait.background = undefined;
  const repeat = method === "GET" || safeTwice || deduped(body);
  if (wait?.background && method === "GET") return laned(wait, (own, asked) => send<T>(method, path, body, either(own, signal), wait, repeat, asked));
  return waited(() => send<T>(method, path, body, signal, wait, repeat), method !== "GET");
}

/**
 * A write whose second run leaves the server as its first did, so `send` may try it again after it got no answer: it sets fields or a
 * value (a PATCH or PUT, a reaction, pin or done mark with its value, a read mark), deletes (a second run changes nothing, or answers an
 * error for what the first did), or keeps one row however often it lands (Save for later, a For mark, room members, an upload, which
 * at worst leaves a file no post names). Every other write goes once: a create (an agent, a room, a memory entry, a reminder note), a list
 * change (board ops, a duty run or set, skills moves) and a write whose answer is its Undo (Mark all as read, a For mark of many).
 */
const twice = <T>(method: string, path: string, body?: unknown, wait?: Wait): Promise<T> => call<T>(method, path, body, undefined, wait, true);

/** A signal that aborts when either does: the lane's stop or the caller's own deadline. */
const either = (a: AbortSignal | undefined, b: AbortSignal | undefined): AbortSignal | undefined => (a && b ? AbortSignal.any([a, b]) : a ?? b);

/**
 * Whether the calls the owner waits on can take a connection of their own. A fetch with credentials "omit" goes on its own HTTP/2
 * connection in Chrome, and the app reads no cookie, so his calls never queue behind the bytes of a read ahead or refresh that are already
 * on their way: the lane can stop such a call, but its answer, written into the server's socket, still arrives first. On 11-21 at 21:38:42
 * UTC his search, a 16 ms handler, came 145 ms after a read ahead of dm_agent-factory, a two round trip answer, and took 292 ms on the
 * network (requests/2026-11-21.jsonl). In a walk at a 200 ms round trip (~/work/p190-search-queue), a small call 120 ms after a 47 KB
 * answer took 507 ms on the page's connection and 204 ms on its own. A new connection costs two round trips, so the page opens it with
 * one small call at boot and sends his calls on it once that call answered.
 */
let ownConnection = false;
if (typeof window !== "undefined") {
  void fetch("/api/me", { credentials: "omit" }).then(response => response.text()).then(() => {
    ownConnection = true;
  }, () => undefined);
}

/**
 * How long a call that did not reach the chat server tries again before it fails. Each release restarts :5184, and the port is closed from
 * the old server's stop until the new one listens: over the 195 restarts from 11-15 to 11-22 that took p50 2.45 s, p90 5.5 s, p99 9.4 s
 * and at most 21.9 s (user journal, "Stopping sieun-pi-apps-chat.service" to "apps/chat on http"). On 11-22 the page showed 98 of his
 * calls failed across 19 restarts (request log).
 */
export const RIDE_OUT_MS = 15_000;

/** The wait before try `tries + 1`: 100 ms more per try up to 500 ms, so a call lands within half a second of the new server listening. */
const tryAgainIn = (tries: number): number => Math.min(500, 100 * tries);

/** A write whose body names a `requestId`, which the server takes once: a send (rooms.ts and group-rooms.ts `byRequestId`, outbox.ts). */
const deduped = (body: unknown): boolean => !(body instanceof Blob) && typeof (body as { requestId?: unknown } | undefined)?.requestId === "string";

/** The waits of the calls that will try again, which `retryNow` ends at once. */
const waking = new Set<() => void>();

/**
 * The server is in reach again: every call waiting to try again tries now. The live socket calls it when it opens (live.svelte.ts), and
 * the page when the browser says it is online or the page shows again, as after a Mac wakes, whose tailnet fails calls for a few
 * seconds: on 11-22 at 13:50 UTC his page's first calls after a wake took 4.0 s of network (requests/2026-11-22.jsonl).
 */
export function retryNow(): void {
  for (const wake of [...waking]) wake();
}

/** Waits `ms` or until `retryNow`, or rejects as the signal aborts, so a call the lane stops during a wait stops there. */
const pause = (ms: number, signal: AbortSignal | undefined): Promise<void> => new Promise((resolve, reject) => {
  const end = () => {
    clearTimeout(timer);
    waking.delete(wake);
    signal?.removeEventListener("abort", done);
  };
  const wake = () => {
    end();
    resolve();
  };
  const done = () => {
    end();
    reject(signal!.reason);
  };
  const timer = setTimeout(wake, ms);
  waking.add(wake);
  signal?.addEventListener("abort", done, { once: true });
});

if (typeof window !== "undefined") {
  addEventListener("online", retryNow);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    retryNow();
    // A hidden page's timers wait for the browser's throttling, a lane step queued while it was hidden among them.
    pumping = false;
    pump();
  });
}

/**
 * Every call of the page goes through here. A call that never got the server's answer, a network error or the bare 502 that `tailscale
 * serve` gives while :5184 is closed or a hand-over's old server closes an idle connection under it, goes again for `RIDE_OUT_MS` when
 * `repeat` says it may run twice (`call`: a GET, a send, a `twice` write), so a release shows the owner a slower answer and no error. Its
 * timing line counts from the first try and holds only the last try's outcome.
 */
async function send<T>(method: string, path: string, body: unknown, signal: AbortSignal | undefined, wait: Wait | undefined, repeat: boolean, asked?: number): Promise<T> {
  const first = performance.now();
  const again = async (tries: number): Promise<boolean> => {
    const ms = tryAgainIn(tries);
    if (!repeat || performance.now() + ms - first > RIDE_OUT_MS) return false;
    await pause(ms, signal);
    return true;
  };
  const blob = body instanceof Blob;
  for (let tries = 1; ; tries++) {
    const started = performance.now();
    if (wait) wait.sent = started;
    let response: Response;
    let text: string;
    try {
      response = await fetch(path, {
        method,
        headers: body === undefined ? {} : { "content-type": blob ? body.type || "application/octet-stream" : "application/json" },
        ...(body === undefined ? {} : { body: blob ? body : JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
        ...(wait?.background && method === "GET" && !(wait.background === "shown" && wait.first) ? { priority: "low" as const } : {}),
        ...(ownConnection && !wait?.background ? { credentials: "omit" as const } : {}),
      });
      text = await response.text();
    } catch (error) {
      if (signal?.aborted) throw error;
      if (await again(tries)) continue;
      recordTiming(method, path, 0, started, error instanceof Error ? `${error.name}: ${error.message}` : String(error), wait, asked, first);
      throw error;
    }
    let value: unknown;
    let error: string | undefined;
    try {
      value = text ? (JSON.parse(text) as unknown) : undefined;
    } catch {
      error = `${method} ${path} answered ${response.status} with a body that is not JSON`;
    }
    const said = (value as { error?: string } | undefined)?.error;
    if (response.status === 502 && said === undefined && await again(tries)) continue;
    const failure = response.ok ? error : said ?? error ?? `${method} ${path} failed with ${response.status}`;
    recordTiming(method, path, response.status, started, failure, wait, asked, first);
    if (failure !== undefined) throw response.ok ? new Error(failure) : new ApiError(response.status, failure);
    return value as T;
  }
}

/** A list value goes as one comma list, such as `from=owner,ag_vent`; an empty list is left out. */
const query = (params: Record<string, string | number | boolean | readonly string[] | undefined | null>): string => {
  const entries = Object.entries(params).flatMap(([k, v]) => {
    const value = Array.isArray(v) ? v.join(",") : v;
    return value === undefined || value === null || value === "" ? [] : [[k, String(value)] as const];
  });
  return entries.length ? `?${entries.map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&")}` : "";
};

/** A fresh id for `SendRequest.requestId`, so a retried send lands once. */
export const requestId = (): string => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/**
 * A file the owner attached, an image or any other file. Its bytes, a PNG as a smaller WebP when that pays (`shrink`), go to POST /api/uploads the moment it is
 * attached, while he types, so the send names only the ref. `preview` shows it before the upload ends, `file` is what he attached, and
 * `ref()` is that upload, started again after a failure. The thumbnail and the sent message show without the upload, so its line is
 * background (`Wait`).
 */
export interface Attached { preview: string; mimeType: string; file: Blob; ref: () => Promise<ImageRef>; name?: string; size?: number }

/** The ref a send shows before its upload lands: an image's preview, or a file's preview with its name and size for its card. */
export const shownRef = (url: string, a: Pick<Attached, "mimeType" | "name" | "size">): ImageRef =>
  a.name === undefined ? { url, mimeType: a.mimeType } : { url, mimeType: a.mimeType, name: a.name, size: a.size ?? 0 };

/** What `attach` takes a Blob's type, name and size as: a File with no type is a file, a Blob with none a pasted image. */
export function attachedFacts(file: Blob): Pick<Attached, "mimeType" | "name" | "size"> {
  const mimeType = file.type || (file instanceof File ? "application/octet-stream" : "image/png");
  return mimeType.startsWith("image/") ? { mimeType } : { mimeType, name: file instanceof File ? file.name : "file", size: file.size };
}

export function attach(file: Blob): Attached {
  const smaller = shrink(file, roundTripMs());
  const facts = attachedFacts(file);
  let upload: Promise<ImageRef> | undefined;
  const ref = (): Promise<ImageRef> => (upload ??= smaller.then(({ blob, encodeMs }) =>
    api.upload(blob, { background: "shown", ...(encodeMs === undefined ? {} : { encodeMs }) }, facts.name)).catch((error: unknown) => {
    upload = undefined;
    throw error;
  }));
  void ref().catch(() => undefined);
  return { preview: URL.createObjectURL(file), file, ref, ...facts };
}

/**
 * A GET whose answer the page keeps and shows before it reads it again (kept.svelte.ts): its path and, in the type only, its answer.
 * `live` marks one the socket keeps current between reads, by the event that carries its whole answer. `pick` keeps only the part of the
 * server's answer the page shows, so a refresh that changed only the rest leaves the screen as it was and counts as no wait of his.
 */
export interface Read<T> {
  readonly path: string; readonly live?: true; readonly pick?: (answer: never) => T; readonly answer?: T;
  /** How long a read may take before it fails with `error`, so a panel with nothing to show offers Retry instead of loading forever. */
  readonly deadline?: { ms: number; error: string };
}
const read = <T>(path: string, live?: true): Read<T> => ({ path, ...(live ? { live } : {}) });
export function get<T>(of: Read<T>, wait?: Wait): Promise<T> {
  const signal = of.deadline ? AbortSignal.timeout(of.deadline.ms) : undefined;
  const answer = call<never>("GET", of.path, undefined, signal, wait).catch((error: unknown) => {
    throw signal?.aborted && of.deadline ? new Error(of.deadline.error) : error;
  });
  return of.pick ? answer.then(of.pick) : answer;
}

/** How long For you waits for /api/for-you before it shows an error with Retry; with board reads cached it answered in 10 to 680 ms during searches on 10-28. */
export const FOR_YOU_DEADLINE_MS = 10_000;

/** An agent as a picker lists it: its name and run status. */
export type PickerAgent = Pick<AgentSummary, "id" | "name" | "status" | "archived">;

/**
 * A channel or Solo room as the page lists it, for the # typeahead, mention chips and pickers (pages/channel/directory.svelte.ts):
 * without its `lastSeq` and its members' run status, which change with every post and turn and which no list shows. On 11-21 his
 * GET /api/rooms refreshes waited p90 1151 ms (d2 run of 11-22 06:30 KST) because each answer differed in those two, so each counted as
 * a wait and drew every open message's mentions again.
 */
export type ListedRoom = Omit<Room, "lastSeq" | "members"> & { members: Omit<Member, "status">[] };
export const listedRoom = ({ lastSeq: _lastSeq, members, ...room }: Room): ListedRoom => ({ ...room, members: members.map(({ status: _status, ...member }) => member) });

/** The reads of the panels the owner opens: the Agents page, an agent's page, and a chat's board with its duties, check-in and jobs. */
export const reads = {
  /**
   * A walk's test agents, for a test room's member picker, with only what the picker shows. Each add or remove changes the agent's `rooms`
   * and `updatedAt`, so in the p155 sweep at a 200 ms round trip every refresh of the whole list differed, counted as his wait and took
   * 1,601 to 1,930 ms from the picker's open, while its network took 410 to 421 ms (~/work/p155-sweep/fix-agents-list/notes.md).
   */
  testAgents: (): Read<PickerAgent[]> => ({
    path: "/api/agents?test=1",
    pick: (agents: AgentSummary[]) => agents.filter(agent => agent.test).map(({ id, name, status, archived }) => ({ id, name, status, archived })),
  }),
  /** Every open room with walks' test rooms, for a test agent's channel picker. */
  testRooms: () => read<Room[]>("/api/rooms?test=1"),
  /** Live and archived agents, for the Agents page: its Archived tab, and its list while the live socket has not connected. */
  allAgents: () => read<AgentSummary[]>("/api/agents?archived=1"),
  models: () => read<ModelCatalog>("/api/models"),
  /** Channels and Solo rooms; a DM is listed by agent, never here. */
  rooms: (): Read<ListedRoom[]> => ({ path: "/api/rooms", pick: (rooms: Room[]) => rooms.map(listedRoom) }),
  /** Archived channels and Solo rooms, newest first, for the sidebar's Archived channels list. */
  archivedRooms: () => read<Room[]>("/api/rooms?archived=1"),
  boards: () => read<BoardRow[]>("/api/boards"),
  /** Every chat's asks, open and done, newest first; each board event brings the kept answer up to date (kept.svelte.ts). */
  forYou: (): Read<ForYouItem[]> => ({
    path: "/api/for-you", pick: (answer: { items: ForYouItem[] }) => answer.items,
    deadline: { ms: FOR_YOU_DEADLINE_MS, error: `For you did not answer in ${FOR_YOU_DEADLINE_MS / 1000} s.` },
  }),
  /** One agent as a role: purpose, where it runs, its board, memory, instructions and swarm (API.md, Agents). */
  agentConfig: (id: AgentId) => read<AgentConfig>(`/api/agents/${enc(id)}/config`),
  /** An agent's folder: its brief and every entry of its memory, which its config counts but does not send (API.md, Agent folder). */
  agentFolder: (id: AgentId) => read<AgentFolder>(`/api/agents/${enc(id)}/folder`),
  /** The prompt each kind of the agent's threads runs with and the skills it lists, built by the pi-host code that runs them (API.md, Agent prompt). */
  agentPrompt: (id: AgentId) => read<AgentPrompt>(`/api/agents/${enc(id)}/prompt`),
  /** An agent's For list, newest activity first; the counts cover the whole list whatever `status` picks (API.md, For <agent>). */
  forMe: (agent: AgentId, status: ForMeStatus | "all" = "pending") => read<ForMeList>(`/api/agents/${enc(agent)}/for-me${query({ status })}`),
  board: (chat: string) => read<BoardView>(`${boardBase(chat)}/board`, true),
  duties: (chat: string) => read<{ duties: DutyRow[] }>(`${boardBase(chat)}/duties`, true),
  checkIn: (chat: string) => read<CheckInView>(`${boardBase(chat)}/check-in`),
  chatAgents: (chat: string) => read<{ agents: ChatAgent[] }>(`${boardBase(chat)}/agents`),
  /**
   * The Hosts page: every box's figures and thread counts, and the threads of `box` (this box when unset) that `threads` picks, working
   * unless asked, test threads only with `tests`. The page keeps it and reads it again every 2 s.
   */
  hosts: (opts: { box?: string; threads?: HostThreadFilter; tests?: boolean } = {}) =>
    read<HostsReport>(`/api/hosts${query({ box: opts.box, threads: opts.threads === "working" ? undefined : opts.threads, tests: opts.tests ? 1 : undefined })}`),
  /**
   * The account pool under the Usage page's chart, 3.8 KB with br. Kept, so a visit draws the last one at once and reads it again behind.
   * Read as his call on each visit and each minute's poll, it shared TCP's first window with the 26 KB usage report sent before it and
   * took two round trips: in the p155 rig at a 200 ms round trip, 413 ms at p50 behind the report against 207 ms alone
   * (~/work/p155-sweep/fix-pool/notes.md).
   */
  pool: () => read<AccountsView>("/api/pool"),
};

export const api = {
  me: () => call<Me>("GET", "/api/me"),
  sidebar: () => call<Sidebar>("GET", "/api/sidebar"),
  /** Saves the whole sidebar layout; the answer carries its new `rev`, and every browser gets it in the next `sidebar` event. */
  saveSidebarLayout: (layout: SidebarLayout) => twice<SavedLayout>("PUT", "/api/sidebar/layout", layout),
  ownerSettings: (wait?: Wait) => call<SavedSettings>("GET", "/api/owner-settings", undefined, undefined, wait),
  /** Replaces each part `parts` names; every page gets the result as `owner_settings`. */
  saveOwnerSettings: (parts: Partial<OwnerSettings>) => twice<SavedSettings>("PATCH", "/api/owner-settings", parts),
  /** Sends this browser's old localStorage copies once, which the server merges (shared/owner-settings.ts `mergeOld`). */
  importOwnerSettings: (old: Partial<OwnerSettings>) => twice<SavedSettings>("POST", "/api/owner-settings/import", old),
  conversations: (opts: { archived?: boolean } = {}) => call<ConversationSummary[]>("GET", `/api/conversations${query({ archived: opts.archived ? 1 : undefined })}`),

  jobs: (opts: { archived?: boolean } = {}) => call<AgentSummary[]>("GET", `/api/jobs${query({ archived: opts.archived ? 1 : undefined })}`),
  /** A new agent with its work thread and DM room (`room`); `kind` "job" with a `parent` files a root thread under that agent as a job instead. */
  createAgent: (input: { name?: string; brief?: string; model?: string; thinkingLevel?: ThinkingLevel; cwd?: string; kind?: "chat" | "job"; parent?: AgentId; host?: string }) =>
    call<AgentSummary & { opened?: OpenedPage }>("POST", "/api/agents", input),
  /** The boxes that run pi-host and can hold an agent, the chat's own box marked `self`, each up or away (agent-model.md phase 6). */
  agentHosts: () => call<AgentHostList>("GET", "/api/agent-hosts"),
  /** The agent folder: its brief and its memory, which every thread of the agent loads (API.md, Agent folder). */
  agentFolder: (id: AgentId) => call<AgentFolder>("GET", `/api/agents/${enc(id)}/folder`),
  setBrief: (id: AgentId, text: string) => twice<AgentFolder>("PUT", `/api/agents/${enc(id)}/brief`, { text }),
  setWorkingMemory: (id: AgentId, text: string) => twice<AgentFolder>("PUT", `/api/agents/${enc(id)}/working-memory`, { text }),
  addMemory: (id: AgentId, input: MemoryInput) => call<AgentFolder>("POST", `/api/agents/${enc(id)}/memory`, input),
  updateMemory: (id: AgentId, entry: string, input: MemoryInput, kind: HarnessEntryView["kind"] = "memory") =>
    twice<AgentFolder>("PUT", `/api/agents/${enc(id)}/memory/${enc(entry)}${query({ kind })}`, input),
  deleteMemory: (id: AgentId, entry: string, kind: HarnessEntryView["kind"] = "memory") =>
    twice<AgentFolder>("DELETE", `/api/agents/${enc(id)}/memory/${enc(entry)}${query({ kind })}`),
  projects: () => call<ProjectList>("GET", "/api/projects"),
  /** These act on an agent through its DM (`PATCH` and abort of `/api/c/dm_<slug>`), and on a job or a root thread through itself. */
  setAgentCwd: (id: AgentId, cwd: string) => twice<ConversationHeader>("PATCH", `/api/c/${enc(roomOf(id))}`, { cwd }),
  setAgentModel: (id: AgentId, model: string, thinkingLevel?: ThinkingLevel) =>
    twice<ConversationHeader>("PATCH", `/api/c/${enc(roomOf(id))}`, { model, ...(thinkingLevel ? { thinkingLevel } : {}) }),
  stopAgent: (id: AgentId) => twice<{ ok: true }>("POST", `/api/c/${enc(roomOf(id))}/abort`),
  archiveAgent: (id: AgentId, archived = true) => twice<ConversationHeader>("PATCH", `/api/c/${enc(roomOf(id))}`, { archived }),
  renameAgent: (id: AgentId, name: string) => twice<ConversationHeader>("PATCH", `/api/c/${enc(roomOf(id))}`, { name }),

  header: (id: ConversationId, wait?: Wait) => call<ConversationHeader>("GET", `/api/c/${enc(id)}`, undefined, undefined, wait),
  items: (id: ConversationId, opts: { before?: string; after?: string; around?: string; limit?: number } = {}, wait?: Wait) =>
    call<TimelinePage>("GET", `/api/c/${enc(id)}/items${query(opts)}`, undefined, undefined, wait),
  replies: (id: ConversationId, root: string, wait?: Wait) =>
    call<{ root: Item; items: Item[] }>("GET", `/api/c/${enc(id)}/replies/${enc(root)}`, undefined, undefined, wait),
  /** A tool step's output, which a page leaves out until the owner opens it. */
  stepOutput: (ref: StepOutputRef) => call<{ output: string }>("GET", `/api/c/${enc(ref.conversation)}/output/${ref.entry}`),
  /** Keeps an attached file's bytes on the server; a send names the ref it answers (`attach`). A file that is not an image passes its `name`. */
  upload: (file: Blob, wait?: Wait, name?: string) => twice<ImageRef>("POST", `/api/uploads${query({ name })}`, file, wait),
  send: (id: ConversationId, request: SendRequest, wait?: Wait) => call<SendResult>("POST", `/api/c/${enc(id)}/send`, request, undefined, wait),
  /** Tries a pending send that failed again now. */
  retrySend: (id: ConversationId, requestId: string) => twice<SendResult>("POST", `/api/c/${enc(id)}/send/${enc(requestId)}/retry`),
  /** Drops a pending send that failed. */
  discardSend: (id: ConversationId, requestId: string) => twice<{ ok: true }>("DELETE", `/api/c/${enc(id)}/send/${enc(requestId)}`),
  abort: (id: ConversationId) => twice<{ ok: true }>("POST", `/api/c/${enc(id)}/abort`),
  /** Puts the owner's emoji on a room post, or with `on` false takes it off; the room's live `items` event carries the change too. */
  react: (id: ConversationId, post: string, emoji: string, on = true) =>
    twice<{ item: Item }>("POST", `/api/c/${enc(id)}/posts/${enc(post)}/reactions`, { emoji, on } satisfies ReactionRequest),
  /** Marks the thread of a room post done, or with `done` false reopens it; the flag sits on the thread's root (server/thread-done.ts). */
  threadDone: (id: ConversationId, post: string, done: boolean) =>
    twice<{ item: Item }>("POST", `/api/c/${enc(id)}/posts/${enc(post)}/done`, { done } satisfies ThreadDoneRequest),
  /** Pins a room post to its room, or with `pinned` false un-pins it (server/pins.ts). */
  pin: (id: ConversationId, post: string, pinned: boolean) =>
    twice<{ item: Item }>("POST", `/api/c/${enc(id)}/posts/${enc(post)}/pin`, { pinned } satisfies PinRequest),
  /** The owner's Save for later rows in one tab, newest first, with each tab's count (server/later.ts); `test` keeps posts in walks' test rooms. */
  later: (state?: LaterState, test = false, wait?: Wait) => call<LaterList>("GET", `/api/later${query({ state, test: test ? 1 : undefined })}`, undefined, undefined, wait),
  /** Saves a room post for later; saving a saved post keeps its one item and opens it again when it was done. */
  saveLater: (room: ConversationId, post: string, remindAt?: number) =>
    twice<{ item: LaterItem }>("POST", "/api/later", { room, post, ...(remindAt !== undefined ? { remindAt } : {}) } satisfies LaterRequest),
  /** Checks a saved post off (`done`) or opens it again, and sets or clears (`null`) its reminder. */
  patchLater: (id: string, patch: LaterPatch) => twice<{ item: LaterItem }>("PATCH", `/api/later/${enc(id)}`, patch),
  /** Unsaves a post; unsaving one that is gone answers `{item: null}`. */
  unsaveLater: (id: string) => twice<{ item: LaterItem | null }>("DELETE", `/api/later/${enc(id)}`),
  /** A Later item of the owner's own text, such as /remind me's, which Later lists and, with `remindAt`, the due timer fires as a post's. */
  remindNote: (note: string, remindAt?: number) => call<{ item: LaterItem }>("POST", "/api/later", { note, ...(remindAt !== undefined ? { remindAt } : {}) } satisfies LaterRequest),
  /** Undo of an unsave: puts the item `unsaveLater` answered back as it was. */
  restoreLater: (item: LaterItem) => twice<{ item: LaterItem }>("PUT", `/api/later/${enc(item.id)}`, item),
  /** Slack's Edit message on the owner's own room post. */
  editPost: (id: ConversationId, post: string, text: string) => twice<{ item: Item }>("PATCH", `/api/c/${enc(id)}/posts/${enc(post)}`, { text }),
  /** Slack's Delete message on the owner's own room post. */
  deletePost: (id: ConversationId, post: string) => twice<{ item: Item }>("DELETE", `/api/c/${enc(id)}/posts/${enc(post)}`),
  patch: (id: ConversationId, patch: ConversationPatch) => twice<ConversationHeader>("PATCH", `/api/c/${enc(id)}`, patch),
  rename: (id: ConversationId, name: string) => twice<ConversationHeader>("PATCH", `/api/c/${enc(id)}`, { name }),
  archive: (id: ConversationId, archived = true) => twice<ConversationHeader>("PATCH", `/api/c/${enc(id)}`, { archived }),
  read: (id: ConversationId, seq?: number) => twice<{ ok: true }>("POST", `/api/c/${enc(id)}/read`, seq === undefined ? {} : { seq }),
  markUnread: (id: ConversationId, post: string) => twice<{ ok: true }>("POST", `/api/c/${enc(id)}/read`, { unreadFrom: post }),
  readAll: (rooms: ConversationId[]) => call<{ before: ReadPoint[] }>("POST", "/api/read", { rooms } satisfies ReadAllRequest),
  restoreReads: (restore: ReadPoint[]) => twice<{ ok: true }>("POST", "/api/read", { restore } satisfies ReadAllRequest),
  threadJobs: (thread: string) => call<JobNode[]>("GET", `/api/threads/${enc(thread)}/jobs`),
  openDm: (agent: AgentId) => twice<ConversationSummary>("POST", "/api/dms", { agent }),

  createRoom: (input: RoomInput) => call<Room & { opened: OpenedPage }>("POST", "/api/rooms", input),
  /** `closed` closes or reopens a Solo room. */
  updateRoom: (id: string, patch: RoomPatch) => twice<Room>("PATCH", `/api/rooms/${enc(id)}`, patch),
  setPrefs: (id: ConversationId, patch: PrefsPatch) => twice<ConversationPrefs>("PUT", `/api/c/${enc(id)}/prefs`, patch),
  /** Only registered agents join; the server refuses a job, a work thread or a comm thread. */
  addMembers: (id: string, agents: AgentId[], wakeOn?: "all" | "none") => twice<Room>("POST", `/api/rooms/${enc(id)}/members`, { agents, ...(wakeOn ? { wakeOn } : {}) }),
  removeMember: (id: string, agent: AgentId) => twice<Room>("DELETE", `/api/rooms/${enc(id)}/members/${enc(agent)}`),
  /** `none` is Mentions only: the member wakes on an @mention or a reply in a thread it posted in. */
  setMemberWakeOn: (id: string, agent: AgentId, wakeOn: Member["wakeOn"]) => twice<Room>("PATCH", `/api/rooms/${enc(id)}/members/${enc(agent)}`, { wakeOn }),

  search: (params: SearchQuery, options: { signal?: AbortSignal } = {}) =>
    call<SearchResult>("GET", `/api/search${query({ ...params, brief: params.brief ? 1 : undefined })}`, undefined, options.signal),
  /** The recent messages the Cmd K search matches in the page (pages/search/recent.ts), only those after `after` when given. */
  searchRecent: (params: { after?: number } = {}) => call<SearchResult>("GET", `/api/search/recent${query(params)}`, undefined, undefined, { background: "ahead" }),
  /** Wiki pages by title and words, or with no `q` the favorites and the pages updated last (server/wiki/pages.ts). */
  pages: (params: { q?: string; limit?: number } = {}, options: { signal?: AbortSignal } = {}) =>
    call<WikiPages>("GET", `/api/pages${query(params)}`, undefined, options.signal),

  /**
   * The answer is the board as GET .../board answers it, without the op summaries the server adds for a chat's own call, so the page keeps
   * the same board a read or event brings, and a refresh whose answer equals it changes nothing on the screen.
   */
  boardOps: (chat: string, ops: BoardOp[]) =>
    call<BoardView & { summaries: string[] }>("POST", `${boardBase(chat)}/board`, { ops }).then(({ board, awaitingGo }): BoardView => ({ board, awaitingGo })),
  /** Board ops from a page that shows the board `base` names (`boardKey`): the answer is what changed from it, or the whole board (`BoardWrite`). */
  boardOpsAfter: (chat: string, base: string, ops: BoardOp[]) =>
    call<BoardWrite & { summaries: string[] }>("POST", `${boardBase(chat)}/board`, { ops, base }).then(({ summaries: _summaries, ...answer }): BoardWrite => answer),
  /** Copies a Prime chat's board, duties and check-in interval into the thread it moved to. */
  importPrime: (chat: string, prime: string) =>
    call<{ board: boolean; duties: number; runs: number; checkInMs: number | null }>("POST", `/api/threads/${enc(chat)}/import-prime`, { prime }),
  /** `result` says what a set or remove did, such as "added d3", "updated d1", "unchanged d1" or "removed d2". */
  dutyAction: (chat: string, action: DutyAction) =>
    call<{ duties: DutyRow[]; result?: string }>("POST", `${boardBase(chat)}/duties`, action, undefined, undefined, action.action !== "run" && action.action !== "set"),
  setCheckIn: (chat: string, patch: CheckInPatch) => twice<CheckInView>("POST", `${boardBase(chat)}/check-in`, patch),
  /** Hides a board from All boards and the Board sidebar, or shows it again. */
  setBoardHidden: (chat: string, hidden: boolean) => twice<{ hidden: boolean }>("POST", `${boardBase(chat)}/board/hidden`, { hidden }),
  /** Marks one item, `<room id>/<post id>`, completed or pending again; the same mark twice changes nothing. */
  markForMe: (agent: AgentId, messageId: string, completed: boolean) =>
    twice<{ item: ForMeItem; pending: number }>("POST", `/api/agents/${enc(agent)}/for-me`, { messageId, completed }),
  /** Marks several For items at once and answers the ids whose status changed, which an Undo marks back. */
  markForMeMany: (agent: AgentId, messageIds: string[], completed: boolean) =>
    call<{ changed: string[]; pending: number }>("POST", `/api/agents/${enc(agent)}/for-me`, { messageIds, completed }),

  usage: (opts: { range: UsageRange; bucket: UsageBucket; thread?: string; host?: string }, wait?: Wait) => call<UsageReport>("GET", `/api/usage${query(opts)}`, undefined, undefined, wait),
  /** A poll behind a live rate the card already shows is `shown`; the card's first read is one it waits on. */
  usageLive: (opts: { thread?: string; host?: string }, wait: Wait = { background: "shown" }) => call<import("./types.ts").UsageLive>("GET", `/api/usage/live${query(opts)}`, undefined, undefined, wait),
  /** The consoles table from auto-sns-agent's consoles.json, read as the file is now. */
  consoles: () => call<ConsolesReport>("GET", "/api/consoles"),
  /** The skills DB read model, everything a Settings > Skills layout renders. */
  skills: () => call<SkillsView>("GET", "/api/skills"),
  /** The skills DB view as the changes since the version `since` names, or whole for an empty one (shared/listed.ts). */
  skillsSince: (since: string, wait?: Wait) => call<import("./shared/listed.ts").ListedAnswer>("GET", `/api/skills?since=${enc(since)}`, undefined, undefined, wait),
  /** Each skill's description, which the view's `?since=` form leaves out (shared/skills.ts `toWire`), as the changes since `since`. */
  skillsTextSince: (since: string, wait?: Wait) => call<import("./shared/listed.ts").ListedAnswer>("GET", `/api/skills/text?since=${enc(since)}`, undefined, undefined, wait),
  /** The scanner's raw inventory, which the `current` layout draws, as the changes since the version `since` names (shared/listed.ts). */
  skillsInventorySince: (since: string, wait?: Wait) => call<import("./shared/listed.ts").ListedAnswer>("GET", `/api/skills/inventory?since=${enc(since)}`, undefined, undefined, wait),
  /** Where the disk differs from the DB: folders with no row and installs the disk does not match. */
  skillsCheck: () => call<SkillsCheck>("GET", "/api/skills/check"),
  /** Makes the disk match the DB; a second run changes nothing. `dryRun` only plans. */
  applySkills: (body: ApplyBody = {}) => twice<ApplyResult>("POST", "/api/skills/apply", body),
  installSkill: (body: InstallBody) => call<SkillsChange>("POST", "/api/skills/install", body),
  /** Removes a copy, an install or a whole skill, with a backup that undo restores. */
  removeSkill: (body: RemoveBody) => call<SkillsChange>("POST", "/api/skills/remove", body),
  adoptSkill: (body: AdoptBody) => call<SkillsChange>("POST", "/api/skills/adopt", body),
  moveSkill: (body: MoveBody) => call<SkillsChange>("POST", "/api/skills/move", body),
  mergeSkill: (body: MergeBody) => call<SkillsChange>("POST", "/api/skills/merge", body),
  ownSkill: (body: OwnBody) => call<SkillsChange>("POST", "/api/skills/own", body),
  undoSkillMove: (body: UndoBody) => call<SkillsChange>("POST", "/api/skills/undo", body),
  skillMoves: () => call<SkillMoves>("GET", "/api/skills/moves"),
  /** Starts a scan of the boxes unless one runs; the `skills` live event says when it ends. */
  scanSkills: () => twice<{ scan: SkillScan }>("POST", "/api/skills/scan"),
  skillDoc: (id: string) => call<SkillDoc>("GET", `/api/skills/doc?id=${enc(id)}`),
  /** The skills review: the cleanup items of a set in review order, one item with its copies and diffs, and the owner's decide and undo. */
  skillsReview: (set?: string) => call<ReviewReport>("GET", `/api/skills/review${query({ set })}`),
  skillsReviewItem: (set: string, id: string) => call<ReviewItem>("GET", `/api/skills/review/item${query({ set, id })}`),
  decideSkillsReview: (body: ReviewDecideBody) => call<ReviewResult>("POST", "/api/skills/review/decide", body),
  undoSkillsReview: (body: ReviewUndoBody) => call<ReviewResult>("POST", "/api/skills/review/undo", body),
  corrections: () => call<{ corrections: unknown[] }>("GET", "/api/corrections"),
};
