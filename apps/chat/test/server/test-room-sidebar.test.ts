/**
 * A walk's test Solo room (POST /api/rooms with test: true) never reaches the owner's sidebar: GET /api/sidebar leaves it out from the moment
 * it is made, and no `sidebar`, `conversation` or `room` live event names it. Only the page that has the room open shows its row (2c6a16cb).
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/test-room-sidebar.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Sidebar } from "../../web/src/lib/api/types.ts";
import { start, type Running } from "./helpers.ts";

describe("a test Solo room and the owner's sidebar", () => {
  let s: Running;
  before(async () => {
    s = await start({ wordMs: 0 });
  });
  after(async () => {
    await s.close();
  });

  test("GET /api/sidebar and the live events leave a test Solo room out from its creation", async () => {
    const live = await s.live();
    const agent = (await s.send("POST", "/api/agents", { name: "sidebar walk", test: true })).body;
    const created = await s.send("POST", "/api/rooms", { kind: "solo", agenda: "quiet: a walk's room", members: [agent.id], test: true });
    assert.equal(created.status, 200);
    const room = created.body.id as string;
    const listed = (sidebar: Sidebar) => [...sidebar.solo, ...sidebar.channels, ...sidebar.dms].some(c => c.id === room);
    assert.equal(listed(await s.get<Sidebar>("/api/sidebar")), false, "right after the create");
    // The sidebar event goes out 150 ms after a change (app.ts `sidebarSoon`); wait past it.
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(listed(await s.get<Sidebar>("/api/sidebar")), false, "after the agenda post");
    const named = live.events.filter(e => (e.type === "sidebar" || e.type === "conversation" || e.type === "room") && JSON.stringify(e).includes(room));
    assert.deepEqual(named.map(e => e.type), []);
    live.close();
  });
});
