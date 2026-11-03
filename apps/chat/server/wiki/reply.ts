/** Body reading and answers shared by the `/wiki` routes and the workspace routes. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EngineAnswer } from "./engine.ts";
import type { Caller } from "./identity.ts";

const MAX_BODY = 40 * 1024 * 1024;
export class WikiBodyError extends Error {}

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const type = typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8";
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...headers });
  res.end(text);
}

export async function readText(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new WikiBodyError("The request body is over 40 MB.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function readJsonBody(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* answered below */ }
  throw new WikiBodyError("The request body is not a JSON object.");
}

/** The engine's answer, its status kept; a successful write's JSON also names the author it was stamped with. */
export function answer(res: ServerResponse, got: EngineAnswer, caller?: Caller): void {
  const ok = got.status >= 200 && got.status < 300;
  const stamped = ok && caller && got.body && typeof got.body === "object"
    ? { ...(got.body as Record<string, unknown>), author: caller.author, ...(caller.known ? {} : { warning: caller.warning }) }
    : got.body;
  send(res, got.status, stamped, caller ? { "x-wiki-author": encodeURIComponent(caller.author) } : {});
}

