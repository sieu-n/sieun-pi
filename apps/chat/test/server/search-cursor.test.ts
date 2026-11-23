/**
 * Show more reads a search's next page after its cursor. The cursor was a bare offset, so a hit written between two pages pushed the hits
 * after it down: the next page brought back one already shown and the last page dropped one (search.spec.ts "Show more" counted 26 and listed
 * 22 while the fixture's agents kept writing "relay"). Each page now reads only what was written before the first one.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { SearchResult } from "../../web/src/lib/api/types.ts";
import { start, type Running } from "./helpers.ts";

let s: Running;
before(async () => {
  s = await start();
});
after(async () => {
  await s.close();
});

async function post(room: string, text: string): Promise<void> {
  const sent = await s.send("POST", `/api/c/${room}/send`, { text, requestId: crypto.randomUUID() });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
}

for (const sort of ["relevance", "recent"] as const) {
  test(`hits written between two pages neither come twice nor push one out (${sort})`, async () => {
    const word = `zq${sort}${Math.random().toString(36).slice(2, 8)}`;
    const room = (await s.send<{ id: string }>("POST", "/api/rooms", { kind: "channel", name: `cursor-${word}`, members: [] })).body.id;
    for (let n = 1; n <= 12; n += 1) await post(room, `${word} post ${n}`);
    // Indexed first: a hit still waiting for Meilisearch ranks among its hits by the engine's own merge, not by Meilisearch's order.
    await s.app.searchEngine.settled();
    const ask = (cursor?: string) => s.get<SearchResult>(`/api/search?${new URLSearchParams({ q: word, sort, limit: "5", ...(cursor ? { cursor } : {}) })}`);
    const pages = [await ask()];
    assert.equal(pages[0]!.total, 12);
    for (let n = 13; n <= 15; n += 1) await post(room, `${word} post ${n}`);
    await s.app.searchEngine.settled();
    while (pages.at(-1)!.nextCursor) pages.push(await ask(pages.at(-1)!.nextCursor));
    const shown = pages.flatMap(page => page.hits.map(hit => hit.snippet.replace(/<\/?mark>/g, "")));
    assert.equal(new Set(shown).size, shown.length, `a hit came twice: ${shown.join(" | ")}`);
    assert.deepEqual(shown.map(text => Number(/post (\d+)/.exec(text)![1])).sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i + 1));
    assert.deepEqual(pages.map(page => page.total), [12, 12, 12]);
    assert.equal((await ask()).total, 15, "a new search counts the hits written since");
  });
}

/**
 * Meilisearch indexes a post a moment after it is written, and the engine merges what it does not hold yet from memory. That merge put the
 * waiting hits among the first page's top ranks, while the next page, read once Meilisearch held them, found them at Meilisearch's own ranks:
 * the results page listed 4 hits twice and never showed 4 others (search-page.spec.ts, 46 of 50 cards on 11-23).
 */
test("hits Meilisearch indexes between two pages neither come twice nor push one out", async () => {
  const word = `zqwait${Math.random().toString(36).slice(2, 8)}`;
  const room = (await s.send<{ id: string }>("POST", "/api/rooms", { kind: "channel", name: `cursor-${word}`, members: [] })).body.id;
  for (let n = 1; n <= 8; n += 1) await post(room, `${word} post ${n}`);
  await s.app.searchEngine.settled();
  // Meilisearch takes the next posts only once the first page was read.
  const meili = (s.app.searchEngine as unknown as { meili: { put: (uid: string, docs: string) => Promise<{ taskUid: number }> } }).meili;
  const put = meili.put.bind(meili);
  const held: (() => void)[] = [];
  meili.put = (uid, docs) => new Promise(resolve => held.push(() => resolve(put(uid, docs))));
  try {
    for (let n = 9; n <= 12; n += 1) await post(room, `${word} post ${n}`);
  } finally {
    meili.put = put;
  }
  const ask = (cursor?: string) => s.get<SearchResult>(`/api/search?${new URLSearchParams({ q: word, limit: "5", ...(cursor ? { cursor } : {}) })}`);
  const pages = [await ask()];
  assert.equal(pages[0]!.total, 12);
  for (const release of held) release();
  await s.app.searchEngine.settled();
  while (pages.at(-1)!.nextCursor) pages.push(await ask(pages.at(-1)!.nextCursor));
  const shown = pages.flatMap(page => page.hits.map(hit => Number(/post (\d+)/.exec(hit.snippet.replace(/<\/?mark>/g, ""))![1])));
  assert.equal(new Set(shown).size, shown.length, `a hit came twice: ${shown.join(" ")}`);
  assert.deepEqual([...shown].sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.deepEqual(pages.map(page => page.total), [12, 12, 12]);
});
