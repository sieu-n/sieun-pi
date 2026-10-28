/**
 * pi-history's HTTP API on a unix socket: /v1/search, /v1/read and /v1/status over this box's index and durable thread indexes, fanned out
 * to every other hosts.json box through its prime-relay (`/v1/history/*`) with that relay's bearer token.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { socketPath } from "./client.ts";
import { parseQuery, QueryError, type Query } from "./core/query.ts";
import { parseRef, readDurable, readPrime, ReadError, type ReadAnswer } from "./core/read.ts";
import { type Hit, mergePages, type Page, pageAsk, type PageAsk, type Ranked } from "./core/search.ts";
import type { SearchAnswer, SearchJob, SearchReply } from "./query-worker.ts";
import { callerRoot, chatOf, expandHome, familyRoots, type HostEntry, hostsFile, localRoots, readHosts, readSettings, RegistryReader, registrySource, settingsPath, type Settings,
  sieunPiConfig } from "./core/scope.ts";

export interface BoxState { ok: boolean; error?: string; tookMs: number; newestAt?: number; backfillPct: number; bytesTotal?: number; lagP50Ms?: number; lagP99Ms?: number }
export interface SearchResult { hits: Hit[]; total: number; nextCursor?: string; tookMs: number; boxes: Record<string, BoxState>; scope: "all" | "family" }
export interface Status {
  box: string; files: number; docs: number; bytesIndexed: number; bytesTotal: number; backfillPct: number; newestAt?: number;
  lagP50Ms?: number; lagP99Ms?: number; queryP50Ms?: number; queryP99Ms?: number; dbBytes: number; peers: Record<string, BoxState>;
}
/** What a peer answers with `local=1`: its ranked hits unmerged, so the asking box merges every source with one rule. */
interface PeerPage { ranked: Ranked[]; total: number; box: BoxState }

/** The indexer's own reading (core/indexer.ts `IndexStatus`); the server reads the same numbers from the database when it runs alone. */
export interface IndexerState {
  files: number; docs: number; bytesIndexed: number; bytesTotal: number; backfillPct: number; newestAt?: number; lagP50Ms?: number; lagP99Ms?: number; dbBytes: number;
}

/** What src/main.ts hands over: the database, the socket, this box's name and the running indexer. */
export interface ServerOptions {
  dbPath: string;
  socket: string;
  /** This box's hosts.json name; settings.json's `box` (or the hosts.json entry for this hostname) when left out. */
  box?: string;
  indexer?: { status(): IndexerState };
  settingsFile?: string;
  fetcher?: typeof fetch;
  /** How often a down peer is asked for its status; PROBE_MS unless a test sets it. */
  probeMs?: number;
}

/**
 * How long a peer box gets to answer. Measured 10-28: prime-relay /v1/health from us-metal02 to the Mac took 375 to 391 ms over 5 runs,
 * and search.md section 4 measured query p95 at 35 ms on the family index, so a peer that has not answered in 5 s is down or stuck.
 */
const PEER_TIMEOUT_MS = 5000;
/** A down peer is probed every 30 s, so a box back online rejoins searches within half a minute (the parent's 10-28 design). */
const PROBE_MS = 30_000;
/** The query timings /v1/status reports, the same window as the indexer's lag samples (API.md). */
const TIMING_SAMPLES = 1000;
const LIMIT_DEFAULT = 20;
/** API.md caps a page at 100 hits. */
const LIMIT_MAX = 100;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const percentile = (values: number[], p: number): number | undefined => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]! * 10) / 10;
};

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  response.end(text);
}

const one = (params: URLSearchParams, key: string): string | null => params.get(key) || null;

/** The peers a call fans out to: every hosts.json box but this one, with its relay URL and token. */
function peers(settings: Settings): { name: string; url: string; token: string }[] {
  return readHosts(hostsFile(settings)).filter(host => host.name !== settings.box && host.address && host.relayPort && host.token).map((host: HostEntry) => {
    const token = host.token!.startsWith("file:") ? readFileSync(join(sieunPiConfig(), host.token!.slice(5)), "utf8").trim() : host.token!;
    return { name: host.name, url: `http://${host.address}:${host.relayPort}/v1/history`, token };
  });
}

