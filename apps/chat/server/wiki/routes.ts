/**
 * The `/wiki` surface of this server (contract item 6, ~/work/wiki-to-sieun-pi/contract.md):
 *   GET    /wiki/<path>                the rendered page, from the engine's page view
 *   GET    /wiki/<path>?format=md      markdown made with Turndown from the stored HTML (also `Accept: text/markdown`); `section`, `lines` pass on
 *   GET    /wiki/<path>?format=html    the stored HTML (`format=raw` answers it as text/plain)
 *   PUT    /wiki/<path>                create or replace: an HTML body, a markdown body (`text/markdown` or `?format=md`) or JSON {content, ...}
 *   POST   /wiki/<path>                create, 409 when the page exists
 *   PATCH  /wiki/<path>                JSON {edits, summary?, baseVersion?}, the engine's edits
 *   any    /wiki/<engine route>        passes through to the engine (UI, assets, raw files, the agent API)
 * and the job workspace routes, `/api/c/:id/workspace[/events|/close]` (workspaces.ts).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { App } from "../app.ts";
import { WikiEngine, encodePath } from "./engine.ts";
import { callerOf } from "./identity.ts";
import { fromMarkdown, splitPage, toMarkdown } from "./markdown.ts";
import { answer, readJsonBody, readText, send, WikiBodyError } from "./reply.ts";
import { serveWorkspace, WORKSPACE_ROUTE } from "./workspaces.ts";

/** Files the page view renders; any other file in a content space is served as its bytes. */
const PAGE_FILE = /\.(html?|mdx?|txt|ya?ml|json)$/i;

/** Handles `/wiki` and `/wiki/*` and the workspace routes; false for every other path. */
export async function serveWiki(app: App, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  const engine = new WikiEngine(app.config.wikiEngine);
  try {
    if (WORKSPACE_ROUTE.test(path)) {
      await serveWorkspace(app, engine, req, res, path);
      return true;
    }
    if (path !== "/wiki" && !path.startsWith("/wiki/")) return false;
    const rest = decodeURIComponent(path.slice("/wiki/".length));
    if (!engine.isContent(rest)) {
      await engine.proxy(req, res, `${path.slice("/wiki".length) || "/"}${url.search}`);
      return true;
    }
    if (req.method === "GET" || req.method === "HEAD") await read(engine, req, res, rest, url.searchParams);
    else if (req.method === "PUT" || req.method === "POST") await write(app, engine, req, res, rest, url.searchParams, req.method);
    else if (req.method === "PATCH") await patch(app, engine, req, res, rest, url.searchParams);
    else send(res, 405, { error: `${req.method} /wiki/<path> is not a verb here; use GET, PUT, POST or PATCH.` });
  } catch (error) {
    if (res.headersSent) {
      res.end();
      return true;
    }
    if (error instanceof WikiBodyError) send(res, 400, { error: error.message });
    else send(res, 502, { error: `The wiki engine at ${engine.config.origin} did not answer: ${error instanceof Error ? error.message : String(error)}` });
  }
  return true;
}

function wantsFormat(req: IncomingMessage, query: URLSearchParams): "page" | "md" | "html" | "raw" {
  const format = query.get("format");
  if (format === "md" || format === "markdown") return "md";
  if (format === "html" || format === "raw") return format;
  return /\btext\/markdown\b/.test(String(req.headers.accept ?? "")) ? "md" : "page";
}

async function read(engine: WikiEngine, req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<void> {
  const format = wantsFormat(req, query);
  if (format === "page") {
    const view = PAGE_FILE.test(path) || !/\.[^/]+$/.test(path) ? "page" : "raw";
    const search = new URLSearchParams(query);
    search.delete("format");
    await engine.proxy(req, res, `/${view}/${encodePath(path)}${search.size ? `?${search}` : ""}`);
    return;
  }
  if (format === "html" || format === "raw") {
    const response = await fetch(engine.url(`/raw/${encodePath(path)}`));
    if (!response.ok) return send(res, response.status, { error: `No page ${path}.` });
    const type = format === "html" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(await response.text());
    return;
  }
  const search = new URLSearchParams({ path });
  for (const key of ["section", "lines"]) if (query.get(key)) search.set(key, query.get(key)!);
  const got = await engine.call("GET", `/api/agent/page?${search}`);
  if (got.status !== 200 || !got.body || typeof got.body !== "object") return answer(res, got);
  const page = got.body as Record<string, unknown> & { content: string; version: number };
  const extra: Record<string, unknown> = { path, version: page.version, ...(query.get("section") ? { section: query.get("section") } : {}) };
  if (!splitPage(page.content).meta) for (const key of ["title", "description", "kind", "status", "updated"]) extra[key] = page[key];
  const markdown = /\.html?$/i.test(path) ? toMarkdown(page.content, extra) : toMarkdown("", extra).trimEnd() + "\n\n" + page.content;
  res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" });
  res.end(markdown);
}

const num = (value: unknown): number | undefined => (value === undefined || value === null || value === "" ? undefined : Number(value));

async function write(app: App, engine: WikiEngine, req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams, method: "PUT" | "POST"): Promise<void> {
  const text = await readText(req);
  const type = String(req.headers["content-type"] ?? "");
  const json = type.startsWith("application/json") ? readJsonBody(text) : {};
  let content = type.startsWith("application/json") ? json.content : text;
  if (typeof content !== "string") throw new WikiBodyError("A page write sends the page as the body, or JSON with content, a string.");
  let baseVersion = num(json.baseVersion ?? query.get("baseVersion"));
  const markdown = query.get("format") === "md" || json.format === "md" || type.startsWith("text/markdown");
  if (markdown && /\.html?$/i.test(path)) {
    const converted = fromMarkdown(content);
    content = converted.content;
    baseVersion ??= converted.baseVersion;
  }
  const caller = await callerOf(app, req);
  if (method === "POST" && await engine.exists(path)) {
    return send(res, 409, { error: `${path} exists; PUT replaces it, PATCH edits it.`, path });
  }
  const allowTruncate = json.allowTruncate ?? (query.get("allowTruncate") === "true" ? true : undefined);
  const got = await engine.call("POST", "/api/agent/page", {
    path, content, author: caller.author,
    ...(typeof (json.summary ?? query.get("summary")) === "string" ? { summary: json.summary ?? query.get("summary") } : {}),
    ...(baseVersion === undefined ? {} : { baseVersion }),
    ...(allowTruncate === undefined ? {} : { allowTruncate }),
  });
  answer(res, got, caller);
}

async function patch(app: App, engine: WikiEngine, req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<void> {
  const body = readJsonBody(await readText(req));
  if (!Array.isArray(body.edits)) throw new WikiBodyError("A PATCH sends JSON {edits: [{old_string, new_string, replace_all?}], summary?, baseVersion?}.");
  const caller = await callerOf(app, req);
  const baseVersion = num(body.baseVersion ?? query.get("baseVersion"));
  const got = await engine.call("PATCH", "/api/agent/page", {
    path, edits: body.edits, author: caller.author,
    ...(typeof body.summary === "string" ? { summary: body.summary } : {}),
    ...(baseVersion === undefined ? {} : { baseVersion }),
  });
  answer(res, got, caller);
}
