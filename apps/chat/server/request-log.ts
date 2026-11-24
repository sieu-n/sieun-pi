/**
 * How long each /api request took, one JSON line per request in `<data dir>/requests/<UTC day>.jsonl`, for the daily speed duty
 * (scripts/duties/api-speed.ts). The server writes its own handler time (`src: "server"`), and the web client posts the time it waited for
 * each call (`src: "client"`, POST /api/timings), which also holds the wait while another request blocks the server's one event loop. On 11-03
 * a 3.9 s search made a concurrent replies call take 2.17 s where the handler took 0.01 s, so only the client line shows what the owner feels.
 * The log keeps today's file and the 2 UTC days before it, 48 to 72 h of lines, for the duty's 24 h window and its 72 h lookback on a quiet
 * day (`LOOKBACK_MS` in api-speed.ts). An older file is deleted when the day changes.
 */
import { appendFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import type { StallProfiler } from "../../../packages/pi-host/src/stall-profile.ts";

export type TimingSource = "server" | "client";

/**
 * Where a request came from: `tailnet` for a browser that came through tailscale serve, which sets Tailscale-User-Login and drops a
 * client's own, so the owner's devices; `local` for a browser on the box itself, such as a job's box Chrome walk.
 */
export type ClientVia = "tailnet" | "local";

/**
 * One request: when it ended, who measured it, its method, route pattern (`/api/c/:id/items`), path, status and duration. A client line
 * also has `net`, the browser's network time for the call when it had one, so `ms - net` is the time the page's own main thread held it.
 * `via` is where the request came from, on a server line since 11-05 and on a client line where the page ran.
 */
export interface RequestTiming {
  at: number; src: TimingSource; m: string; r: string; p: string; s: number; ms: number; net?: number; via?: ClientVia;
  /** On a client upload line, the ms the page spent encoding the image before the call (web shrink.ts); `ms` leaves it out. */
  enc?: number;
  /** On a client line of an image send, the ms from the owner's Enter until the server stored the message; `ms` is Enter to its bubble. */
  stored?: number;
  /** A server line's split of `ms`: the wait for the request body, the handler's own time after it, and the longest event-loop stall in it. */
  body?: number; run?: number; stall?: number;
  /** On a server line with a stall, the parts of it `LoopStalls.worst` names. */
  stallCpu?: number; stallGc?: number; stallBy?: string;
  /** On a server line of GET /api/search, where its handler time went by part, with its pending count and filter size (search-engine.ts `SearchSplit`). */
  split?: Record<string, number>;
  /**
   * Why the request failed: the server's error for a refused or failed request, and on a client line the error the page got, with `s` 0 when
   * the call never reached the server, such as during a release restart.
   */
  err?: string;
  /** On a client line, the page gave up on the send and showed it as Not delivered; `ms` is 0, since it times no call. */
  shown?: true;
  /**
   * On a client line, the screen did not wait on the call (web client.ts `Wait`): `ahead` is a read ahead of any view, such as a room's
   * page before the owner opens it, and `shown` is a refresh behind a page the screen already showed, whose answer changed nothing on it.
   */
  bg?: "ahead" | "shown";
  /**
   * On a client line of a failed call, what the page was doing when it failed (web client.ts `pageState`): `visible` when the owner could see
   * it, `hidden` for a hidden tab, and `leaving` once the page began to reload or unload, whose own reload aborts its calls. A line without
   * it is from before 11-22, when 49 of 50 failed calls after a restart were the hidden old page's calls aborted by its own reload.
   */
  page?: "visible" | "hidden" | "leaving";
  /**
   * On a client line, the ms of `ms` the page was hidden (web client.ts `hiddenWithin`), which the owner never waited for: a page reloads
   * for a newer build while it is hidden or out of focus (web reload.ts), and its first reads wait in the hidden page's throttled timers.
   */
  hid?: number;
}

/**
 * The server's event-loop stalls, so a slow request line tells a blocked or starved process from a slow handler: a stall as long as the
 * request means nothing in the process ran. A timer every 20 ms keeps the stalls over 50 ms from the last minute. On 11-04 at a box load of
 * 200 to 280, an idle node process on us-metal02 stalled over 50 ms 53 times in 120 s, up to 365 ms, while a send and a /read on :5184 took
 * 2,564 ms and 1,880 ms with no other request ending inside them.
 *
 * Each stall also keeps how much of it the loop thread ran on CPU, how much of it was GC, and with a `StallProfiler` the functions that ran
 * in it. On 11-23 and 11-24 the owner's five slowest searches spent 75 to 126 ms in the Meilisearch call while Meilisearch itself answered
 * every one of 1,048 probe searches in 32 ms or less, and in the 50 search lines with a stall the call took 15 ms at the median once the stall
 * was taken out (~/work/p279-search/p279-meili.md): the time was this process's, held by work no request line named.
 */
export class LoopStalls {
  private readonly stalls: Stall[] = [];
  private readonly gc: { start: number; ms: number }[] = [];
  private last = performance.now();
  private cpu = process.threadCpuUsage();
  private readonly gcObserver = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) this.gc.push({ start: entry.startTime, ms: entry.duration });
  });
  private readonly timer = setInterval(() => this.tick(), 20);

  constructor(private readonly profiler?: StallProfiler) {
    this.gcObserver.observe({ entryTypes: ["gc"] });
    this.timer.unref();
  }

  private tick(): void {
    const now = performance.now();
    const cpu = process.threadCpuUsage();
    const from = this.last;
    const ms = now - from - 20;
    if (ms > 50) {
      const slice = this.profiler?.take(from, now, "");
      this.stalls.push({ end: now, ms, cpu: (cpu.user + cpu.system - this.cpu.user - this.cpu.system) / 1000, ...(slice ? { by: slice.text.slice(0, STALL_TEXT) } : {}) });
    }
    this.last = now;
    this.cpu = cpu;
    while (this.stalls.length && this.stalls[0]!.end < now - 60_000) this.stalls.shift();
    while (this.gc.length && this.gc[0]!.start < now - 60_000) this.gc.shift();
  }

  /** The longest stall that ended after `since` (performance.now()), counting one still running now. */
  longest(since: number): number {
    return this.worst(since).stall;
  }

  /**
   * The longest stall that ended after `since`, with the ms of it the loop thread ran on CPU and spent in GC, and what the profiler saw run
   * in it. GC pauses reach the observer a turn after they end, so a request line asks once its response closed.
   */
  worst(since: number): StallPart {
    const now = performance.now();
    const open = Math.min(now - this.last - 20, now - since);
    let worst: Stall | undefined;
    for (const stall of this.stalls) if (stall.end > since && (!worst || Math.min(stall.ms, stall.end - since) > Math.min(worst.ms, worst.end - since))) worst = stall;
    const ms = worst ? Math.min(worst.ms, worst.end - since) : 0;
    if (open > 50 && open >= ms) return { stall: open };
    if (!worst) return { stall: 0 };
    const start = worst.end - worst.ms - 20;
    const gc = this.gc.filter(pause => pause.start < worst.end && pause.start + pause.ms > start).reduce((sum, pause) => sum + pause.ms, 0);
    return { stall: ms, stallCpu: Math.round(worst.cpu), ...(gc ? { stallGc: Math.round(gc) } : {}), ...(worst.by ? { stallBy: worst.by } : {}) };
  }

  stop(): void {
    clearInterval(this.timer);
    this.gcObserver.disconnect();
    this.profiler?.stop();
  }
}

