/**
 * Duty precheck: sw factory stays snappy (owner's words, #sw-factory-build, 11-03, msg mw0et67o: "Thread > load messages 이것도 진짜 너무
 * 느리거든? 이거 계속 느린 api 뭔지 꾸준히 (daily) monitoring 하는걸 add to duty and keep it snappy"). It reads the request log
 * (server/request-log.ts) of the last 24 h and gives each route's p90 as the owner waits for it: his own devices' lines (via tailnet), else
 * the server's handler time plus his network p50 from his other tailnet lines, and each metric says which in `metricSources`. A box
 * browser's line, such as a job's walk, never sets a metric; its slowest routes are walk_slow_api rows apart. A client line's `net` is the
 * browser's network time for the call, so a flagged route whose network p90 is far below its wait was held by the page's main thread. *
 * When no tailnet or server line of the window reached search, messages or replies, the precheck times a few GETs of that route against the
 * live server itself and says so in `metricSources`; a probe that fails gives no value and a probe_failed row.
 * Usage: OUTPUT_FILE=<file> node --import tsx scripts/duties/api-speed.ts [--data-dir <dir>] [--hours 24] [--server http://127.0.0.1:5184]
 * The data dir defaults to APPS_CHAT_DATA_DIR, else ~/.pi/agent/chat, and the server to APPS_CHAT_URL, else http://127.0.0.1:5184.
 * Without OUTPUT_FILE the result prints to stdout.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { RequestTiming } from "../../server/request-log.ts";
import type { Item } from "../../web/src/lib/api/types.ts";

/**
 * Who measured a line: the server's handler time, or a page's wait, `tailnet` for the owner's devices and `client` for a browser on the box,
 * such as a job's walk, or a line from before the server named where the page ran. On 11-03 a thread open in the box Chrome waited 32 ms at
 * p50 for GET /api/rooms at a box load of 12, and up to 2,135 ms while the load sat near 300, so a walk says little about the owner's wait.
 */
export type SpeedSource = "server" | "client" | "tailnet" | "probe";
const sourceOf = (t: RequestTiming): SpeedSource => (t.src === "client" && t.via === "tailnet" ? "tailnet" : t.src);

/**
 * One route's speed from one source. `netP50` and `netP90` come from the client lines that carry the browser's network time, so a client
 * p90 far above its `netP90` is the page's own main thread, not the server or the network.
 */
export interface RouteSpeed { route: string; src: SpeedSource; count: number; p50: number; p90: number; max: number; slowestPath: string; netCount?: number; netP50?: number; netP90?: number }

/** The routes each metric reads, by `<method> <route pattern>`. */
export const ROUTES = {
  search: "GET /api/search",
  messages: "GET /api/c/:id/items",
  replies: "GET /api/c/:id/replies/:root",
  send: "POST /api/c/:id/send",
} as const;

const percentile = (sorted: readonly number[], q: number): number => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;

/**
 * The request log's lines in the window ending at `now`; a line that does not parse is skipped, and so is a server line with status 0, a
 * request the caller dropped. A client line with status 0 stays, since it is a call that never reached the server.
 */
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
        if (timing.at >= from && timing.at <= now && (timing.s > 0 || (timing.src === "client" && timing.err !== undefined))) out.push(timing);
      } catch { /* a torn last line */ }
    }
  }
  return out;
}

/** Each route's speed per source, slowest p90 first. */
export function routeSpeeds(timings: readonly RequestTiming[]): RouteSpeed[] {
  const groups = new Map<string, RequestTiming[]>();
  for (const timing of timings) {
    if (timing.s === 0 || timing.shown) continue;
    const key = `${sourceOf(timing)} ${timing.m} ${timing.r}`;
    const group = groups.get(key);
    if (group) group.push(timing);
    else groups.set(key, [timing]);
  }
  return [...groups.values()].map(group => {
    const sorted = group.map(t => t.ms).sort((a, b) => a - b);
    const slowest = group.reduce((a, b) => (b.ms > a.ms ? b : a));
    const net = group.flatMap(t => (t.net === undefined ? [] : [t.net])).sort((a, b) => a - b);
    return {
      route: `${group[0]!.m} ${group[0]!.r}`, src: sourceOf(group[0]!), count: group.length, p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9), max: sorted.at(-1)!, slowestPath: slowest.p,
      ...(net.length ? { netCount: net.length, netP50: percentile(net, 0.5), netP90: percentile(net, 0.9) } : {}),
    };
  }).sort((a, b) => b.p90 - a.p90);
}

/** The owner's network time: the p50 of `net` on his own devices' answered calls, which also holds those calls' few ms of handler time. */
export interface OwnerNetwork { count: number; p50: number }

