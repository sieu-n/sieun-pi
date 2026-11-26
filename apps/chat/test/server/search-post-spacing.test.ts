/**
 * A post change waits for the next spaced send to Meilisearch instead of going at once. On 11-26 Meilisearch on us-metal02 indexed about
 * 99% of the time, with a send every 5 s and one more for each of about 437 post changes a day (~/work/meili-shrink). A search before the
 * send finds the waiting posts in memory, with the exact count (c191).
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/search-post-spacing.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { type OwnMeili, startOwnMeili } from "../../server/meili.ts";
import { type PostDoc, SearchEngine } from "../../server/search-engine.ts";

let own: OwnMeili;
before(async () => {
  own = await startOwnMeili();
});
after(() => own.stop());

const post = (n: number, text = `a quokka post ${n}`): PostDoc => ({
  id: `p_room_${n}`, source: "post", text, reactions: "", at: 1_000 + n, tier: 0, author: "owner", room: "ch_room", post: `${n}`,
  dm: false, listed: true, ownerPost: true, kind: "room.post", has: [],
});

async function until(check: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test("a post change is not sent at once, and a search while it waits finds it with the exact count", async () => {
  const cursors = new Map<string, string>();
  // The rooms as the app holds them, which a search reads when Meilisearch is slow to answer.
  const posts = new Map(Array.from({ length: 10 }, (_, n) => [`p_room_${n}`, post(n)]));
  const change = (id: string, doc: PostDoc | null) => {
    if (doc) posts.set(id, doc);
    else posts.delete(id);
    engine.postChanged(id, doc);
  };
  const engine = new SearchEngine({
    connect: async () => own.meili,
    sources: [{ box: "box", atSearch: true, up: () => true, read: cursor => ({ rows: [], cursor: cursor ?? "0", more: false }) }],
    allPosts: () => [...posts.values()],
    cursors: { get: box => cursors.get(box), set: (box, cursor) => void cursors.set(box, cursor) },
    channelCopy: /^\[#/,
    log: () => undefined,
  });
  try {
    await engine.settled();
    const meili = own.meili;
    const put = meili.put.bind(meili);
    const deleteIds = meili.deleteIds.bind(meili);
    let sends = 0;
    meili.put = (uid, docs) => (sends++, put(uid, docs));
    meili.deleteIds = (uid, ids) => (sends++, deleteIds(uid, ids));
    try {
      // The first change after a quiet spell goes at once; the changes after it wait for the spacing.
      change("p_room_10", post(10));
      await until(() => sends === 1, "the first send");
      change("p_room_11", post(11));
      change("p_room_0", post(0, "a quokka post 0, edited zqedit"));
      change("p_room_1", null);
      await new Promise(resolve => setTimeout(resolve, 500));
      assert.equal(sends, 1, "a post change went to Meilisearch before the spacing passed");

      const where = { op: "eq", field: "source", value: "post" } as const;
      for (const sort of ["recent", "relevance"] as const) {
        const found = await engine.search("quokka", where, { sort, limit: 100 });
        assert.equal(found.total, 11, sort);
        const ids = found.docs.map(doc => doc.id);
        assert.ok(ids.includes("p_room_11") && !ids.includes("p_room_1"), sort);
        assert.match(found.docs.find(doc => doc.id === "p_room_0")!.text, /edited/);
      }
      assert.equal((await engine.search("zqedit", where, { sort: "recent", limit: 10 })).total, 1);
      const page = await engine.search("quokka", where, { sort: "recent", limit: 3 });
      assert.equal(page.total, 11);
      assert.equal(page.docs.length, 3);

      await engine.settled();
      assert.equal(sends, 3, "the waiting put and delete went with one send");
      const sent = await engine.search("quokka", where, { sort: "relevance", limit: 100 });
      assert.equal(sent.total, 11);
      assert.ok(!sent.docs.some(doc => doc.id === "p_room_1"));
      assert.equal((await engine.search("zqedit", where, { sort: "recent", limit: 10 })).total, 1);
    } finally {
      meili.put = put;
      meili.deleteIds = deleteIds;
    }
  } finally {
    engine.stop();
  }
});