/** One stall: when it ended, its length and the loop thread's CPU ms in it (performance.now() ms), and the profiler's summary of it. */
interface Stall { end: number; ms: number; cpu: number; by?: string }

/** A stall's profile summary is cut to this many characters on a request line: 5 functions and a 12-frame stack fit in about 900. */
const STALL_TEXT = 1_000;

/**
 * A server line's longest stall: its ms, the ms of it the loop thread ran on CPU (much less than `stall` means it waited for a core or on a
 * blocking call) and spent in GC, and the functions with the most self time in it and the stack under the top one (pi-host stall-profile.ts).
 */
export interface StallPart { stall: number; stallCpu?: number; stallGc?: number; stallBy?: string }

/** A client sample as POST /api/timings takes it; the server names its route. */
export interface ClientTiming {
  m: string; p: string; s: number; ms: number; net?: number; enc?: number; stored?: number; err?: string; shown?: true; bg?: "ahead" | "shown"; page?: "visible" | "hidden" | "leaving"; hid?: number;
}

/** Today's file and the 2 UTC days before it stay: the duty's whole 24 h window and 48 to 72 h of its 72 h lookback (`LOOKBACK_MS`). */
const KEEP_DAYS = 2;

export const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

export class RequestLog {
  private day = "";
  private pending = Promise.resolve();

