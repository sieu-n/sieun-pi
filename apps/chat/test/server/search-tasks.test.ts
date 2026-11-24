/**
 * Search deletes Meilisearch's tasks a day after they finish, and sends again what a refused send carried. On 11-24 Meilisearch held 80,885
 * finished tasks in a 4.38 GB task file (~/work/meili-memory/meili-stale-docs.md).
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/search-tasks.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { type MeiliTaskState, type OwnMeili, startOwnMeili } from "../../server/meili.ts";
import { type EntryRow, SearchEngine } from "../../server/search-engine.ts";

let own: OwnMeili;
before(async () => {
  own = await startOwnMeili();
});
after(() => own.stop());

const row = (entryId: number, text: string): EntryRow => ({ thread: "t1", conversation: 1, entryId, kind: "pi.user", author: "owner", at: 500 + entryId, text });

/** An engine on the shared Meilisearch whose box holds `rows`, read from the cursor on as pi-host's index reads. */
function engine(rows: EntryRow[]): SearchEngine {
  const cursors = new Map<string, string>();
  return new SearchEngine({
    connect: async () => own.meili,
    sources: [{ box: "box", atSearch: true, up: () => true, read: cursor => ({ rows: rows.slice(Number(cursor ?? 0)), cursor: String(rows.length), more: false }) }],
    allPosts: () => [],
    cursors: { get: box => cursors.get(box), set: (box, cursor) => void cursors.set(box, cursor) },
    channelCopy: /^\[#/,
    log: () => undefined,
  });
}

const allTasks = async () => (await own.meili.call<{ results: (MeiliTaskState & { type: string })[] }>("GET", "/tasks?limit=1000")).results;
const sweep = (one: SearchEngine, now: number) => (one as unknown as { sweepTasks(now: number): Promise<void> }).sweepTasks(now);

test("a sweep deletes only the tasks that finished more than a day before it, and sends no deletion when none did", async () => {
  const one = engine([row(1, "a wombat entry")]);
  await one.settled();
  const kept = await allTasks();
  assert.ok(kept.length > 0);

  await sweep(one, Date.now());
  assert.deepEqual((await allTasks()).map(task => task.uid), kept.map(task => task.uid));

  await sweep(one, Date.now() + 25 * 60 * 60 * 1000);
  const left = await allTasks();
  assert.deepEqual(left.map(task => task.type), ["taskDeletion"]);
  assert.equal((await one.search("wombat", { op: "eq", field: "source", value: "entry" }, { sort: "recent", limit: 10 })).total, 1);
  one.stop();
});

test("a send Meilisearch refused goes again with the next refresh", async () => {
  const rows = [row(1, "a wombat entry")];
  const one = engine(rows);
  await one.settled();
  rows.push(row(2, "a second wombat entry, written while Meilisearch restarts"));
  const put = own.meili.put;
  own.meili.put = async () => {
    throw new Error("connect ECONNREFUSED");
  };
  await assert.rejects(one.refresh(), /ECONNREFUSED/);
  own.meili.put = put;
  await one.settled();
  const all = await own.meili.call<{ results: { text: string }[] }>("POST", "/indexes/search/documents/fetch", { fields: ["text"], limit: 10 });
  assert.equal(all.results.length, 2);
  one.stop();
});