export async function startServer(options: ServerOptions): Promise<{ close(): Promise<void>; socket: string }> {
  const fetcher = options.fetcher ?? fetch;
  const settingsOf = (): Settings => {
    const settings = readSettings(options.settingsFile ?? settingsPath());
    return options.box ? { ...settings, box: options.box } : settings;
  };
  const registry = new RegistryReader(() => registrySource(settingsOf()), fetcher);
  const timings: number[] = [];
  let db: DatabaseSync | null = null;
  const durables = new Map<string, DatabaseSync | null>();

  const index = (): DatabaseSync => {
    if (!db) {
      if (!existsSync(options.dbPath)) throw new HttpError(503, `No index at ${options.dbPath} yet.`);
      db = new DatabaseSync(options.dbPath, { readOnly: true });
    }
    return db;
  };
  /** Each durable index that exists, opened read-only once; a missing file is looked for again on the next call. */
  const durableIndexes = (settings: Settings): { at: number; db: DatabaseSync }[] => settings.durableIndexes.flatMap((path, at) => {
    let handle = durables.get(path) ?? null;
    if (!handle && existsSync(path)) {
      try { handle = new DatabaseSync(path, { readOnly: true }); } catch { handle = null; }
      durables.set(path, handle);
    }
    return handle ? [{ at, db: handle }] : [];
  });

  /** The roots a call may see: null for the owner or `agentScope: "all"`, else the caller's chat family (or a peer's `roots=` seeds, expanded here). */
  const scopeOf = async (params: URLSearchParams, settings: Settings): Promise<{ roots: string[] | null; seeds: string[] | null }> => {
    const caller = one(params, "caller");
    const seeds = caller ? null : one(params, "roots")?.split(",").filter(Boolean) ?? null;
    if (!caller && !(seeds && params.get("local") === "1")) return { roots: null, seeds: null };
    if (caller && settings.agentScope === "all") return { roots: null, seeds: null };
    const jobs = await registry.read();
    const roots = localRoots(index());
    const chats = seeds ?? [chatOf(callerRoot(index(), caller!, one(params, "callerPath")), jobs, root => roots.get(root) ?? null)];
    return { roots: familyRoots(chats, jobs, roots), seeds: chats };
  };

  const boxState = (tookMs: number): BoxState => {
    const status = localStatus(false);
    return { ok: true, tookMs, ...status.newestAt ? { newestAt: status.newestAt } : {}, backfillPct: status.backfillPct, bytesTotal: status.bytesTotal,
      ...status.lagP50Ms !== undefined ? { lagP50Ms: status.lagP50Ms } : {}, ...status.lagP99Ms !== undefined ? { lagP99Ms: status.lagP99Ms } : {} };
  };

  /** This box's index reading: the indexer's when it runs here, else counted from the database (tests, a read-only copy). */
  const localStatus = (counts: boolean): Omit<Status, "peers" | "box"> => {
    const p50 = percentile(timings, 0.5), p99 = percentile(timings, 0.99);
    const timing = p50 !== undefined && p99 !== undefined ? { queryP50Ms: p50, queryP99Ms: p99 } : {};
    if (options.indexer) {
      const own = options.indexer.status();
      return { files: own.files, docs: own.docs, bytesIndexed: own.bytesIndexed, bytesTotal: own.bytesTotal, backfillPct: own.backfillPct,
        ...own.newestAt ? { newestAt: own.newestAt } : {}, ...own.lagP50Ms !== undefined ? { lagP50Ms: own.lagP50Ms, lagP99Ms: own.lagP99Ms } : {}, dbBytes: own.dbBytes, ...timing };
    }
    const handle = index();
    const sizes = handle.prepare("SELECT count(*) AS files, coalesce(sum(min(indexed_to, size)), 0) AS done, coalesce(sum(size), 0) AS total FROM files").get() as Record<string, number>;
    const newest = handle.prepare("SELECT max(id) AS id FROM docs").get() as { id: number | null };
    // Counting every doc takes tens of ms at 600,000 docs, so only /v1/status counts them; a search's box state needs the newest time alone.
    const docs = counts ? Number((handle.prepare("SELECT count(*) AS n FROM docs").get() as { n: number }).n) : 0;
    let dbBytes = 0;
    for (const suffix of ["", "-wal"]) try { dbBytes += statSync(options.dbPath + suffix).size; } catch {}
    const total = Number(sizes.total);
    return {
      files: Number(sizes.files), docs, bytesIndexed: Number(sizes.done), bytesTotal: total,
      backfillPct: total ? Math.floor(Number(sizes.done) / total * 1000) / 10 : 100, ...newest.id ? { newestAt: Math.floor(Number(newest.id) / 1024) } : {}, dbBytes, ...timing,
    };
  };

  // One worker per job in flight: a free one is reused, and when none is free a new one starts, so a slow search never holds up another.
  const idle: Worker[] = [];
  const workers = new Set<Worker>();
  const run = <T extends SearchAnswer>(job: SearchJob): Promise<T> => new Promise((resolve, reject) => {
    let worker = idle.pop();
    if (!worker) {
      worker = new Worker(new URL("./query-worker.ts", import.meta.url));
      workers.add(worker);
    }
    const current = worker;
    const failed = (error: Error) => { workers.delete(current); reject(error); };
    current.once("error", failed);
    current.once("message", (reply: SearchReply) => {
      current.off("error", failed);
      idle.push(current);
      if ("answer" in reply) resolve(reply.answer as T);
      else reject(reply.error.startsWith("No index") ? new HttpError(503, reply.error) : new Error(reply.error));
    });
    current.postMessage(job);
  });
  // Two workers open the index at start, the pair a first search uses, so the first search after a restart does not pay for their start.
  const warm = Promise.all([run({ op: "open", dbPath: options.dbPath }), run({ op: "open", dbPath: options.dbPath })]).catch(() => {});

  const localPages = async (query: Query, ask: PageAsk, roots: string[] | null, settings: Settings): Promise<Page[]> => {
    await warm;
    const job = { dbPath: options.dbPath, box: settings.box, durableIndexes: settings.durableIndexes, query, ask, roots };
    const [hits, count] = await Promise.all([run<Extract<SearchAnswer, { op: "hits" }>>({ ...job, op: "hits" }), run<Extract<SearchAnswer, { op: "count" }>>({ ...job, op: "count" })]);
    return [{ hits: hits.prime, total: count.total }, ...hits.durable];
  };

  /** Peers that failed to answer: a search skips them at once, and a probe asks each for its status until it answers again. */
  const down = new Map<string, { since: number; error: string }>();
  const askPeer = async <T>(peer: { name: string; url: string; token: string }, path: string, params: URLSearchParams): Promise<T> => {
    let response: Response;
    try {
      response = await fetcher(`${peer.url}/${path}?${params}`, {
        headers: { Authorization: `Bearer ${peer.token}` }, signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!down.has(peer.name)) down.set(peer.name, { since: Date.now(), error: message });
      throw error;
    }
    const body = await response.text();
    if (!response.ok) {
      // A 4xx is about the request; a 5xx means the peer's pi-history or relay cannot answer, so the peer counts as down.
      if (response.status >= 500 && !down.has(peer.name)) down.set(peer.name, { since: Date.now(), error: `${response.status}` });
      throw new Error(`${response.status} ${body.slice(0, 200)}`);
    }
    down.delete(peer.name);
    return JSON.parse(body) as T;
  };
  const downState = (name: string): BoxState | null => {
    const state = down.get(name);
    return state ? { ok: false, error: `offline since ${new Date(state.since).toISOString()} (${state.error})`, tookMs: 0, backfillPct: 0 } : null;
  };
  const probe = setInterval(() => {
    const settings = settingsOf();
    for (const peer of peers(settings).filter(candidate => down.has(candidate.name))) void askPeer(peer, "status", new URLSearchParams({ local: "1" })).catch(() => {});
  }, options.probeMs ?? PROBE_MS);
  probe.unref();

  const search = async (params: URLSearchParams): Promise<SearchResult | PeerPage> => {
    const started = performance.now();
    const settings = settingsOf();
    const query = parseQuery({ q: one(params, "q"), kind: one(params, "kind"), box: one(params, "box"), chat: one(params, "chat"), agent: one(params, "agent"),
      since: one(params, "since"), until: one(params, "until") });
    const sort = params.get("sort") === "relevant" ? "relevant" : "newest";
    const limit = Math.min(LIMIT_MAX, Math.max(1, Number(params.get("limit")) || LIMIT_DEFAULT));
    const ask = pageAsk(sort, limit, one(params, "cursor"));
    const { roots, seeds } = await scopeOf(params, settings);
    const wanted = (box: string): boolean => !query.filters.boxes.length || query.filters.boxes.includes(box);
    if (params.get("local") === "1") {
      const pages = wanted(settings.box) ? await localPages(query, ask, roots, settings) : [];
      const tookMs = performance.now() - started;
      return { ranked: pages.flatMap(page => page.hits), total: pages.reduce((sum, page) => sum + page.total, 0), box: boxState(Math.round(tookMs)) };
    }
    const forward = new URLSearchParams(params);
    for (const key of ["caller", "callerPath", "roots"]) forward.delete(key);
    forward.set("local", "1");
    if (seeds) forward.set("roots", seeds.join(","));
    // Each peer's answer settles into a value at once, so one that fails while this box runs its own query is never an unhandled rejection.
    const boxes: Record<string, BoxState> = {};
    const asked = peers(settings).filter(peer => wanted(peer.name)).filter(peer => {
      const state = downState(peer.name);
      if (state) boxes[peer.name] = state;
      return !state;
    });
    const remote = asked.map(peer => ({ peer, started: performance.now(),
      answer: askPeer<PeerPage>(peer, "search", forward).then(page => ({ page }), (error: unknown) => ({ error })) }));
    const pages: Page[] = [];
    if (wanted(settings.box)) {
      const local = await localPages(query, ask, roots, settings);
      pages.push(...local);
      boxes[settings.box] = boxState(Math.round(performance.now() - started));
    }
    for (const { peer, started: asked, answer } of remote) {
      const settled = await answer;
      if ("page" in settled) {
        pages.push({ hits: settled.page.ranked, total: settled.page.total });
        boxes[peer.name] = { ...settled.page.box, tookMs: Math.round(performance.now() - asked) };
      } else {
        const error = settled.error;
        boxes[peer.name] = { ok: false, error: error instanceof Error ? error.message : String(error), tookMs: Math.round(performance.now() - asked), backfillPct: 0 };
      }
    }
    const merged = mergePages(pages, ask);
    const tookMs = Math.round((performance.now() - started) * 10) / 10;
    return { hits: merged.hits, total: merged.total, ...merged.next ? { nextCursor: merged.next } : {}, tookMs, boxes, scope: roots ? "family" : "all" };
  };

  const read = async (params: URLSearchParams): Promise<ReadAnswer> => {
    const settings = settingsOf();
    const ref = parseRef(params.get("ref") ?? "");
    const before = Math.max(0, Number(params.get("before") ?? 3) || 0);
    const after = Math.max(0, Number(params.get("after") ?? 3) || 0);
    const { roots, seeds } = await scopeOf(params, settings);
    if (ref.box !== settings.box) {
      const peer = peers(settings).find(candidate => candidate.name === ref.box);
      if (!peer || params.get("local") === "1") throw new ReadError(404, `No box ${ref.box} in hosts.json.`);
      const forward = new URLSearchParams({ ref: params.get("ref")!, before: String(before), after: String(after), local: "1", ...seeds ? { roots: seeds.join(",") } : {} });
      return askPeer<ReadAnswer>(peer, "read", forward);
    }
    if (ref.source === "prime") return readPrime(index(), settings.box, ref, before, after, roots);
    const durable = durableIndexes(settings).find(candidate => candidate.at === ref.index);
    if (!durable) throw new ReadError(404, `No durable index ${ref.index} on ${settings.box}.`);
    return readDurable(durable.db, settings.box, ref, before, after, roots);
  };

  const status = async (params: URLSearchParams): Promise<Status> => {
    const settings = settingsOf();
    const own = { box: settings.box, ...localStatus(true) };
    const out: Record<string, BoxState> = {};
    if (params.get("local") !== "1") {
      await Promise.all(peers(settings).map(async peer => {
        const asked = performance.now();
        try {
          const answer = await askPeer<Status>(peer, "status", new URLSearchParams({ local: "1" }));
          out[peer.name] = { ok: true, tookMs: Math.round(performance.now() - asked), backfillPct: answer.backfillPct, bytesTotal: answer.bytesTotal,
            ...answer.newestAt ? { newestAt: answer.newestAt } : {}, ...answer.lagP50Ms !== undefined ? { lagP50Ms: answer.lagP50Ms, lagP99Ms: answer.lagP99Ms } : {} };
        } catch (error) {
          out[peer.name] = { ok: false, error: error instanceof Error ? error.message : String(error), tookMs: Math.round(performance.now() - asked), backfillPct: 0 };
        }
      }));
    }
    return { ...own, peers: out };
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://pi-history");
    try {
      if (request.method !== "GET") throw new HttpError(405, "GET only.");
      if (url.pathname === "/v1/search") {
        const started = performance.now();
        const result = await search(url.searchParams);
        timings.push(performance.now() - started);
        if (timings.length > TIMING_SAMPLES) timings.shift();
        return send(response, 200, result);
      }
      if (url.pathname === "/v1/read") return send(response, 200, await read(url.searchParams));
      if (url.pathname === "/v1/status") return send(response, 200, await status(url.searchParams));
      throw new HttpError(404, `No route ${url.pathname}.`);
    } catch (error) {
      const code = error instanceof HttpError || error instanceof ReadError ? error.status : error instanceof QueryError || error instanceof RangeError ? 400 : 500;
      const message = error instanceof Error ? error.message : String(error);
      send(response, /fts5: syntax error|unterminated string/.test(message) ? 400 : code, { error: message });
    }
  };

  const server = createServer((request, response) => { void handle(request, response); });
  mkdirSync(dirname(options.socket), { recursive: true, mode: 0o700 });
  rmSync(options.socket, { force: true });
  // The socket opens once the two workers hold the index: their start took 140 to 165 ms on us-metal02 on 10-28, which a search right after a
  // restart waited for.
  await warm;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.socket, () => resolve()); });
  chmodSync(options.socket, 0o600);
  return {
    socket: options.socket,
    close: () => new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
      for (const worker of workers) void worker.terminate();
      clearInterval(probe);
      db?.close();
      for (const handle of durables.values()) handle?.close();
    }),
  };
}
