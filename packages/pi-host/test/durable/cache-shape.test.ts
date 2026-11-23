/**
 * A thread's requests are shaped for the prompt cache (`cache-shape.ts`): system updates before a lapsed cache fold into the leading
 * system message, and a cache breakpoint never sits on a tool change block, where Anthropic writes no cache. On 11-21 comm thread
 * 5d50e997 paid for 160k to 274k tokens of fresh input on each request after a tool update, then wrote the same tokens to the cache.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Message, Provider, Tool } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { cacheableBreakpoints, COLD_MS, foldPoint, foldSystem, KEEP_CHARS, LEAN_CHARS, LEFT_OUT_NOTE, leanHistory, sniffImage, thawArrays, viewableImages, withCacheShape } from "../../src/durable/cache-shape.ts";

const tool = (name: string, description = name): Tool => ({ name, description, parameters: { type: "object", properties: {} } } as unknown as Tool);
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (text: string, timestamp: number): Message => ({ role: "user", content: text, timestamp });
const answer = (text: string, timestamp: number): Message =>
  ({ role: "assistant", content: [{ type: "text", text }], api: "anthropic-messages", provider: "anthropic", model: "claude-fable-5", usage, stopReason: "stop", timestamp } as Message);
const system = (fields: Partial<Extract<Message, { role: "system" }>>, timestamp: number): Message => ({ role: "system", content: "", ...fields, timestamp } as Message);

const MIN = 60_000;
const t0 = 1_800_000_000_000;
const head = system({ sections: { rules: "R1", context: "C1" }, toolsAdded: [tool("a"), tool("b")] }, 0);
// A turn, then a release that changed the context section and tool a's text, then the owner's next post.
const before: Message[] = [head, user("one", t0), answer("ok", t0 + 1000), system({ sections: { context: "C2" }, toolsRemoved: [{ name: "a" }, { name: "b" }], toolsAdded: [tool("a", "a2"), tool("b")] }, t0 + 30 * MIN), user("two", t0 + 3 * 60 * MIN)];

test("a request within the hour keeps every system update in place, so its prefix is the one the cache holds", () => {
  const warm = [...before.slice(0, 4), user("two", t0 + 40 * MIN)];
  assert.equal(foldPoint(warm, t0 + 40 * MIN), 0);
  assert.equal(foldSystem(warm, t0 + 40 * MIN), warm);
});

test("the first request after the cache lapsed folds each update into the leading system message, which holds the current sections and tools", () => {
  const now = t0 + 3 * 60 * MIN;
  assert.equal(foldPoint(before, now), before.length);
  const folded = foldSystem(before, now);
  assert.equal(folded.length, before.length - 1);
  assert.deepEqual(folded[0], { role: "system", content: "", sections: { rules: "R1", context: "C2" }, toolsAdded: [tool("a", "a2"), tool("b")], timestamp: 0 });
  assert.deepEqual(folded.slice(1), [before[1], before[2], before[4]]);
});

test("the requests after that fold at the same point from the assistant timestamps, so they read the prefix the cold request wrote", () => {
  const cold = t0 + 3 * 60 * MIN;
  const sent = foldSystem(before, cold);
  const later = [...before, answer("checking", cold + 500), system({ sections: { context: "C3" } }, cold + 2 * MIN), user("three", cold + 3 * MIN)];
  const next = foldSystem(later, cold + 3 * MIN);
  assert.deepEqual(next.slice(0, sent.length), sent, "the cold request's transcript is a prefix of the next one");
  assert.deepEqual(next.slice(sent.length), later.slice(before.length), "an update after the cold point stays where it was");
});

test("a breakpoint on a tool change block moves to the text block before it, or to the message before when the update has no text", () => {
  const payload = { messages: [
    { role: "user", content: [{ type: "text", text: "two" }] },
    { role: "system", content: [{ type: "text", text: "Updated" }, { type: "tool_removal" }, { type: "tool_addition", cache_control: { type: "ephemeral", ttl: "1h" } }] },
  ] };
  assert.equal(cacheableBreakpoints(payload), payload);
  assert.deepEqual(payload.messages[1]!.content, [{ type: "text", text: "Updated", cache_control: { type: "ephemeral", ttl: "1h" } }, { type: "tool_removal" }, { type: "tool_addition" }]);
  const toolsOnly = { messages: [
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t" }] },
    { role: "system", content: [{ type: "tool_addition", cache_control: { type: "ephemeral" } }] },
  ] };
  cacheableBreakpoints(toolsOnly);
  assert.deepEqual(toolsOnly.messages[0]!.content, [{ type: "tool_result", tool_use_id: "t", cache_control: { type: "ephemeral" } }]);
  assert.equal(cacheableBreakpoints({ messages: [{ role: "user", content: [{ type: "text", text: "x", cache_control: {} }] }] }), undefined);
});

/** The body pi-ai's Anthropic provider sends for `messages`, caught by a fetch that answers 400. */
async function wire(provider: Provider, messages: Message[]): Promise<{ messages: { role: string; content: { type: string; cache_control?: unknown }[] | string }[]; system: { text: string }[] }> {
  const model = provider.getModels().find(m => {
    const compat = m.compat as { supportsMidConvoSystemMessages?: boolean; supportsMidConvoToolChanges?: boolean } | undefined;
    return compat?.supportsMidConvoSystemMessages && compat.supportsMidConvoToolChanges;
  });
  assert.ok(model, "pi-ai lists a model that takes system updates mid-conversation");
  let body: unknown;
  const fetch = async (_url: unknown, init?: { body?: unknown }) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "test" } }), { status: 400, headers: { "content-type": "application/json" } });
  };
  await provider.stream(model, { messages } as never, { apiKey: "sk-ant-api-test", fetch, cacheRetention: "long", maxRetries: 0 } as never).result();
  return body as never;
}
const marks = (body: Awaited<ReturnType<typeof wire>>) =>
  body.messages.map(m => `${m.role}:${(typeof m.content === "string" ? [{ type: "str" }] : m.content).map(b => b.type + ("cache_control" in b && b.cache_control ? "*" : "")).join(",")}`);

