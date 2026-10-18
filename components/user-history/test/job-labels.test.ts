// Guards the 10-18 loads of chat 01a14d31 from Korea: its children frame was 62 KB of JSON, 56 KB of it the jobs' whole task briefs, and the page got it twice, inline in the shell (126 KB, 33 KB packed) and again on the socket.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LABEL_CHARS, wireEvent } from "../src/first-page.ts";
import { request } from "node:http";
import { childName, childSearchText } from "../src/client/children.ts";
import { startChatServer } from "../src/chat-server.ts";
import { asset } from "../src/chat-assets.ts";
import type { ChatBackend } from "../src/chat-backend.ts";
import type { ChildAgent, ThreadEvent } from "../src/shared/types.ts";

const brief = "Owner's words (verbatim): fix the cold load\n" + "context ".repeat(400);
const child = (n: number, label: string): ChildAgent => ({ id: `sub-${n}`, label, status: "running" });

test("the feed sends the first LABEL_CHARS of each job's label, and the page names the job the same", () => {
  const children = [child(1, brief), child(2, "short label")];
  const event: ThreadEvent = { type: "children", children };
  const sent = wireEvent(event);
  assert.ok(sent.type === "children");
  assert.equal(sent.children[0]!.label.length, LABEL_CHARS);
  assert.equal(sent.children[0]!.labelMore, true);
  assert.equal(sent.children[1]!.labelMore, undefined);
  assert.equal(sent.children[1], children[1]);
  assert.equal(childName(sent.children[0]!), childName(children[0]!));
  assert.ok(JSON.stringify(sent).length * 5 < JSON.stringify(event).length);
  assert.equal(wireEvent(event), sent, "one cut per event, shared by every page");
  assert.equal(children[0]!.label, brief, "the server's own state keeps the whole brief");
});

test("events without long labels go out as they are", () => {
  const event: ThreadEvent = { type: "children", children: [child(1, "a job")] };
  assert.equal(wireEvent(event), event);
  const status: ThreadEvent = { type: "status", connection: "connected" };
  assert.equal(wireEvent(status), status);
});

const tail = "the word zanzibar sits past the cut";
const longBrief = brief + tail;

test("GET api/threads/<id>/child-labels gives the whole label of each job the feed cut", async t => {
  const children = [child(1, longBrief), child(2, "short label")];
  const backend = { close: async () => {}, threads: { state: (id: string) => id === "t1" ? { children } : undefined } } as unknown as ChatBackend;
  const js = asset(Buffer.from("1"), "text/javascript"), css = asset(Buffer.from("a{}"), "text/css");
  const server = await startChatServer({ backend, bundle: { js, css, version: "test" }, port: 0, capability: "cap", csrfToken: "token", stopToken: "stop",
    identity: { pid: process.pid, instanceId: "test", socketPath: "/isolated-labels.sock" }, onStop: async () => {} });
  t.after(() => server.close());
  const body = await new Promise<string>((resolve, reject) => {
    const req = request(new URL("api/threads/t1/child-labels", server.url), res => { let text = ""; res.on("data", chunk => { text += String(chunk); }); res.on("end", () => resolve(text)); });
    req.on("error", reject); req.end();
  });
  assert.deepEqual(JSON.parse(body), { labels: { "sub-1": longBrief } });
});

test("the subagent search finds a word past the cut once the page has the whole label", () => {
  const event: ThreadEvent = { type: "children", children: [child(1, longBrief)] };
  const sent = wireEvent(event);
  assert.ok(sent.type === "children");
  const cut = sent.children[0]!;
  assert.ok(!childSearchText(cut).includes("zanzibar"));
  assert.ok(childSearchText(cut, longBrief).includes("zanzibar"));
});
