import { posix } from "node:path";

/**
 * The data facts of the Wiki and skill facts duty (wiki-skill-facts.ts): the ClickHouse `db.table` names, Postgres and Convex table names
 * and HTTP routes a curated page cites, judged against auto-sns-agent's code. A name counts when a sampled commit defined it and HEAD has
 * no trace of it: the commits are the start and end of each page's day, so a name that lived between two page days is in the code's history.
 * A name no sampled commit defined, such as a vendor's route or `otel.otel_traces` that the collector makes, never counts. On 2026-11-26 the
 * auditor found apps/search/pricing-billing.html naming `usage.events` four times a day after bd2cb5b1b3 moved it to `product.usage_events`,
 * while d1 read only code names.
 */

export type DataKind = "clickhouse" | "postgres" | "convex" | "route";
export interface DataStale { kind: DataKind; name: string; current?: string }
export interface TreeEntry { blob: string; path: string }
export interface Route { segs: string[]; prefix: boolean }
export interface Defs { names: Map<DataKind, Set<string>>; routes: Route[] }

/** The folders whose files define a data name: DDL, alembic, Convex tables, FastAPI and Convex HTTP routes, api-portal's operations. */
export const DATA_ROOTS = ["convex", "apps/crawler-v3/alembic", "apps/crawler-v3/src", "apps/vent/src", "apps/research-agent-be/src",
  "apps/infra/clickhouse", "apps/infra/metal/config", "ops/bin", "apps/api-portal/src/lib/server"] as const;
/** A SvelteKit app's routes folder, found in HEAD's tree, so an app that left the repo (apps/llm-wiki went to sieun-pi) never counts. */
export const ROUTES_DIR = /^apps\/[^/]+(?:\/overlay)?\/src\/routes$/;
/**
 * History words for data facts: wiki-skill-facts.ts HISTORY plus the words a page uses to tell a move. On 2026-11-26
 * domains/architecture/outside-calls/attribution.html said "The table was `ledger.events` before `5bd7834fa3`", and
 * projects/limits-ledger said "0150 drops `enrichment_concurrency_slots`".
 */
export const DATA_HISTORY = /\b(?:removed|removal|deleted|no longer|renamed|renames?|retired|replaced|superseded|dropped|drops?|used to|formerly|was cut|moved|was|were|before|previously|earlier|old|one-time|one-off)\b/i;
/**
 * The words that make a table or diagram history from its section's text: "The old paths answer 410" above douyin.html's path table and
 * "0060_m3_subapp_door dropped them" above kick.html's. "moves" stays out, since convex/crons.html says a cron "moves waiting rows".
 */
export const SECTION_HISTORY = /\b(?:removed|removal|deleted|no longer|renamed|retired|replaced|superseded|dropped|drops|used to|formerly|was cut|old|one-time|one-off)\b/i;

const isTest = (path: string): boolean => /(?:^|\/)(?:tests?|__tests__|fixtures)\//.test(path) || /\.(?:test|spec)\.[cm]?[jt]s$|(?:^|\/)(?:test_[^/]*|[^/]*_test|conftest)\.py$/.test(path);
const CODE = /\.(?:py|sql|ts|mjs|cjs|js|sh)$/;
/** Whether a blob at `path` can define a data name; a route file under a routes folder needs no read, its path is the route. */
export const wantsBlob = (path: string): boolean => CODE.test(path) && !isTest(path) && !/\/src\/routes\//.test(path) && !path.endsWith(".d.ts");

