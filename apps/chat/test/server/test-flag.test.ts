/**
 * A walk's throwaway agent and room (`POST /api/agents {test: true}`, `POST /api/rooms {test: true}`): no owner list, live event or badge
 * shows them, `?test=1` lists them for the walk, and the room still delivers to its members as any room does.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/test-flag.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { AgentSummary, ConversationHeader, ConversationSummary, LiveEvent, Room, Sidebar } from "../../web/src/lib/api/types.ts";
import { FIXTURE_AGENTS as agents } from "../../server/fixture/seed.ts";
import { start, until, type LiveClient, type Running } from "./helpers.ts";

/** Every id a live event names, so a spec can check that none of them is a test id. */
function idsIn(event: LiveEvent): string[] {
  switch (event.type) {
    case "agent": return [event.agent.id, event.agent.room ?? ""];
    case "job": return [event.job.id, event.job.agent?.id ?? ""];
    case "conversation": return [event.conversation.id];
    case "room": return [event.room.id];
    case "status": return [event.conversation];
    case "sidebar": return [...event.sidebar.solo, ...event.sidebar.channels, ...event.sidebar.dms].map(c => c.id);
    default: return [];
  }
}

describe("a walk's test agent and test room", () => {
  let s: Running;
  let live: LiveClient;
  let testAgent: AgentSummary;
  let plainAgent: AgentSummary;
  let room: Room;
  before(async () => {
    s = await start({ wordMs: 0 });
    live = await s.live();
    testAgent = (await s.send("POST", "/api/agents", { name: "walk throwaway", test: true })).body;
    plainAgent = (await s.send("POST", "/api/agents", { name: "plain new agent" })).body;
    room = (await s.send("POST", "/api/rooms", { kind: "solo", name: "walk room", agenda: "quiet: a walk", members: [testAgent.id, agents.vent], test: true })).body;
  });
  after(async () => {
    live.close();
    await s.close();
  });

  test("stay out of the agent list, the sidebar, the room list and the conversation directory, and ?test=1 lists them", async () => {
    const listed = await s.get<AgentSummary[]>("/api/agents");
    assert.ok(listed.some(a => a.id === plainAgent.id));
    assert.ok(!listed.some(a => a.id === testAgent.id));
    assert.ok((await s.get<AgentSummary[]>("/api/agents?test=1")).some(a => a.id === testAgent.id));
    const sidebar = await s.get<Sidebar>("/api/sidebar");
    const rows = [...sidebar.solo, ...sidebar.channels, ...sidebar.dms].map(c => c.id);
    assert.ok(rows.includes(plainAgent.room!));
    assert.ok(!rows.includes(testAgent.room!) && !rows.includes(room.id));
    assert.ok(!(await s.get<Room[]>("/api/rooms")).some(r => r.id === room.id));
    assert.ok((await s.get<Room[]>("/api/rooms?test=1")).some(r => r.id === room.id));
    const directory = (await s.get<ConversationSummary[]>("/api/conversations")).map(c => c.id);
    assert.ok(!directory.includes(room.id) && !directory.includes(testAgent.room!));
  });

  test("send no live event about them, while the plain agent's events go out", async () => {
    await live.waitFor(e => e.type === "agent" && e.agent.id === plainAgent.id);
    const testIds = new Set([testAgent.id, testAgent.room!, testAgent.thread, room.id]);
    assert.deepEqual(live.events.flatMap(idsIn).filter(id => testIds.has(id)), []);
  });

  test("open by id, and the room still delivers its agenda to the test agent's comm thread", async () => {
    const header = await s.get<ConversationHeader>(`/api/c/${room.id}`);
    assert.equal(header.agenda, "quiet: a walk");
    await until(async () => s.app.agents.record(testAgent.id)?.comm?.[room.id], comm => !!comm);
    assert.ok(s.app.agentStore.isTest(s.app.agents.record(testAgent.id)!.comm![room.id]!));
  });
});
