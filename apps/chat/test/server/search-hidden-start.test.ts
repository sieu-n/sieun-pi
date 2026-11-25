/**
 * A start keeps the hidden threads the last server flagged, and marks a newly hidden thread without waiting for its own sends, which carry
 * `hidden` already. Until p279 a start began with none flagged and waited for every send it made first, and each search meanwhile named all
 * 3,000 hidden threads: 125 KB of filter that held his search 6 s after the start at 11:27:47Z on 11-25 91 ms (~/work/p279-search/held).
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/search-hidden-start.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { type Meili, type OwnMeili, startOwnMeili } from "../../server/meili.ts";
import { and, eq, type EntryRow, filterText, type PostDoc, SearchEngine } from "../../server/search-engine.ts";

let own: OwnMeili;
before(async () => {
  own = await startOwnMeili();
});
after(() => own.stop());

const rows: EntryRow[] = [
  { thread: "t_comm", conversation: 1, entryId: 1, kind: "pi.user", author: "owner", at: 500, text: "a wombat in a comm thread" },
  { thread: "t_test", conversation: 1, entryId: 1, kind: "pi.user", author: "owner", at: 501, text: "a wombat in a test agent's thread" },
  { thread: "t_work", conversation: 1, entryId: 1, kind: "pi.user", author: "owner", at: 502, text: "a wombat in a work thread" },
];

const post = (text: string): PostDoc => ({
  id: "p_room_1", source: "post", text, reactions: "", at: 1_000, tier: 0, author: "owner", room: "ch_room", post: "1",
  dm: false, listed: true, ownerPost: true, kind: "room.post", has: [],
});

/** Own Meilisearch, with the waits on this engine's own document sends held until `release`, as a Meilisearch seconds behind holds them. */
function slowSends(meili: Meili): { meili: Meili; release: () => void } {
  const mine = new Set<number>();
  let release!: () => void;
  const open = new Promise<void>(resolve => (release = resolve));
  const slow = Object.create(meili) as Meili;
  slow.put = async (uid, docs) => {
    const task = await meili.put(uid, docs);
    mine.add(task.taskUid);
    return task;
  };
  slow.waitTask = async task => {
    if (mine.has(task.taskUid)) await open;
    return meili.waitTask(task);
  };
  return { meili: slow, release };
}

function engine(hidden: readonly string[], text: string, store: { cursors: Map<string, string>; flagged: string[] }, meili: Meili): SearchEngine {
  const one = new SearchEngine({
    connect: async () => meili,
    sources: [{ box: "box", atSearch: true, up: () => true, read: cursor => (cursor ? { rows: [], cursor, more: false } : { rows, cursor: "1", more: false }) }],
    allPosts: () => [post(text)],
    cursors: { get: box => store.cursors.get(box), set: (box, cursor) => void store.cursors.set(box, cursor) },
    flagged: { get: () => store.flagged, set: threads => void (store.flagged = [...threads]) },
    channelCopy: /^\[#/,
    log: () => undefined,
  });
  one.hiddenThreads = () => hidden;
  return one;
}

const entries = (one: SearchEngine) => and(eq("source", "entry"), ...one.hiddenFilter());
const within = <T>(work: Promise<T>, ms: number) =>
  Promise.race([work.then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), ms))]);

test("a start names no flagged thread in its filter, and marks a newly hidden thread while its own sends wait in Meilisearch", async () => {
  const store = { cursors: new Map<string, string>(), flagged: [] as string[] };
  const first = engine(["t_comm"], "a wombat post", store, own.meili);
  await first.settled();
  await first.flagHidden();
  first.stop();
  assert.deepEqual(store.flagged, ["t_comm"]);

  // The next server hides the test agent's thread too, and its start sends the post edited while no server ran.
  const slow = slowSends(own.meili);
  const second = engine(["t_comm", "t_test"], "a wombat post, edited", store, slow.meili);
  try {
    await second.start();
    const filter = filterText(entries(second));
    assert.ok(!filter.includes("t_comm"), `the start named the flagged thread: ${filter}`);
    assert.ok(await within(second.flagHidden(), 5_000), "marking the newly hidden thread waited for the start's own send");
    const after = filterText(entries(second));
    assert.ok(!after.includes("t_test") && !after.includes("t_comm"), `a marked thread is still named: ${after}`);
    const found = await second.search("wombat", entries(second), { sort: "recent", limit: 100 });
    assert.deepEqual(found.docs.map(doc => doc.source === "entry" && doc.threads[0]), ["t_work"]);
    assert.equal(found.total, 1);
    assert.deepEqual([...store.flagged].sort(), ["t_comm", "t_test"]);
  } finally {
    slow.release();
    second.stop();
  }
});

test("a send flagged before a thread became hidden is waited for before the thread counts as marked", async () => {
  const store = { cursors: new Map<string, string>(), flagged: [] as string[] };
  const first = engine([], "a wombat post", store, own.meili);
  await first.settled();
  first.stop();
  const slow = slowSends(own.meili);
  let hidden: readonly string[] = [];
  const one = engine([], "a wombat post, edited", store, slow.meili);
  one.hiddenThreads = () => hidden;
  try {
    await one.start();
    await one.flagHidden();
    hidden = ["t_work"];
    assert.equal(await within(one.flagHidden(), 1_000), false, "the thread counted as marked before the send that flagged it otherwise landed");
    assert.ok(filterText(entries(one)).includes("t_work"));
  } finally {
    slow.release();
    one.stop();
  }
});
