/**
 * A server start sends Meilisearch only the posts that changed since it got them. Until 11-24 every start sent all 7,441 posts again, and
 * each search before Meilisearch had indexed them held every post in memory and named each one in its filter: 121 of that day's 463
 * searches, 138 ms at the median against 20 ms for the rest (~/work/p279-search/p279-meili.md).
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/search-start-posts.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { type OwnMeili, startOwnMeili } from "../../server/meili.ts";
import { type EntryRow, type PostDoc, SearchEngine } from "../../server/search-engine.ts";

let own: OwnMeili;
before(async () => {
  own = await startOwnMeili();
});
after(() => own.stop());

const post = (n: number, text = `a wombat post ${n}`): PostDoc => ({
  id: `p_room_${n}`, source: "post", text, reactions: "", at: 1_000 + n, tier: 0, author: "owner", room: "ch_room", post: `${n}`,
  dm: false, listed: true, ownerPost: true, kind: "room.post", has: [],
});

const row: EntryRow = { thread: "t1", conversation: 1, entryId: 1, kind: "pi.user", author: "owner", at: 500, text: "a wombat entry" };

/** An engine on the shared Meilisearch with this box's one entry and `posts`, as a server builds it at each start. */
function engine(posts: () => PostDoc[], cursors: Map<string, string>): SearchEngine {
  return new SearchEngine({
    connect: async () => own.meili,
    sources: [{ box: "box", atSearch: true, up: () => true, read: cursor => (cursor ? { rows: [], cursor, more: false } : { rows: [row], cursor: "1", more: false }) }],
    allPosts: posts,
    cursors: { get: box => cursors.get(box), set: (box, cursor) => void cursors.set(box, cursor) },
    channelCopy: /^\[#/,
    log: () => undefined,
  });
}

const pendingIds = (one: SearchEngine): string[] => [...(one as unknown as { pending: Map<string, unknown> }).pending.keys()].sort();

test("a start sends only the posts that changed since Meilisearch got them, and a search after it holds no other post in memory", async () => {
  const cursors = new Map<string, string>();
  const posts = Array.from({ length: 50 }, (_, i) => post(i));
  const first = engine(() => posts, cursors);
  await first.settled();
  first.stop();
  assert.equal((await first.search("wombat", { op: "eq", field: "source", value: "post" }, { sort: "recent", limit: 100 })).total, 50);

  const changed = [...posts.slice(0, 49), post(49, "a wombat post 49, edited while the server was down"), post(50)];
  const second = engine(() => changed, cursors);
  await second.start();
  assert.deepEqual(pendingIds(second), ["p_room_49", "p_room_50"]);
  await second.settled();
  const found = await second.search("wombat", { op: "eq", field: "source", value: "post" }, { sort: "recent", limit: 100 });
  assert.equal(found.total, 51);
  assert.match(found.docs.find(doc => doc.id === "p_room_49")!.text, /edited/);
  second.stop();

  const third = engine(() => changed, cursors);
  await third.start();
  assert.deepEqual(pendingIds(third), []);
  third.stop();
});
