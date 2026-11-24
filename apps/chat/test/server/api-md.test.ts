/**
 * API.md lists every route and live socket message the server has, and only those. A route is each `route(...)` in server/http.ts and in
 * each file whose route builder http.ts spreads into its table (`...accountRoutes(app, route)`, `routeFiles`), plus each handler outside that
 * table (OUTSIDE), and it is listed when an API.md table row's endpoint cell starts with
 * `METHOD /path`. A `/api/threads/:id/...` route whose `/api/agents/:id/...` twin exists is listed by either row. The live socket's events
 * and commands are the `type` names of `LiveEvent` and `LiveCommand` in web/src/lib/api/types.ts, listed by the first cell of a row in
 * API.md's "Live socket" tables.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (file: string): string => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");

const METHODS = "GET|POST|PUT|PATCH|DELETE";
const ROUTE_CALL = new RegExp(`\\broute\\(\\s*"(${METHODS})",\\s*[\`"]([^\`"]+)[\`"]`, "g");
const SCOPES = ["agents", "threads"];

/** The handlers outside the route table, each with a line its file must hold so a removed handler drops out of this list too. */
const OUTSIDE: Array<[route: string, file: string, marker: string]> = [
  ["POST /api/timings", "server/http.ts", 'path === "/api/timings" && method === "POST"'],
  ["GET /api/local-image", "server/http.ts", 'path === "/api/local-image" && req.method === "GET"'],
  ["GET /api/images/<thread>/<entry>/<index>", "server/http.ts", 'path.startsWith("/api/images/")'],
  ["GET /api/uploads/<file>", "server/http.ts", 'path.startsWith("/api/uploads/")'],
  ["GET /api/c/:id/workspace", "server/wiki/workspaces.ts", 'req.method === "GET" && !verb'],
  ["POST /api/c/:id/workspace", "server/wiki/workspaces.ts", "WORKSPACE_ROUTE = /^\\/api\\/c\\/([^/]+)\\/workspace(?:\\/(events|close))?$/"],
  ["POST /api/c/:id/workspace/events", "server/wiki/workspaces.ts", "(events|close)"],
  ["POST /api/c/:id/workspace/close", "server/wiki/workspaces.ts", "(events|close)"],
  ["GET /wiki/<path>", "server/wiki/routes.ts", 'req.method === "GET" || req.method === "HEAD"'],
  ["PUT /wiki/<path>", "server/wiki/routes.ts", 'req.method === "PUT" || req.method === "POST"'],
  ["POST /wiki/<path>", "server/wiki/routes.ts", 'method === "POST" && await engine.exists(path)'],
  ["PATCH /wiki/<path>", "server/wiki/routes.ts", 'req.method === "PATCH"'],
];

/**
 * server/http.ts and the file of each route builder it spreads into its route table with its own `route`, read from its imports, so a new
 * builder file is read with no change here. The /api/db routes of server/chat-db-routes.ts (dabb9658) are mounted this way.
 */
function routeFiles(http: string): string[] {
  const builders = [...http.matchAll(/^\s*\.\.\.(\w+)\([^\n]*\broute\),$/gm)].map(m => m[1]!);
  assert.ok(builders.length > 0, "http.ts spreads route builders into its route table");
  return ["server/http.ts", ...builders.map(name => {
    const from = new RegExp(`^import \\{[^}]*\\b${name}\\b[^}]*\\} from "\\./([\\w/-]+\\.ts)";$`, "m").exec(http);
    assert.ok(from, `http.ts imports the route builder ${name} from a server file`);
    const file = `server/${from[1]}`;
    assert.ok(read(file).includes(`export function ${name}`), `${file} defines ${name}`);
    return file;
  })];
}

