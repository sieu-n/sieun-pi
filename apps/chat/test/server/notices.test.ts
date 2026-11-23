/**
 * The owner's notices (server/notices.ts): each new post someone else writes goes to every page as a `notice` with why it is for him, a
 * test room's notice goes only to the pages that watch it, and a For you ask whose Remind me comes due goes out as an ask notice.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/notices.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { RoomPost, RoomRow } from "../../server/agent-store.ts";
import { NOTICE_FRESH_MS, noticeReason } from "../../server/notices.ts";
import type { LiveEvent, PostNotice } from "../../web/src/lib/api/types.ts";
import { start, type Running } from "./helpers.ts";

const NOW = 1_800_000_000_000;
const channel: RoomRow = { kind: "channel", id: "ch_1", name: "build", purpose: "", members: [], createdAt: 0, archived: false };
const post = (seq: number, fields: Partial<RoomPost> = {}): RoomPost =>
  ({ id: `p${seq}`, seq, room: "ch_1", author: "ag_vent", text: "hi", images: [], at: NOW, requestId: `r${seq}`, ...fields });

test("a channel post names why it is for the owner, and his own, old, imported and archived posts raise none", () => {
  const root = post(1, { author: "owner" });
  const posts = [root, post(2, { threadRoot: "p1" }), post(3, { mentions: ["owner"] }), post(4, { answers: "p1" }), post(5), post(6, { threadRoot: "p5" })];
  assert.deepEqual(posts.map(p => noticeReason(channel, p, posts, NOW)), [undefined, "thread", "mention", "reply", "post", "post"]);
  const ownerReplied = [...posts, post(7, { author: "owner", threadRoot: "p5" }), post(8, { threadRoot: "p5" })];
  assert.equal(noticeReason(channel, ownerReplied[7]!, ownerReplied, NOW), "thread", "a reply in a thread he replied in");
  assert.equal(noticeReason(channel, ownerReplied[5]!, ownerReplied, NOW), "post", "his later reply does not reach back");
  assert.equal(noticeReason(channel, post(9, { at: NOW - NOTICE_FRESH_MS - 1 }), posts, NOW), undefined);
  assert.equal(noticeReason(channel, post(9, { imported: true }), posts, NOW), undefined);
  assert.equal(noticeReason({ ...channel, archived: true }, post(9), posts, NOW), undefined);
  assert.equal(noticeReason({ kind: "dm", id: "dm_vent", agent: "ag_vent", createdAt: 0, archived: false }, post(9), [], NOW), "dm");
});

describe("notice events", () => {
  let s: Running;
  before(async () => {
    s = await start({ wordMs: 0 });
  });
  after(async () => {
    await s.close();
  });

  const isNotice = (room: string) => (event: LiveEvent): event is Extract<LiveEvent, { type: "notice" }> =>
    event.type === "notice" && event.notice.kind === "post" && event.notice.room === room;
  const agentPost = (room: string, text: string, fields: Partial<RoomPost> = {}) =>
    s.app.agentStore.append({ room, author: "ag_vent", text, images: [], at: Date.now(), requestId: crypto.randomUUID(), ...fields }).post;

  test("an agent's mention of the owner reaches every page with its author, room and text", async () => {
    const room = (await s.send("POST", "/api/rooms", { kind: "channel", name: `notice-${crypto.randomUUID().slice(0, 8)}`, members: [] })).body.id as string;
    const live = await s.live();
    const written = agentPost(room, "@You the  deploy\nfinished", { mentions: ["owner"] });
    const { notice } = await live.waitFor(isNotice(room), 5000);
    assert.equal(notice.kind, "post");
    if (notice.kind !== "post") return;
    assert.deepEqual({ ...notice, author: notice.author.id }, {
      kind: "post", room, roomKind: "channel", roomName: notice.roomName, post: written.id, author: "ag_vent", reason: "mention", at: written.at, images: 0,
      text: "@You the deploy finished",
    } satisfies Omit<PostNotice, "author"> & { author: string });
    assert.match(notice.roomName, /^#notice-/);
  });

  test("a test room's notice goes only to a page that watches the room", async () => {
    const room = (await s.send("POST", "/api/rooms", { kind: "channel", name: `notice-test-${crypto.randomUUID().slice(0, 8)}`, members: [], test: true })).body.id as string;
    const plain = (await s.send("POST", "/api/rooms", { kind: "channel", name: `notice-${crypto.randomUUID().slice(0, 8)}`, members: [] })).body.id as string;
    const watching = await s.live();
    const other = await s.live();
    watching.watch(room);
    // The room's status answers the watch, so the server holds the watch before the post.
    await watching.waitFor(event => event.type === "status" && event.conversation === room, 5000);
    agentPost(room, "done", { mentions: ["owner"] });
    await watching.waitFor(isNotice(room), 5000);
    // A plain room's notice reaches every page after the test room's, and one socket keeps order, so `other` holds every earlier notice once it has this one.
    agentPost(plain, "later", { mentions: ["owner"] });
    await other.waitFor(isNotice(plain), 5000);
    assert.equal(other.events.some(isNotice(room)), false);
  });

  test("a For you ask whose Remind me comes due reaches every page as an ask notice", async () => {
    const item = (await s.app.boards.forYou()).find(i => !i.todo.done)!;
    const live = await s.live();
    await s.app.boards.apply(item.chatId, [{ op: "todo_update", id: item.todo.id, remindAt: new Date(Date.now() + 300).toISOString() }]);
    const { notice } = await live.waitFor((e): e is Extract<LiveEvent, { type: "notice" }> => e.type === "notice" && e.notice.kind === "ask", 5000);
    assert.deepEqual(notice.kind === "ask" && { chatId: notice.chatId, todo: notice.todo, chatName: notice.chatName }, { chatId: item.chatId, todo: item.todo.id, chatName: item.chatName });
    await s.app.boards.apply(item.chatId, [{ op: "todo_update", id: item.todo.id, remindAt: null }]);
  });
});
