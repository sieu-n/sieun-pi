/**
 * The comm and work split (apps/chat/docs/agent-model.md, phase 4) on the fixture host: the server makes each agent's comm thread in its DM
 * and its rooms before any post, also for an agent made or added to a room later, every owner post lands on it as the owner's turn, the
 * feed moves from the work thread to the comm thread once, and a comm thread shows in no list but opens by its id.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/comm.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { AgentSummary, ConversationHeader, ConversationSummary, Item, LiveEvent, SearchResult, Sidebar, TimelinePage } from "../../web/src/lib/api/types.ts";
import { AGENT_REF_DOC } from "../../server/agent-folder.ts";
import { FIXTURE_AGENTS as agents, FIXTURE_IDS as ids, seedFixture } from "../../server/fixture/seed.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
import type { ContentBlock, SubmitInput } from "../../server/host/types.ts";
import { start, until, type Running } from "./helpers.ts";

type Message = Extract<Item, { kind: "message" }>;
const ROOM = "dm_vent";
const posts = async (s: Running, room = ROOM): Promise<Message[]> => (await s.get<TimelinePage>(`/api/c/${room}/items?limit=200`)).items as Message[];
const commOf = (s: Running, agent = agents.vent, room = ROOM): string | undefined => s.app.agents.record(agent)!.comm?.[room];

/** A tell_owner call and its result in conversation 1 of `thread`. */
function told(host: FixtureHost, thread: string, id: string, text: string): void {
  const t = host.threadsById.get(thread)!;
  const content: ContentBlock[] = [{ type: "toolCall", id, name: "tell_owner", arguments: { text } }];
  host.append(t, 1, { kind: "pi.assistant", model: [{ role: "assistant", content, provider: "anthropic", model: "claude-opus-5-5", stopReason: "toolUse", timestamp: Date.now() }] });
  host.append(t, 1, { kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: id, toolName: "tell_owner", content: [{ type: "text", text: "told the owner" }], isError: false, timestamp: Date.now() }] });
}

