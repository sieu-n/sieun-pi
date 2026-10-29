/**
 * The chat server over several boxes (server/host/relay-host.ts, server/host/multi-host.ts and the waiting deliveries in server/rooms.ts),
 * against a fake agent relay whose pi-host is a FixtureHost (test/server/fake-relay.ts).
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/relay-host.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, mock, test } from "node:test";
import type { AgentHostList, AgentSummary, Item, TimelinePage } from "../../web/src/lib/api/types.ts";
import { App } from "../../server/app.ts";
import { fixtureFolders, readConfig } from "../../server/config.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
import { MultiHost } from "../../server/host/multi-host.ts";
import { RelayHost } from "../../server/host/relay-host.ts";
import { HostAway, type EntryRecord } from "../../server/host/types.ts";
import { serve } from "../../server/http.ts";
import { seedFixture } from "../../server/fixture/seed.ts";
import { FakeRelay } from "./fake-relay.ts";
import { until } from "./helpers.ts";

const TOKEN = "test-token";
const fast = () => 20;
const tmp = (name: string) => mkdtempSync(join(tmpdir(), `apps-chat-relay-${name}-`));
const inputs = (host: FixtureHost, thread: string): EntryRecord[] =>
  host.threadsById.get(thread)?.entries.filter(e => e.conversationId === 1 && (e.kind === "pi.user" || e.kind === "agent.message")) ?? [];
const textOf = (entry: EntryRecord): string => JSON.stringify(entry.model?.[0]?.content);

describe("RelayHost", () => {
  let relay: FakeRelay;
  let dir: string;
  let client: RelayHost;
  before(async () => {
    relay = new FakeRelay("mac", TOKEN);
    await relay.listening;
    dir = tmp("unit");
  });
  after(async () => {
    await client?.close();
    await relay.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("it answers hello with welcome from the saved cursor, then serves calls", async () => {
    mkdirSync(join(dir, "relay"), { recursive: true });
    writeFileSync(join(dir, "relay", "mac.json"), JSON.stringify({ feedAfter: 7 }));
    client = new RelayHost({ box: "mac", url: relay.url, token: TOKEN, dataDir: dir, redialWait: fast });
    const links: string[] = [];
    client.onLink(link => links.push(link.state));
    client.start();
    await until(async () => client.state().state, state => state === "up");
    assert.deepEqual(relay.welcomes, [7]);
    assert.deepEqual(links, ["up"]);
    assert.equal(client.info?.home, "/Users/test");
    const made = await client.create({ name: "remote one", cwd: "/Users/test/src/sieun-pi", box: "mac" });
    assert.equal(relay.calls.at(-1)!.args.box, undefined, "the box is the chat server's routing, not a pi-host field");
    assert.equal((await client.threads()).some(t => t.id === made.id), true);
    const sent = await client.submit(made.id, { text: "hello mac", requestId: "r-1" });
    assert.equal(typeof sent.submission, "number");
    assert.deepEqual((await client.ping()).ok, true);
    await client.filePut("/Users/test/.pi/agent/agents/x/brief.md", "brief");
    assert.deepEqual(await client.fileGet("/Users/test/.pi/agent/agents/x/brief.md"), { exists: true, text: "brief", size: 5, modifiedAt: 1 });
    assert.equal((await client.check("true", 1000)).ok, true);
  });

  test("a watch gets its events, and after a reconnect it opens again from the newest entry it saw", async () => {
    const thread = (await client.create({ name: "watched" })).id;
    const seen: number[] = [];
    const stop = await client.watch(thread, { conversation: 1 }, event => {
      if (event.type !== "events") return;
      for (const e of event.events) if (e.type === "entry_appended") seen.push(e.entry.id);
    });
    await client.submit(thread, { text: "one", requestId: "w-1" });
    await until(async () => seen.length, n => n > 0);
    const newest = Math.max(...seen);
    relay.drop();
    await until(async () => client.state().state, state => state === "up");
    const rewatch = await until(async () => relay.calls.filter(c => c.op === "watch" && c.args.thread === thread), calls => calls.length === 2);
    assert.ok((rewatch[1]!.args.fromEntry as number) >= newest, "the second watch starts from the newest entry seen");
    await stop();
  });

  test("a submit in flight when the link drops goes again after the reconnect, and pi-host keeps it once", async () => {
    const thread = (await client.create({ name: "drop mid-submit" })).id;
    let dropped = false;
    relay.onCall = call => {
      if (call.op === "durable_submit" && !dropped) {
        dropped = true;
        return "drop";
      }
    };
    const sent = await client.submit(thread, { text: "only once please", requestId: "d:p1:ag_x" });
    relay.onCall = undefined;
    assert.ok(dropped);
    assert.equal(relay.calls.filter(c => c.op === "durable_submit" && c.args.requestId === "d:p1:ag_x").length, 2, "sent twice over two links");
    assert.equal(inputs(relay.host, thread).filter(e => textOf(e).includes("only once please")).length, 1, "pi-host keeps one input per requestId");
    assert.equal(typeof sent.submission, "number");
  });

  test("a call that could act twice fails as away when the link drops under it, and every call fails at once while the box is away", async () => {
    const thread = (await client.create({ name: "no key" })).id;
    relay.onCall = call => (call.op === "durable_submit" ? "drop" : undefined);
    await assert.rejects(client.submit(thread, { text: "no requestId" }), (error: unknown) => error instanceof HostAway && error.box === "mac");
    relay.onCall = undefined;
    relay.drop(true);
    await until(async () => client.state().state, state => state === "away");
    const started = Date.now();
    await assert.rejects(client.threads(), (error: unknown) => error instanceof HostAway && error.message === "mac is offline");
    assert.ok(Date.now() - started < 100, "no wait for a box that is away");
    assert.equal((await client.ping()).ok, false);
    relay.down = false;
    await until(async () => client.state().state, state => state === "up");
  });

  test("a feed row is acked only after the handler finished, and the cursor is saved for the next welcome", async () => {
    const order: string[] = [];
    client.onFeed = async row => {
      await new Promise(resolve => setTimeout(resolve, 50));
      order.push(`read ${row.seq}`);
    };
    const row = (seq: number) => ({ seq, thread: "t", conversation: 1, entry: seq, toolCallId: `c${seq}`, toolName: "send_message", requestId: `m:t:c${seq}`, text: "x", at: 1 });
    relay.feed(row(8));
    relay.feed(row(9));
    await until(async () => relay.acks, acks => acks.includes(9));
    assert.deepEqual(order, ["read 8", "read 9"]);
    assert.deepEqual(relay.acks.slice(-2), [8, 9]);
    assert.equal(JSON.parse(readFileSync(join(dir, "relay", "mac.json"), "utf8")).feedAfter, 9);
    relay.feed(row(9));
    await until(async () => relay.acks.filter(a => a === 9).length, n => n === 2);
    assert.deepEqual(order, ["read 8", "read 9"], "a row at or below the cursor is acked without a second read");
    const welcomes = relay.welcomes.length;
    relay.drop();
    await until(async () => relay.welcomes.length, n => n > welcomes);
    assert.equal(relay.welcomes.at(-1), 9);
  });
});

/** The chat server on a fixture box of its own and a fake relay for the box "mac". */
async function startTwoBoxes(name: string) {
  const dataDir = tmp(name);
  const config = { ...readConfig([]), dataDir, port: 0, fixture: true, box: "test-box", ...fixtureFolders(dataDir), hostsFile: join(dataDir, "hosts.json") };
  const local = new FixtureHost();
  local.wordMs = 0;
  seedFixture(local, dataDir);
  const relay = new FakeRelay("mac", TOKEN);
  await relay.listening;
  const remote = new RelayHost({ box: "mac", url: relay.url, token: TOKEN, dataDir, redialWait: fast });
  const host = new MultiHost("test-box", [{ box: "test-box", label: "metal", host: local }, { box: "mac", label: "Mac", host: remote }], dataDir,
    { box: "test-box", platform: "linux", home: config.home, projects: config.projects, agentsDir: config.agentsDir });
  const app = new App(config, host, () => {});
  app.rooms.backoff = () => 20;
  await app.start();
  const server = serve(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async <T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T };
  };
  await until(async () => remote.state().state, state => state === "up");
  return {
    app, relay, remote, call, dataDir,
    posts: async (room: string) => ((await call<TimelinePage>("GET", `/api/c/${room}/items?limit=200`)).body.items as Extract<Item, { kind: "message" }>[]),
    async close() {
      server.closeAllConnections();
      server.close();
      await app.stop();
      await relay.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

describe("agents on another box", () => {
  let s: Awaited<ReturnType<typeof startTwoBoxes>>;
  let agent: AgentSummary;
  before(async () => {
    s = await startTwoBoxes("rooms");
  });
  after(async () => {
    await s.close();
  });

  test("GET /api/agent-hosts lists both boxes, and an agent made on the Mac runs there", async () => {
    const hosts = (await s.call<AgentHostList>("GET", "/api/agent-hosts")).body.hosts;
    assert.deepEqual(hosts.map(h => [h.box, h.label, h.self, h.state]), [["test-box", "metal", true, "up"], ["mac", "Mac", false, "up"]]);
    assert.deepEqual(hosts[1]!.projects, ["/Users/test/src/sieun-pi"]);
    const refused = await s.call("POST", "/api/agents", { name: "Mac agent", host: "mac", cwd: "/Users/test" });
    assert.equal(refused.status, 400, "the Mac's home folder is no project");
    const outside = await s.call("POST", "/api/agents", { name: "Mac agent", host: "mac", cwd: "/opt/elsewhere" });
    assert.equal(outside.status, 400);
    const made = await s.call<AgentSummary>("POST", "/api/agents", { name: "Mac agent", host: "mac" });
    assert.equal(made.status, 200);
    agent = made.body;
    assert.equal(agent.host, "mac");
    assert.equal(agent.hostState, "up");
    assert.ok(s.relay.host.threadsById.has(agent.thread), "the work thread is on the Mac's pi-host");
    const record = s.app.agents.record(agent.id)!;
    assert.equal(record.agentsDir, "/Users/test/.pi/agent/agents");
    const ref = await s.relay.host.docGet(agent.thread, "agent.ref") as { dir: string };
    assert.equal(ref.dir, "/Users/test/.pi/agent/agents/mac-agent");
  });

  test("its brief and memory are read and written through the Mac's relay", async () => {
    const put = await s.call("PUT", `/api/agents/${agent.id}/brief`, { text: "Keep the Mac's crawler green." });
    assert.equal(put.status, 200);
    assert.equal(put.body.brief.text, "Keep the Mac's crawler green.");
    assert.equal(s.relay.files.get("/Users/test/.pi/agent/agents/mac-agent/brief.md"), "Keep the Mac's crawler green.");
    const memory = await s.call("POST", `/api/agents/${agent.id}/memory`, { title: "Mac sleeps", content: "The Mac sleeps at night." });
    assert.equal(memory.status, 200);
    assert.equal(memory.body.memory.count, 1);
    const store = JSON.parse(s.relay.files.get("/Users/test/.pi/agent/agents/mac-agent/harness/harness_state.json")!);
    assert.equal(store.entries.memory.mac_sleeps.title, "Mac sleeps");
  });

  test("a DM post goes to a comm thread made on the Mac, and a feed row from the relay is read and acked", async () => {
    const room = agent.room!;
    const sent = await s.call("POST", `/api/c/${room}/send`, { text: "hi from metal", requestId: "mac-1" });
    assert.equal(sent.status, 200);
    await until(() => s.posts(room), page => page.find(p => p.text === "hi from metal")?.send === "sent");
    const comm = s.app.agents.record(agent.id)!.comm![room]!;
    assert.ok(s.relay.host.threadsById.has(comm), "the comm thread is on the Mac");
    assert.equal(inputs(s.relay.host, comm).filter(e => textOf(e).includes("hi from metal")).length, 1);
    s.relay.feed({ seq: 1, thread: comm, conversation: 1, entry: 1, toolCallId: "c1", toolName: "send_message", requestId: `m:${comm}:c1`, text: "x", at: Date.now() });
    await until(async () => s.relay.acks, acks => acks.includes(1));
    await until(() => s.posts(room), page => page.some(p => p.author.id === agent.id));
  });

  test("while the Mac is away, posts read as queued and wait with no retries; back, they go as one bundled input with their ages", async () => {
    const room = agent.room!;
    const comm = s.app.agents.record(agent.id)!.comm![room]!;
    s.relay.drop(true);
    await until(async () => s.remote.state().state, state => state === "away");
    const before = s.relay.calls.length;
    const texts = ["first while away", "second while away", "third while away"];
    for (const [i, text] of texts.entries()) assert.equal((await s.call("POST", `/api/c/${room}/send`, { text, requestId: `away-${i}` })).status, 200);
    const queued = await until(() => s.posts(room), page => texts.every(t => page.find(p => p.text === t)?.sendError === "queued, mac is offline"));
    for (const text of texts) {
      const post = queued.find(p => p.text === text)!;
      assert.equal(post.send, "sending");
      assert.equal(post.deliveries[0]!.state, "queued");
    }
    const listed = await until(async () => (await s.call<AgentSummary[]>("GET", "/api/agents")).body.find(a => a.id === agent.id), a => a?.hostState === "away");
    assert.equal(listed!.host, "mac", "the agent stays listed from the Mac's last thread list");
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(s.relay.calls.length, before, "nothing reaches the relay while the box is away");
    const stored = s.app.agentStore.postsOf(room).filter(p => texts.includes(p.text));
    assert.ok(stored.every(p => p.delivery!.attempts === 0), "an away box costs no delivery attempt");

    s.relay.down = false;
    await until(() => s.posts(room), page => texts.every(t => page.find(p => p.text === t)?.send === "sent"));
    const bundles = inputs(s.relay.host, comm).filter(e => textOf(e).includes("while away"));
    assert.equal(bundles.length, 1, "one input for the three posts");
    const text = (bundles[0]!.model![0]!.content as { text: string }[])[0]!.text;
    assert.match(text, /^\[3 posts the owner wrote while mac was offline go together in this one input, oldest first\]/);
    for (const [i, t] of texts.entries()) assert.match(text, new RegExp(`\\[${i + 1} of 3, written \\d+ min ago at \\d\\d:\\d\\dZ\\]\\n\\n${t}`));
    const first = stored[0]!;
    const submits = s.relay.calls.filter(c => c.op === "durable_submit" && String(c.args.requestId).startsWith("b:"));
    assert.deepEqual(submits.map(c => c.args.requestId), [`b:${first.id}:${agent.id}`]);
    for (const post of stored) assert.deepEqual(post.delivery!.bundle, { requestId: `b:${first.id}:${agent.id}`, members: stored.map(p => p.id) });
  });

  test("a waiting post to an agent archived meanwhile is dropped with a note", async () => {
    const room = agent.room!;
    s.relay.drop(true);
    await until(async () => s.remote.state().state, state => state === "away");
    await s.call("POST", `/api/c/${room}/send`, { text: "to an archived agent", requestId: "archived-1" });
    await until(() => s.posts(room), page => page.find(p => p.text === "to an archived agent")?.sendError === "queued, mac is offline");
    // The owner archived it on the Mac meanwhile; the Mac's thread list says so once it is back, before the waiting post goes.
    s.relay.host.threadsById.get(agent.thread)!.row.archived = true;
    s.relay.down = false;
    const page = await until(() => s.posts(room), p => p.find(x => x.text === "to an archived agent")?.send === "failed");
    assert.match(page.find(p => p.text === "to an archived agent")!.sendError!, /^dropped, Mac agent was archived while mac was offline$/);
    assert.equal(inputs(s.relay.host, s.app.agents.record(agent.id)!.comm![room]!).filter(e => textOf(e).includes("to an archived agent")).length, 0);
  });
});

describe("a 6 h offline replay", () => {
  test("posts written over 6 h while the Mac sleeps go as one input with their ages, and a retried bundle keeps its members and key", async () => {
    const s = await startTwoBoxes("replay");
    try {
      const agent = (await s.call<AgentSummary>("POST", "/api/agents", { name: "Sleepy", host: "mac" })).body;
      const room = agent.room!;
      await s.call("POST", `/api/c/${room}/send`, { text: "awake", requestId: "awake" });
      await until(() => s.posts(room), page => page.find(p => p.text === "awake")?.send === "sent");
      const comm = s.app.agents.record(agent.id)!.comm![room]!;

      const start = Date.parse("2026-10-30T13:10:00Z");
      mock.timers.enable({ apis: ["Date"], now: start });
      s.relay.drop(true);
      await until(async () => s.remote.state().state, state => state === "away");
      const hours = [0, 2, 5];
      for (const h of hours) {
        mock.timers.setTime(start + h * 3600_000);
        await s.call("POST", `/api/c/${room}/send`, { text: `night post ${h}`, requestId: `night-${h}` });
      }
      await until(() => s.posts(room), page => hours.every(h => page.find(p => p.text === `night post ${h}`)?.sendError === "queued, mac is offline"));
      const before = s.relay.calls.length;

      // The first try of the bundle meets a pi-host that fails once, so the retry must send the same members under the same key.
      mock.timers.setTime(start + 6 * 3600_000);
      let failed = false;
      s.relay.host.beforeSubmit = (_thread, input) => {
        if (String(input.requestId).startsWith("b:") && !failed) {
          failed = true;
          throw new Error("pi-host restarting");
        }
      };
      s.relay.down = false;
      await until(() => s.posts(room), page => hours.every(h => page.find(p => p.text === `night post ${h}`)?.send === "sent"));
      s.relay.host.beforeSubmit = undefined;
      assert.equal(s.relay.calls.slice(0, before).filter(c => c.op === "durable_submit" && JSON.stringify(c.args).includes("night post")).length, 0, "nothing tried while away");
      const tries = s.relay.calls.filter(c => c.op === "durable_submit" && String(c.args.requestId).startsWith("b:"));
      assert.equal(tries.length, 2, "one failed try and one retry");
      assert.equal(tries[0]!.args.requestId, tries[1]!.args.requestId);
      const got = inputs(s.relay.host, comm).filter(e => textOf(e).includes("night post"));
      assert.equal(got.length, 1);
      const text = (got[0]!.model![0]!.content as { text: string }[])[0]!.text;
      assert.match(text, /\[1 of 3, written 6\.0 h ago at 13:10Z\]\n\nnight post 0/);
      assert.match(text, /\[2 of 3, written 4\.0 h ago at 15:10Z\]\n\nnight post 2/);
      assert.match(text, /\[3 of 3, written 1\.0 h ago at 18:10Z\]\n\nnight post 5/);
    } finally {
      mock.timers.reset();
      await s.close();
    }
  });
});
