/**
 * Slack's Mark unread on the fixture host: `POST /api/c/:id/read {unreadFrom}` moves the room's one read mark to just before that post, the
 * sidebar shows the room unread again, the marked post counts even when it is the owner's own or a thread reply, and reading the room
 * again clears it.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/mark-unread.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { ConversationSummary, Sidebar } from "../../web/src/lib/api/types.ts";
import { start, type Running } from "./helpers.ts";

describe("Mark unread", () => {
  let s: Running;
  before(async () => {
    s = await start({ wordMs: 0 });
  });
  after(async () => {
    await s.close();
  });

  const row = async (list: "channels" | "dms", id: string): Promise<ConversationSummary> => (await s.get<Sidebar>("/api/sidebar"))[list].find(c => c.id === id)!;
  const post = async (room: string, text: string, threadRoot?: string): Promise<{ id: string; seq: number }> =>
    (await s.send("POST", `/api/c/${room}/send`, { text, requestId: crypto.randomUUID(), ...(threadRoot ? { threadRoot } : {}) })).body.item;

  test("in a channel, the room reads unread from the marked post, its own posts and a thread reply included, until it is read again", async () => {
    const room = (await s.send("POST", "/api/rooms", { kind: "channel", name: `unread-${Date.now()}`, members: [] })).body.id as string;
    const first = await post(room, "first");
    const second = await post(room, "second");
    const reply = await post(room, "a reply", first.id);
    assert.equal((await row("channels", room)).hasNew, false, "the owner's own posts leave the room read");

    assert.equal((await s.send("POST", `/api/c/${room}/read`, { unreadFrom: second.id })).status, 200);
    const marked = await row("channels", room);
    assert.equal(marked.hasNew, true);
    assert.equal(marked.unread, 0, "a channel counts only mentions, as Slack does");
    assert.equal((await s.get(`/api/c/${room}`)).readSeq, second.seq - 1);

    await s.send("POST", `/api/c/${room}/read`, {});
    assert.equal((await row("channels", room)).hasNew, false);

    await s.send("POST", `/api/c/${room}/read`, { unreadFrom: reply.id });
    assert.equal((await row("channels", room)).hasNew, true, "a thread reply marked unread makes the room unread");
    await s.send("POST", `/api/c/${room}/read`, { seq: reply.seq });
    assert.equal((await row("channels", room)).hasNew, false);

    assert.equal((await s.send("POST", `/api/c/${room}/read`, { unreadFrom: "p999" })).status >= 400, true);
  });

  test("in a DM, the badge counts the marked post and every agent post after it", async () => {
    const room = "dm_vent";
    await s.send("POST", `/api/c/${room}/read`, {});
    assert.equal((await row("dms", room)).unread, 0);
    const mine = await post(room, `mine ${Date.now()}`);
    await s.send("POST", `/api/c/${room}/read`, { unreadFrom: mine.id });
    const marked = await row("dms", room);
    assert.equal(marked.unread >= 1, true);
    assert.equal(marked.hasNew, true);
    await s.send("POST", `/api/c/${room}/read`, {});
    assert.equal((await row("dms", room)).unread, 0);
  });
});
