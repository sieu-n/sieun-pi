/**
 * How long each /api request took, one JSON line per request in `<data dir>/requests/<UTC day>.jsonl`, for the daily speed duty
 * (scripts/duties/api-speed.ts). The server writes its own handler time (`src: "server"`), and the web client posts the time it waited for
 * each call (`src: "client"`, POST /api/timings), which also holds the wait while another request blocks the server's one event loop. On 11-03
 * a 3.9 s search made a concurrent replies call take 2.17 s where the handler took 0.01 s, so only the client line shows what the owner feels.
 * A day file older than the duty's 24 h window can hold is deleted when the day changes.
 */
import { appendFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

export type TimingSource = "server" | "client";

/**
 * Where a client line's page ran: `tailnet` for a browser that came through tailscale serve, which sets Tailscale-User-Login and drops a
 * client's own, so the owner's devices; `local` for a browser on the box itself, such as a job's box Chrome walk.
 */
export type ClientVia = "tailnet" | "local";

/**
 * One request: when it ended, who measured it, its method, route pattern (`/api/c/:id/items`), path, status and duration. A client line
 * also has `net`, the browser's network time for the call when it had one, so `ms - net` is the time the page's own main thread held it, and
 * `via`, where that page ran.
 */
export interface RequestTiming {
  at: number; src: TimingSource; m: string; r: string; p: string; s: number; ms: number; net?: number; via?: ClientVia;
  /** A server line's split of `ms`: the wait for the request body, the handler's own time after it, and the longest event-loop stall in it. */
  body?: number; run?: number; stall?: number;
  /**
   * Why the request failed: the server's error for a refused or failed request, and on a client line the error the page got, with `s` 0 when
   * the call never reached the server, such as during a release restart.
   */
  err?: string;
}

/**
 * The server's event-loop stalls, so a slow request line tells a blocked or starved process from a slow handler: a stall as long as the
 * request means nothing in the process ran. A timer every 20 ms keeps the stalls over 50 ms from the last minute. On 11-04 at a box load of
 * 200 to 280, an idle node process on us-metal02 stalled over 50 ms 53 times in 120 s, up to 365 ms, while a send and a /read on :5184 took
 * 2,564 ms and 1,880 ms with no other request ending inside them.
 */
export class LoopStalls {
  private readonly stalls: { end: number; ms: number }[] = [];
  private last = performance.now();
  private readonly timer = setInterval(() => this.tick(), 20);

  constructor() {
    this.timer.unref();
  }

  private tick(): void {
    const now = performance.now();
    const ms = now - this.last - 20;
    this.last = now;
    if (ms > 50) this.stalls.push({ end: now, ms });
    while (this.stalls.length && this.stalls[0]!.end < now - 60_000) this.stalls.shift();
  }

  /** The longest stall that ended after `since` (performance.now()), counting one still running now. */
  longest(since: number): number {
    const now = performance.now();
    const open = Math.min(now - this.last - 20, now - since);
    return Math.max(open > 50 ? open : 0, ...this.stalls.filter(stall => stall.end > since).map(stall => Math.min(stall.ms, stall.end - since)));
  }

  stop(): void {
    clearInterval(this.timer);
  }
}

/** A client sample as POST /api/timings takes it; the server names its route. */
export interface ClientTiming { m: string; p: string; s: number; ms: number; net?: number; err?: string }

/** A 24 h window spans at most two UTC days, so a file older than yesterday holds no line the duty reads. */
const KEEP_DAYS = 2;

export const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

export class RequestLog {
  private day = "";
  private pending = Promise.resolve();

  constructor(readonly dir: string, private readonly log: (line: string) => void = () => {}) {}

  write(timing: RequestTiming): void {
    const day = dayOf(timing.at);
    const round = (ms: number | undefined) => (ms === undefined ? undefined : Math.round(ms * 10) / 10);
    const line = `${JSON.stringify({ ...timing, ms: round(timing.ms), body: round(timing.body), run: round(timing.run), stall: timing.stall ? round(timing.stall) : undefined })}\n`;
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
  }).map(({ m, p, s, ms, net, err }) => ({
    m, p: p.split("?")[0]!, s, ms, ...(typeof net === "number" && Number.isFinite(net) && net >= 0 ? { net } : {}),
    ...(typeof err === "string" && err ? { err: err.slice(0, 500) } : {}),
  }));
}
