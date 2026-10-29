/**
 * DM rooms on the fixture host (server/rooms.ts): an owner post is stored and answered at once, delivered to the agent's work thread once,
 * and the agent's speaking calls come back as its posts through the feed, with nothing lost or doubled across re-reads and restarts.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/rooms.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Item, LiveEvent, Sidebar, TimelinePage } from "../../web/src/lib/api/types.ts";
import { TELL_OWNER_HELD } from "../../web/src/lib/api/shared/chat-feed.ts";
import { FIXTURE_AGENTS as agents, FIXTURE_IDS as ids, seedFixture } from "../../server/fixture/seed.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
import type { ContentBlock, EntryRecord, SubmitInput } from "../../server/host/types.ts";
import { start, until, type Running } from "./helpers.ts";

type Message = Extract<Item, { kind: "message" }>;
const ROOM = "dm_vent";
const posts = async (s: Running, room = ROOM): Promise<Message[]> => (await s.get<TimelinePage>(`/api/c/${room}/items?limit=200`)).items as Message[];
const inputs = (host: FixtureHost, text: string): EntryRecord[] =>
  host.threadsById.get(ids.vent)!.entries.filter(e => e.conversationId === 1 && e.kind === "pi.user" && JSON.stringify(e.model?.[0]?.content).includes(text));

describe("owner posts and the feed", () => {
  let s: Running;
  let host: FixtureHost;
  before(async () => {
    s = await start({ wordMs: 2 });
    host = s.host as FixtureHost;
  });
  after(async () => {
    await s.close();
  });

  const vent = () => s.app.agents.record(agents.vent)!;
  const thread = () => host.threadsById.get(ids.vent)!;
  const assistant = (content: ContentBlock[]) =>
    host.append(thread(), 1, { kind: "pi.assistant", model: [{ role: "assistant", content, provider: "anthropic", model: "claude-opus-5-5", stopReason: "toolUse", timestamp: Date.now() }] });
  const result = (id: string, name: string, text: string, extra: { isError?: boolean; details?: Record<string, unknown> } = {}) =>
    host.append(thread(), 1, { kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: extra.isError ?? false, ...(extra.details ? { details: extra.details } : {}), timestamp: Date.now() }] });
  const typed = (text: string) => host.append(thread(), 1, { kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }] });
  const told = (id: string, text: string, why?: string) => {
    assistant([{ type: "toolCall", id, name: "tell_owner", arguments: { text, ...(why ? { why } : {}) } }]);
    return result(id, "tell_owner", "told the owner");
  };

  test("the seeded room reads as posts with a why, a work link and a job pill", async () => {
    const page = await posts(s);
    const found = page.find(p => p.text.startsWith("The job found two relay errors"))!;
    assert.equal(found.why, "done");
    assert.match(found.work?.around ?? "", /^e\d+$/);
    assert.equal(found.work?.conversation, ids.vent);
    assert.equal(found.jobs?.length, 1);
    assert.match(found.jobs![0]!.name, /canary logs/);
    const header = await s.get(`/api/c/${ROOM}`);
    assert.equal(header.workThread, ids.vent);
    assert.equal(header.agent.id, agents.vent);
    assert.deepEqual(header.members.map((m: any) => m.principal.id), ["owner", agents.vent]);
    assert.equal(header.readSeq, 9);
    const row = (await s.get<Sidebar>("/api/sidebar")).dms.find(c => c.id === ROOM)!;
    assert.equal(row.unread, 1, "the agent's post after the read mark");
  });

  test("a post answers at once, reaches the thread once for one requestId, and the agent's answer comes back as its posts", async () => {
    const live = await s.live();
    live.watch(ROOM);
    await live.waitFor(e => e.type === "status" && e.conversation === ROOM);
    const text = `hello room ${Date.now()}`;
    const first = await s.send("POST", `/api/c/${ROOM}/send`, { text, requestId: "room-1" });
    assert.equal(first.status, 200);
    assert.equal(first.body.item.requestId, "room-1");
    assert.match(first.body.item.id, /^p\d+$/);
    const again = await s.send("POST", `/api/c/${ROOM}/send`, { text, requestId: "room-1" });
    assert.equal(again.body.item.id, first.body.item.id, "the same requestId answers the first post");
    const answered = await until(() => posts(s), page => page.filter(p => p.author.id === agents.vent && p.text.includes(text)).length > 0);
    const mine = answered.filter(p => p.author.id === "owner" && p.text === text);
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.send, "sent");
    assert.equal(mine[0]!.deliveries[0]!.state, "delivered");
    assert.equal(inputs(host, text).length, 1, "pi-host has the input once");
    const replies = await until(() => posts(s), page => page.filter(p => p.author.id === agents.vent && p.seq! > mine[0]!.seq!).length === 2);
    assert.deepEqual(replies.filter(p => p.seq! > mine[0]!.seq!).map(p => p.text), [`Got it. You said: "${text}".`, "I checked the canary and the relay, and both answer."]);
    await live.waitFor(e => e.type === "status" && e.conversation === ROOM && e.status === "working");
    await live.waitFor((e: LiveEvent) => e.type === "items" && e.conversation === ROOM && e.items.some(i => i.kind === "message" && i.text === "I checked the canary and the relay, and both answer." && i.author.id === agents.vent));
    live.close();
  });

  test("a held or refused tell_owner and a plain input a job wrote into the thread post nothing, and jobs attach to the turn's post", async () => {
    const before = (await posts(s)).length;
    typed(`Test from the apps/chat build job ${Date.now()}`);
    assistant([{ type: "toolCall", id: "c_held", name: "tell_owner", arguments: { text: "held text" } }]);
    result("c_held", "tell_owner", `${TELL_OWNER_HELD}. The owner did not start this turn.`);
    assistant([{ type: "toolCall", id: "c_err", name: "tell_owner", arguments: { text: "refused text" } }]);
    result("c_err", "tell_owner", "Not sent, a wiki: link in it opens no page.", { isError: true });
    assistant([{ type: "toolCall", id: "c_job", name: "subagent", arguments: { task: "x" } }]);
    result("c_job", "subagent", "started", { details: { conversationId: 777 } });
    told("c_ok", "Sent with a job.", "update");
    result("c_spawn", "ipython", "spawned", { details: { conversations: [778, 779] } });
    await s.app.rooms.feed(vent());
    const page = await posts(s);
    const added = page.slice(before);
    assert.deepEqual(added.map(p => [p.author.id, p.text]), [[agents.vent, "Sent with a job."]]);
    assert.equal(added[0]!.why, "update");
    assert.deepEqual(added[0]!.jobs!.map(j => j.conversation), [`${ids.vent}:777`, `${ids.vent}:778`, `${ids.vent}:779`]);

    // The same entries read again land nothing twice: the same toolCallId.
    const cursor = s.app.agentStore.rooms.feed[agents.vent]!;
    cursor.entry -= 12;
    await s.app.rooms.feed(vent());
    assert.equal((await posts(s)).length, page.length);
  });

  test("a turn a channel post started speaks to the channel, not the DM", async () => {
    const before = (await posts(s)).length;
    host.append(thread(), 1, { kind: "agent.message", model: [{ role: "user", content: [{ type: "text", text: "[#pi-cutover · post 9 from You (owner)] status?" }], timestamp: Date.now() }], data: { from: "owner", via: "#pi-cutover" } });
    assistant([{ type: "toolCall", id: "c_chan", name: "send_message", arguments: { text: "for the channel" } }]);
    result("c_chan", "send_message", "Sent.");
    // A check-in turn after it speaks to the owner again.
    host.append(thread(), 1, { kind: "agent.message", model: [{ role: "user", content: [{ type: "text", text: "[check-in] Read your board." }], timestamp: Date.now() }], data: { from: "board", via: "check-in" } });
    told("c_check", "One step moved.");
    await s.app.rooms.feed(vent());
    assert.deepEqual((await posts(s)).slice(before).map(p => p.text), ["One step moved."]);
  });

  test("read marks, retry and the routes by agent id", async () => {
    const page = await posts(s);
    await s.send("POST", `/api/c/${ROOM}/read`, { seq: page.at(-1)!.seq });
    assert.equal((await s.get<Sidebar>("/api/sidebar")).dms.find(c => c.id === ROOM)!.unread, 0);
    assert.equal((await s.send("POST", `/api/c/${ROOM}/send/room-1/retry`)).body.item.deliveries[0].state, "delivered");
    assert.equal((await s.send("DELETE", `/api/c/${ROOM}/send/room-1`)).status, 400);
    assert.equal((await s.get(`/api/agents/${agents.vent}/board`)).board.plan[0].id, "p1");
    assert.deepEqual((await s.get(`/api/agents/${agents.vent}/board`)).board, (await s.get(`/api/threads/${ids.vent}/board`)).board);
    assert.equal((await s.send("POST", "/api/dms", { agent: ids.vent })).body.id, ROOM);
    assert.equal((await s.get<any[]>("/api/dms")).length, 5);
    const older = await s.get<TimelinePage>(`/api/c/${ROOM}/items?limit=3`);
    assert.equal(older.items.length, 3);
    const above = await s.get<TimelinePage>(`/api/c/${ROOM}/items?before=${older.older}&limit=3`);
    assert.equal(above.items.at(-1)!.id, `p${Number(older.older!.slice(1)) - 1}`);
  });
});

describe("restarts", () => {
  test("a pi-host down for six tries (31.5 s at the real backoff) across a chat restart loses and doubles nothing", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "apps-chat-rooms-restart-"));
    const host = new FixtureHost();
    host.wordMs = 0;
    seedFixture(host, dataDir);
    let down = true;
    let failures = 0;
    host.beforeSubmit = (_thread: string, input: SubmitInput) => {
      if (!down || !input.requestId?.startsWith("d:")) return;
      failures += 1;
      // pi-host comes back after the delivery failed six times, which the real backoff (0.5, 1, 2, 4, 8, 16 s) spreads over 31.5 s.
      if (failures >= 6) down = false;
      throw new Error("connect ENOENT /run/user/1000/pi-host/host.sock");
    };
    const entries = host.entries.bind(host);
    host.entries = async (...args) => {
      if (down) throw new Error("connect ENOENT /run/user/1000/pi-host/host.sock");
      return entries(...args);
    };
    const text = `while pi-host restarts ${Date.now()}`;
    try {
      const first = await start({ host, dataDir });
      first.app.rooms.backoff = () => 20;
      const sent = await first.send("POST", `/api/c/${ROOM}/send`, { text, requestId: "restart-room-1" });
      assert.equal(sent.status, 200);
      assert.equal(sent.body.item.send, "sending");
      await until(() => Promise.resolve(failures), n => n >= 3);
      await first.close();

      const second = await start({ host, dataDir });
      second.app.rooms.backoff = () => 20;
      try {
        await until(() => posts(second), page => page.filter(p => p.author.id === agents.vent && p.text.includes(text)).length > 0);
        const page = await until(() => posts(second), p => p.filter(x => x.author.id === agents.vent && x.text === "I checked the canary and the relay, and both answer.").length >= 1);
        assert.equal(page.filter(p => p.author.id === "owner" && p.text === text).length, 1);
        assert.equal(inputs(host, text).length, 1);
        assert.equal(page.filter(p => p.text.includes(text) && p.author.id === agents.vent).length, 1);
      } finally {
        await second.close();
      }

      // A third start reads the same thread from its saved cursor and adds nothing.
      const third = await start({ host, dataDir });
      try {
        const count = (await posts(third)).length;
        await third.app.rooms.feed(third.app.agents.record(agents.vent)!);
        assert.equal((await posts(third)).length, count);
      } finally {
        await third.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