test("through pi-ai's Anthropic provider, a warm request puts its breakpoint on the update's text and a cold one sends one system prompt", async () => {
  const inner = anthropicProvider();
  const messages = [...before.slice(0, 4), user("two", t0 + 40 * MIN)];
  const raw = marks(await wire(inner, messages));
  assert.match(raw.at(-1)!, /^system:text,.*tool_addition\*$/, "pi-ai alone puts the breakpoint on the last tool addition");
  const warm = marks(await wire(withCacheShape(inner, () => t0 + 40 * MIN), messages));
  assert.match(warm.at(-1)!, /^system:text\*,(tool_\w+,)*tool_addition$/);
  const cold = await wire(withCacheShape(inner, () => t0 + 3 * 60 * MIN), before);
  assert.deepEqual(marks(cold), ["user:str", "assistant:text", "user:text*"]);
  assert.equal(cold.system[0]!.text, "R1\n\nC2");
});

/** The request without its cache markers, which move as the transcript grows. */
const bare = (body: unknown) => JSON.parse(JSON.stringify(body, (key, value) => key === "cache_control" ? undefined : value));

test("on the wire, each request's system, tools and messages start with the previous request's, across a cold fold and a later tool update", async () => {
  const inner = anthropicProvider();
  const cold = t0 + 3 * 60 * MIN;
  const turns: Message[][] = [
    before,
    [...before, answer("checking", cold + 500), user("three", cold + 2 * MIN)],
    [...before, answer("checking", cold + 500), user("three", cold + 2 * MIN), answer("done", cold + 2 * MIN + 500),
      system({ sections: { context: "C3" }, toolsRemoved: [{ name: "a" }, { name: "b" }], toolsAdded: [tool("a", "a3"), tool("b")] }, cold + 4 * MIN), user("four", cold + 5 * MIN)],
  ];
  const clocks = [cold, cold + 2 * MIN, cold + 5 * MIN];
  for (const lean of [false, true]) {
    const bodies: { system: unknown; tools: unknown; messages: unknown[] }[] = [];
    // A comm thread's request also passes through leanHistory first, in prime-chat's beforeRequest hook.
    for (const [index, messages] of turns.entries()) bodies.push(bare(await wire(withCacheShape(inner, () => clocks[index]!), lean ? [...leanHistory(messages, clocks[index]!)] : messages)));
    for (let index = 1; index < bodies.length; index++) {
      const [was, now] = [bodies[index - 1]!, bodies[index]!];
      assert.deepEqual(now.system, was.system, `request ${index + 1} keeps the system prompt`);
      assert.deepEqual(now.tools, was.tools, `request ${index + 1} keeps the tool list`);
      const last = was.messages.length - 1;
      assert.deepEqual(now.messages.slice(0, last), was.messages.slice(0, last), `request ${index + 1} starts with request ${index}'s messages`);
    }
  }
});

