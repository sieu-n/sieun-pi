// Guards the 10-18 Mac reconnects on release-322de20: a reconnect pulled 0.5 to 0.72 MB and was current in 1.0 to 1.2 s, 428 KB of it agents lists, because the agents feed sent each chat's whole list on subscribe and on every change (01a1164b: 252 agents, 229 not working, 84 KB a frame, 73 frames a minute) and went out beside the thread's lines.
import assert from "node:assert/strict";
import { test } from "node:test";
import WebSocket from "ws";
import { AgentsDiff, agentsHave, applyAgentsFrame, parseHave, sortAgents, type AgentsDelta, type AgentsView } from "../src/shared/sessions-delta.ts";
import { startChatServer } from "../src/chat-server.ts";
import { asset, packAsset } from "../src/chat-assets.ts";
import type { ChatBackend } from "../src/chat-backend.ts";
import type { ChatAgent, SessionRow } from "../src/shared/types.ts";

const agent = (n: number, extra: Partial<ChatAgent> = {}): ChatAgent => ({ key: `child:k${n}`, sessionId: `job${n}`, childId: `k${n}`, name: `job number ${n}`, job: `job-${n}`, sender: `job-${n}`,
  link: "subagent", state: n < 20 ? "working" : "done", activity: "read the crawler logs and fixed the retry", lastActivityAt: "2026-10-18T10:00:00.000Z", steps: [], ...extra });
const list = sortAgents(Array.from({ length: 252 }, (_, n) => agent(n, { lastActivityAt: new Date(Date.UTC(2026, 9, 18, 10) - n * 1000).toISOString() })));
const view = (agents: ChatAgent[]): AgentsView => ({ chat: "chat1", agents });
const size = (frame: unknown) => JSON.stringify(frame).length;

test("a reconnect that names a current agents list gets no agents, and one after one agent changed gets that agent only", () => {
  // The page's copy went through JSON, so its fields may sit in another order than the server's.
  const held = JSON.parse(JSON.stringify(list.map(entry => Object.fromEntries(Object.entries(entry).reverse())))) as ChatAgent[];
  const current = new AgentsDiff(parseHave(agentsHave(held)!)).frame(view(list)) as AgentsDelta;
  assert.deepEqual(current, { type: "agents-delta", chat: "chat1", upsert: [], remove: [] });
  assert.ok(size(current) < 100, `${size(current)} bytes against ${size(view(list))} for the whole list`);

  const changed = list.map(entry => entry.key === "child:k7" ? { ...entry, activity: "finished", lastActivityAt: "2026-10-18T10:00:05.000Z" } : entry).filter(entry => entry.key !== "child:k9");
  const now = sortAgents([...changed, agent(300, { lastActivityAt: "2026-10-18T10:00:06.000Z" })]);
  const delta = new AgentsDiff(parseHave(agentsHave(held)!)).frame(view(now)) as AgentsDelta;
  assert.deepEqual([delta.upsert.map(entry => entry.key).sort(), delta.remove, delta.order], [["child:k300", "child:k7"], ["child:k9"], undefined], "the page's sort rebuilds the order");
  assert.deepEqual(applyAgentsFrame(view(held), delta).agents, now);

  // A held feed sends each later change as the agents that moved.
  const live = new AgentsDiff();
  assert.deepEqual(live.frame(view(list)), view(list));
  assert.equal(live.frame(view([...list])), null);
  const ticked = sortAgents(list.map(entry => entry.key === "child:k3" ? { ...entry, lastActivityAt: "2026-10-18T10:00:01.000Z" } : entry));
  const tick = live.frame(view(ticked)) as AgentsDelta;
  assert.deepEqual([tick.upsert.map(entry => entry.key), tick.remove, tick.order], [["child:k3"], [], undefined]);
  assert.deepEqual(applyAgentsFrame(view(list), tick).agents, ticked);
  // An order the page's sort would not give, such as two agents with the same time in the server's order, goes along.
  const tie = live.frame(view([ticked[1]!, ticked[0]!, ...ticked.slice(2)])) as AgentsDelta;
  assert.deepEqual([tie.upsert, tie.order?.slice(0, 2)], [[], [ticked[1]!.key, ticked[0]!.key]]);
});

const script = packAsset(asset(Buffer.from("console.log('chat');\n"), "text/javascript; charset=utf-8"));
const style = packAsset(asset(Buffer.from("body{color:red}\n"), "text/css; charset=utf-8"));