describe("delivery to the comm thread", () => {
  test("the server makes the DM's comm thread before any post, each owner post lands on it as the owner's turn, and a restart reuses it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "apps-chat-comm-"));
    const host = new FixtureHost();
    host.wordMs = 0;
    seedFixture(host, dataDir);
    const submits: { thread: string; input: SubmitInput }[] = [];
    host.beforeSubmit = (thread, input) => void submits.push({ thread, input });
    try {
      const first = await start({ host, dataDir });
      const threadsBefore = host.threadsById.size;
      try {
        assert.ok(commOf(first), "the comm thread is there before the first post");
        const workEntries = host.threadsById.get(ids.vent)!.entries.length;
        await first.send("POST", `/api/c/${ROOM}/send`, { text: "first comm post", requestId: "comm-1" });
        await first.send("POST", `/api/c/${ROOM}/send`, { text: "second comm post", requestId: "comm-2" });
        await until(() => posts(first), page => page.filter(p => p.author.id === "owner" && p.send === "sent").length >= 2 && page.some(p => p.text.includes("second comm post") && p.author.id === agents.vent));
        const comm = commOf(first)!;
        assert.ok(comm);
        assert.equal(host.threadsById.size, threadsBefore, "the posts make no thread");
        const row = host.threadsById.get(comm)!.row;
        assert.equal(row.name, "Vent · DM");
        assert.equal(`${row.provider}/${row.modelId}`, "anthropic/claude-opus-5-5");
        assert.equal(row.thinkingLevel, "high");
        const delivered = submits.filter(x => x.input.requestId?.startsWith("d:"));
        assert.deepEqual(delivered.map(x => [x.thread, x.input.text, x.input.ownerTurn]), [[comm, "first comm post", true], [comm, "second comm post", true]]);
        assert.equal(host.threadsById.get(ids.vent)!.entries.length, workEntries, "the work thread gets no input");
        assert.deepEqual(host.threadsById.get(comm)!.docs.get(AGENT_REF_DOC), {
          agent: agents.vent, dir: join(first.app.config.agentsDir, "vent"), role: "comm", room: ROOM, work: ids.vent,
        });
        assert.deepEqual(host.threadsById.get(ids.vent)!.docs.get(AGENT_REF_DOC), { agent: agents.vent, dir: join(first.app.config.agentsDir, "vent"), role: "work", comm });
        const answer = (await posts(first)).find(p => p.author.id === agents.vent && p.text.includes("first comm post"))!;
        assert.equal(answer.work?.conversation, comm, "Show work opens the comm turn");
      } finally {
        await first.close();
      }

      const second = await start({ host, dataDir });
      try {
        const comm = commOf(second)!;
        await second.send("POST", `/api/c/${ROOM}/send`, { text: "after the restart", requestId: "comm-3" });
        await until(() => posts(second), page => page.some(p => p.author.id === agents.vent && p.text.includes("after the restart")));
        assert.equal(host.threadsById.size, threadsBefore, "the restart reuses the comm thread");
        assert.equal(submits.filter(x => x.input.requestId?.startsWith("d:")).at(-1)!.thread, comm);
      } finally {
        await second.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("a comm thread create that timed out after pi-host made the thread, tried again in the next pass and after a restart, leaves one thread", async () => {
    // On 11-23 pi-host's loop froze for 14 min, apps/chat's create for agent factory's #1124-cost-management comm thread timed out three
    // times, and each try made a thread: two stayed behind empty.
    const dataDir = mkdtempSync(join(tmpdir(), "apps-chat-comm-again-"));
    const host = new FixtureHost();
    host.wordMs = 0;
    seedFixture(host, dataDir);
    const create = host.create.bind(host);
    const timedOut = new Set<string>();
    host.create = async opts => {
      const made = await create(opts);
      if (timedOut.has(made.name)) return made;
      timedOut.add(made.name);
      throw new Error("pi-host did not answer durable_create in 120 s");
    };
    const doubles = () => {
      const names = [...host.threadsById.values()].map(t => t.row.name).filter(name => name.includes(" · "));
      return names.filter((name, i) => names.indexOf(name) !== i);
    };
    try {
      const first = await start({ host, dataDir });
      try {
        assert.ok(timedOut.size > 0, "the first pass's creates timed out");
        await first.app.ensureComms();
        assert.deepEqual(doubles(), []);
      } finally {
        await first.close();
      }
      const second = await start({ host, dataDir });
      try {
        const comm = commOf(second);
        assert.ok(comm, "the second try made the comm thread");
        assert.deepEqual(doubles(), []);
        assert.deepEqual([...host.threadsById.values()].filter(t => t.row.name === "Vent · DM").map(t => t.row.id), [comm]);
      } finally {
        await second.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("the feed's switch", () => {
  let s: Running;
  let host: FixtureHost;
  const dataDir = mkdtempSync(join(tmpdir(), "apps-chat-switch-"));
  before(async () => {
    host = new FixtureHost();
    host.wordMs = 0;
    seedFixture(host, dataDir);
    // A DM from before its comm thread: the work thread spoke there, and the feed has not read it yet.
    told(host, ids.vent, "w_before", "said in the work thread before the split");
    s = await start({ host, dataDir });
  });
  after(async () => {
    await s.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("an unread work-thread call posts once, the comm thread's calls post, and the work thread's calls after the switch never do", async () => {
    const comm = commOf(s)!;
    const cursor = s.app.agentStore.rooms.feed[agents.vent]!;
    assert.equal(cursor.thread, comm);

    told(host, ids.vent, "w_after", "said in the work thread after the split");
    told(host, comm, "c_1", "said in the comm thread");
    await s.app.rooms.feed(s.app.agents.record(agents.vent)!);
    // A cursor sent back over the comm thread's entries lands nothing twice.
    cursor.entry = 0;
    await s.app.rooms.feed(s.app.agents.record(agents.vent)!);

    const page = await posts(s);
    assert.equal(page.filter(p => p.text === "said in the work thread before the split").length, 1);
    assert.equal(page.filter(p => p.text === "said in the work thread after the split").length, 0);
    const fromComm = page.filter(p => p.text === "said in the comm thread");
    assert.equal(fromComm.length, 1);
    assert.equal(fromComm[0]!.author.id, agents.vent);
    assert.equal(fromComm[0]!.work?.conversation, comm);
    assert.equal(page.find(p => p.text === "said in the work thread before the split")!.work?.conversation, ids.vent);
  });

  test("the DM's status counts the comm thread, the agent's does not, and both carry the comm thread's own state", async () => {
    const comm = commOf(s)!;
    const thread = host.threadsById.get(comm)!;
    thread.row.status = "running";
    thread.row.updatedAt = Date.now();
    await s.app.threads.refresh();
    try {
      const dm = (await s.get<Sidebar>("/api/sidebar")).dms.find(c => c.id === ROOM)!;
      assert.equal(dm.status, "working");
      assert.equal(dm.commStatus, "working");
      const agent = (await s.get<AgentSummary[]>("/api/agents")).find(a => a.id === agents.vent)!;
      assert.equal(agent.status, "idle", "a status answer does not light the Work pill");
      assert.deepEqual(agent.comm?.find(c => c.room === ROOM), { room: ROOM, thread: comm, status: "working" });
    } finally {
      thread.row.status = "idle";
      await s.app.threads.refresh();
    }
    const dm = (await s.get<Sidebar>("/api/sidebar")).dms.find(c => c.id === ROOM)!;
    assert.equal(dm.commStatus, "idle");
    assert.equal(dm.status, "idle");
  });
});

describe("a comm thread in the lists", () => {
  let s: Running;
  let host: FixtureHost;
  let comm: string;
  const WORD = `quokkaword${Date.now()}`;
  before(async () => {
    s = await start({ wordMs: 0 });
    host = s.host as FixtureHost;
    await s.send("POST", `/api/c/${ROOM}/send`, { text: `find ${WORD} here`, requestId: "lists-1" });
    await until(() => posts(s), page => page.some(p => p.author.id === agents.vent && p.text.includes(WORD)));
    comm = commOf(s)!;
    const thread = host.threadsById.get(comm)!;
    host.addChild(thread, 1, "a job the comm thread started", Date.now());
    await s.app.threads.refresh();
  });
  after(async () => {
    await s.close();
  });

  const mentions = (value: unknown): boolean => JSON.stringify(value).includes(comm);

  test("no list holds it: directory, agents, jobs, the sidebar, conversations and the live hello", async () => {
    const directory = await s.get("/api/directory");
    assert.equal(mentions(directory.jobs), false);
    assert.equal(directory.agents.some((a: AgentSummary) => a.id === comm || a.thread === comm), false);
    assert.equal(mentions(await s.get("/api/jobs?archived=1")), false);
    const listed = await s.get<AgentSummary[]>("/api/agents?archived=1");
    assert.equal(listed.some(a => a.id === comm || a.thread === comm), false);
    const sidebar = await s.get<Sidebar>("/api/sidebar");
    assert.equal(mentions(sidebar.solo), false);
    assert.equal(sidebar.dms.some(c => c.id === comm), false);
    const conversations = await s.get<ConversationSummary[]>("/api/conversations?archived=1");
    assert.equal(conversations.some(c => c.id.startsWith(comm)), false, "the Cmd K Conversations group and the in: picker read this list");
    assert.equal(s.app.agents.unrecorded(s.app.threads.threadsList()).some(t => t.id === comm), false);
    const live = await s.live();
    const hello = await live.waitFor((e: LiveEvent): e is Extract<LiveEvent, { type: "hello" }> => e.type === "hello");
    assert.equal(hello.conversations.some(c => c.id.startsWith(comm)), false);
    assert.equal(hello.agents.some(a => a.id === comm || a.thread === comm), false);
    assert.equal(mentions(hello.jobs), false);
    live.close();
  });

  test("search shows its words as the DM's posts, never as rows of the comm thread", async () => {
    const result = await s.get<SearchResult>(`/api/search?q=${WORD}&limit=50`);
    assert.equal(result.hits.some(h => h.conversation.id.startsWith(comm)), false);
    assert.ok(result.hits.length >= 2, "the owner's post and the agent's answer");
    assert.ok(result.hits.every(h => h.conversation.id === ROOM && h.conversation.kind === "dm" && /^p\d+$/.test(h.messageId)));
    assert.equal(result.total, result.hits.length);
    const owner = await s.get<SearchResult>(`/api/search?q=${WORD}%20from:owner&limit=50`);
    assert.deepEqual(owner.hits.map(h => h.author.id), ["owner"]);
    const inRoom = await s.get<SearchResult>(`/api/search?q=${WORD}%20in:${ROOM}&limit=50`);
    assert.equal(inRoom.hits.length, result.hits.length);
    const around = await s.get<TimelinePage>(`/api/c/${ROOM}/items?around=${owner.hits[0]!.messageId}`);
    assert.equal(around.focus, owner.hits[0]!.messageId);
  });

  test("it opens as a transcript by its id, and the board and agents API read its agent", async () => {
    const header = await s.get<ConversationHeader>(`/api/c/${comm}`);
    assert.equal(header.summary.id, comm);
    assert.equal(header.summary.parent, ROOM);
    assert.equal(header.agent?.id, agents.vent);
    const items = await s.get<TimelinePage>(`/api/c/${comm}/items`);
    assert.ok(items.items.some(i => i.kind === "message" && i.text.includes(WORD)));
    assert.deepEqual((await s.get(`/api/threads/${comm}/board`)).board, (await s.get(`/api/agents/${agents.vent}/board`)).board);
    assert.deepEqual(await s.get(`/api/threads/${comm}/check-in`), await s.get(`/api/agents/${agents.vent}/check-in`));
    assert.equal(s.app.boards.chatId(comm), agents.vent);
    assert.equal((await s.get(`/api/agents/${comm}/folder`)).agent, agents.vent);
    assert.deepEqual(await s.get(`/api/agents/${comm}/config`), await s.get(`/api/agents/${agents.vent}/config`));
  });
});

describe("an agent no one wrote to yet", () => {
  let s: Running;
  let host: FixtureHost;
  before(async () => {
    s = await start({ wordMs: 0 });
    host = s.host as FixtureHost;
  });
  after(async () => {
    await s.close();
  });

  test("every open agent has its comm thread in its DM and each open room it is in, and its work thread holds the work role", async () => {
    for (const record of s.app.agents.list().filter(r => !r.archived)) {
      const rooms = [record.room, ...s.app.groups.memberRooms(record.id).map(r => r.id)];
      for (const room of rooms) assert.ok(record.comm?.[room], `${record.id} has a comm thread in ${room}`);
      const ref = host.threadsById.get(record.workThread)!.docs.get(AGENT_REF_DOC) as { role: string; comm?: string };
      assert.equal(ref.role, "work");
      assert.equal(ref.comm, record.comm![record.room]);
    }
  });

  test("a new test agent gets its DM's comm thread with no post, and one for a channel it joins", async () => {
    const made = await s.send("POST", "/api/agents", { name: "comm probe", test: true });
    assert.equal(made.status, 200);
    await s.app.ensureComms();
    const record = s.app.agents.record(made.body.id)!;
    const dm = record.comm?.[record.room];
    assert.ok(dm, "the DM's comm thread");
    assert.equal(s.app.agentStore.rooms.feed[record.id]!.thread, dm, "the DM's feed reads the comm thread");
    assert.deepEqual(host.threadsById.get(dm)!.docs.get(AGENT_REF_DOC), {
      agent: record.id, dir: join(s.app.config.agentsDir, record.slug), role: "comm", room: record.room, work: record.workThread, test: true,
    });
    assert.equal((host.threadsById.get(record.workThread)!.docs.get(AGENT_REF_DOC) as { comm?: string }).comm, dm);
    assert.equal(host.threadsById.get(dm)!.entries.filter(e => e.kind === "pi.user").length, 0, "no input reached it");

    s.app.groups.addMembers(ids.generalChannel, [record.id]);
    await s.app.threads.refresh();
    await s.app.ensureComms();
    const channel = s.app.agents.record(record.id)!.comm?.[ids.generalChannel];
    assert.ok(channel, "the channel's comm thread");
    assert.equal(host.threadsById.get(channel)!.row.name, "comm probe · #general");
    const threads = host.threadsById.size;
    await s.app.threads.refresh();
    await s.app.ensureComms();
    assert.equal(host.threadsById.size, threads, "a second pass makes nothing");
  });
});