/** Every `METHOD /path` in the route tables, with the board routes built per scope written out for both scopes. */
function codeRoutes(): Set<string> {
  const http = read("server/http.ts");
  assert.ok(http.includes('(["agents", "threads"] as const).flatMap(scope =>'), "http.ts builds its board routes from the scopes agents and threads");
  const routes = new Set<string>();
  for (const file of routeFiles(http)) {
    const text = read(file);
    const calls = [...text.matchAll(/\broute\(/g)].filter(m => !text.slice(Math.max(0, m.index - 9), m.index).endsWith("function "));
    const found = [...text.matchAll(ROUTE_CALL)];
    assert.equal(found.length, calls.length, `${file}: every route() call names its method and path as literals, so this test can read it`);
    for (const [, method, path] of found) {
      for (const p of path!.includes("${scope}") ? SCOPES.map(s => path!.replace("${scope}", s)) : [path!]) routes.add(`${method} ${p}`);
    }
  }
  for (const [route, file, marker] of OUTSIDE) {
    assert.ok(read(file).includes(marker), `${route}: ${file} no longer holds ${JSON.stringify(marker)}; update OUTSIDE`);
    routes.add(route);
  }
  return routes;
}

/** Each table row's endpoint: the first cell that starts with a code span of `METHOD /path`, cut at a space, `?` or `{`. */
function listedRoutes(md: string): Set<string> {
  const listed = new Set<string>();
  const cell = new RegExp(`^\`(${METHODS}) (/[^\\s\`?{]+)`);
  for (const line of md.split("\n")) {
    if (!line.startsWith("|")) continue;
    for (const part of line.slice(1).split(" | ")) {
      const match = cell.exec(part.trim());
      if (match) {
        listed.add(`${match[1]} ${match[2]}`);
        break;
      }
    }
  }
  return listed;
}

const twinOf = (route: string): string | undefined =>
  route.includes(" /api/threads/:id/") ? route.replace(" /api/threads/:id/", " /api/agents/:id/") : undefined;

/** The `type` names of an exported union type, read from its declaration up to the next export. */
function unionTypes(text: string, name: string): Set<string> {
  const start = text.indexOf(`export type ${name} =`);
  assert.ok(start >= 0, `types.ts declares ${name}`);
  const end = text.indexOf("\nexport ", start + 1);
  return new Set([...text.slice(start, end === -1 ? undefined : end).matchAll(/type: "([\w-]+)"/g)].map(m => m[1]!));
}

/** The first cells of the rows of the tables under `## Live socket` whose header's first cell is `heading`. */
function liveRows(md: string, heading: string): Set<string> {
  const start = md.indexOf("\n## Live socket\n");
  assert.ok(start >= 0, "API.md has a Live socket section");
  const end = md.indexOf("\n## ", start + 1);
  const rows = new Set<string>();
  let inTable = false;
  for (const line of md.slice(start, end === -1 ? undefined : end).split("\n")) {
    if (!line.startsWith("|")) {
      inTable = false;
      continue;
    }
    const first = line.slice(1).split("|")[0]!.trim();
    if (first === heading) inTable = true;
    else if (inTable && !first.startsWith("---")) rows.add(first.replace(/^`|`$/g, ""));
  }
  return rows;
}

/** The routes in `routes` that have no row in `md`, by their own row or their `/api/agents/:id/...` twin's. */
function missingRows(routes: Set<string>, md: string): string[] {
  const listed = listedRoutes(md);
  return [...routes].filter(r => !listed.has(r) && !(twinOf(r) && routes.has(twinOf(r)!) && listed.has(twinOf(r)!))).sort();
}

test("API.md has a row for every route the server has", () => {
  assert.deepEqual(missingRows(codeRoutes(), read("API.md")), [], "routes with no row in API.md");
});

test("a route a builder file mounts fails the check when its row is gone (server/chat-db-routes.ts, 11-24)", () => {
  assert.ok(routeFiles(read("server/http.ts")).includes("server/chat-db-routes.ts"), "the /api/db routes are read from the file http.ts mounts them from");
  const md = read("API.md").split("\n").filter(line => !/^\| [^|]* \| `(GET|POST) \/api\/db[/`]/.test(line)).join("\n");
  assert.deepEqual(missingRows(codeRoutes(), md), ["GET /api/db", "GET /api/db/:kind/check", "POST /api/db/:kind/apply"]);
});

test("every route API.md lists is one the server has", () => {
  const routes = codeRoutes();
  const extra = [...listedRoutes(read("API.md"))].filter(r => !routes.has(r));
  assert.deepEqual(extra.sort(), [], "API.md rows that name no route in the code");
});

test("API.md lists every live event and command the server and page exchange, and only those", () => {
  const md = read("API.md");
  const types = read("web/src/lib/api/types.ts");
  const review = read("web/src/lib/api/shared/skills-review.ts");
  const events = unionTypes(types, "LiveEvent");
  for (const m of review.matchAll(/export type ReviewEvent = \{ type: "([\w-]+)"/g)) events.add(m[1]!);
  assert.deepEqual([...liveRows(md, "Event")].sort(), [...events].sort(), "live events in API.md and LiveEvent");
  assert.deepEqual([...liveRows(md, "Command")].sort(), [...unionTypes(types, "LiveCommand")].sort(), "live commands in API.md and LiveCommand");
});