  constructor(readonly dir: string, private readonly log: (line: string) => void = () => {}) {}

  write(timing: RequestTiming): void {
    const day = dayOf(timing.at);
    const round = (ms: number | undefined) => (ms === undefined ? undefined : Math.round(ms * 10) / 10);
    const line = `${JSON.stringify({ ...timing, ms: round(timing.ms), body: round(timing.body), run: round(timing.run), stall: timing.stall ? round(timing.stall) : undefined,
      split: timing.split && Object.fromEntries(Object.entries(timing.split).map(([part, ms]) => [part, round(ms)])) })}\n`;
    this.pending = this.pending.then(async () => {
      if (day !== this.day) {
        this.day = day;
        await mkdir(this.dir, { recursive: true });
        await this.prune(day);
      }
      await appendFile(join(this.dir, `${day}.jsonl`), line);
    }).catch(error => this.log(`request log: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** Resolves once every line written so far is on disk. */
  flushed(): Promise<void> {
    return this.pending;
  }

  private async prune(today: string): Promise<void> {
    const oldest = dayOf(Date.parse(today) - KEEP_DAYS * 86_400_000);
    for (const name of await readdir(this.dir)) {
      if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) < oldest) await rm(join(this.dir, name), { force: true });
    }
  }
}

/** The client samples of a POST /api/timings body; anything else in it is dropped. */
export function clientTimings(body: unknown): ClientTiming[] {
  const samples = (body as { samples?: unknown } | null)?.samples;
  if (!Array.isArray(samples)) return [];
  return samples.filter((sample): sample is ClientTiming => {
    const { m, p, s, ms } = (sample ?? {}) as Record<string, unknown>;
    return typeof m === "string" && typeof p === "string" && p.startsWith("/api/") && typeof s === "number" && typeof ms === "number" && Number.isFinite(ms) && ms >= 0;
  }).map(({ m, p, s, ms, net, enc, stored, err, shown, bg, page, hid }) => ({
    m, p: p.split("?")[0]!, s, ms, ...(typeof net === "number" && Number.isFinite(net) && net >= 0 ? { net } : {}),
    ...(typeof enc === "number" && Number.isFinite(enc) && enc >= 0 ? { enc } : {}),
    ...(typeof stored === "number" && Number.isFinite(stored) && stored >= 0 ? { stored } : {}),
    ...(typeof err === "string" && err ? { err: err.slice(0, 500) } : {}), ...(shown === true ? { shown } : {}),
    ...(bg === "ahead" || bg === "shown" ? { bg } : {}),
    ...(page === "visible" || page === "hidden" || page === "leaving" ? { page } : {}),
    ...(typeof hid === "number" && Number.isFinite(hid) && hid > 0 ? { hid: Math.min(hid, ms) } : {}),
  }));
}
