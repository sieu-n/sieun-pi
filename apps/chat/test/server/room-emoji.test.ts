/**
 * A channel's and a sidebar section's emoji icon, as the owner picks them in the sidebar's emoji picker: `PATCH /api/rooms/:id {emoji}` keeps
 * the picked emoji on the room, the sidebar row and the channel header carry it, a name the picker does not know is refused, null takes it off,
 * and it stays after a restart; `PUT /api/sidebar/layout` keeps a section's known emoji and drops an unknown one.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/room-emoji.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { ConversationHeader, Room, SavedLayout, Sidebar } from "../../web/src/lib/api/types.ts";
import type { FixtureHost } from "../../server/host/fixture.ts";
import { start, until, type Running } from "./helpers.ts";

const rowOf = async (s: Running, room: string) => (await s.get<Sidebar>("/api/sidebar")).channels.find(c => c.id === room);

describe("a channel's emoji", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "room-emoji-"));
  let s: Running;
  let room: Room;
  before(async () => {
    s = await start({ dataDir });
    room = (await s.send<Room>("POST", "/api/rooms", { kind: "channel", name: "emoji-test", members: [] })).body;
  });
  after(async () => {
    await s.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("a picked emoji, or its Slack name, is the room's icon on the room, its sidebar row and its header", async () => {
    const set = await s.send<Room>("PATCH", `/api/rooms/${room.id}`, { emoji: "rocket" });
    assert.equal(set.status, 200);
    assert.equal(set.body.emoji, "🚀");
    assert.equal((await until(() => rowOf(s, room.id), row => row?.emoji === "🚀"))?.emoji, "🚀");
    assert.equal((await s.get<ConversationHeader>(`/api/c/${room.id}`)).summary.emoji, "🚀");
    assert.equal((await s.send<Room>("PATCH", `/api/rooms/${room.id}`, { emoji: "🎯" })).body.emoji, "🎯");
  });

  test("a name the picker does not know is refused and leaves the icon as it was", async () => {
    for (const emoji of ["not-an-emoji", "xyzzy", 7]) {
      const refused = await s.send("PATCH", `/api/rooms/${room.id}`, { emoji });
      assert.equal(refused.status, 400, JSON.stringify(emoji));
    }
    assert.equal((await rowOf(s, room.id))?.emoji, "🎯");
  });

  test("the icon stays after a restart, and null takes it off so the row shows # again", async () => {
    const host = s.host as FixtureHost;
    await s.close();
    s = await start({ dataDir, host });
    assert.equal((await rowOf(s, room.id))?.emoji, "🎯");
    const cleared = await s.send<Room>("PATCH", `/api/rooms/${room.id}`, { emoji: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.emoji, undefined);
    assert.equal((await until(() => rowOf(s, room.id), row => row?.emoji === undefined))?.emoji, undefined);
  });
});

describe("a section's emoji", () => {
  let s: Running;
  before(async () => {
    s = await start();
  });
  after(async () => {
    await s.close();
  });

  test("the saved layout keeps a section's known emoji and drops one the picker does not know", async () => {
    const sections = [
      { id: "sec_emoji", name: "Search app", collapsed: false, sort: "name", emoji: "🔎" },
      { id: "sec_named", name: "Research", collapsed: false, sort: "name", emoji: "books" },
      { id: "sec_bogus", name: "Devops", collapsed: false, sort: "name", emoji: "<b>" },
    ];
    const saved = await s.send<SavedLayout>("PUT", "/api/sidebar/layout", { sections });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.sections.map(x => x.emoji), ["🔎", "📚", undefined]);
    const layout = (await until(() => s.get<Sidebar>("/api/sidebar"), sb => sb.layout?.rev === saved.body.rev)).layout!;
    assert.deepEqual(layout.sections.map(x => [x.name, x.emoji]), [["Search app", "🔎"], ["Research", "📚"], ["Devops", undefined]]);
  });
});
