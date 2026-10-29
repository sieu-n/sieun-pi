/**
 * The local chat proxy: an HTTP server on 127.0.0.1 that threads on this box use to reach the chat server's HTTP API. Each request goes up the
 * newest live `/v2/agents` link as a `chat_http` call, and the server's `result` becomes the answer. With no live link it answers 503.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AgentLink } from "./link.ts";
import type { ChatHttpResult } from "./protocol.ts";

/** Headers that describe one hop, which the proxy sets itself on each side. */
const HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade"]);

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.once("end", () => resolve(body));
    request.once("error", reject);
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

export function createChatProxy(liveLink: () => AgentLink | undefined, log: (line: string) => void): Server {
  return createServer(async (request, response) => {
    try {
      const body = await readBody(request);
      const link = liveLink();
      if (!link) return json(response, 503, { error: "the relay has no live link to the chat server" });
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) if (value !== undefined && !HOP.has(name)) headers[name] = Array.isArray(value) ? value.join(", ") : value;
      const answer = await link.callUp({ method: request.method ?? "GET", path: request.url ?? "/", headers, ...(body ? { body } : {}) });
      if (!answer.ok) return json(response, answer.unsent ? 503 : 502, { error: answer.error });
      const result = answer.data as ChatHttpResult;
      const out: Record<string, string> = {};
      for (const [name, value] of Object.entries(result.headers ?? {})) if (!HOP.has(name.toLowerCase())) out[name] = value;
      response.writeHead(result.status, out);
      response.end(result.body ?? "");
    } catch (error) {
      log(`chat proxy: ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) json(response, 500, { error: error instanceof Error ? error.message : String(error) });
      else response.destroy();
    }
  });
}