test("a comm thread's earlier turns lose thinking and long tool texts once the cache lapsed, the current turn stays whole, and later requests trim the same way", () => {
  const long = "x".repeat(LEAN_CHARS + 500);
  const think = (text: string, timestamp: number): Message => ({ ...answer(text, timestamp), content: [{ type: "thinking", thinking: "hmm", thinkingSignature: "sig" }, { type: "toolCall", id: `t${timestamp}`, name: "ipython", arguments: { code: long } }] } as Message);
  const toolResult = (timestamp: number): Message => ({ role: "toolResult", toolCallId: `t${timestamp}`, toolName: "ipython", content: [{ type: "text", text: long }, { type: "image", data: "AAAA", mimeType: "image/png" }], isError: false, timestamp } as Message);
  const old: Message[] = [head, user("one", t0), think("a", t0 + 1000), toolResult(t0 + 1000), answer("done", t0 + 2000)];
  const cold = t0 + 3 * 60 * MIN;
  const now: Message[] = [...old, user("two", cold), think("b", cold + 500), toolResult(cold + 500)];
  const warm = [...old, user("two", t0 + 20 * MIN), think("b", t0 + 20 * MIN + 500)];
  assert.equal(leanHistory(warm, t0 + 30 * MIN), warm, "within the hour nothing is trimmed");
  const lean = leanHistory(now, cold + 1000);
  const earlier = lean[2] as Extract<Message, { role: "assistant" }>;
  assert.deepEqual(earlier.content.map(part => part.type), ["toolCall"], "the earlier turn's thinking is gone");
  const code = (earlier.content[0] as unknown as { arguments: { code: string } }).arguments.code;
  assert.ok(code.startsWith("x".repeat(LEAN_CHARS)) && code.includes("500 more characters cut"), code.slice(-80));
  assert.deepEqual((lean[3] as Extract<Message, { role: "toolResult" }>).content.map(part => part.type === "text" ? part.text.length < long.length : part.type), [true, true]);
  assert.deepEqual(lean.slice(5), now.slice(5), "the turn the cold request runs in stays whole, thinking and all");
  const next = [...now, answer("ok", cold + 2000), user("three", cold + 5 * MIN)];
  assert.deepEqual(leanHistory(next, cold + 5 * MIN).slice(0, lean.length), lean, "the next request trims the same part the same way");
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]).toString("base64");
const TIFF = Buffer.from("MM\0*\0\0\0\x08rest", "latin1").toString("base64");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64");
const withImage = (data: string, mimeType: string, timestamp: number): Message =>
  ({ role: "user", content: [{ type: "text", text: "look" }, { type: "image", data, mimeType }], timestamp } as Message);

