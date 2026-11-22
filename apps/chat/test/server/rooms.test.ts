/**
 * DM rooms on the fixture host (server/rooms.ts): an owner post is stored and answered at once, delivered to the agent's comm thread once,
 * and the comm thread's speaking calls come back as its posts through the feed, with nothing lost or doubled across re-reads and restarts.
 * test/server/comm.test.ts covers the comm thread itself.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/rooms.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Item, LiveEvent, SearchResult, Sidebar, TimelinePage } from "../../web/src/lib/api/types.ts";
import { TELL_OWNER_HELD } from "../../web/src/lib/api/shared/chat-feed.ts";
import { FIXTURE_AGENTS as agents, FIXTURE_IDS as ids, seedFixture } from "../../server/fixture/seed.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
import type { ContentBlock, EntryRecord, SubmitInput } from "../../server/host/types.ts";
import { start, until, type Running } from "./helpers.ts";

type Message = Extract<Item, { kind: "message" }>;
const ROOM = "dm_vent";
const posts = async (s: Running, room = ROOM): Promise<Message[]> => (await s.get<TimelinePage>(`/api/c/${room}/items?limit=200`)).items as Message[];
/** vent's DM comm thread, which its first delivery made. */
const commOf = (s: Running): string => s.app.agents.record(agents.vent)!.comm![ROOM]!;
const inputs = (host: FixtureHost, thread: string, text: string): EntryRecord[] =>
  host.threadsById.get(thread)!.entries.filter(e => e.conversationId === 1 && e.kind === "pi.user" && JSON.stringify(e.model?.[0]?.content).includes(text));

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
  /** The thread the room's feed reads: the comm thread once the first post made it. */
  const thread = () => host.threadsById.get(vent().comm?.[ROOM] ?? ids.vent)!;
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
    assert.equal(inputs(host, commOf(s), text).length, 1, "pi-host has the input once, in the comm thread");
    assert.equal(inputs(host, ids.vent, text).length, 0, "the work thread gets no input");
    const replies = await until(() => posts(s), page => page.filter(p => p.author.id === agents.vent && p.seq! > mine[0]!.seq!).length === 2);
    assert.deepEqual(replies.filter(p => p.seq! > mine[0]!.seq!).map(p => p.text), [`Got it. You said: "${text}".`, "I checked the canary and the relay, and both answer."]);
    assert.deepEqual(replies.filter(p => p.seq! > mine[0]!.seq!).map(p => p.answers), [mine[0]!.id, mine[0]!.id], "each answer names the post its turn started from");
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
    const comm = commOf(s);
    assert.deepEqual(added[0]!.jobs!.map(j => j.conversation), [`${comm}:777`, `${comm}:778`, `${comm}:779`]);

    // The same entries read again land nothing twice: the same toolCallId.
    const cursor = s.app.agentStore.rooms.feed[agents.vent]!;
    cursor.entry -= 12;
    await s.app.rooms.feed(vent());
    assert.equal((await posts(s)).length, page.length);
  });

  test("a result posted with reply_to answers the post it names, not the newer post whose turn it came in", async () => {
    // #sw-factory-build on 11-20: the result for p37 came in the turn after p27 and landed under p27 (c210).
    const asked = await s.send("POST", `/api/c/${ROOM}/send`, { text: `quiet, run the reactions tests ${Date.now()}`, requestId: "reply-to-1" });
    const newer = await s.send("POST", `/api/c/${ROOM}/send`, { text: `quiet, also what is p9? ${Date.now()}`, requestId: "reply-to-2" });
    await until(() => posts(s), page => page.find(p => p.id === newer.body.item.id)?.deliveries[0]?.state === "delivered");
    host.append(thread(), 1, { kind: "agent.message", model: [{ role: "user", content: [{ type: "text", text: "tests pass" }], timestamp: Date.now() }], data: { from: ids.vent, via: "agent" } });
    for (const [id, replyTo] of [["c_rt1", asked.body.item.id], ["c_rt2", `${ROOM}/${asked.body.item.id}`], ["c_rt3", "dm_other/p1"]] as const) {
      assistant([{ type: "toolCall", id, name: "tell_owner", arguments: { text: `result ${id}`, why: "answer", about: "tests", reply_to: replyTo } }]);
      result(id, "tell_owner", "told the owner");
    }
    await s.app.rooms.feed(vent());
    const page = await posts(s);
    const answers = ["c_rt1", "c_rt2", "c_rt3"].map(id => page.find(p => p.text === `result ${id}`)?.answers);
    assert.deepEqual(answers, [asked.body.item.id, asked.body.item.id, undefined], "a reply_to in another room names nothing here");
    assert.equal(s.app.agentStore.postsOf(ROOM).some(p => "replyTo" in p), false, "the post stores no reply_to");
  });

  test("in a turn a report woke, a post with no reply_to answers the newest owner post nothing answers yet", async () => {
    // A blind run on 11-21: the comm thread answered the owner's quick question in the turn its work thread's report woke, with no reply_to.
    const task = await s.send("POST", `/api/c/${ROOM}/send`, { text: `quiet, run the tests ${Date.now()}`, requestId: "open-1" });
    const question = await s.send("POST", `/api/c/${ROOM}/send`, { text: `quiet, where do posts live? ${Date.now()}`, requestId: "open-2" });
    await until(() => posts(s), page => page.find(p => p.id === question.body.item.id)?.deliveries[0]?.state === "delivered");
    // The next run marked the question's thread done in the step whose post tell_owner held as long, before the answer went out.
    await s.send("POST", `/api/c/${ROOM}/posts/${question.body.item.id}/done`, { done: true });
    host.append(thread(), 1, { kind: "agent.message", model: [{ role: "user", content: [{ type: "text", text: "tests pass" }], timestamp: Date.now() }], data: { from: ids.vent, via: "agent" } });
    assistant([
      { type: "toolCall", id: "c_open1", name: "tell_owner", arguments: { text: "in one file per room", why: "answer", about: "posts" } },
      { type: "toolCall", id: "c_open2", name: "tell_owner", arguments: { text: "all tests pass", why: "answer", about: "tests", reply_to: task.body.item.id } },
    ]);
    result("c_open1", "tell_owner", "told the owner");
    result("c_open2", "tell_owner", "told the owner");
    await s.app.rooms.feed(vent());
    const page = await posts(s);
    assert.equal(page.find(p => p.text === "in one file per room")?.answers, question.body.item.id);
    assert.equal(page.find(p => p.text === "all tests pass")?.answers, task.body.item.id);
  });

  test("in a turn a report woke, a post with no reply_to answers the post its round closes", async () => {
    // #dev-app-search-prospect on 11-21: the comm thread took 👀 off the older ask and marked it completed beside its answer, with no reply_to.
    const task = await s.send("POST", `/api/c/${ROOM}/send`, { text: `quiet, is the API serving? ${Date.now()}`, requestId: "closed-1" });
    const question = await s.send("POST", `/api/c/${ROOM}/send`, { text: `quiet, what does it cost? ${Date.now()}`, requestId: "closed-2" });
    await until(() => posts(s), page => page.find(p => p.id === question.body.item.id)?.deliveries[0]?.state === "delivered");
    host.append(thread(), 1, { kind: "agent.message", model: [{ role: "user", content: [{ type: "text", text: "the API serves" }], timestamp: Date.now() }], data: { from: ids.vent, via: "agent" } });
    assistant([
      { type: "toolCall", id: "c_closed1", name: "tell_owner", arguments: { text: "yes, it serves", why: "answer", about: "api" } },
      { type: "toolCall", id: "c_closed2", name: "set_emoji", arguments: { message_id: task.body.item.id, emoji: "eyes", on: false } },
    ]);
    result("c_closed1", "tell_owner", "told the owner");
    await s.app.rooms.feed(vent());
    assert.equal((await posts(s)).find(p => p.text === "yes, it serves")?.answers, task.body.item.id);
  });

  test("a reply_to with the message id of an input queued behind newer posts answers that input's post", async () => {
    // A contact finder blind check on 11-21: p2 and p3 reached the comm thread during a long turn, p2's input entered after p3 was posted,
    // and the answer whose reply_to was p2's message id was stored as answers=p3.
    const older = await s.send("POST", `/api/c/${ROOM}/send`, { text: `quiet, does it work today? ${Date.now()}`, requestId: "queued-1" });
    const newer = await s.send("POST", `/api/c/${ROOM}/send`, { text: `quiet, fast vs thorough? ${Date.now()}`, requestId: "queued-2" });
    await until(() => posts(s), page => page.find(p => p.id === newer.body.item.id)?.deliveries[0]?.state === "delivered");
    const entered = Date.now() + 60_000;
    for (const [i, text] of [older.body.item.text, newer.body.item.text].entries()) {
      for (const e of inputs(host, vent().comm?.[ROOM] ?? ids.vent, text)) e.model![0]!.timestamp = entered + i * 1000;
    }
    await s.app.rooms.feed(vent());
    for (const [id, at] of [["c_q1", entered], ["c_q2", entered + 1000]] as const) {
      assistant([{ type: "toolCall", id, name: "tell_owner", arguments: { text: `queued ${id}`, why: "answer", about: "finder", reply_to: at.toString(36) } }]);
      result(id, "tell_owner", "told the owner");
    }
    await s.app.rooms.feed(vent());
    const page = await posts(s);
    assert.equal(page.find(p => p.text === "queued c_q1")?.answers, older.body.item.id);
    assert.equal(page.find(p => p.text === "queued c_q2")?.answers, newer.body.item.id);
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
    // The delivery's first call makes the comm thread, so each try fails there while pi-host is away.
    const create = host.create.bind(host);
    host.create = async (...args) => {
      if (down) {
        failures += 1;
        // pi-host comes back after the delivery failed six times, which the real backoff (0.5, 1, 2, 4, 8, 16 s) spreads over 31.5 s.
        if (failures >= 6) down = false;
        throw new Error("connect ENOENT /run/user/1000/pi-host/host.sock");
      }
      return create(...args);
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
        assert.equal(inputs(host, commOf(second), text).length, 1);
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

describe("feed marks across a restart", () => {
  test("a row written after the stop's save and a row whose read was cut by the stop each land once, and an unchanged feed is not read", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "apps-chat-rooms-seen-"));
    const host = new FixtureHost();
    host.wordMs = 0;
    seedFixture(host, dataDir);
    const feedReads: string[] = [];
    let gate: { thread: string; release: (error: Error) => void; reached: () => void } | null = null;
    const entries = host.entries.bind(host);
    host.entries = async (thread, opts) => {
      if (opts.conversation === 1 && opts.after !== undefined) feedReads.push(thread);
      if (gate && thread === gate.thread && opts.after !== undefined) {
        const held = gate;
        gate = null;
        held.reached();
        await new Promise<never>((_, reject) => { held.release = reject; });
      }
      return entries(thread, opts);
    };
    const told = (thread: string, id: string, text: string) => {
      const t = host.threadsById.get(thread)!;
      host.append(t, 1, { kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id, name: "tell_owner", arguments: { text } }], provider: "anthropic", model: "claude-opus-5-5", stopReason: "toolUse", timestamp: Date.now() }] });
      host.append(t, 1, { kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: id, toolName: "tell_owner", content: [{ type: "text", text: "told the owner" }], isError: false, timestamp: Date.now() }] });
    };
    const count = (page: Message[], text: string) => page.filter(p => p.author.id === agents.vent && p.text === text).length;
    try {
      const first = await start({ host, dataDir });
      const opened = `make the comm thread ${Date.now()}`;
      await first.send("POST", `/api/c/${ROOM}/send`, { text: opened, requestId: "seen-1" });
      await until(() => posts(first), page => page.some(p => p.author.id === agents.vent && p.text.includes(opened)));
      const comm = commOf(first);
      await first.app.threads.refresh();
      first.app.rooms.poll();
      await first.app.rooms.feed(first.app.agents.record(agents.vent)!);
      await first.close();

      // Written after the first server saved its marks: the thread's updatedAt moves past the kept mark.
      told(comm, "seen-after-save", "written after the save");
      const second = await start({ host, dataDir });
      try {
        await until(() => posts(second), page => count(page, "written after the save") === 1);
        // A read the stop cuts: the poll starts it, pi-host never answers it, and the server stops meanwhile.
        let reached!: () => void;
        const waiting = new Promise<void>(resolve => (reached = resolve));
        gate = { thread: comm, release: () => {}, reached };
        const held = gate;
        told(comm, "seen-cut-by-stop", "read when the stop came");
        await second.app.threads.refresh();
        second.app.rooms.poll();
        await waiting;
        await second.close();
        held.release(new Error("this server stopped"));
      } catch (error) {
        await second.close().catch(() => undefined);
        throw error;
      }

      feedReads.length = 0;
      const third = await start({ host, dataDir });
      try {
        const page = await until(() => posts(third), p => count(p, "read when the stop came") === 1);
        assert.equal(count(page, "written after the save"), 1);
        assert.equal(count(page, "read when the stop came"), 1);
        // The cut read left no mark, so the third start read that feed; a feed with a kept mark and no change was not read.
        assert.ok(feedReads.includes(comm), "the feed whose read the stop cut is read again");
        const fourth = feedReads.length;
        await third.close();
        feedReads.length = 0;
        const again = await start({ host, dataDir });
        try {
          await new Promise(resolve => setTimeout(resolve, 300));
          assert.ok(!feedReads.includes(comm), `an unchanged feed was read again at the start: ${feedReads.join(", ")} (third start read ${fourth})`);
          const last = await posts(again);
          assert.equal(count(last, "written after the save"), 1);
          assert.equal(count(last, "read when the stop came"), 1);
        } finally {
          await again.close();
        }
      } catch (error) {
        await third.close().catch(() => undefined);
        throw error;
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("test sends", () => {
  let s: Running;
  let host: FixtureHost;
  before(async () => {
    s = await start({ wordMs: 0 });
    host = s.host as FixtureHost;
  });
  after(async () => {
    await s.close();
  });

  const BY = "agent factory's DM rooms job";
  const REASON = "It typed this into your composer to check that the DM room delivers; you did not write it.";
  const notices = (): EntryRecord[] =>
    host.threadsById.get(commOf(s))!.entries.filter(e => e.kind === "agent.message" && (e.data as { via?: string }).via === "test-send" && JSON.stringify(e.model?.[0]?.content).includes("[test send from"));
  const stored = (id: string) => s.app.agentStore.postsOf(ROOM).find(p => p.id === id)!;

  test("a delivered post marked as a job's test send reads as the job's in the room, the comm thread and search, and the agent gets one notice", async () => {
    const word = `zebraprobe${Date.now()}`;
    const text = `Phase 2 check ${word}: reply with one line.`;
    const sent = await s.send("POST", `/api/c/${ROOM}/send`, { text, requestId: "probe-1" });
    const id: string = sent.body.item.id;
    await until(() => posts(s), page => page.find(p => p.id === id)?.send === "sent");
    const comm = commOf(s);
    const entry = inputs(host, comm, text)[0]!;
    assert.ok(entry, "the owner's delivery wrote a pi.user input");

    const marked = await s.send("PATCH", `/api/c/${ROOM}/posts/${id}`, { testSend: { by: BY, reason: REASON } });
    assert.equal(marked.status, 200);
    assert.equal(marked.body.item.author.name, BY);
    assert.notEqual(marked.body.item.author.id, "owner");
    assert.deepEqual(marked.body.item.testSend, { by: marked.body.item.author, reason: REASON });
    await until(() => Promise.resolve(stored(id).testSend), mark => mark?.entry === entry.id && mark.notice !== undefined);
    assert.equal((await s.send("PATCH", `/api/c/${ROOM}/posts/${id}`, { testSend: { by: BY, reason: REASON } })).status, 200);
    await s.app.rooms.feed(s.app.agents.record(agents.vent)!);
    const sentNotices = notices();
    assert.equal(sentNotices.length, 1, "one notice for one post, however often it is marked");
    assert.deepEqual(sentNotices[0]!.data, { from: BY, via: "test-send" });
    const noticeText = JSON.stringify(sentNotices[0]!.model?.[0]?.content);
    assert.match(noticeText, new RegExp(`Post ${id} in your DM`));
    assert.match(noticeText, /not from the owner/);

    const inRoom = (await posts(s)).find(p => p.id === id)!;
    assert.equal(inRoom.author.name, BY);
    assert.equal(inRoom.testSend?.reason, REASON);
    assert.equal(inRoom.send, "sent", "the delivery line stays");

    const transcript = await s.get<TimelinePage>(`/api/c/${comm}/items?around=e${entry.id}&limit=6`);
    const input = transcript.items.find(item => item.id === `e${entry.id}`) as Message;
    assert.equal(input.author.name, BY);
    assert.equal(input.testSend?.reason, REASON);

    // Search reads the comm thread's words as the DM's posts.
    const all = await s.get<SearchResult>(`/api/search?q=${word}&limit=100`);
    assert.equal(all.hits.some(h => h.conversation.id === comm), false);
    const hit = all.hits.find(h => h.messageId === id && h.conversation.id === ROOM)!;
    assert.equal(hit.conversation.kind, "dm");
    assert.equal(hit.author.name, BY);
    assert.equal(hit.role, "agent");
    assert.deepEqual(hit.testSend, { reason: REASON });
    const owner = await s.get<SearchResult>(`/api/search?q=${word}%20from:owner&limit=100`);
    assert.equal(owner.hits.some(h => h.messageId === id || h.messageId === `e${entry.id}`), false, "from:owner leaves the test send out");
    assert.equal(owner.total, owner.hits.length);
    const listed = JSON.parse(readFileSync(join(s.app.config.dataDir, "test-sends.json"), "utf8"));
    assert.deepEqual(listed.entries, [{ thread: comm, entry: entry.id, by: BY, reason: REASON }], "pi-history's search reads the same list");
  });

  test("a post marked while its delivery still retries reaches the agent as the job's agent message and needs no notice", async () => {
    const text = `Phase 2 retry check ${Date.now()}`;
    let marked = false;
    host.beforeSubmit = (_thread: string, input: SubmitInput) => {
      if (input.text === text && !marked) throw new Error("connect ENOENT /run/user/1000/pi-host/host.sock");
    };
    s.app.rooms.backoff = () => 30;
    try {
      const sent = await s.send("POST", `/api/c/${ROOM}/send`, { text, requestId: "probe-2" });
      const id: string = sent.body.item.id;
      await until(() => Promise.resolve(stored(id).delivery?.attempts ?? 0), n => n >= 1);
      const before = notices().length;
      assert.equal((await s.send("PATCH", `/api/c/${ROOM}/posts/${id}`, { testSend: { by: BY, reason: REASON } })).status, 200);
      marked = true;
      await until(() => Promise.resolve(stored(id).delivery?.state), state => state === "delivered");
      assert.equal(stored(id).delivery?.testSend, true);
      const got = host.threadsById.get(commOf(s))!.entries.filter(e => (e.kind === "pi.user" || e.kind === "agent.message") && JSON.stringify(e.model?.[0]?.content).includes(text));
      assert.deepEqual(got.map(e => [e.kind, e.data]), [["agent.message", { from: BY, via: "test-send" }]]);
      assert.equal(notices().length, before);
    } finally {
      host.beforeSubmit = undefined;
    }
  });

  test("a mark needs a job and a reason, and only an owner post takes one", async () => {
    const page = await posts(s);
    const own = page.find(p => p.author.id === "owner" && !p.testSend)!;
    const agentPost = page.find(p => p.author.id === agents.vent)!;
    assert.equal((await s.send("PATCH", `/api/c/${ROOM}/posts/${own.id}`, { testSend: { by: BY } })).status, 400);
    assert.equal((await s.send("PATCH", `/api/c/${ROOM}/posts/${own.id}`, { text: "edited" })).status, 400);
    assert.equal((await s.send("PATCH", `/api/c/${ROOM}/posts/${agentPost.id}`, { testSend: { by: BY, reason: REASON } })).status, 400);
    assert.equal((await s.send("PATCH", `/api/c/${ROOM}/posts/p99999`, { testSend: { by: BY, reason: REASON } })).status, 400);
    assert.equal((await posts(s)).find(p => p.id === own.id)!.author.id, "owner");
  });
});