export function ownerNetwork(timings: readonly RequestTiming[]): OwnerNetwork | undefined {
  const net = timings.flatMap(t => (sourceOf(t) === "tailnet" && t.s > 0 && !t.shown && t.net !== undefined ? [t.net] : [])).sort((a, b) => a - b);
  return net.length ? { count: net.length, p50: percentile(net, 0.5) } : undefined;
}

/**
 * A route's p90 as the owner waits for it, and the text that says where it came from: his own devices' lines, else the server's handler p90
 * plus his network p50 from his other calls. A box browser's line never sets it. On 11-05 the send metric read 288 ms from 255 job walks in
 * the box Chrome, which waits for the box's CPU, while the server answered sends at 15 ms p90 and the owner made no send over the tailnet.
 */
export interface OwnerSpeed { route: string; p90: number; source: string; speed: RouteSpeed }

export function ownerSpeed(speeds: readonly RouteSpeed[], route: string, net: OwnerNetwork | undefined): OwnerSpeed | undefined {
  const own = speeds.find(s => s.src === "tailnet" && s.route === route);
  if (own) return { route, p90: own.p90, source: `the owner's devices, ${own.count} requests`, speed: own };
  const server = speeds.find(s => s.src === "server" && s.route === route);
  if (!server) return undefined;
  const handler = `no request of the owner's in the window, so the server's handler p90 ${server.p90} ms over ${server.count} requests`;
  return net
    ? { route, p90: Math.round((server.p90 + net.p50) * 10) / 10, source: `${handler} plus his network p50 ${net.p50} ms over ${net.count} tailnet requests`, speed: server }
    : { route, p90: server.p90, source: `${handler} alone, since no tailnet request in the window carries the network time`, speed: server };
}

const WHO: Record<SpeedSource, string> = {
  tailnet: "the owner's devices",
  client: "browsers on the box, such as job walks, or pages from before the server named where a page ran",
  server: "the server's own handler time",
  probe: "the precheck's own calls from the box",
};

/**
 * A flagged route's finding: who measured it, then the network time, then where the rest went. A wait at least twice its network p90 was
 * held by the page's main thread in long tasks (render, markdown, the hello lists), as GET /api/rooms was on 11-03 at 654 ms p50 against a
 * 7.2 ms handler; otherwise the network or the server held it.
 */
export function finding(s: RouteSpeed): string {
  const head = `${s.route} p90 ${s.p90} ms, p50 ${s.p50} ms, max ${s.max} ms over ${s.count} requests from ${WHO[s.src]}`;
  const net = s.netP90 === undefined
    ? s.src === "server" ? "" : "; no line carries the network time yet, so read the server's line for this route beside it"
    : `; on the ${s.netCount} lines that carry the network time, the network and the server took p90 ${s.netP90} ms, p50 ${s.netP50} ms, so ${
      s.p90 >= 2 * s.netP90 ? "the page's main thread held the rest in long tasks; trace a page load in the box Chrome to find them" : "the network or the server held the wait"}`;
  return `${head}${net}; the slowest was ${s.slowestPath}`;
}

/** The routes a send of the owner's goes through: the post, its retry and the image upload it waits on. */
const SEND_ROUTES = new Set([ROUTES.send, "POST /api/c/:id/send/:requestId/retry", "POST /api/uploads"]);

/**
 * The sends a page saw as Not delivered, each once. A server line that refused one (status 400 to 499) counts, since the page never
 * retries a refusal, and it is the only line a tab too old to post timings leaves. A page's `shown` line counts when its last call never
 * reached the server (status 0) or failed there (500 and up), which the page tried again first; its 4xx repeats the server's line. A failed
 * call that a later try landed is no failure. On 11-04 at 03:09Z three of the owner's sends answered 400 and showed Not delivered, and no
 * metric counted them.
 */
export function failedSends(timings: readonly RequestTiming[]): RequestTiming[] {
  return timings.filter(t => SEND_ROUTES.has(`${t.m} ${t.r}`) && (t.src === "server" ? t.s >= 400 && t.s < 500 : t.shown === true && (t.s === 0 || t.s >= 500)));
}

/**
 * A failed send from a browser on the box (`via` local), such as a job's walk, is not the owner's. A line with no `via` is from before the
 * server named where a request came from and may be his, so it counts. On 11-05 the duty counted 8 failed sends, and 3 of them were a job's
 * walk in a test room, one a deliberate blob:walk6 upload.
 */
const fromBox = (t: RequestTiming): boolean => t.via === "local";

const who = (t: RequestTiming): string => (t.via ? `${t.src} via ${t.via}` : t.src);