test("an image whose bytes are no type Anthropic takes becomes a text line, a mislabelled one gets its own type, and a good one stays", () => {
  assert.equal(sniffImage(PNG), "image/png");
  assert.equal(sniffImage(TIFF), undefined);
  const good = [head, withImage(PNG, "image/png", t0)];
  assert.equal(viewableImages(good), good);
  const [, svg, tiff, wrong, empty] = viewableImages([head, withImage(SVG, "image/svg+xml", t0), withImage(TIFF, "image/tiff", t0), withImage(PNG, "image/jpeg", t0), withImage(TIFF, "", t0)]);
  assert.deepEqual((svg as { content: unknown[] }).content[1], { type: "text", text: "[an image of type image/svg+xml, not shown]" });
  assert.deepEqual((tiff as { content: unknown[] }).content[1], { type: "text", text: "[an image of type image/tiff, not shown]" });
  assert.deepEqual((wrong as { content: unknown[] }).content[1], { type: "image", data: PNG, mimeType: "image/png" });
  assert.deepEqual((empty as { content: unknown[] }).content[1], { type: "text", text: "[an image of type unknown, not shown]" });
});

test("on the wire, a history holding an SVG image sends its text line, and the next request starts with the same messages", async () => {
  const inner = anthropicProvider();
  const first: Message[] = [head, withImage(SVG, "image/svg+xml", t0), answer("ok", t0 + 1000), user("two", t0 + 2 * MIN)];
  const second: Message[] = [...first, answer("sure", t0 + 2 * MIN + 500), user("three", t0 + 4 * MIN)];
  const bodies = [bare(await wire(withCacheShape(inner, () => t0 + 2 * MIN), first)), bare(await wire(withCacheShape(inner, () => t0 + 4 * MIN), second))];
  const sent = JSON.stringify(bodies[0].messages);
  assert.ok(sent.includes("[an image of type image/svg+xml, not shown]"), sent.slice(0, 400));
  assert.ok(!sent.includes('"image"'), "no image block goes out");
  const last = bodies[0].messages.length - 1;
  assert.deepEqual(bodies[1].messages.slice(0, last), bodies[0].messages.slice(0, last));
  assert.deepEqual(bodies[1].system, bodies[0].system);
});

/** Freezes `value` and everything in it, as pi-durable's `freezeJson` does with each entry it reads. */
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
};
const frozenArrays = (value: unknown, path = ""): string[] =>
  Array.isArray(value) ? [...(Object.isFrozen(value) ? [path] : []), ...value.flatMap((item, at) => frozenArrays(item, `${path}[${at}]`))]
    : value && typeof value === "object" ? Object.entries(value).flatMap(([key, item]) => frozenArrays(item, `${path}.${key}`)) : [];

test("thawArrays copies each frozen array and the plain objects above it, shares every other node, and keeps the JSON bytes", () => {
  const payload = deepFreeze({ messages: [{ role: "user", content: [{ type: "text", text: "a" }] }], tools: [{ name: "Bash", input_schema: { type: "object", required: ["command"], properties: { command: { type: "string" } } } }], when: new Date(0) });
  const thawed = thawArrays(payload);
  assert.equal(JSON.stringify(thawed), JSON.stringify(payload));
  assert.deepEqual(frozenArrays(thawed), []);
  assert.equal(thawed.tools[0]!.input_schema.properties, payload.tools[0]!.input_schema.properties, "a node with no frozen array under it is shared");
  assert.equal(thawed.when, payload.when, "a Date stays the same object, so its toJSON still runs");
  const plain = { messages: [{ role: "user", content: "a" }], tools: [{ name: "x", required: ["y"] }] };
  assert.equal(thawArrays(plain), plain, "a payload with no frozen array comes back as is");
});

