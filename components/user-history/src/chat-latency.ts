import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import { constants, type IntervalHistogram, monitorEventLoopDelay, performance, PerformanceObserver } from "node:perf_hooks";

/**
 * How slow the chat service was to the owner each minute, for the Whole system duty's CPU rule (scripts/duties/whole-system.ts): the slowest page
 * or API read it answered and the longest its event loop stalled, so a minute with no request still reads. The chat VP's rule on 10-18 at
 * 11:58Z: a busy box is no harness fault, and a CPU minute is dirty only when the harness itself is slow, such as a read over 1 s.
 */
export interface ChatLatency {
  /** The slowest GET the service answered since the last line, in ms; 0 when it answered none. */
  readMs: number;
  /** That read's route under the chat's base path, with asset hashes cut. */
  read?: string;
  /** The slowest GET that waited on another box (its relay, its daemon through the bridge or LGTM's Prometheus), in ms, and its route; absent when none did. */
  remoteMs?: number;
  remote?: string;
  /** The event loop's longest delay since the last line, in ms (perf_hooks monitorEventLoopDelay). */
  loopMs: number;
  /** The longest garbage collection since the last line, in ms, and its kind; absent when none ran. */
  gcMs?: number;
  gc?: GcKind;
}

export type GcKind = "major" | "minor" | "incremental" | "weak";
const GC_KINDS: ReadonlyMap<number, GcKind> = new Map([[constants.NODE_PERFORMANCE_GC_MAJOR, "major"], [constants.NODE_PERFORMANCE_GC_MINOR, "minor"],
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL, "incremental"], [constants.NODE_PERFORMANCE_GC_WEAKCB, "weak"]]);
let longestGc: { ms: number; kind: GcKind } | null = null;
/** A gc entry's kind from its `detail`, which this @types/node leaves off PerformanceEntry; -1 when it has none. */
const gcKindOf = (entry: object): number => {
  const detail: unknown = Reflect.get(entry, "detail");
  const kind: unknown = typeof detail === "object" && detail !== null ? Reflect.get(detail, "kind") : undefined;
  return typeof kind === "number" ? kind : -1;
};

/**
 * Keeps the longest GC of the window. p769's scratch profile on 10-19 found every main-thread run over 1 s was a major GC, and the live
 * service takes no profiler (66797edc), so the latency line names a GC that long beside the loop stall it explains.
 */
export function noteGc(ms: number, kind: number): void {
  const named = GC_KINDS.get(kind);
  if (named && ms > (longestGc?.ms ?? 0)) longestGc = { ms, kind: named };
}

/** api/hosts waits on each other box's relay over the network, up to 35 s by design (hosts.ts), so its time says nothing about this box. */
const REMOTE_READS = new Set(["api/hosts"]);
let slowest = { ms: 0, route: "" };
let slowestRemote = { ms: 0, route: "" };
const reading = new AsyncLocalStorage<{ remote: boolean }>();

/**
 * Marks the request in progress as one that waited on another box, so its time goes to `remoteMs` and not to this box's `readMs`. The relay
 * calls (hosts.ts), a copy brought up to date (host-catalogs.ts), a remote daemon attach (chat-threads.ts) and each LGTM query (usage/lgtm.ts)
 * call it. On 10-22 d7 counted 15:01, 15:16 and 15:27Z as us-metal02 CPU minutes from a Mac chat's older page that waited 1.6 to 2.4 s on
 * the Mac relay, and 16:29 and 16:30Z from a Prompt view that read a 5 MB capture through it (1.2 to 16.6 s in three reads on 10-22 with the box at its usual load). On 10-23
 * the slowest read of 130 watch minutes was an api/usage read waiting on LGTM's Prometheus at obs.virev.ai, 12 to 30 s in 117 of them, with
 * the loop under 1 s, and d7 counted all ten us-metal02 minutes from 08:09 to 08:18Z dirty from it.
 */
export function waitedOnHost(): void {
  const read = reading.getStore();
  if (read) read.remote = true;
}
let loop: IntervalHistogram | null = null;

/** The route of a request path under `base`, its query dropped and a content hash such as app.3f9c1a.js cut to app.js. */
export const readRoute = (url: string, base: string): string => {
  const path = url.split("?")[0]!;
  return (path.startsWith(base) ? path.slice(base.length) : path).replace(/\.[0-9a-f]{6,}(?=\.\w+$)/, "").slice(0, 80);
};

/** Times a GET from now until its response is sent, and starts the event loop monitor on the first one. */
export function timeRead(req: IncomingMessage, res: ServerResponse, base: string): void {
  if (!loop) {
    loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable();
    new PerformanceObserver(list => { for (const entry of list.getEntries()) noteGc(entry.duration, gcKindOf(entry)); })
      .observe({ entryTypes: ["gc"] });
  }
  const read = { remote: false };
  reading.enterWith(read);
  if (req.method !== "GET") return;
  const started = performance.now();
  res.once("finish", () => {
    const route = readRoute(req.url ?? "/", base);
    const ms = Math.round(performance.now() - started);
    if (read.remote) { if (ms > slowestRemote.ms) slowestRemote = { ms, route }; }
    else if (!REMOTE_READS.has(route) && ms > slowest.ms) slowest = { ms, route };
  });
}

/** The latency since the last take, then starts a new window; undefined before the server timed its first request. */
export function takeLatency(): ChatLatency | undefined {
  if (!loop) return undefined;
  const taken: ChatLatency = { readMs: slowest.ms, ...slowest.route ? { read: slowest.route } : {},
    ...slowestRemote.ms ? { remoteMs: slowestRemote.ms, remote: slowestRemote.route } : {}, loopMs: Math.round(loop.max / 1e6),
    ...longestGc ? { gcMs: Math.round(longestGc.ms), gc: longestGc.kind } : {} };
  slowest = { ms: 0, route: "" };
  slowestRemote = { ms: 0, route: "" };
  longestGc = null;
  loop.reset();
  return taken;
}
