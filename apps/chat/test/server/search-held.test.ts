/**
 * A relevance search whose words match posts Meilisearch has not indexed yet asks Meilisearch which of them it holds, to place the cut
 * between its ranks and the engine's (search-engine.ts). That round trip went before the answer's own asks, one more Meilisearch wait in
 * the handler: on 11-23 22:02Z two of the owner's searches spent 120 and 189 ms in it (split.held). It now goes beside them.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/search-held.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { SearchResult } from "../../web/src/lib/api/types.ts";
import type { Meili } from "../../server/meili.ts";
import { start, type Running } from "./helpers.ts";

let s: Running;
before(async () => {
  s = await start();
});
after(async () => {
  await s.close();
});

const meiliOf = (): Meili => (s.app.searchEngine as unknown as { meili: Meili }).meili;

async function post(room: string, text: string): Promise<string> {
  const requestId = crypto.randomUUID();
  const sent = await s.send("POST", `/api/c/${room}/send`, { text, requestId });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  return s.app.agentStore.postsOf(room).find(one => one.requestId === requestId)!.id;
}

/** Holds Meilisearch's writes until `release`, so the posts written meanwhile stay pending. */
function holdWrites(): () => Promise<void> {
  const meili = meiliOf();
  const put = meili.put.bind(meili);
  const held: (() => void)[] = [];
  meili.put = (uid, docs) => new Promise(resolve => held.push(() => resolve(put(uid, docs))));
  return async () => {
    meili.put = put;
    for (const release of held) release();
    await s.app.searchEngine.settled();
  };
}

/** Counts the answer's main asks (every field, no newer-than filter) and notes whether one left before the held check's fetch answered. */
function watchAsks(): { asks: () => number; beforeHeld: () => boolean; stop: () => void } {
  const meili = meiliOf();
  const search = meili.search.bind(meili);
  const fetch = meili.fetch.bind(meili);
  let asks = 0;
  let early = false;
  let asked: () => void = () => undefined;
  const answerAsked = new Promise<void>(resolve => (asked = resolve));
  meili.search = (uid, body) => {
    if (!("attributesToRetrieve" in body) && !String(body.filter).includes(">=")) {
      asks += 1;
      asked();
    }
    return search(uid, body);
  };
  // The held check's answer waits for the answer's first ask, or 2 s when that ask waits on it.
  meili.fetch = async <T>(uid: string, ids: readonly string[], fields: readonly string[]) => {
    const docs = await fetch<T>(uid, ids, fields);
    early = await Promise.race([answerAsked.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2_000))]);
    return docs;
  };
  return { asks: () => asks, beforeHeld: () => early, stop: () => Object.assign(meili, { search, fetch }) };
}

test("the answer's asks leave before Meilisearch says which pending hits it holds", async () => {
  const word = `zqheld${Math.random().toString(36).slice(2, 8)}`;
  const room = (await s.send<{ id: string }>("POST", "/api/rooms", { kind: "channel", name: `held-${word}`, members: [] })).body.id;
  for (let n = 1; n <= 3; n += 1) await post(room, `${word} post ${n}`);
  await s.app.searchEngine.settled();
  const release = holdWrites();
  for (let n = 4; n <= 5; n += 1) await post(room, `${word} post ${n}`);
  const watch = watchAsks();
  try {
    const found = await s.get<SearchResult>(`/api/search?${new URLSearchParams({ q: word, limit: "20" })}`);
    assert.equal(found.total, 5);
    assert.ok(watch.beforeHeld(), "the answer's ask waited for the held check");
    assert.equal(watch.asks(), 1, "a right guess of the cut asks once");
  } finally {
    watch.stop();
    await release();
  }
});

test("a pending post Meilisearch already holds, unknown to the guess, gets the same answer as a known one", async () => {
  const word = `zqedit${Math.random().toString(36).slice(2, 8)}`;
  const room = (await s.send<{ id: string }>("POST", "/api/rooms", { kind: "channel", name: `held-${word}`, members: [] })).body.id;
  const first = await post(room, `${word} post 1`);
  for (let n = 2; n <= 4; n += 1) await post(room, `${word} post ${n}`);
  await s.app.searchEngine.settled();
  const release = holdWrites();
  // A reaction puts the first post in pending again while Meilisearch keeps its indexed copy; a new post is pending and not indexed.
  assert.equal((await s.send("POST", `/api/c/${room}/posts/${first}/reactions`, { emoji: "+1" })).status, 200);
  await post(room, `${word} post 5`);
  const ask = () => s.get<SearchResult>(`/api/search?${new URLSearchParams({ q: word, limit: "20" })}`);
  const watch = watchAsks();
  try {
    const missed = await ask();
    assert.equal(watch.asks(), 2, "the wrong guess asks again with the cut the held check gives");
    const known = await ask();
    assert.equal(watch.asks(), 3, "the learned guess asks once");
    assert.deepEqual(missed, known);
    assert.equal(known.total, 5);
  } finally {
    watch.stop();
    await release();
  }
});
