/**
 * Pinned posts (server/pins.ts): the owner pins a post of a channel or a DM, a thread reply included, the post and the room header carry
 * it, newest pin first, the room's watchers get the post at once, and un-pinning or deleting the post takes it off the list.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/pins.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { ConversationHeader, Item, Principal, TimelinePage } from "../../web/src/lib/api/types.ts";
import type { RoomPost } from "../../server/agent-store.ts";
import { markPin, pinInput, pinLine, pinnedPosts, pinnedSection, pinOf } from "../../server/pins.ts";
import { reactionsLine } from "../../server/reactions.ts";
import { start, type Running } from "./helpers.ts";

type Message = Extract<Item, { kind: "message" }>;

const owner: Principal = { id: "owner", kind: "owner", name: "You", avatar: { initials: "Me", hue: 210 } };

function post(seq: number, extra: Partial<RoomPost> = {}): RoomPost {
  return { id: `p${seq}`, seq, room: "ch_x", author: "owner", text: `post ${seq}`, images: [], at: seq, requestId: `r:${seq}`, ...extra };
}

describe("the pin model", () => {
  test("pinned is a boolean, a second pin changes nothing, and un-pinning keeps the row", () => {
    assert.equal(pinInput({ pinned: false }), false);
    assert.throws(() => pinInput({ pinned: "yes" }), /true to pin it or false to un-pin it/);
    const p = post(1);
    assert.equal(markPin(p, false), undefined);
    p.pinned = markPin(p, true, 5);
    assert.deepEqual(p.pinned, { pinned: true, by: "owner", at: 5 });
    assert.equal(markPin(p, true), undefined);
    assert.deepEqual(markPin(p, false, 6), { pinned: false, by: "owner", at: 6 });
    assert.throws(() => markPin(post(2, { deletedAt: 3 }), true), /deleted/);
  });

  test("the list holds pinned live posts, newest pin first", () => {
    const posts = [
      post(1, { pinned: { pinned: true, by: "owner", at: 10 } }),
      post(2, { pinned: { pinned: true, by: "owner", at: 30 } }),
      post(3, { pinned: { pinned: false, by: "owner", at: 40 } }),
      post(4, { pinned: { pinned: true, by: "owner", at: 50 }, deletedAt: 60 }),
      post(5),
    ];
    assert.deepEqual(pinnedPosts(posts).map(p => p.id), ["p2", "p1"]);
    assert.deepEqual(pinOf(() => owner, posts[0]!), { pinned: { by: owner, at: 10 } });
    assert.deepEqual(pinOf(() => owner, posts[3]!), {}, "a deleted post reads unpinned");
  });

  test("agents read a pinned post's flag after its reactions, and the room's pins under the post they answer", () => {
    const posts = [post(1, { pinned: { pinned: true, by: "owner", at: 10 }, reactions: [{ emoji: "👍", by: "owner", at: 1 }] }), post(2)];
    assert.equal(pinLine(posts[0]!), "[pinned by Sieun (owner)]");
    assert.equal(reactionsLine(() => owner, posts[0]!), "[reactions: 👍 Sieun (owner)] [pinned by Sieun (owner)]");
    assert.deepEqual(pinnedSection(posts, p => `${p.seq} ${p.text}`), ["", "(pinned in this room)", "1 post 1"]);
    assert.deepEqual(pinnedSection([post(2)], p => p.text), [], "no section while nothing is pinned");
  });
});

describe("pins on the fixture server", () => {
  let s: Running;
  const CH = "ch_cutover";
  const items = async (room: string): Promise<Message[]> => (await s.get<TimelinePage>(`/api/c/${room}/items?limit=200`)).items as Message[];
  const pin = (room: string, postId: string, pinned: unknown) => s.send<{ item: Message; error?: string }>("POST", `/api/c/${room}/posts/${postId}/pin`, { pinned });
  const header = (room: string) => s.get<ConversationHeader>(`/api/c/${room}`);
  before(async () => {
    s = await start({ wordMs: 1 });
  });
  after(async () => {
    await s.close();
  });

  test("the owner pins a channel post and a thread reply, the header lists both newest first, and the watchers see the post", async () => {
    assert.deepEqual((await header(CH)).pins, [], "a room with no pins sends an empty list");
    const posts = s.app.agentStore.postsOf(CH);
    const root = posts.find(p => !p.threadRoot && posts.some(r => r.threadRoot === p.id))!;
    const reply = posts.find(p => p.threadRoot === root.id)!;
    const live = await s.live();
    live.watch(CH);
    await live.waitFor(e => e.type === "status" && e.conversation === CH);

    const on = await pin(CH, root.id, true);
    assert.equal(on.status, 200, on.body.error);
    assert.equal(on.body.item.pinned?.by.id, "owner");
    await live.waitFor(e => e.type === "items" && e.conversation === CH && e.items.some(i => i.id === root.id && i.kind === "message" && !!i.pinned));
    assert.equal((await pin(CH, reply.id, true)).status, 200);
    assert.deepEqual((await header(CH)).pins?.map(i => i.id), [reply.id, root.id]);
    assert.ok((await items(CH)).find(i => i.id === root.id)?.pinned, "the timeline reads it pinned");

    const off = await pin(CH, root.id, false);
    assert.equal(off.body.item.pinned, undefined);
    assert.deepEqual((await header(CH)).pins?.map(i => i.id), [reply.id]);
    const pinnedNow = s.app.agentStore.postsOf(CH).find(p => p.id === reply.id)!;
    const row = s.app.groups.row(CH)!;
    const envelope = s.app.groups.envelope(row, { ...pinnedNow, id: "p99999", seq: 99999, threadRoot: undefined, pinned: undefined });
    assert.match(envelope, new RegExp(`\\(pinned in this room\\)\\n${pinnedNow.seq} .*\\[pinned by Sieun \\(owner\\)\\]$`), "a member's input lists the room's pins");
    await pin(CH, reply.id, false);
    assert.equal((await pin(CH, root.id, "yes")).status, 400);
    assert.equal((await pin(CH, "p999999", true)).status, 404);
    live.close();
  });

  test("a DM post pins too, and deleting it takes it off the list", async () => {
    const sent = await s.send<{ item: Message }>("POST", "/api/c/dm_vent/send", { text: "pin me", requestId: "pin-dm-1" });
    const id = sent.body.item.id;
    assert.equal((await pin("dm_vent", id, true)).status, 200);
    assert.deepEqual((await header("dm_vent")).pins?.map(i => i.id), [id]);
    assert.equal((await s.send("DELETE", `/api/c/dm_vent/posts/${id}`)).status, 200);
    assert.deepEqual((await header("dm_vent")).pins, []);
  });
});
