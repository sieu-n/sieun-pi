/**
 * A channel rename (server/group-rooms.ts `update`): the name is normalized as on create, a blank name or one another open channel holds is
 * a 400, the live socket carries the new name to the room and sidebar rows, and the directory, search, a lookup by name and a post through
 * the id all read it at once. Unarchiving a channel whose name an open channel took meanwhile is refused too, and a create of a taken name is a 400.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/channel-rename.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Room, SearchResult, Sidebar } from "../../web/src/lib/api/types.ts";
import { FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import { start, type Running } from "./helpers.ts";

describe("a channel rename", () => {
  let s: Running;
  before(async () => {
    s = await start({ wordMs: 0 });
  });
  after(async () => {
    await s.close();
  });

  test("normalizes the name, refuses a blank or taken one with a 400, and every reader sees the new name at once", async () => {
    const live = await s.live();
    const renamed = await s.send("PATCH", `/api/rooms/${ids.cutoverChannel}`, { name: "  #Pi Host Cutover " });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.name, "pi-host-cutover");
    await live.waitFor(e => e.type === "room" && e.room.id === ids.cutoverChannel && e.room.name === "pi-host-cutover");
    await live.waitFor(e => e.type === "conversation" && e.conversation.id === ids.cutoverChannel && e.conversation.name === "pi-host-cutover");

    const directory = await s.get<{ rooms: Room[] }>("/api/directory");
    assert.deepEqual(directory.rooms.filter(r => r.kind === "channel").map(r => r.name).sort(), ["general", "pi-host-cutover"]);
    const sidebar = await s.get<Sidebar>("/api/sidebar");
    assert.equal(sidebar.channels.find(c => c.id === ids.cutoverChannel)?.name, "pi-host-cutover");
    assert.equal(s.app.groups.row("#pi-host-cutover")?.id, ids.cutoverChannel);
    assert.equal(s.app.groups.row("pi-cutover"), undefined);

    const word = `rename${Date.now().toString(36)}`;
    const sent = await s.send("POST", `/api/c/${ids.cutoverChannel}/send`, { text: `quiet ${word}`, requestId: `rename-${word}` });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const hits = await s.get<SearchResult>(`/api/search?q=${word}`);
    assert.deepEqual(hits.hits.map(h => [h.conversation.id, h.conversation.name]), [[ids.cutoverChannel, "pi-host-cutover"]]);

    const taken = await s.send("PATCH", `/api/rooms/${ids.cutoverChannel}`, { name: "General" });
    assert.equal(taken.status, 400);
    assert.match(taken.body.error, /#general already exists/);
    const blank = await s.send("PATCH", `/api/c/${ids.cutoverChannel}`, { name: " # " });
    assert.equal(blank.status, 400);
    const same = await s.send("PATCH", `/api/rooms/${ids.cutoverChannel}`, { name: "pi-host-cutover" });
    assert.equal(same.status, 200, "keeping its own name is no clash");

    const back = await s.send("PATCH", `/api/c/${ids.cutoverChannel}`, { name: "pi-cutover" });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(back.body.summary.name, "pi-cutover");
    live.close();
  });

  test("an archived channel whose name an open channel took is not unarchived until one of them is renamed", async () => {
    const first = (await s.send("POST", "/api/rooms", { kind: "channel", name: "relay" })).body as Room;
    assert.equal((await s.send("PATCH", `/api/rooms/${first.id}`, { archived: true })).status, 200);
    const second = await s.send("POST", "/api/rooms", { kind: "channel", name: "relay" });
    assert.equal(second.status, 200, "an archived channel's name is free");
    const duplicate = await s.send("POST", "/api/rooms", { kind: "channel", name: "Relay" });
    assert.equal(duplicate.status, 400, "a create that takes an open channel's name is the owner's mistake, not a server error");
    assert.match(duplicate.body.error, /A channel named #relay already exists/);
    const unarchive = await s.send("PATCH", `/api/rooms/${first.id}`, { archived: false });
    assert.equal(unarchive.status, 400);
    assert.match(unarchive.body.error, /#relay is open/);
    const both = await s.send("PATCH", `/api/rooms/${first.id}`, { name: "relay-old", archived: false });
    assert.equal(both.status, 200, JSON.stringify(both.body));
    assert.equal(both.body.archived, false);
  });
});
