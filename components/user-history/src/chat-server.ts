import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ChatBackend, ChatSession, SendMode, ChatWindow } from "./chat-backend.ts";
import { chatContentSecurityPolicy, renderChatPage } from "./chat-page.ts";
import { renderChatMessages } from "./page.ts";
import { parseChatImages } from "./chat-images.ts";

const maxBodyBytes = 12 * 1024 * 1024;
const maxMessageLength = 32000;

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function sessionItem(session: ChatSession) {
  return {
    id: session.sessionId, name: session.name, status: session.status, writable: session.canSend,
    created: session.created, lastActivityAt: session.lastActivityAt, model: session.model,
    lifecycle: session.lifecycle, nativeStatus: session.nativeStatus, lastAssistant: session.lastAssistant, unread: session.unread, readError: session.readError,
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

function parseMessage(value: unknown): { sessionId: string; message: string; images: ReturnType<typeof parseChatImages>; mode: SendMode; requestId: string } {
  if (typeof value !== "object" || value === null ||
    !("sessionId" in value) || typeof value.sessionId !== "string" || !value.sessionId || value.sessionId.length > 256 ||
    !("message" in value) || typeof value.message !== "string" || value.message.length > maxMessageLength ||
    !("requestId" in value) || typeof value.requestId !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/.test(value.requestId)) {
    throw new RequestError(400, "Expected a session, message text up to 32,000 characters, and a request ID.");
  }
  let images;
  try { images = parseChatImages("images" in value ? value.images : undefined); }
  catch (error) { throw new RequestError(400, error instanceof Error ? error.message : "Invalid images."); }
  if (!value.message.trim() && !images.length) throw new RequestError(400, "Add a message or image.");
  const mode = "mode" in value ? value.mode : "followUp";
  if (mode !== "steer" && mode !== "followUp") throw new RequestError(400, "Choose Send now or Queue.");
  return { sessionId: value.sessionId, message: value.message, images, mode, requestId: value.requestId };
}

export async function startChatServer({ backend, port, capability, csrfToken, identity, stopToken, onStop, identityReady = Promise.resolve() }: {
  backend: ChatBackend; port: number; capability: string; csrfToken: string;
  identity: { pid: number; instanceId: string; socketPath: string }; stopToken: string;
  onStop(): Promise<void>; identityReady?: Promise<void>;
}): Promise<{ url: string; close(): Promise<void> }> {
  const base = "/" + capability + "/";
  const page = renderChatPage({ csrfToken });
  const sends = new Map<string, { fingerprint: string; result: Promise<void> }>();
  const creations = new Map<string, { sourceSessionId: string | undefined; result: Promise<ChatSession> }>();
  let host = "";
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
  function close(): Promise<void> {
    if (closing) return closing;
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
      if (closing) throw new RequestError(410, "Chat service is stopping. Run sieun-pi chat start again.");
      if (req.method === "GET" && route === "api/identity") {
        await identityReady;
        json(res, 200, { service: "sieun-pi-chat", ...identity });
        return;
      }
      if (route === "api/service-stop") {
        if (req.method !== "POST") throw new RequestError(405, "Expected POST.");
        if (req.headers["x-chat-stop-token"] !== stopToken || req.headers.origin !== `http://${host}`) {
          throw new RequestError(403, "Service authorization is missing.");
        }
        const body = await jsonBody(req);
        if (typeof body !== "object" || body === null || !("instanceId" in body) || body.instanceId !== identity.instanceId) {
          throw new RequestError(409, "The service instance changed. Check chat status before stopping.");
        }
        res.once("finish", () => { void onStop(); });
        json(res, 200, { stopped: true });
        return;
      }
      if (req.method === "GET" && route === "") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page);
        return;
      }
      if (req.method === "GET" && route === "api/sessions") {
        json(res, 200, { sessions: (await backend.list()).map(sessionItem) });
        return;
      }
      if (req.method === "GET" && route === "api/target") {
        const id = url.searchParams.get("id");
        if (!id || id.length > 256) throw new RequestError(400, "A session ID is required.");
        json(res, 200, sessionItem(await backend.target(id))); return;
      }
      if (req.method === "GET" && route === "api/session") {
        const id = url.searchParams.get("id");
        if (!id || id.length > 256) throw new RequestError(400, "A session ID is required.");
        const mode = url.searchParams.get("view") ?? "compact";
        const turns = Number(url.searchParams.get("turns") ?? 1);
        const expanded = url.searchParams.getAll("expanded");
        if ((mode !== "compact" && mode !== "detailed" && mode !== "questions") || !Number.isSafeInteger(turns) || turns < 1 || turns > 10000 || expanded.length > 100 || expanded.some(id => id.length > 256)) throw new RequestError(400, "Invalid conversation window.");
        const startId = url.searchParams.get("startId");
        const older = Number(url.searchParams.get("older") ?? 0);
        if (startId && startId.length > 256 || !Number.isSafeInteger(older) || older < 0 || older > 100) throw new RequestError(400, "Invalid history cursor.");
        const window: ChatWindow = { mode, turns, expanded, ...(startId ? { startId } : {}), older };
        const view = await backend.read(id, window);
        const html = renderChatMessages(view.messages);
        const revision = createHash("sha256").update(html).digest("hex");
        json(res, 200, { ...sessionItem(view.session), history: view.history, revision, html: url.searchParams.get("since") === revision ? null : html, queueCount: view.queueCount, queue: view.queue, work: view.work, children: view.children, controls: view.controls, usage: view.usage });
        return;
      }
      if (req.method === "GET" && route === "api/tool") {
        const id = url.searchParams.get("id"); const toolId = url.searchParams.get("toolId");
        if (!id || id.length > 256 || !toolId || toolId.length > 512) throw new RequestError(400, "Choose a native tool call.");
        const view = await backend.read(id);
        const tool = view.messages.flatMap(message => message.tools ?? []).find(tool => tool.id === toolId);
        if (!tool) throw new RequestError(404, "This tool call is not on the selected native branch.");
        json(res, 200, { sessionId: id, tool }); return;
      }
      if (req.method === "GET" && ["api/models", "api/commands", "api/accounts"].includes(route)) {
        const id = url.searchParams.get("id");
        if (!id || id.length > 256) throw new RequestError(400, "A session ID is required.");
        json(res, 200, await (route === "api/models" ? backend.models(id) : route === "api/commands" ? backend.commands(id) : backend.accounts(id)));
        return;
      }
      if (!["api/create", "api/message", "api/model", "api/rename", "api/effort", "api/account", "api/stop", "api/compact", "api/queue", "api/read"].includes(route)) throw new RequestError(404, "Not found.");
      if (req.method !== "POST") throw new RequestError(405, "Expected POST.");
      if (req.headers["x-chat-token"] !== csrfToken || req.headers.origin !== `http://${host}`) {
        throw new RequestError(403, "Message authorization is missing. Reopen /what-did-i-say.");
      }
      const body = await jsonBody(req);
      if (route === "api/create") {
        if (typeof body !== "object" || body === null || !("requestId" in body) || typeof body.requestId !== "string" ||
          !/^[a-zA-Z0-9_-]{16,100}$/.test(body.requestId) || ("sourceSessionId" in body &&
          (typeof body.sourceSessionId !== "string" || !body.sourceSessionId || body.sourceSessionId.length > 256))) {
          throw new RequestError(400, "Expected a creation request ID and optional source session.");
        }
        const sourceSessionId = "sourceSessionId" in body && typeof body.sourceSessionId === "string" ? body.sourceSessionId : undefined;
        let creation = creations.get(body.requestId);
        if (creation && creation.sourceSessionId !== sourceSessionId) throw new RequestError(409, "This request ID belongs to another creation.");
        if (!creation) {
          creation = { sourceSessionId, result: backend.create({ sourceSessionId }) };
          creations.set(body.requestId, creation);
        }
        json(res, 200, { session: sessionItem(await creation.result) }); return;
      }
      if (["api/rename", "api/effort", "api/account", "api/stop", "api/compact", "api/queue", "api/read"].includes(route)) {
        if (typeof body !== "object" || body === null || !("sessionId" in body) || typeof body.sessionId !== "string" || !body.sessionId || body.sessionId.length > 256) throw new RequestError(400, "Choose a session.");
        const sessionId = body.sessionId;
        if (route === "api/rename") {
          if (!("name" in body) || typeof body.name !== "string" || !body.name.trim() || body.name.length > 200) throw new RequestError(400, "Use a name of 1 to 200 characters.");
          await backend.rename({ sessionId, name: body.name });
        } else if (route === "api/effort") {
          if (!("level" in body) || typeof body.level !== "string" || body.level.length > 32) throw new RequestError(400, "Choose an effort level.");
          await backend.setEffort({ sessionId, level: body.level });
        } else if (route === "api/account") {
          if (!("provider" in body) || typeof body.provider !== "string" || body.provider.length > 128 || !("target" in body) || typeof body.target !== "string" || body.target.length > 256 || !("force" in body) || typeof body.force !== "boolean") throw new RequestError(400, "Choose a pool account.");
          json(res, 200, await backend.setAccount({ sessionId, provider: body.provider, target: body.target, force: body.force })); return;
        } else if (route === "api/read") {
          if (!("entryId" in body) || typeof body.entryId !== "string" || body.entryId.length > 256) throw new RequestError(400, "Choose an assistant entry.");
          await backend.markRead({ sessionId, entryId: body.entryId });
        } else if (route === "api/queue") {
          if (!("lane" in body) || (body.lane !== "steering" && body.lane !== "followUp") || !("index" in body) || typeof body.index !== "number" || !Number.isSafeInteger(body.index) || body.index < 0 || !("expectedText" in body) || typeof body.expectedText !== "string" || body.expectedText.length > maxMessageLength || ("text" in body && (typeof body.text !== "string" || !body.text.trim() || body.text.length > maxMessageLength))) throw new RequestError(400, "Choose a queued message and its current text.");
          const status = await backend.mutateQueue({ sessionId, lane: body.lane, index: body.index, expectedText: body.expectedText, ...("text" in body && typeof body.text === "string" ? { text: body.text } : {}) });
          json(res, status === "applied" ? 200 : 409, { status, ...(status !== "applied" ? { error: "The native queue changed. Refresh before editing." } : {}) }); return;
        } else if (route === "api/stop") await backend.stop(sessionId);
        else await backend.compact(sessionId);
        json(res, 200, { accepted: true }); return;
      }
      if (route === "api/model") {
        if (typeof body !== "object" || body === null ||
          !("sessionId" in body) || typeof body.sessionId !== "string" || !body.sessionId || body.sessionId.length > 256 ||
          !("provider" in body) || typeof body.provider !== "string" || !body.provider || body.provider.length > 256 ||
          !("modelId" in body) || typeof body.modelId !== "string" || !body.modelId || body.modelId.length > 512) {
          throw new RequestError(400, "Choose a session and model.");
        }
        json(res, 200, { model: await backend.setModel({ sessionId: body.sessionId, provider: body.provider, modelId: body.modelId }) });
        return;
      }
      const input = parseMessage(body);
      const fingerprint = createHash("sha256").update(JSON.stringify([input.sessionId, input.message, input.images, input.mode])).digest("hex");
      let pending = sends.get(input.requestId);
      if (pending && pending.fingerprint !== fingerprint) {
        throw new RequestError(409, "This request ID belongs to a different message.");
      }
      if (!pending) {
        pending = { fingerprint, result: backend.send({ sessionId: input.sessionId, message: input.message, images: input.images, mode: input.mode }) };
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
      server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a loopback TCP address.");
    host = `127.0.0.1:${address.port}`;
    server.on("error", () => { void close(); });
    return { url: `http://${host}${base}`, close };
  } catch (error) {
    await close();
    throw error;
  }
}