/** A slow route's flagged excerpt: the owner's own wait with its network split, or the fallback reading with its source. */
const slowExcerpt = (o: OwnerSpeed): string =>
  o.speed.src === "tailnet" ? finding(o.speed) : `${o.route} p90 about ${o.p90} ms for the owner: ${o.source}; the slowest was ${o.speed.slowestPath}`;

/**
 * The precheck's own GETs of one metric route against the live server, for a route no request of the window reached: the wall time of each
 * call, or why the probe failed. On 11-06 the owner had made no call since 11-05 00Z, so search, messages and replies had no value and the
 * duty read as unmeasured each day he was away.
 */
export type Probe = { route: string; at: number; path: string; ms: number[] } | { route: string; at: number; path?: string; error: string };

/** The metric routes the precheck probes when the window holds no tailnet or server line of theirs. */
export const PROBED = [ROUTES.search, ROUTES.messages, ROUTES.replies] as const;

export const unmeasured = (speeds: readonly RouteSpeed[]): string[] => PROBED.filter(route => !speeds.some(s => s.route === route && s.src !== "client"));

/** A probed route's p90 as the owner would wait for it: the probe's wall-time p90 plus his network p50 when the window has it. */
export function probeSpeed(probe: Probe, net: OwnerNetwork | undefined): OwnerSpeed | undefined {
  if (!("ms" in probe) || !probe.ms.length) return undefined;
  const sorted = [...probe.ms].sort((a, b) => a - b);
  const speed: RouteSpeed = { route: probe.route, src: "probe", count: sorted.length, p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9), max: sorted.at(-1)!, slowestPath: probe.path };
  const head = `a probe from the box at ${new Date(probe.at).toISOString()}, since the owner made no call in the window: ${speed.count} GETs of ${probe.path} took p90 ${speed.p90} ms`;
  return net
    ? { route: probe.route, p90: Math.round((speed.p90 + net.p50) * 10) / 10, source: `${head} plus his network p50 ${net.p50} ms over ${net.count} tailnet requests`, speed }
    : { route: probe.route, p90: speed.p90, source: `${head} alone, since no tailnet request in the window carries the network time`, speed };
}

const PROBE_CALLS = 5;
const SEARCH_QUERY = "duty";

async function getJson(base: string, path: string): Promise<{ ms: number; body: unknown }> {
  const started = performance.now();
  const res = await fetch(new URL(path, base));
  const text = await res.text();
  const ms = Math.round((performance.now() - started) * 10) / 10;
  if (!res.ok) throw new Error(`GET ${path} answered ${res.status}: ${text.slice(0, 200)}`);
  return { ms, body: JSON.parse(text) as unknown };
}

const why = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The conversation ids the window's requests named, busiest first, then the live server's rooms. */
async function conversations(base: string, timings: readonly RequestTiming[]): Promise<string[]> {
  const counts = new Map<string, number>();
  for (const t of timings) {
    const id = /^\/api\/c\/([^/?]+)/.exec(t.p)?.[1];
    if (id) counts.set(decodeURIComponent(id), (counts.get(decodeURIComponent(id)) ?? 0) + 1);
  }
  const rooms = await getJson(base, "/api/rooms").then(r => (r.body as { id: string }[]).map(room => room.id), () => []);
  return [...new Set([...[...counts].sort((a, b) => b[1] - a[1]).map(([id]) => id), ...rooms])];
}

/** The first of the candidates whose latest page answers and gives `pick` a path to probe. */
async function firstPath(base: string, ids: readonly string[], pick: (items: readonly Item[]) => string | undefined): Promise<string | undefined> {
  for (const id of ids) {
    const page = await getJson(base, `/api/c/${encodeURIComponent(id)}/items`).then(r => r.body as { items?: Item[] }, () => undefined);
    const tail = page?.items && pick(page.items);
    if (tail !== undefined) return `/api/c/${encodeURIComponent(id)}${tail}`;
  }
  return undefined;
}

const repliesTail = (items: readonly Item[]): string | undefined => {
  const root = items.find(item => item.kind === "message" && (item.thread?.replies ?? 0) > 0);
  return root && `/replies/${encodeURIComponent(root.id)}`;
};

/**
 * Probes each route against the live server at `base` with a few GETs: search with a plain query, the busiest conversation's latest
 * messages, and a thread's replies on a real root post. The CLI runs it before apiSpeed, whose window ends before the probe's own lines.
 */