const CH_DDL = /\b(?:CREATE|ATTACH|create)\s+(?:OR\s+REPLACE\s+)?(?:TEMPORARY\s+)?(?:TABLE|(?:MATERIALIZED\s+)?VIEW|DICTIONARY|table|view)\s+(?:IF\s+NOT\s+EXISTS\s+|if\s+not\s+exists\s+)?`?([a-z_][a-z0-9_]*)`?\.`?([a-z_][a-z0-9_]*)`?/g;
const CH_RENAME = /\bRENAME\s+TABLE\s+`?([a-z_]\w*)`?\.`?(\w+)`?\s+TO\s+`?([a-z_]\w*)`?\.`?(\w+)/g;
const PG_DEFS = [/__tablename__\s*=\s*["'](\w+)/g, /\bcreate_table\(\s*["'](\w+)/g, /\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_]\w*)"?\s*\(/g];
const PG_RENAME = [/\brename_table\(\s*["'](\w+)["']\s*,\s*["'](\w+)/g, /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?([a-z_]\w*)"?\s+RENAME\s+TO\s+"?([a-z_]\w*)/g];
const CONVEX_TABLE = /^\s*([A-Za-z_]\w*)\s*:\s*(?:resource\b|defineTable\()/gm;
/** A FastAPI route call, as a decorator or a registrar call: crawler-v3's youtube_db.py registers `_CHANNEL.get("/profiles/{handle}/videos", ...)`. */
const PY_ROUTE = /\.(?:get|post|put|patch|delete|head|options|api_route|add_api_route|websocket)\(\s*["'](\/[^"']*)["']/g;
const PY_PREFIX = /\bprefix\s*=\s*["'](\/[^"']*)["']/g;
const TS_ROUTES = [/\bpath\s*:\s*["'`](\/[^"'`]*)["'`]/g, /^\s*["'](\/[^"'\s]+)["']\s*:/gm, /["'](?:GET|POST|PUT|PATCH|DELETE)["']\s*,\s*["'](\/[^"']+)["']/g];
const TS_PREFIX = /\bpathPrefix\s*:\s*["'`](\/[^"'`]*)["'`]/g;

/** A route as segments with each parameter as `*` (`{id}`, `[id]`, `<id>`, `:id`, `${x}`); null for no path, a URL or a file path. */
export function routeSegs(raw: string): string[] | null {
  const path = raw.replace(/[?#].*$/, "").replace(/\/+$/, "");
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  const segs = path.slice(1).split("/");
  if (!segs.length || segs.some(seg => !seg || seg.startsWith("."))) return null;
  return segs.map(seg => /^(?:\{[^}]*\}|\[[^\]]*\]|<[^>]*>|:\w+|\$\{[^}]*\}|\*)$/.test(seg) ? "*" : seg);
}

/** The routes a SvelteKit route file serves, with groups gone and an optional parameter as two routes; none for a rest parameter. */
export function svelteRoutes(path: string): Route[] {
  const match = /^apps\/[^/]+(?:\/overlay)?\/src\/routes((?:\/[^/]+)*)\/\+(?:page|server)(?:\.server)?\.(?:svelte|ts|js)$/.exec(path);
  if (!match) return [];
  const parts = match[1]!.split("/").filter(part => part && !/^\(.*\)$/.test(part));
  const rest = parts.findIndex(part => part.includes("[..."));
  // A rest parameter after two fixed segments serves everything under them: v1/tiktok/live/[...path] answers each retired path with 410.
  if (rest >= 0) return rest >= 2 && parts.slice(0, rest).every(part => !part.includes("[")) && rest === parts.length - 1 ? [{ segs: parts.slice(0, rest), prefix: true }] : [];
  if (!parts.length) return [];
  let out: string[][] = [[]];
  for (const part of parts) {
    const optional = /^\[\[.*\]\]$/.test(part);
    const seg = /\[/.test(part) ? "*" : part;
    out = optional ? [...out, ...out.map(segs => [...segs, seg])] : out.map(segs => [...segs, seg]);
  }
  return out.filter(segs => segs.length).map(segs => ({ segs, prefix: false }));
}

/** The data names and routes one code blob defines, and the renames it states as `from>to`, by its path and text. */
export function blobDefs(path: string, text: string): { names: [DataKind, string][]; routes: Route[]; renames: [DataKind, string, string][] } {
  const names: [DataKind, string][] = []; const routes: Route[] = []; const renames: [DataKind, string, string][] = [];
  const alembic = path.startsWith("apps/crawler-v3/alembic/");
  if (!alembic) for (const m of text.matchAll(CH_DDL)) if (m[1] !== "public") names.push(["clickhouse", `${m[1]}.${m[2]}`]);
  for (const m of text.matchAll(CH_RENAME)) renames.push(["clickhouse", `${m[1]}.${m[2]}`, `${m[3]}.${m[4]}`]);
  if (path.startsWith("apps/crawler-v3/")) {
    for (const re of PG_DEFS) if (alembic || re === PG_DEFS[0]) for (const m of text.matchAll(re)) names.push(["postgres", m[1]!]);
    if (alembic) for (const re of PG_RENAME) for (const m of text.matchAll(re)) renames.push(["postgres", m[1]!, m[2]!]);
  }
  if (path.startsWith("convex/") && /(?:^|\/)(?:schema|\w*[Tt]ables?)\.ts$/.test(path)) for (const m of text.matchAll(CONVEX_TABLE)) names.push(["convex", m[1]!]);
  const add = (raw: string, prefix: boolean): void => { const segs = routeSegs(raw); if (segs) routes.push({ segs, prefix }); };
  if (path.endsWith(".py")) {
    const prefixes = [...text.matchAll(PY_PREFIX)].map(m => m[1]!.replace(/\/+$/, ""));
    for (const m of text.matchAll(PY_ROUTE)) { add(m[1]!, false); for (const prefix of prefixes) add(prefix + m[1]!, false); }
  } else if (/\.[cm]?[jt]s$/.test(path)) {
    for (const re of TS_ROUTES) for (const m of text.matchAll(re)) add(m[1]!, false);
    for (const m of text.matchAll(TS_PREFIX)) add(m[1]!, true);
  }
  return { names, routes, renames };
}

/** Whether a cited route is one a defined route serves: every segment equal or a parameter on either side, or under a path prefix. */
export function routeServes(def: Route, cited: readonly string[]): boolean {
  if (def.prefix ? cited.length < def.segs.length : cited.length !== def.segs.length) return false;
  return def.segs.every((seg, index) => seg === "*" || cited[index] === "*" || seg === cited[index]);
}

const DOT = /(?<![\w./$-])([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)(?![\w(/-]|\.[A-Za-z_])/g;
const SNAKE = /(?<![\w./$:-])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?![\w(/.-])/g;
const CAMEL = /(?<![\w./$:-])([a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+)(?![\w(/.-])/g;
const ROUTE = /(?<![\w.:/~$-])(\/[A-Za-z0-9_{}[\]<>:$*-]+(?:\/[A-Za-z0-9_{}[\]<>:$*.-]*)*)/g;

/** The data tokens of a span with the kind each could be; a route keeps its raw text, which the finding quotes. */
export function spanTokens(span: string): [DataKind, string][] {
  const out: [DataKind, string][] = [];
  for (const m of span.matchAll(DOT)) out.push(["clickhouse", m[1]!]);
  for (const m of span.matchAll(SNAKE)) out.push(["postgres", m[1]!]);
  for (const m of span.matchAll(CAMEL)) out.push(["convex", m[1]!]);
  for (const m of span.matchAll(ROUTE)) if (routeSegs(m[1]!)) out.push(["route", m[1]!.replace(/[.,;:)]+$/, "").replace(/\/+$/, "")]);
  return out;
}

/** A rev's definitions from its tree entries and the defs of each blob read. */
export function revDefs(entries: readonly TreeEntry[], blobs: ReadonlyMap<string, ReturnType<typeof blobDefs>>): Defs {
  const names = new Map<DataKind, Set<string>>(); const routes: Route[] = [];
  for (const { blob, path } of entries) {
    routes.push(...svelteRoutes(path));
    const defs = blobs.get(blob);
    if (!defs) continue;
    for (const [kind, name] of defs.names) names.set(kind, (names.get(kind) ?? new Set()).add(name));
    routes.push(...defs.routes);
  }
  return { names, routes };
}

/** Every route of `defs` filed by segment count and first segment, with prefix routes and a leading parameter kept apart. */
const routeIndex = new WeakMap<Defs, { exact: Map<string, Route[]>; loose: Route[] }>();
function indexOf(defs: Defs): { exact: Map<string, Route[]>; loose: Route[] } {
  let index = routeIndex.get(defs);
  if (index) return index;
  index = { exact: new Map(), loose: [] };
  for (const route of defs.routes) {
    if (route.prefix || route.segs[0] === "*") { index.loose.push(route); continue; }
    const key = `${route.segs.length}\x1f${route.segs[0]}`;
    index.exact.set(key, [...index.exact.get(key) ?? [], route]);
  }
  routeIndex.set(defs, index);
  return index;
}

/** Whether `defs` defines the data token: a route any of its routes serves, or a name of that kind. */
export function defines(defs: Defs, kind: DataKind, token: string): boolean {
  if (kind !== "route") return defs.names.get(kind)?.has(token) ?? false;
  const segs = routeSegs(token);
  if (!segs) return false;
  const index = indexOf(defs);
  const near = segs[0] === "*" ? defs.routes : [...index.exact.get(`${segs.length}\x1f${segs[0]}`) ?? [], ...index.loose];
  return near.some(route => routeServes(route, segs));
}

/** One Defs holding every name and route of `all`, each route once. */
export function unionDefs(all: Iterable<Defs>): Defs {
  const names = new Map<DataKind, Set<string>>(); const routes = new Map<string, Route>();
  for (const defs of all) {
    for (const [kind, set] of defs.names) names.set(kind, new Set([...names.get(kind) ?? [], ...set]));
    for (const route of defs.routes) routes.set(`${route.prefix}${route.segs.join("/")}`, route);
  }
  return { names, routes: [...routes.values()] };
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Whether a HEAD code line still uses a name as data: after a SQL word, quoted whole, or as a Convex table key. A docstring that tells a
 * move does not: apps/vent/tests/unit/test_ledger.py says "after usage.events moved" on 2026-11-26.
 */
export function usesAsData(line: string, kind: DataKind, token: string): boolean {
  if (kind === "route") {
    const segs = routeSegs(token);
    return !!segs && [...line.matchAll(/["'`](\/[^"'`\s]*)["'`]/g)].some(m => { const at = routeSegs(m[1]!); return !!at && routeServes({ segs: at, prefix: false }, segs); });
  }
  const name = escape(token);
  return new RegExp(`(?:\\b(?:from|join|into|table|exists|update|on|to|describe|optimize|truncate)\\s+["\`]?${name}(?![\\w.])|["'\`]${name}["'\`]|^\\s*${name}\\s*:\\s*(?:resource|defineTable))`, "i").test(line);
}

/**
 * The current name a diff between the last commit that defined `name` and the next sampled commit gives it: a rename it states, a route
 * file it moved, or else the HEAD name of the same kind that its hunks add most often where they take `name` away.
 */
export function currentFromDiff(diff: string, kind: DataKind, name: string, head: Defs): string | undefined {
  const counts = new Map<string, number>();
  const bump = (to: string, by = 1): void => { counts.set(to, (counts.get(to) ?? 0) + by); };
  const token = kind === "route" ? routeSegs(name) : null;
  const named = (line: string): boolean => kind === "route" ? usesAsData(line, kind, name) : new RegExp(`(?<![\\w.])${escape(name)}(?![\\w])`).test(line);
  for (const file of diff.split(/^diff --git /m).slice(1)) {
    const from = /^rename from (.+)$/m.exec(file)?.[1], to = /^rename to (.+)$/m.exec(file)?.[1];
    if (token && from && to && svelteRoutes(from).some(route => routeServes(route, token))) for (const route of svelteRoutes(to)) if (defines(head, "route", "/" + route.segs.join("/"))) bump("/" + route.segs.join("/"), 10);
    for (const hunk of file.split(/^@@[^\n]*$/m).slice(1)) {
      const lines = hunk.split("\n");
      if (!lines.some(line => line.startsWith("-") && named(line))) continue;
      for (const line of lines.filter(line => line.startsWith("+"))) {
        for (const re of [CH_RENAME, ...PG_RENAME]) for (const m of line.matchAll(re)) {
          const [old, next] = m.length > 4 ? [`${m[1]}.${m[2]}`, `${m[3]}.${m[4]}`] : [m[1]!, m[2]!];
          if (old === name && defines(head, kind, next)) bump(next, 10);
        }
        for (const [k, candidate] of spanTokens(line.slice(1))) if (k === kind && candidate !== name && defines(head, kind, candidate)) bump(candidate);
      }
    }
  }
  const best = [...counts].sort((a, b) => b[1] - a[1]);
  return best[0] && (best.length === 1 || best[0][1] > best[1]![1]) ? best[0][0] : undefined;
}

/** A ClickHouse table HEAD holds under one other database with the same table name: links.link_events moved to product.link_events. */
export function sameTableElsewhere(head: Defs, name: string): string | undefined {
  const table = name.split(".")[1];
  const found = [...head.names.get("clickhouse") ?? []].filter(other => other !== name && other.split(".")[1] === table);
  return found.length === 1 ? found[0] : undefined;
}

export const routeKey = (token: string): string => { const segs = routeSegs(token); return segs ? "/" + segs.join("/") : token; };
export const kindLabel: Record<DataKind, string> = { clickhouse: "ClickHouse table", postgres: "Postgres table", convex: "Convex table", route: "route" };
export const dataRoots = (headDirs: readonly string[]): string[] => [...DATA_ROOTS, ...headDirs.filter(dir => ROUTES_DIR.test(dir))].map(dir => posix.normalize(dir));
