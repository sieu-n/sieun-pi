// Guards the owner's ask of 10-22: open the Prompt dialog in under 1 s. Before, the GET read the newest 48 MiB of the session file (0.6 to 1.3 s
// on frontend bro's 82 MB file), the capture held each image's base64 (4.59 MB of frontend bro's 5.07 MB, read over the Mac relay in 1.0 to
// 2.2 s), and the whole view went out as one JSON body (280 KB gzipped for the AI harness chat, 0.75 s from the Mac).
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { brotliDecompressSync } from "node:zlib";
import { buildSessionContext } from "prime-agent";
import { startChatServer } from "../src/chat-server.ts";
import type { ChatBackend } from "../src/chat-backend.ts";
import { captureFile, readCapture, recordPrompt } from "../src/prompt-capture.ts";
import { payloadParts, promptView, toPart } from "../src/prompt-view.ts";
import { readBranchTail, readContextTail } from "../src/session-tail.ts";
import { firstScreen, PREVIEW_CHARS, type PromptFrame, type PromptView, withTexts } from "../src/shared/prompt-view.ts";

const SESSION = "01a16473-d331-762e-9c0a-5b90a52903f4";
const at = (n: number) => new Date(Date.UTC(2026, 9, 22, 9, 0, n)).toISOString();
const usage = (input: number) => ({ input, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: input + 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const user = (id: string, parentId: string, n: number, text: string) =>
  ({ type: "message", id, parentId, timestamp: at(n), message: { role: "user", content: [{ type: "text", text }], timestamp: Date.parse(at(n)) } });
const reply = (id: string, parentId: string, n: number, text: string, input: number) => ({ type: "message", id, parentId, timestamp: at(n),
  message: { role: "assistant", content: [{ type: "text", text }], api: "anthropic-messages", provider: "anthropic", model: "m", usage: usage(input), stopReason: "stop", timestamp: Date.parse(at(n)) } });

/** 40 old turns of 20 KB each, a compaction that keeps the last 2 of them, and 2 turns after it. */
function sessionLines(): string[] {
  const lines: object[] = [{ type: "session", version: 3, id: SESSION, timestamp: at(0), cwd: "/tmp" }];
  let parent = "";
  for (let n = 1; n <= 80; n += 2) {
    lines.push(user(`u${n}`, parent || (null as unknown as string), n, `old ask ${n} ` + "x".repeat(20_000)));
    lines.push(reply(`a${n}`, `u${n}`, n + 1, `old answer ${n}`, 1000 + n));
    parent = `a${n}`;
  }
  lines.push({ type: "compaction", id: "c1", parentId: parent, timestamp: at(81), summary: "what happened", firstKeptEntryId: "u77", tokensBefore: 90_000 });
  lines.push(user("u82", "c1", 82, "new ask"), reply("a83", "u82", 83, "new answer", 5000));
  return lines.map(line => JSON.stringify(line));
}

test("the Prompt view reads the session back only to the start of the model's context, and a grown session shows at once", async t => {
  const dir = await mkdtemp(join(tmpdir(), "prompt-open-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, `${SESSION}.jsonl`);
  await writeFile(file, sessionLines().join("\n") + "\n");
  const context = await readContextTail(file, 48 * 1024 * 1024);
  assert.deepEqual(context?.entries.map(entry => entry.id), ["u77", "a77", "u79", "a79", "c1", "u82", "a83"]);
  assert.equal(context?.whole, false);
  const all = await readBranchTail(file, { messages: 1_000_000, bytes: 48 * 1024 * 1024 });
  assert.deepEqual(buildSessionContext(context!.entries).messages, buildSessionContext(all!.entries).messages, "the same context as the whole branch");

  const capture = { capturedAt: at(84), sessionId: SESSION, sessionFile: file, provider: "anthropic", model: "m",
    payload: { system: "You are Prime.", messages: [{ role: "user", content: "new ask" }, { role: "assistant", content: "new answer" }] } };
  const view = await promptView(SESSION, { sessionFile: file, dataDir: dir, chat: false, readCapture: async () => capture });
  assert.equal(view.measuredInputTokens, 5000);
  assert.deepEqual(view.parts.filter(part => part.role).map(part => part.at), [at(82), at(83)]);

  await appendFile(file, JSON.stringify(user("u84", "a83", 84, "one more")) + "\n" + JSON.stringify(reply("a85", "u84", 85, "more", 7000)) + "\n");
  const grown = await promptView(SESSION, { sessionFile: file, dataDir: dir, chat: false, readCapture: async () => capture });
  assert.equal(grown.measuredInputTokens, 7000, "the next open reads the reply written since");
});

test("a capture keeps each image's place and size but not its base64 data", async t => {
  const dir = await mkdtemp(join(tmpdir(), "prompt-capture-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const data = "iVBORw0KGgo".repeat(10_000);
  const payload = { system: "s", messages: [
    { role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data } }] },
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "ipython", input: { code: "shot()" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "saved" }, { type: "image", source: { type: "base64", media_type: "image/png", data } }] }] },
  ] };
  await recordPrompt(dir, { capturedAt: at(1), sessionId: SESSION, sessionFile: null, provider: "anthropic", model: "m", payload });
  const raw = await readFile(captureFile(dir, SESSION), "utf8");
  assert.ok(!raw.includes(data), "no image data in the file");
  assert.ok(raw.length < 4000, `the capture is ${raw.length} bytes`);
  const parts = payloadParts((await readCapture(dir, SESSION))!.payload).map(toPart);
  assert.deepEqual(parts.filter(part => part.role).map(part => [part.label, part.tokens]),
    [["Owner", 1], ["Image", 1600], ["Assistant tool call: ipython", 4], ["Tool result: ipython", 1604]]);

  const responses = { instructions: "s", input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${data}` }] }] };
  await recordPrompt(dir, { capturedAt: at(2), sessionId: SESSION, sessionFile: null, provider: "openai", model: "m", payload: responses });
  assert.ok(!(await readFile(captureFile(dir, SESSION), "utf8")).includes(data), "no data URL either");
});

const longView = (): PromptView => {
  const parts = payloadParts({ system: "You are Prime.", tools: [{ name: "ipython", description: "run", input_schema: { type: "object" } }], messages: [
    { role: "user", content: "ask " + "a".repeat(5000) },
    { role: "assistant", content: [{ type: "thinking", thinking: "think ".repeat(500), signature: "s" }, { type: "tool_use", id: "c1", name: "ipython", input: { code: "x".repeat(3000) } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "out ".repeat(4000) }] },
  ] }).map(toPart);
  return { threadId: SESSION, sessionFile: "/tmp/s.jsonl", origin: { kind: "exact", capturedAt: at(1), provider: "anthropic", model: "m" }, totalTokens: 1, parts };
};

test("the first screen keeps the parts before the conversation and each incoming preview, and the texts line restores the whole view", () => {
  const view = longView();
  const first = firstScreen(view);
  assert.deepEqual(first.view.parts.map(part => [part.label, part.text.length]),
    [["Base system prompt", 14], ["Tool: ipython", view.parts[1]!.text.length], ["Owner", PREVIEW_CHARS], ["Assistant thinking", 0], ["Assistant tool call: ipython", 0], ["Tool result: ipython", 0]]);
  assert.deepEqual(first.view.parts.map(part => part.tokens), view.parts.map(part => part.tokens), "tokens count the whole text");
  assert.deepEqual(withTexts(first.view, first.texts), view);
});

test("GET prompt streams the first screen, then the texts, as two NDJSON lines", async t => {
  const view = longView();
  const server = await startChatServer({ backend: { close: async () => {}, prompt: async () => view } as unknown as ChatBackend, bundle: { js: { body: Buffer.from(""), etag: '"js"', contentType: "text/javascript" }, css: { body: Buffer.from(""), etag: '"css"', contentType: "text/css" }, version: "test" },
    port: 0, capability: "cap", csrfToken: "token", stopToken: "stop", identity: { pid: process.pid, instanceId: "test", socketPath: "/isolated-prompt-open.sock" }, onStop: async () => {} });
  t.after(() => server.close());
  const response = await new Promise<{ type: string | undefined; encoding: string | undefined; body: Buffer }>((resolve, reject) => {
    const req = request(new URL(`/cap/api/threads/${SESSION}/prompt`, server.url), { headers: { "accept-encoding": "gzip, br" } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ type: res.headers["content-type"], encoding: res.headers["content-encoding"], body: Buffer.concat(chunks) }));
    });
    req.on("error", reject); req.end();
  });
  assert.equal(response.type, "application/x-ndjson; charset=utf-8");
  assert.equal(response.encoding, "br");
  const lines = brotliDecompressSync(response.body).toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line) as PromptFrame);
  assert.equal(lines.length, 2);
  assert.ok("view" in lines[0]! && "texts" in lines[1]!);
  assert.deepEqual(lines[0], { view: firstScreen(view).view });
  assert.deepEqual(withTexts(lines[0].view, lines[1].texts), view);
});