export async function probeRoutes(base: string, routes: readonly string[], timings: readonly RequestTiming[]): Promise<Probe[]> {
  if (!routes.length) return [];
  const at = Date.now();
  const ids = await conversations(base, timings);
  const pathOf = async (route: string): Promise<string | undefined> =>
    route === ROUTES.search ? `/api/search?q=${SEARCH_QUERY}` : firstPath(base, ids, route === ROUTES.messages ? () => "/items" : repliesTail);
  const out: Probe[] = [];
  for (const route of routes) {
    const path = await pathOf(route);
    if (!path) {
      out.push({ route, at, error: route === ROUTES.replies ? `no conversation the log or ${base}/api/rooms names has a post with replies` : `no conversation the log or ${base}/api/rooms names answers its items` });
      continue;
    }
    try {
      const ms: number[] = [];
      for (let i = 0; i < PROBE_CALLS; i++) ms.push((await getJson(base, path)).ms);
      out.push({ route, at, path, ms });
    } catch (error) {
      out.push({ route, at, path, error: why(error) });
    }
  }
  return out;
}

export function apiSpeed(dir: string, now: number, windowMs: number, probes: readonly Probe[] = []) {
  const timings = readTimings(dir, now, windowMs);
  const speeds = routeSpeeds(timings);
  const net = ownerNetwork(timings);
  const probed = (route: string): OwnerSpeed | undefined => {
    const probe = probes.find(p => p.route === route);
    return probe && probeSpeed(probe, net);
  };
  const speedOf = (route: string): OwnerSpeed | undefined => ownerSpeed(speeds, route, net) ?? probed(route);
  const failed = failedSends(timings);
  const owners = failed.filter(t => !fromBox(t));
  const walks = failed.filter(fromBox);
  const pageRoutes = new Set<string>([...Object.values(ROUTES), ...speeds.filter(s => s.src !== "server").map(s => s.route)]);
  const slowest = [...pageRoutes].flatMap(route => speedOf(route) ?? []).sort((a, b) => b.p90 - a.p90).slice(0, 3);
  const walkSlowest = speeds.filter(s => s.src === "client").slice(0, 3);
  const [search, messages, replies, send] = [ROUTES.search, ROUTES.messages, ROUTES.replies, ROUTES.send].map(speedOf);
  const metrics: Record<string, number> = {};
  if (slowest.length) metrics.slowest_api_p90_ms = slowest[0]!.p90;
  if (search) metrics.search_p90_ms = search.p90;
  if (messages) metrics.thread_open_p90_ms_messages = messages.p90;
  if (replies) metrics.thread_open_p90_ms_replies = replies.p90;
  if (messages || replies) metrics.thread_open_p90_ms = Math.max(messages?.p90 ?? 0, replies?.p90 ?? 0);
  if (send) metrics.send_p90_ms = send.p90;
  metrics.failed_sends_24h = owners.length;
  return {
    metrics,
    slowest,
    metricSources: Object.fromEntries(Object.entries({ slowest: slowest[0], search, messages, replies, send }).flatMap(([key, speed]) => (speed ? [[key, `${speed.route}: ${speed.source}`]] : []))),
    network: net,
    routes: speeds,
    flagged: [
      ...[...owners.map(t => ["failed_send", t] as const), ...walks.map(t => ["walk_failed_send", t] as const)].map(([kind, t]) => ({
        kind, sig: `${who(t)}:${t.m} ${t.r}:${t.s}`,
        excerpt: `${new Date(t.at).toISOString()} ${t.m} ${t.p} ${t.s ? `answered ${t.s}` : "never reached the server"} (${who(t)}${t.shown ? ", Not delivered after the page's tries" : ""}): ${t.err ?? "no reason logged"}`,
      })),
      ...probes.flatMap(p => ("error" in p ? [{ kind: "probe_failed", sig: `probe:${p.route}`, excerpt: `${p.route} has no value: a probe from the box at ${new Date(p.at).toISOString()} failed: ${p.error}` }] : [])),
      ...slowest.map(o => ({ kind: "slow_api", sig: `${o.speed.src}:${o.route}`, excerpt: slowExcerpt(o) })),
      ...walkSlowest.map(s => ({ kind: "walk_slow_api", sig: `${s.src}:${s.route}`, excerpt: finding(s) })),
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { "data-dir": { type: "string" }, hours: { type: "string" }, server: { type: "string" } } });
  const dir = resolve(values["data-dir"] ?? process.env.APPS_CHAT_DATA_DIR ?? join(homedir(), ".pi/agent/chat"));
  const base = values.server ?? process.env.APPS_CHAT_URL ?? "http://127.0.0.1:5184";
  const now = Date.now();
  const windowMs = Number(values.hours ?? 24) * 3600_000;
  const timings = readTimings(dir, now, windowMs);
  const probes = await probeRoutes(base, unmeasured(routeSpeeds(timings)), timings);
  const json = JSON.stringify(apiSpeed(dir, now, windowMs, probes), null, 1);
  if (process.env.OUTPUT_FILE) writeFileSync(process.env.OUTPUT_FILE, json);
  else process.stdout.write(`${json}\n`);
}
