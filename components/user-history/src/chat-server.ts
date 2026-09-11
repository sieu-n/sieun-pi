import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ChatBackend, ChatSession } from "./chat-backend.ts";
import { chatContentSecurityPolicy, renderChatPage } from "./chat-page.ts";
import { renderChatMessages } from "./page.ts";

const maxBodyBytes = 64 * 1024;
const maxMessageLength = 32000;
const maxSends = 256;

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function sessionItem(session: ChatSession) {
  return {
    id: session.sessionId, name: session.name, kind: session.kind === "root" ? "session" : "agent",
    status: session.status, writable: session.canSend,
    ...(session.parentSessionId ? { parentId: session.parentSessionId } : {}),
  };
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
    throw new RequestError(415, "Expected application/json.");
  }
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    request.resume();
    throw new RequestError(413, "Request is too large.");
  }
  const chunks = await new Promise<Buffer[]>((resolve, reject) => {
    let size = 0;
    const parts: Buffer[] = [];
    function cleanup() {
      request.off("data", data);
      request.off("end", end);
      request.off("error", failed);
      request.off("aborted", aborted);
    }
    function failed(error: Error) { cleanup(); reject(error); }
    function aborted() { failed(new RequestError(400, "Request was interrupted.")); }
    function data(bytes: Buffer) {
      size += bytes.length;
      if (size > maxBodyBytes) {
        cleanup();
        request.resume();
        reject(new RequestError(413, "Request is too large."));
      } else parts.push(bytes);
    }
    function end() { cleanup(); resolve(parts); }
    request.on("data", data);
    request.once("end", end);
    request.once("error", failed);
    request.once("aborted", aborted);
  });
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new RequestError(400, "Invalid JSON."); }
}

function parseMessage(value: unknown) {
  if (typeof value !== "object" || value === null ||
    !("sessionId" in value) || typeof value.sessionId !== "string" || !value.sessionId || value.sessionId.length > 256 ||
    !("message" in value) || typeof value.message !== "string" || !value.message.trim() || value.message.length > maxMessageLength ||
    !("requestId" in value) || typeof value.requestId !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/.test(value.requestId)) {
    throw new RequestError(400, "Expected a session, a non-empty message up to 32,000 characters, and a request ID.");
  }
  return { sessionId: value.sessionId, message: value.message, requestId: value.requestId };
}

export async function startChatServer({ backend, initialSessionId, idleMs = 30 * 60 * 1000 }: {
  backend: ChatBackend; initialSessionId: string; idleMs?: number;
}): Promise<{ url: string; close(): Promise<void> }> {
  const base = "/" + randomBytes(24).toString("hex") + "/";
  const csrfToken = randomBytes(32).toString("hex");
  const page = renderChatPage({ initialSessionId, csrfToken });
  const sends = new Map<string, { sessionId: string; message: string; result: Promise<void> }>();
  let host = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | undefined;

  const server = createServer((req, res) => { void handle(req, res); });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 30;
  server.on("clientError", (_error, socket) => { socket.destroy(); });

  function json(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
  }
  function touch() {
    clearTimeout(timer);
    timer = setTimeout(() => { void close(); }, idleMs);
    timer.unref();
  }
  function close(): Promise<void> {
    if (closing) return closing;
    clearTimeout(timer);
    closing = (async () => {
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      sends.clear();
      await backend.close();
    })();
    return closing;
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", chatContentSecurityPolicy);
    try {
      if (req.headers.host !== host) throw new RequestError(421, "Unexpected host.");
      if (req.headers["sec-fetch-site"] === "cross-site" ||
        (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`)) {
        throw new RequestError(403, "Cross-origin requests are blocked.");
      }
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (url.origin !== `http://${host}` || !url.pathname.startsWith(base)) throw new RequestError(404, "Not found.");
      const route = url.pathname.slice(base.length);
      if (closing) throw new RequestError(410, "Chat is closed. Run /agent-chat again.");
      if (req.method === "GET" && route === "") {
        touch();
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page);
        return;
      }
      if (req.method === "GET" && route === "api/sessions") {
        touch();
        json(res, 200, { sessions: (await backend.list()).map(sessionItem), initialSessionId });
        return;
      }
      if (req.method === "GET" && route === "api/session") {
        const id = url.searchParams.get("id");
        if (!id || id.length > 256) throw new RequestError(400, "A session ID is required.");
        touch();
        const view = await backend.read(id);
        json(res, 200, { ...sessionItem(view.session), html: renderChatMessages(view.messages), queueCount: view.queueCount });
        return;
      }
      if (route !== "api/message" && route !== "api/close") throw new RequestError(404, "Not found.");
      if (req.method !== "POST") throw new RequestError(405, "Expected POST.");
      if (req.headers["x-chat-token"] !== csrfToken || req.headers.origin !== `http://${host}`) {
        throw new RequestError(403, "Message authorization is missing. Reopen /agent-chat.");
      }
      const body = await jsonBody(req);
      touch();
      if (route === "api/close") {
        res.once("finish", () => { void close(); });
        json(res, 200, { closed: true });
        return;
      }
      const input = parseMessage(body);
      let pending = sends.get(input.requestId);
      if (pending && (pending.sessionId !== input.sessionId || pending.message !== input.message)) {
        throw new RequestError(409, "This request ID belongs to a different message.");
      }
      if (!pending) {
        if (sends.size >= maxSends) throw new RequestError(429, "Reopen /agent-chat before sending more messages.");
        pending = { ...input, result: backend.send({ sessionId: input.sessionId, message: input.message }) };
        sends.set(input.requestId, pending);
      }
      try { await pending.result; }
      catch (error) {
        throw new RequestError(502, "Message delivery was not confirmed. Check the conversation before sending again. " +
          (error instanceof Error ? error.message : "Prime Agent rejected the request."));
      }
      json(res, 200, { accepted: true });
    } catch (error) {
      if (!res.headersSent && !res.destroyed) json(res, error instanceof RequestError ? error.status : 502,
        { error: error instanceof Error ? error.message : "Prime Agent is unavailable." });
    }
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a loopback TCP address.");
    host = `127.0.0.1:${address.port}`;
    server.on("error", () => { void close(); });
    touch();
    return { url: `http://${host}${base}`, close };
  } catch (error) {
    await close();
    throw error;
  }
}