test("through pi-ai's Anthropic provider, a frozen context reaches the SDK's body encode with no frozen array, in the same bytes, and encodes as fast as a plain copy", async () => {
  const inner = anthropicProvider();
  const schema = { type: "object", properties: { command: { type: "string" }, paths: { type: "array", items: { type: "string" } } }, required: ["command"] };
  const tools = ["Bash", "Read", "Edit"].map(name => ({ name, description: `${name} tool`, parameters: schema }) as unknown as Tool);
  const history: Message[] = [];
  const text = 'a "quoted" line\twith é and 한\n'.repeat(40);
  for (let n = 0; n < 400; n++) {
    const call = { type: "toolCall", id: `call_${n}`, name: "Bash", arguments: { command: `echo ${n}`, paths: ["a", "b"] } };
    history.push(user(`ask ${n} ${text}`, t0 + n * 1000), { ...answer(`looking ${n}`, t0 + n * 1000 + 100), content: [{ type: "text", text: `looking ${n}` }, call] } as Message);
    for (let k = 0; k < 8; k++) history.push({ role: "toolResult", toolCallId: `call_${n}`, toolName: "Bash", content: [{ type: "text", text }], isError: false, timestamp: t0 + n * 1000 + 200 } as Message);
    history.push(answer(`answer ${n}`, t0 + n * 1000 + 500));
  }
  const messages = deepFreeze([system({ sections: { rules: "R1" }, toolsAdded: tools }, 0), ...history, user("latest", t0 + 400_000)]);
  const encoded: unknown[] = [];
  const real = JSON.stringify;
  JSON.stringify = function (this: unknown, value: unknown, ...rest: unknown[]) {
    const text = (real as (...args: unknown[]) => string).call(JSON, value, ...rest);
    if (typeof text === "string" && text.length > 1_000_000) encoded.push(value);
    return text;
  } as typeof JSON.stringify;
  let shapedBody: unknown, rawBody: unknown;
  try {
    shapedBody = await wire(withCacheShape(inner, () => t0 + 400_000), messages);
    rawBody = await wire(inner, messages);
  } finally {
    JSON.stringify = real;
  }
  const [shapedPayload, rawPayload] = encoded;
  assert.ok(shapedPayload && rawPayload, `${encoded.length} large encodes seen`);
  assert.ok(frozenArrays(rawPayload).length > 0, "pi-ai alone hands the SDK the frozen schema arrays");
  assert.deepEqual(frozenArrays(shapedPayload), [], "the shaped payload holds no frozen array");
  assert.equal(JSON.stringify(shapedBody), JSON.stringify(rawBody), "both requests send the same body");
  const median = (value: unknown) => {
    const times: number[] = [];
    for (let n = 0; n < 7; n++) { const start = performance.now(); JSON.stringify(value); times.push(performance.now() - start); }
    return times.sort((a, b) => a - b)[3]!;
  };
  const copy = JSON.parse(JSON.stringify(shapedPayload));
  const [shapedMs, copyMs] = [median(shapedPayload), median(copy)];
  assert.ok(shapedMs < copyMs * 2, `the shaped payload encodes in ${shapedMs.toFixed(1)} ms against ${copyMs.toFixed(1)} ms for a plain copy`);
});

test("a cold comm request keeps only the newest earlier turns that fit KEEP_CHARS, cut where a turn starts, and later requests keep the same", () => {
  const big = "y".repeat(1000);
  const turns: Message[] = [];
  for (let n = 0; n < 200; n++) turns.push(user(`ask ${n} ${big}`, t0 + n * 1000), answer(`answer ${n}`, t0 + n * 1000 + 500));
  const cold = t0 + 4 * 60 * MIN;
  const now: Message[] = [head, ...turns, system({ sections: { context: "C9" } }, t0 + 300_000), user("latest", cold)];
  const lean = leanHistory(now, cold);
  const kept = lean.slice(1).filter(message => message.role !== "system");
  const chars = kept.slice(0, -1).reduce((sum, message) => sum + JSON.stringify(message.content).length, 0);
  assert.ok(chars <= KEEP_CHARS && chars > KEEP_CHARS / 2, `kept ${chars} characters of earlier turns`);
  assert.equal(kept[0]!.role, "user", "the kept part starts with a turn's input");
  assert.equal(((kept[0] as Extract<Message, { role: "user" }>).content as { text: string }[])[0]!.text, LEFT_OUT_NOTE);
  assert.ok(lean.some(message => message.role === "system" && message.sections?.context === "C9"), "a system update stays for the fold");
  assert.deepEqual(lean.at(-1), now.at(-1));
  const next = [...now, answer("ok", cold + 1000), user("more", cold + 2 * MIN)];
  assert.deepEqual(leanHistory(next, cold + 2 * MIN).slice(0, lean.length), lean, "the next request keeps the same part");
});