test("the server sends a thread's first lines before an agents list asked for in the same breath", async t => {
  let release!: () => void;
  const opened = new Promise<void>(resolve => { release = resolve; });
  const rows = [{ id: "chat1", chat: true, agents: list } as unknown as SessionRow];
  const backend = {
    close: async () => {},
    catalog: { watch: (listener: (event: unknown) => void) => { listener({ type: "sessions", sessions: rows, tags: [], daemon: "up" }); return () => {}; }, childUsage: () => [] },
    threads: { state: () => null, subscribe: async (_id: string, send: (event: unknown) => void) => { await opened; send({ type: "snapshot", snapshot: { messages: [] } }); return () => {}; } },
    chats: { ids: async () => new Set<string>() },
  } as unknown as ChatBackend;
  const server = await startChatServer({ backend, bundle: { js: script, css: style, version: "test" }, port: 0, capability: "cap", csrfToken: "token", stopToken: "stop",
    identity: { pid: process.pid, instanceId: "test", socketPath: "/isolated-agents-feed.sock" }, onStop: async () => {} });
  t.after(() => server.close());
  const ws = new WebSocket(new URL("api/ws?token=token", server.url).href.replace("http", "ws"), { headers: { origin: new URL(server.url).origin } });
  t.after(() => ws.close());
  const frames: string[] = [];
  ws.on("message", raw => { const frame = JSON.parse(String(raw)) as { sub: number; event: string }; if (frame.event === "thread" || frame.event === "agents") frames.push(`${frame.sub}:${frame.event}`); });
  await new Promise(resolve => ws.once("open", resolve));
  ws.send(JSON.stringify({ type: "subscribe", sub: 1, feed: "thread", id: "chat1" }));
  ws.send(JSON.stringify({ type: "subscribe", sub: 2, feed: "agents", id: "chat1", delta: true }));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(frames, [], "the agents list waits for the thread");
  release();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(frames, ["1:thread", "2:agents"]);
});

test("the page subscribes its agents feeds after the open thread's first page, on a cold load and after a reconnect, naming what it holds", async t => {
  type Fake = { sent: Array<Record<string, unknown>>; readyState: number; onopen?: () => void; onclose?: () => void; onmessage?: (message: { data: unknown }) => void };
  const sockets: Fake[] = [];
  class FakeSocket implements Fake {
    static OPEN = 1; static CLOSING = 2;
    sent: Array<Record<string, unknown>> = []; readyState = 0; onopen?: () => void; onclose?: () => void; onmessage?: (message: { data: unknown }) => void;
    constructor() { sockets.push(this); }
    send(text: string) { this.sent.push(JSON.parse(text) as Record<string, unknown>); }
    close() { this.readyState = 3; }
  }
  Object.assign(globalThis, { WebSocket: FakeSocket, window: { addEventListener: () => {} },
    document: { visibilityState: "visible", baseURI: "https://box.example/cap/", body: { dataset: { chatToken: "t" } }, getElementById: () => null, addEventListener: () => {} } });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { subscribeFeed } = await import("../src/client/feeds.ts");
  const { api } = await import("../src/client/api.ts");
  const { AgentFeeds } = await import("../src/client/agent-feeds.ts");
  const feeds = (socket: Fake) => socket.sent.map(message => message.feed);

  subscribeFeed({ feed: "thread", id: "chat1" }, () => {});
  const agents = new AgentFeeds(api.agentsStream, () => {}, () => true);
  agents.show(["chat1"]);
  const first = sockets[0]!;
  first.readyState = 1; first.onopen?.();
  assert.deepEqual(feeds(first), ["thread"], "a cold load asks for the thread alone");
  agents.open();
  assert.deepEqual(feeds(first), ["thread", "agents"]);
  const sub = first.sent[1]!.sub;
  first.onmessage?.({ data: JSON.stringify({ sub, event: "agents", data: view(list) }) });
  assert.equal(agents.byChat().get("chat1")?.length, 252);

  first.readyState = 3; first.onclose?.();
  t.mock.timers.tick(1000);
  const second = sockets[1]!;
  second.readyState = 1; second.onopen?.();
  assert.deepEqual(feeds(second), ["thread"], "a reconnect asks for the thread alone");
  assert.equal(agents.byChat().get("chat1")?.length, 252, "the page keeps showing the agents it has");
  agents.open();
  assert.deepEqual(second.sent[1], { type: "subscribe", sub: second.sent[1]!.sub, feed: "agents", id: "chat1", delta: true, have: agentsHave(list) });
});
