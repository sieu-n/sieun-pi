/**
 * Duty precheck: sw factory stays snappy (owner's words, #sw-factory-build, 11-03, msg mw0et67o: "Thread > load messages 이것도 진짜 너무
 * 느리거든? 이거 계속 느린 api 뭔지 꾸준히 (daily) monitoring 하는걸 add to duty and keep it snappy"). It reads the request log
 * (server/request-log.ts) of the last 24 h and gives each route's p90. A metric reads the web client's lines, the wait the owner sees, and
 * falls back to the server's own handler time for a route no page called in the window. A client line's `net` is the browser's network
 * time for the call, so a flagged route whose network p90 is far below its wait was held by the page's main thread, not by the server.
 *
 * Usage: OUTPUT_FILE=<file> node --import tsx scripts/duties/api-speed.ts [--data-dir <dir>] [--hours 24]
 * The data dir defaults to APPS_CHAT_DATA_DIR, else ~/.pi/agent/chat. Without OUTPUT_FILE the result prints to stdout.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { RequestTiming, TimingSource } from "../../server/request-log.ts";

/**
 * One route's speed from one source. `netP50` and `netP90` come from the client lines that carry the browser's network time, so a client
 * p90 far above its `netP90` is the page's own main thread, not the server or the network.
 */
export interface RouteSpeed { route: string; src: TimingSource; count: number; p50: number; p90: number; max: number; slowestPath: string; netP50?: number; netP90?: number }

/** The routes each metric reads, by `<method> <route pattern>`. */
export const ROUTES = {
  search: "GET /api/search",
  messages: "GET /api/c/:id/items",
  replies: "GET /api/c/:id/replies/:root",
  send: "POST /api/c/:id/send",
} as const;

const percentile = (sorted: readonly number[], q: number): number => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;

/** The request log's lines in the window ending at `now`; a line that does not parse is skipped. */
export function readTimings(dir: string, now: number, windowMs: number): RequestTiming[] {
  const logDir = join(dir, "requests");
  if (!existsSync(logDir)) return [];
  const from = now - windowMs;
  const out: RequestTiming[] = [];
  for (const name of readdirSync(logDir).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort()) {
    if (Date.parse(name.slice(0, 10)) + 86_400_000 < from) continue;
    for (const line of readFileSync(join(logDir, name), "utf8").split("\n")) {
      if (!line) continue;
      try {
        const timing = JSON.parse(line) as RequestTiming;
        if (timing.at >= from && timing.at <= now && timing.s > 0) out.push(timing);
      } catch { /* a torn last line */ }
    }
  }
  return out;
}

/** Each route's speed per source, slowest p90 first. */
export function routeSpeeds(timings: readonly RequestTiming[]): RouteSpeed[] {
  const groups = new Map<string, RequestTiming[]>();
  for (const timing of timings) {
    const key = `${timing.src} ${timing.m} ${timing.r}`;
    const group = groups.get(key);
    if (group) group.push(timing);
    else groups.set(key, [timing]);
  }
  return [...groups.values()].map(group => {
    const sorted = group.map(t => t.ms).sort((a, b) => a - b);
    const slowest = group.reduce((a, b) => (b.ms > a.ms ? b : a));
    const net = group.flatMap(t => (t.net === undefined ? [] : [t.net])).sort((a, b) => a - b);
    return {
      route: `${group[0]!.m} ${group[0]!.r}`, src: group[0]!.src, count: group.length, p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9), max: sorted.at(-1)!, slowestPath: slowest.p,
      ...(net.length ? { netP50: percentile(net, 0.5), netP90: percentile(net, 0.9) } : {}),
    };
  }).sort((a, b) => b.p90 - a.p90);
}

/** A route's speed as the owner sees it: the client's lines, else the server's. */
const speedOf = (speeds: readonly RouteSpeed[], route: string): RouteSpeed | undefined =>
  speeds.find(s => s.src === "client" && s.route === route) ?? speeds.find(s => s.src === "server" && s.route === route);

export function apiSpeed(dir: string, now: number, windowMs: number) {
  const speeds = routeSpeeds(readTimings(dir, now, windowMs));
  const client = speeds.filter(s => s.src === "client");
  const seen = client.length ? client : speeds;
  const metrics: Record<string, number> = {};
  if (seen.length) metrics.slowest_api_p90_ms = seen[0]!.p90;
  const search = speedOf(speeds, ROUTES.search);
  if (search) metrics.search_p90_ms = search.p90;
  const messages = speedOf(speeds, ROUTES.messages);
  const replies = speedOf(speeds, ROUTES.replies);
  if (messages) metrics.thread_open_p90_ms_messages = messages.p90;
  if (replies) metrics.thread_open_p90_ms_replies = replies.p90;
  if (messages || replies) metrics.thread_open_p90_ms = Math.max(messages?.p90 ?? 0, replies?.p90 ?? 0);
  const send = speedOf(speeds, ROUTES.send);
  if (send) metrics.send_p90_ms = send.p90;
  const slowest = seen.slice(0, 3);
  return {
    metrics,
    slowest,
    metricSources: Object.fromEntries(Object.entries({ search, messages, replies, send }).flatMap(([key, speed]) => (speed ? [[key, `${speed.src}, ${speed.count} requests`]] : []))),
    routes: speeds,
    flagged: slowest.map(s => ({
      kind: "slow_api", sig: `${s.src}:${s.route}`,
      excerpt: `${s.route} p90 ${s.p90} ms, p50 ${s.p50} ms, max ${s.max} ms over ${s.count} ${s.src} requests; the slowest was ${s.slowestPath}${
        s.netP90 === undefined ? "" : `; its network time, the server's included, was p90 ${s.netP90} ms, p50 ${s.netP50} ms, and the page's main thread held the rest`}`,
    })),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { "data-dir": { type: "string" }, hours: { type: "string" } } });
  const dir = resolve(values["data-dir"] ?? process.env.APPS_CHAT_DATA_DIR ?? join(homedir(), ".pi/agent/chat"));
  const json = JSON.stringify(apiSpeed(dir, Date.now(), Number(values.hours ?? 24) * 3600_000), null, 1);
  if (process.env.OUTPUT_FILE) writeFileSync(process.env.OUTPUT_FILE, json);
  else process.stdout.write(`${json}\n`);
}
