import type { IncomingMessage, ServerResponse } from "node:http";
import { type IntervalHistogram, monitorEventLoopDelay, performance } from "node:perf_hooks";

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
  /** The event loop's longest delay since the last line, in ms (perf_hooks monitorEventLoopDelay). */
  loopMs: number;
}

/** api/hosts waits on each other box's relay over the network, up to 35 s by design (hosts.ts), so its time says nothing about this box. */
const REMOTE_READS = new Set(["api/hosts"]);
let slowest = { ms: 0, route: "" };
let loop: IntervalHistogram | null = null;

/** The route of a request path under `base`, its query dropped and a content hash such as app.3f9c1a.js cut to app.js. */
export const readRoute = (url: string, base: string): string => {
  const path = url.split("?")[0]!;
  return (path.startsWith(base) ? path.slice(base.length) : path).replace(/\.[0-9a-f]{6,}(?=\.\w+$)/, "").slice(0, 80);
};

/** Times a GET from now until its response is sent, and starts the event loop monitor on the first one. */
export function timeRead(req: IncomingMessage, res: ServerResponse, base: string): void {
  if (!loop) { loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable(); }
  if (req.method !== "GET") return;
  const started = performance.now();
  res.once("finish", () => {
    const route = readRoute(req.url ?? "/", base);
    const ms = Math.round(performance.now() - started);
    if (!REMOTE_READS.has(route) && ms > slowest.ms) slowest = { ms, route };
  });
}

/** The latency since the last take, then starts a new window; undefined before the server timed its first request. */
export function takeLatency(): ChatLatency | undefined {
  if (!loop) return undefined;
  const taken: ChatLatency = { readMs: slowest.ms, ...slowest.route ? { read: slowest.route } : {}, loopMs: Math.round(loop.max / 1e6) };
  slowest = { ms: 0, route: "" };
  loop.reset();
  return taken;
}
