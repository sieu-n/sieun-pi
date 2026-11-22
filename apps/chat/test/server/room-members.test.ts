/**
 * Channel members on the fixture host (group-rooms.ts rule 6): an add makes the new member's comm thread at once, with no post, and shows
 * "You added X" in the timeline; a removed member gets no later post, keeps its comm thread record, and a re-add goes on in that thread;
 * adding twice and removing a non-member change nothing, the owner stays; an agent's set_room_member route adds and removes by name; and a
 * remove stops the member's comm thread turn in the room, running or waiting for a slot, so its answer never lands after the remove.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/room-members.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { ConversationHeader, Item, Room, TimelinePage } from "../../web/src/lib/api/types.ts";
import { FIXTURE_AGENTS as agents, FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import type { FixtureHost } from "../../server/host/fixture.ts";
import { start, until, type Running } from "./helpers.ts";

const lines = async (s: Running, room: string): Promise<string[]> =>
  (await s.get<TimelinePage>(`/api/c/${room}/items?limit=200`)).items.flatMap((i: Item) => (i.kind === "system" ? [i.text] : []));
const memberIds = (room: Room): string[] => room.members.slice(1).map(m => m.principal.id);

describe("channel members", () => {
  let s: Running;
  let room: Room;
  before(async () => {
    s = await start({ wordMs: 0 });
    const made = await s.send("POST", "/api/rooms", { kind: "channel", name: "members-walk", members: [agents.vent], test: true });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    room = made.body;
  });
  after(async () => {
    await s.close();
  });

  test("an add makes the member's comm thread with no post and shows a system line; adding twice changes nothing", async () => {
    const added = await s.send("POST", `/api/rooms/${room.id}/members`, { agents: [agents.crawler] });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.deepEqual(memberIds(added.body), [agents.vent, agents.crawler]);
    const comm = await until(async () => s.app.agents.record(agents.crawler)!.comm?.[room.id], id => id !== undefined);
    assert.ok(comm, "the comm thread came before any post");
    assert.deepEqual(await lines(s, room.id), ["You added Crawler VP"]);

    const again = await s.send("POST", `/api/rooms/${room.id}/members`, { agents: ["Crawler VP"] });
    assert.equal(again.status, 200);
    assert.deepEqual(memberIds(again.body), [agents.vent, agents.crawler]);
    assert.deepEqual(await lines(s, room.id), ["You added Crawler VP"], "no second line");
    assert.equal((await s.get<ConversationHeader>(`/api/c/${room.id}`)).test, true, "a test room's header says so");
  });

  test("a removed member gets no later post and keeps its comm thread, which a re-add reuses; the owner stays", async () => {
    const comm = s.app.agents.record(agents.crawler)!.comm![room.id]!;
    const removed = await s.send("DELETE", `/api/rooms/${room.id}/members/${agents.crawler}`);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual(memberIds(removed.body), [agents.vent]);
    assert.equal(s.app.agents.record(agents.crawler)!.comm?.[room.id], comm);
    const sent = await s.send("POST", `/api/c/${room.id}/send`, { text: "quiet, after the remove", requestId: "members-1" });
    assert.deepEqual(sent.body.deliveries.map((d: { target: string }) => d.target), [agents.vent]);

    assert.equal((await s.send("DELETE", `/api/rooms/${room.id}/members/${agents.crawler}`)).status, 200, "removing a non-member is a no-op");
    assert.equal((await s.send("DELETE", `/api/rooms/${room.id}/members/owner`)).status, 400);
    assert.deepEqual(await lines(s, room.id), ["You added Crawler VP", "You removed Crawler VP"]);

    await s.send("POST", `/api/rooms/${room.id}/members`, { agents: [agents.crawler] });
    assert.equal(s.app.agents.record(agents.crawler)!.comm?.[room.id], comm, "the re-add goes on in the same comm thread");
  });

  test("an agent adds and removes a member by name through its thread, and the line names it", async () => {
    const as = (body: unknown) => s.send("POST", `/api/threads/${ids.vent}/members`, body);
    const add = await as({ room: "#members-walk", agent: "frontend bro", member: true });
    assert.equal(add.status, 200, JSON.stringify(add.body));
    assert.deepEqual(add.body, { room: room.id, agent: agents.frontend, member: true, text: "Added frontend bro to #members-walk; it hears every post there from now on." });
    assert.equal((await as({ room: room.id, agent: agents.frontend, member: true })).body.text, "frontend bro is already in #members-walk; nothing changed.");
    const remove = await as({ room: room.id, agent: "frontend bro", member: false });
    assert.match(remove.body.text, /^Removed frontend bro from #members-walk; later posts no longer reach it/);
    assert.equal((await as({ room: room.id, agent: "frontend bro", member: false })).body.text, "frontend bro is not in #members-walk; nothing changed.");
    assert.deepEqual((await lines(s, room.id)).slice(-2), ["Vent added frontend bro", "Vent removed frontend bro"]);
    assert.equal((await as({ room: "#nope", agent: "frontend bro", member: true })).status, 404);
    assert.equal((await as({ room: room.id, agent: "nobody", member: true })).status, 404);
    assert.equal((await as({ room: room.id, agent: "frontend bro" })).status, 400);
  });
});

describe("a remove mid-turn", () => {
  let s: Running;
  let host: FixtureHost;
  let room: Room;
  before(async () => {
    s = await start({ wordMs: 20 });
    host = s.host as FixtureHost;
    const made = await s.send("POST", "/api/rooms", { kind: "channel", name: "members-stop", members: [agents.crawler], test: true });
    room = made.body;
  });
  after(async () => {
    await s.close();
  });
  const crawlerPosts = () => s.app.agentStore.postsOf(room.id).filter(p => p.author === agents.crawler);

  // The fixture answers "slow" a word a second and holds "queue" two seconds in its turn queue before it starts.
  for (const [what, text, busy] of [
    ["running", "slow check of the relay port", (t: { running: Map<number, unknown> }) => t.running.has(1)],
    ["waiting for a slot", "queue check of the relay port", (t: { places: Map<number, { state: string }> }) => t.places.get(1)?.state === "queued"],
  ] as const) {
    test(`stops the member's comm thread turn ${what}, so no answer lands after the remove`, async () => {
      if (!s.app.groups.row(room.id)!.members.some(m => m.agent === agents.crawler)) await s.send("POST", `/api/rooms/${room.id}/members`, { agents: [agents.crawler] });
      await s.send("POST", `/api/c/${room.id}/send`, { text, requestId: `stop-${what}` });
      const comm = await until(async () => s.app.agents.record(agents.crawler)!.comm?.[room.id], id => id !== undefined);
      const thread = host.threadsById.get(comm!)!;
      await until(async () => busy(thread as never), on => on);
      const removed = await s.send("DELETE", `/api/rooms/${room.id}/members/${agents.crawler}`);
      assert.equal(removed.status, 200);
      await until(async () => thread.running.has(1), on => !on);
      await new Promise(resolve => setTimeout(resolve, 2500));
      await s.app.groups.feed(comm!);
      assert.deepEqual(crawlerPosts(), [], "the stopped turn posted nothing");
      assert.equal((thread.entries.at(-1)?.model?.[0] as { stopReason?: string } | undefined)?.stopReason, "aborted");
    });
  }
});
