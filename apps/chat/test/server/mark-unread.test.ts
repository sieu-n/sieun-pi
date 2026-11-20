/**
 * Mark unread on the fixture host (server/keep-unread.ts): `POST /api/c/:id/read {unreadFrom}` makes the room read unread from that post, as
 * Slack's Mark unread does, and keeps the post in Later's Keep unread stack with a reminder at the next 9:00 in Seoul. The reminder marks
 * the room unread from the post again, and a reply, a reaction or checking it off in Later handles it and clears both.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/mark-unread.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { answers, nextMorning } from "../../server/keep-unread.ts";
import type { ConversationSummary, LaterList, Sidebar } from "../../web/src/lib/api/types.ts";
import { start, type Running } from "./helpers.ts";

test("the reminder lands at the next 9:00 in Seoul, which is 00:00 UTC", () => {
  assert.equal(nextMorning(Date.UTC(2026, 10, 20, 14, 0)), Date.UTC(2026, 10, 21, 0, 0), "23:00 KST goes to 9:00 the next day");
  assert.equal(nextMorning(Date.UTC(2026, 10, 20, 23, 30)), Date.UTC(2026, 10, 21, 0, 0), "8:30 KST goes to 9:00 the same day");
  assert.equal(nextMorning(Date.UTC(2026, 10, 21, 0, 0)), Date.UTC(2026, 10, 22, 0, 0), "9:00 KST sharp goes to the next day");
});

test("a reply answers the post in its thread, or a top-level post after it", () => {
  const top = { id: "p5", seq: 5 };
  const reply = { id: "p7", seq: 7, threadRoot: "p5" };
  assert.equal(answers(top, { id: "p9", seq: 9 }), true);
  assert.equal(answers(top, { id: "p4", seq: 4 }), false);
  assert.equal(answers(top, { id: "p9", seq: 9, threadRoot: "p5" }), true);
  assert.equal(answers(top, { id: "p9", seq: 9, threadRoot: "p2" }), false);
  assert.equal(answers(reply, { id: "p9", seq: 9, threadRoot: "p5" }), true);
  assert.equal(answers(reply, { id: "p9", seq: 9 }), false, "a top-level post leaves a thread reply kept unread");
});

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
  const kept = async (room: string, postId: string) => (await s.get<LaterList>("/api/later")).items.find(i => i.id === `${room}:${postId}`);
  const channel = async (): Promise<string> => (await s.send("POST", "/api/rooms", { kind: "channel", name: `unread-${crypto.randomUUID().slice(0, 8)}`, members: [] })).body.id as string;

  test("the room reads unread from the post, the post sits in Keep unread due at 9:00 Seoul, and a plain read clears only the room", async () => {
    const room = await channel();
    await post(room, "first");
    const second = await post(room, "second");
    assert.equal((await row("channels", room)).hasNew, false, "the owner's own posts leave the room read");

    const before = Date.now();
    assert.equal((await s.send("POST", `/api/c/${room}/read`, { unreadFrom: second.id })).status, 200);
    const marked = await row("channels", room);
    assert.equal(marked.hasNew, true);
    assert.equal(marked.unreadFrom, second.id);
    assert.equal(marked.unread, 0, "a channel counts only mentions, as Slack does");
    assert.equal((await s.get(`/api/c/${room}`)).readSeq, second.seq - 1);
    const item = await kept(room, second.id);
    assert.equal(item?.state, "open");
    assert.equal(item?.unread, true);
    assert.equal(item?.remindAt, nextMorning(before));

    await s.send("POST", `/api/c/${room}/read`, {});
    const read = await row("channels", room);
    assert.equal(read.hasNew, false);
    assert.equal(read.unreadFrom, undefined);
    assert.equal((await kept(room, second.id))?.state, "open", "reading the room leaves the post on him in Later");

    assert.equal((await s.send("POST", `/api/c/${room}/read`, { unreadFrom: "p999" })).status >= 400, true);
  });

  test("when the reminder comes due unhandled, the room reads unread from the post again", async () => {
    const room = await channel();
    const target = await post(room, "deal with this tomorrow");
    await post(room, "after it");
    await s.send("POST", `/api/c/${room}/read`, { unreadFrom: target.id });
    await s.send("POST", `/api/c/${room}/read`, {});
    assert.equal((await row("channels", room)).hasNew, false);
    await s.send("PATCH", `/api/later/${encodeURIComponent(`${room}:${target.id}`)}`, { remindAt: Date.now() + 200 });
    await new Promise(resolve => setTimeout(resolve, 700));
    const bumped = await row("channels", room);
    assert.equal(bumped.hasNew, true);
    assert.equal(bumped.unreadFrom, target.id);
    assert.equal((await s.get(`/api/c/${room}`)).readSeq, target.seq - 1);
  });

  test("a reply, a reaction or Mark complete handles the post and clears the room", async () => {
    const room = await channel();
    const a = await post(room, "a");
    const b = await post(room, "b");
    const c = await post(room, "c");

    await s.send("POST", `/api/c/${room}/read`, { unreadFrom: a.id });
    await post(room, "on it", a.id);
    assert.equal((await kept(room, a.id))?.state, "done", "a reply in its thread handles it");
    assert.equal((await row("channels", room)).hasNew, false);

    await s.send("POST", `/api/c/${room}/read`, { unreadFrom: b.id });
    await s.send("POST", `/api/c/${room}/posts/${b.id}/reactions`, { emoji: "+1" });
    assert.equal((await kept(room, b.id))?.state, "done", "a reaction handles it");
    assert.equal((await row("channels", room)).hasNew, false);

    await s.send("POST", `/api/c/${room}/read`, { unreadFrom: c.id });
    await s.send("PATCH", `/api/later/${encodeURIComponent(`${room}:${c.id}`)}`, { state: "done" });
    const done = await row("channels", room);
    assert.equal(done.hasNew, false, "checking it off in Later handles it");
    assert.equal(done.unreadFrom, undefined);
  });

  test("a thread reply marked unread leaves the channel read and sits in Keep unread", async () => {
    const room = await channel();
    const root = await post(room, "root");
    const reply = await post(room, "a reply", root.id);
    const readSeq = (await s.get(`/api/c/${room}`)).readSeq;
    await s.send("POST", `/api/c/${room}/read`, { unreadFrom: reply.id });
    assert.equal((await row("channels", room)).hasNew, false);
    assert.equal((await s.get(`/api/c/${room}`)).readSeq, readSeq);
    assert.equal((await kept(room, reply.id))?.unread, true);
    await post(room, "a new top-level post");
    assert.equal((await kept(room, reply.id))?.state, "open", "a top-level post does not answer a thread reply");
    await post(room, "answered", root.id);
    assert.equal((await kept(room, reply.id))?.state, "done");
  });

  test("in a DM, the badge counts the marked post and every agent post after it", async () => {
    const room = "dm_vent";
    await s.send("POST", `/api/c/${room}/read`, {});
    assert.equal((await row("dms", room)).unread, 0);
    const mine = await post(room, `mine ${Date.now()}`);
    await s.send("POST", `/api/c/${room}/read`, { unreadFrom: mine.id });
    const marked = await row("dms", room);
    assert.equal(marked.unread >= 1, true);
    assert.equal(marked.unreadFrom, mine.id);
    await s.send("POST", `/api/c/${room}/read`, {});
    assert.equal((await row("dms", room)).unread, 0);
  });
});
