/**
 * A walk's throwaway agent and room (`POST /api/agents {test: true}`, `POST /api/rooms {test: true}`): no owner list, live event or badge
 * shows them, `?test=1` lists them for the walk, and the room still delivers to its members as any room does.
 * The fixture host reads the thread list while each create is in flight, as pi-host's 2 s poll did on 11-03, when a walk's test DM and
 * channel comm threads showed in the owner's Solo group before the chat had claimed them.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/test-flag.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { AgentSummary, ConversationHeader, ConversationSummary, ForYouItem, LiveEvent, Room, SearchResult, Sidebar } from "../../web/src/lib/api/types.ts";
import { FIXTURE_AGENTS as agents } from "../../server/fixture/seed.ts";
import { start, until, type LiveClient, type Running } from "./helpers.ts";

/** Every id a live event names, so a spec can check that none of them is a test id. */
function idsIn(event: LiveEvent): string[] {
  switch (event.type) {
    case "hello": return [
      ...[...event.sidebar.solo, ...event.sidebar.channels, ...event.sidebar.dms].map(c => c.id),
      ...[...event.agents, ...event.jobs].flatMap(a => [a.id, a.thread, a.room ?? ""]), ...event.conversations.flatMap(c => [c.id, c.agent ?? "", c.parent ?? ""]),
    ];
    case "agent": return [event.agent.id, event.agent.thread, event.agent.room ?? ""];
    case "job": return [event.job.id, event.job.thread, event.job.agent?.id ?? ""];
    case "conversation": return [event.conversation.id, event.conversation.agent ?? "", event.conversation.parent ?? ""];
    case "room": return [event.room.id];
    case "status": return [event.conversation];
    case "jobs": return [event.thread];
    case "board": case "duties": return [event.chatId];
    case "sidebar": return [...event.sidebar.solo, ...event.sidebar.channels, ...event.sidebar.dms].map(c => c.id);
    default: return [];
  }
}

describe("a walk's test agent, test channel and test DM", () => {
  let s: Running;
  let live: LiveClient;
  let testAgent: AgentSummary;
  let plainAgent: AgentSummary;
  let channel: Room;
  let solo: Room;
  let testIds: Set<string>;
  const word = "zebrawalkword";
  before(async () => {
    s = await start({ wordMs: 0 });
    // Each create reads the thread list before it answers, so a new thread is listed before its creator claims it.
    const host = s.host as { create(opts: object): Promise<{ id: string }> };
    const create = host.create.bind(host);
    host.create = async opts => {
      const thread = await create(opts);
      await s.app.threads.refresh();
      return thread;
    };
    live = await s.live();
    testAgent = (await s.send("POST", "/api/agents", { name: "walk throwaway", test: true })).body;
    plainAgent = (await s.send("POST", "/api/agents", { name: "plain new agent" })).body;
    channel = (await s.send("POST", "/api/rooms", { kind: "channel", name: "walk-channel", members: [testAgent.id], test: true })).body;
    solo = (await s.send("POST", "/api/rooms", { kind: "solo", name: "walk room", agenda: `quiet: a walk ${word}`, members: [testAgent.id, agents.vent], test: true })).body;
    await s.send("POST", `/api/c/${testAgent.room}/send`, { text: `hello ${word}`, requestId: "walk-dm-1" });
    await s.send("POST", `/api/c/${channel.id}/send`, { text: `hello channel ${word}`, requestId: "walk-ch-1" });
    const comm = await until(async () => s.app.agents.record(testAgent.id)?.comm, c => !!c?.[testAgent.room!] && !!c?.[channel.id] && !!c?.[solo.id]);
    await s.app.threads.refresh();
    await live.waitFor(e => e.type === "agent" && e.agent.id === plainAgent.id);
    testIds = new Set([testAgent.id, testAgent.room!, testAgent.thread, channel.id, solo.id, ...Object.values(comm!)]);
  });
  after(async () => {
    live.close();
    await s.close();
  });

  const leaks = (ids: string[]) => ids.filter(id => testIds.has(id) || [...testIds].some(t => id.startsWith(`${t}:`)));

  test("the sidebar lists none of them, and the plain agent's DM is there", async () => {
    const sidebar = await s.get<Sidebar>("/api/sidebar");
    const rows = [...sidebar.solo, ...sidebar.channels, ...sidebar.dms];
    assert.ok(rows.some(c => c.id === plainAgent.room));
    assert.deepEqual(leaks(rows.map(c => c.id)), []);
    assert.deepEqual(rows.filter(c => /walk throwaway/.test(c.name)).map(c => c.name), []);
  });

  test("the agent, job, room, directory and conversation lists leave them out, and ?test=1 lists them", async () => {
    for (const path of ["/api/agents", "/api/agents?archived=1", "/api/jobs", "/api/jobs?archived=1", "/api/rooms"]) {
      assert.deepEqual(leaks((await s.get<(AgentSummary | Room)[]>(path)).map(a => a.id)), [], path);
    }
    assert.ok((await s.get<AgentSummary[]>("/api/agents?test=1")).some(a => a.id === testAgent.id));
    const testRooms = (await s.get<Room[]>("/api/rooms?test=1")).map(r => r.id);
    assert.ok(testRooms.includes(channel.id) && testRooms.includes(solo.id));
    const directory = await s.get<{ agents: AgentSummary[]; jobs: AgentSummary[]; rooms: Room[] }>("/api/directory");
    assert.deepEqual(leaks([...directory.agents, ...directory.jobs, ...directory.rooms].map(a => a.id)), []);
    for (const path of ["/api/conversations", "/api/conversations?archived=1"]) {
      const rows = await s.get<ConversationSummary[]>(path);
      assert.deepEqual(leaks(rows.flatMap(c => [c.id, c.agent ?? "", c.parent ?? ""])), [], path);
    }
  });

  test("search and For you find nothing of them", async () => {
    const found = await s.get<SearchResult>(`/api/search?q=${word}`);
    assert.deepEqual(found.hits.map(h => h.conversation.id).filter(id => leaks([id]).length), []);
    assert.equal(found.total, 0);
    const forYou = await s.get<{ items: ForYouItem[] }>("/api/for-you");
    assert.deepEqual(leaks(forYou.items.map(i => i.chatId)), []);
  });

  test("no live event names them, and a new page's hello holds none of them", async () => {
    assert.deepEqual(live.events.flatMap(e => leaks(idsIn(e)).map(id => `${e.type} ${id}`)), []);
    const fresh = await s.live();
    const hello = await fresh.waitFor(e => e.type === "hello");
    fresh.close();
    assert.deepEqual(leaks(idsIn(hello)), []);
  });

  test("they open by id, and the rooms still deliver to the test agent's comm threads", async () => {
    const header = await s.get<ConversationHeader>(`/api/c/${solo.id}`);
    assert.equal(header.agenda, `quiet: a walk ${word}`);
    assert.equal((await s.get<ConversationHeader>(`/api/c/${testAgent.thread}`)).agent?.id, testAgent.id);
    for (const room of [testAgent.room!, channel.id, solo.id]) assert.ok(s.app.agentStore.isTest(s.app.agents.record(testAgent.id)!.comm![room]!));
  });
});
