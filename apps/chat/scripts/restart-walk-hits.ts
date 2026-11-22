/**
 * The owner's calls that an apps/chat restart or hand-over hit, from the request log and the service's lines in the user journal. Duty d2
 * (scripts/duties/api-speed.ts) counts the failed ones into failed_sends_24h, and scripts/restart-walk-count.mjs counts them per day.
 * His calls are the page's own lines (src client) that came through tailscale serve (via tailnet); walks and duties on the box log as local.
 * A restart is a Started line or, since the socket hand-over, a Reloading line. A client line is written when its batch reaches the server:
 * at once for a failed call, whose batch the page posts again 10 s later while the server is down, and within the page's 10 s timer
 * otherwise (web/src/lib/api/client.ts sendTimings). So a call made within 10 s of a restart reaches the log within 20 s of it, which is the
 * window. On 11-22, 152 of his calls failed within it across 32 of 94 restarts, and 13 away from any restart.
 */

/** The fields of a request log line this file reads (server/request-log.ts `RequestTiming`). */
export interface HitLine {
  at: number; src: string; via?: string; m: string; r: string; p: string; s: number; ms: number; err?: string; bg?: string; shown?: true;
  /** What the page was doing when the call failed (web client.ts `pageState`); lines from before 11-22 have none. */
  page?: string;
}

export interface RestartHit<T extends HitLine = HitLine> {
  line: T;
  /** The restart the line followed: the latest Started or Reloading line at or before it. */
  restart: number;
}

export const RESTART_WINDOW_MS = 20_000;

/** Restart times (ms) from `journalctl -o short-unix` lines: each "Started <unit>" line and each "Reloading <unit>" line of a hand-over. */
export function parseStarts(text: string): number[] {
  return text.split("\n").filter(line => /: (Started|Reloading) /.test(line)).map(line => Math.round(Number(line.split(" ")[0]) * 1000))
    .filter(Number.isFinite).sort((a, b) => a - b);
}

/** A line of the owner's page: src client, via tailnet, and not the timings post itself. */
export const ownerLine = (line: HitLine): boolean => line.src === "client" && line.via === "tailnet" && line.r !== "/api/timings";

/** The request log lines that are the owner's page calls. */
export function parseOwnerLines(text: string): HitLine[] {
  const out: HitLine[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.includes('"tailnet"') || !raw.includes('"client"')) continue;
    let line: HitLine;
    try {
      line = JSON.parse(raw) as HitLine;
    } catch {
      continue;
    }
    if (ownerLine(line) && Number.isFinite(line.at)) out.push(line);
  }
  return out;
}

/** A call failed when its status is 0 or 500 and up, or it names an error. */
export const failedLine = (line: HitLine): boolean => Boolean(line.err) || line.s === 0 || line.s >= 500;

/**
 * A failed call the owner could see or lose: any write that never landed, and a read his screen waited on (no `bg`) on a visible page. The
 * page logs a failure only after its own tries (client.ts), so a line is the call's end. A read ahead of any view or a refresh behind a page
 * already on the screen is no wait of his, and a call on a hidden page or one the page's own reload or unload aborted never showed. A line
 * from before the page logged `page` counts a read only when the server answered 500 and up: on 11-22 its 49 network errors after
 * restarts were a hidden page's calls aborted by its own reload, and the 1 that showed was a 502. A 4xx is no restart's doing.
 */
export function seenFailure(line: HitLine): boolean {
  if (!(line.s === 0 || line.s >= 500)) return false;
  if (line.m !== "GET" && line.m !== "HEAD") return true;
  if (line.bg) return false;
  return line.page ? line.page === "visible" : line.s >= 500;
}

/** The latest restart at or before `at`, when `at` is within `windowMs` of it. `starts` is sorted. */
export function restartBefore(starts: readonly number[], at: number, windowMs = RESTART_WINDOW_MS): number | undefined {
  let found = -1;
  for (let lo = 0, hi = starts.length - 1; lo <= hi;) {
    const mid = (lo + hi) >> 1;
    if (starts[mid]! <= at) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found >= 0 && at - starts[found]! <= windowMs ? starts[found] : undefined;
}

/** The owner's failed calls he could see or lose (seenFailure) that came within the window of a restart, each with the restart it followed. */
export function restartHits<T extends HitLine>(starts: readonly number[], lines: readonly T[], windowMs = RESTART_WINDOW_MS): RestartHit<T>[] {
  return lines.flatMap(line => {
    if (!ownerLine(line) || !seenFailure(line)) return [];
    const restart = restartBefore(starts, line.at, windowMs);
    return restart === undefined ? [] : [{ line, restart }];
  });
}

export interface DayCount {
  restarts: number; restartsHit: number; failed: number; slow: number; outsideFailed: number; outsideSlow: number; routes: [string, number][];
}

/**
 * Per UTC day of the restart: how many restarts there were, how many had one of his calls fail or wait over `slowMs`, and the counts, with
 * the routes. A slow call is a wait of his: background reads (bg ahead or shown) are left out of slow.
 */
export function countRestartHits(starts: readonly number[], lines: readonly HitLine[], { windowMs = RESTART_WINDOW_MS, slowMs = 1000 } = {}): Record<string, DayCount> {
  type Acc = Omit<DayCount, "routes" | "restartsHit"> & { routes: Record<string, number>; hit: Set<number> };
  const days: Record<string, Acc> = {};
  const day = (at: number): string => new Date(at).toISOString().slice(0, 10);
  const of = (at: number): Acc => (days[day(at)] ??= { restarts: 0, failed: 0, slow: 0, outsideFailed: 0, outsideSlow: 0, routes: {}, hit: new Set() });
  for (const start of starts) of(start).restarts++;
  for (const line of lines) {
    const failed = failedLine(line);
    const slow = !failed && line.ms > slowMs && !line.bg;
    if (!failed && !slow) continue;
    const restart = restartBefore(starts, line.at, windowMs);
    const acc = of(restart ?? line.at);
    if (restart === undefined) {
      acc[failed ? "outsideFailed" : "outsideSlow"]++;
      continue;
    }
    acc[failed ? "failed" : "slow"]++;
    acc.hit.add(restart);
    const key = `${line.m} ${line.r}`;
    acc.routes[key] = (acc.routes[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(days).sort().map(([name, { hit, routes, ...rest }]) =>
    [name, { ...rest, restartsHit: hit.size, routes: Object.entries(routes).sort((a, b) => b[1] - a[1]) }]));
}
