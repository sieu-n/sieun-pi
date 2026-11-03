/**
 * The wiki engine behind `/wiki`: a pass-through proxy for its own routes and a JSON client for its agent API. Every write goes through the
 * engine's `/api/agent/*`, so its gates run, and its status and error JSON reach the caller unchanged.
 */
import { request } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WikiEngineConfig } from "../config.ts";

/** What the engine answered: its status and its JSON body, or its text when the body is not JSON. */
export interface EngineAnswer { status: number; body: unknown }

const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer", "host"]);

export class WikiEngine {
  constructor(readonly config: WikiEngineConfig) {}

  /** The engine URL of an engine path such as `/page/apps/x.html` or `/api/agent/page`, under the engine's base. */
  url(path: string): string {
    return `${this.config.origin}${this.config.base}${path}`;
  }

  /** Whether a `/wiki/<rest>` path names content (a page or a file) rather than one of the engine's own routes. */
  isContent(rest: string): boolean {
    const first = rest.split("/")[0] ?? "";
    return this.config.spaces.includes(first);
  }

  async call(method: string, path: string, body?: unknown): Promise<EngineAnswer> {
    const response = await fetch(this.url(path), {
      method,
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    try {
      return { status: response.status, body: JSON.parse(text) };
    } catch {
      return { status: response.status, body: text };
    }
  }

  /** Whether the content file exists, by a HEAD of its raw route, which records no page view. */
  async exists(path: string): Promise<boolean> {
    const response = await fetch(this.url(`/raw/${encodePath(path)}`), { method: "HEAD" });
    return response.ok;
  }

  /**
   * Streams the request to the engine path and the answer back. While the engine serves at its root (base ""), the links in an HTML answer
   * are root paths, so they get the `/wiki` prefix that routes them back here.
   */
  proxy(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const rewrite = this.config.base === "";
    const target = new URL(this.url(path));
    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(req.headers)) if (value !== undefined && !HOP.has(key)) headers[key] = value;
    if (rewrite) headers["accept-encoding"] = "identity";
    return new Promise((resolve, reject) => {
      const upstream = request(target, { method: req.method, headers }, answer => {
        const out: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(answer.headers)) if (value !== undefined && !HOP.has(key)) out[key] = value;
        const html = rewrite && String(answer.headers["content-type"] ?? "").startsWith("text/html");
        if (!html) {
          res.writeHead(answer.statusCode ?? 502, out);
          answer.pipe(res);
          answer.on("end", resolve);
          answer.on("error", reject);
          return;
        }
        const chunks: Buffer[] = [];
        answer.on("data", (chunk: Buffer) => chunks.push(chunk));
        answer.on("error", reject);
        answer.on("end", () => {
          const body = Buffer.from(rootLinksUnderWiki(Buffer.concat(chunks).toString("utf8")));
          delete out["content-length"];
          res.writeHead(answer.statusCode ?? 502, { ...out, "content-length": String(body.length) });
          res.end(body);
          resolve();
        });
      });
      upstream.on("error", reject);
      req.pipe(upstream);
    });
  }
}

/** Root-relative `href`, `src` and `action` values (`/page/...`, `/raw/...`) moved under `/wiki`; a `//host` URL stays. */
export function rootLinksUnderWiki(html: string): string {
  return html.replace(/\b(href|src|action)=(["'])\/(?!\/|wiki\/)/g, "$1=$2/wiki/");
}

/** A content path as a URL path: each segment encoded, the slashes kept. */
export const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");
