import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { openRuntime } from "@sieun-pi/pi-testkit/faux";

/** One request the fake Anthropic server saw. */
export interface SeenRequest {
  at: number;
  authorization: string | undefined;
  apiKey: string | undefined;
  beta: string | undefined;
  status: number;
  /** The request's system text, every block joined. */
  system: string;
}

/** What the fake server answers: a status with a JSON error body, or 200 with a short SSE stream of `text`. */
export type Answer = { status: 200; text: string } | { status: number; body: unknown; headers?: Record<string, string> };

/**
 * A local stand-in for api.anthropic.com/v1/messages. The real anthropic-messages provider talks to it through a
 * baseUrl override, so the SDK, its timeouts and Pi's retry all run as they do against Anthropic.
 */
export async function fakeAnthropic(answers: Answer[]): Promise<{ url: string; seen: SeenRequest[]; server: Server; close(): Promise<void> }> {
  const seen: SeenRequest[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      let system = "";
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { system?: string | { text?: string }[] };
        system = typeof body.system === "string" ? body.system : (body.system ?? []).map(block => block.text ?? "").join("\n");
      } catch {
        // A body that is not JSON leaves the system text empty.
      }
      const answer: Answer = answers.shift() ?? { status: 200, text: "ok" };
      seen.push({
        at: Date.now(),
        authorization: req.headers.authorization,
        apiKey: req.headers["x-api-key"] as string | undefined,
        beta: req.headers["anthropic-beta"] as string | undefined,
        status: answer.status,
        system,
      });
      if (answer.status !== 200 || !("text" in answer)) {
        const failed = answer as { status: number; body: unknown; headers?: Record<string, string> };
        res.writeHead(failed.status, { "content-type": "application/json", ...(failed.headers ?? {}) });
        res.end(JSON.stringify(failed.body));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("message_start", { type: "message_start", message: { id: `msg_${seen.length}`, type: "message", role: "assistant", model: "claude-fake", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } });
      send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer.text } });
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
      send("message_stop", { type: "message_stop" });
      res.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, server, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

/** A rate-limit answer shaped like Anthropic's. */
export function rateLimited(retryAfterSec?: number): Answer {
  return {
    status: 429,
    body: { type: "error", error: { type: "rate_limit_error", message: "This request would exceed your account's rate limit. Please try again later." } },
    headers: retryAfterSec === undefined ? { "x-should-retry": "false" } : { "retry-after": String(retryAfterSec), "x-should-retry": "false" },
  };
}

/** Points the built-in anthropic provider at `url` with an OAuth-shaped placeholder key, so the pool's header decides the account. */
export function anthropicAt(url: string): ExtensionFactory {
  return pi => pi.registerProvider("anthropic", { baseUrl: url, apiKey: "sk-ant-oat01-placeholder" });
}

/** Opens a runtime in `root` on a built-in Anthropic model that talks to `url`. */
export async function openAnthropic(root: string, url: string, extensions: ExtensionFactory[], model = "claude-sonnet-4-5") {
  const rt = await openRuntime({ root, extensionFactories: [anthropicAt(url), ...extensions] });
  const m = rt.services.modelRuntime.getModel("anthropic", model);
  if (!m) throw new Error(`no anthropic model ${model}`);
  await rt.session.setModel(m);
  return rt;
}
