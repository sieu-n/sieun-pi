/**
 * A turn whose model answers with nothing stores an assistant message with no content, and pi-ai's Anthropic conversion sends the system
 * update held back before it and then skips it, so the update lands right before the next input. On 11-23 comm thread 64bc3ad1 failed every
 * turn after its entries 42 (`pi.system`), 43 (an empty reply) and 44 (an agent message) with Anthropic's 400 "role 'system' must precede an
 * 'assistant' message or end the array". `withCacheShape` leaves empty replies out (`withoutEmptyReplies`).
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Message, Provider } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { COLD_MS, foldSystem, withCacheShape, withoutEmptyReplies } from "../../src/durable/cache-shape.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const reply = (content: unknown[], timestamp: number, stopReason = "stop"): Message =>
  ({ role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "claude-fable-5", usage, stopReason, timestamp } as Message);
const user = (text: string, timestamp: number): Message => ({ role: "user", content: [{ type: "text", text }], timestamp });
const system = (working: string, timestamp: number): Message => ({ role: "system", content: "", sections: { working }, timestamp } as Message);
const result = (id: string, timestamp: number): Message =>
  ({ role: "toolResult", toolCallId: id, toolName: "post", content: [{ type: "text", text: "posted" }], isError: false, timestamp } as Message);

const t0 = 1_795_473_700_000;
const head: Message = { role: "system", content: "", sections: { rules: "R", working: "W0" }, timestamp: 0 } as Message;
/** 64bc3ad1's active entries 10 to 48 in order, the tool loop cut to one call. */
const komodo: Message[] = [
  head,
  user("[#komodo · post 1 from You (owner)] initialize one agent specializing in CI/CD", t0),
  reply([{ type: "thinking", thinking: "handing over", thinkingSignature: "sig" }, { type: "toolCall", id: "t1", name: "post", arguments: {} }], t0 + 10_000, "toolUse"),
  result("t1", t0 + 11_000),
  system("W1", t0 + 11_500),
  reply([], t0 + 38_000),
  user("[work-done: no-reply agent:agent factory]", t0 + 177_000),
  system("W2", t0 + 177_100),
  reply([], t0 + 177_200),
  user("[agent-message from sibling:agent factory] The result is in p2 of #komodo", t0 + 1_984_000),
  system("W3", t0 + 1_984_100),
];

/** The body pi-ai's Anthropic provider sends for `messages`, caught by a fetch that answers 400. */
async function wire(provider: Provider, messages: Message[]): Promise<{ messages: { role: string; content: { type: string; text?: string }[] | string }[] }> {
  const model = provider.getModels().find(m => (m.compat as { supportsMidConvoSystemMessages?: boolean } | undefined)?.supportsMidConvoSystemMessages);
  assert.ok(model, "pi-ai lists a model that takes system updates mid-conversation");
  let body: unknown;
  const fetch = async (_url: unknown, init?: { body?: unknown }) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "test" } }), { status: 400, headers: { "content-type": "application/json" } });
  };
  await provider.stream(model, { messages } as never, { apiKey: "sk-ant-api-test", fetch, cacheRetention: "long", maxRetries: 0 } as never).result();
  return body as never;
}

/**
 * Each system message Anthropic refuses: one whose run of system messages ends at a message other than an assistant one, unless it is
 * directive-only (no content). 64bc3ad1's earlier requests sent a text update and a directive-only one together before an assistant message.
 */
const refused = (body: Awaited<ReturnType<typeof wire>>): number[] => body.messages.flatMap((message, index) => {
  if (message.role !== "system" || message.content.length === 0) return [];
  const next = body.messages.slice(index + 1).find(later => later.role !== "system");
  return next && next.role !== "assistant" ? [index] : [];
});
const texts = (body: Awaited<ReturnType<typeof wire>>): string =>
  body.messages.flatMap(message => typeof message.content === "string" ? [message.content] : message.content.map(block => block.text ?? "")).join("\n");

test("pi-ai alone puts the update held before an empty reply right before the next input, the shape Anthropic refused in 64bc3ad1", async () => {
  const body = await wire(anthropicProvider(), komodo);
  assert.notDeepEqual(refused(body), [], "without the shape, a system update sits before a user message");
});

test("through withCacheShape, 64bc3ad1's entry order sends every system update before an assistant message or at the end", async () => {
  const body = await wire(withCacheShape(anthropicProvider(), () => t0 + 1_984_200), komodo);
  assert.deepEqual(refused(body), []);
  for (const working of ["W1", "W2", "W3", "[agent-message from sibling:agent factory]"]) assert.ok(texts(body).includes(working), `the request still sends ${working}`);
});

test("an assistant message with only blank text or empty unsigned thinking leaves; one with a signature, a tool call or text stays", () => {
  const blank = reply([{ type: "text", text: "  " }, { type: "thinking", thinking: "" }], t0);
  const signed = reply([{ type: "thinking", thinking: "", thinkingSignature: "sig" }], t0);
  const redacted = reply([{ type: "thinking", thinking: "", redacted: true, thinkingSignature: "opaque" }], t0);
  const said = reply([{ type: "text", text: "ok" }], t0);
  assert.deepEqual(withoutEmptyReplies([head, blank, signed, redacted, said]), [head, signed, redacted, said]);
  const clean = [head, said];
  assert.equal(withoutEmptyReplies(clean), clean, "a transcript with no empty reply is the same array");
});

test("an empty reply's request warmed the cache, so the fold still reads its timestamp and an update after it stays in place", async () => {
  const now = t0 + COLD_MS + 5 * 60_000;
  const messages = [head, user("one", t0), reply([{ type: "text", text: "ok" }], t0 + 1000), user("two", t0 + COLD_MS + 60_000),
    reply([], t0 + COLD_MS + 61_000), system("W1", t0 + COLD_MS + 2 * 60_000), user("three", now)];
  assert.notEqual(foldSystem(withoutEmptyReplies(messages), now)[0], head, "without its timestamp the update would fold into the leading message");
  const body = await wire(withCacheShape(anthropicProvider(), () => now), messages);
  assert.deepEqual(body.messages.map(message => message.role), ["user", "assistant", "user", "user", "system"]);
  assert.ok(texts(body).includes("W1"), "the update goes as its own system message");
});
