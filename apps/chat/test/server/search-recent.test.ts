/**
 * GET /api/search/recent feeds the Cmd K search's own index (web/src/pages/search/local-index.ts), and `brief=1` leaves each hit's longer
 * text out of a search answer. On 11-20 the owner's round trip was 197 ms, so a keystroke's rows come from the page and the server's
 * answer has to fit one round trip: the 20 hits of "kimchi" were 52.0 KB with their text on 11-19.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { SearchResult } from "../../web/src/lib/api/types.ts";
import { FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import { NO_FILTERS } from "../../web/src/pages/search/filters.ts";
import { entryOf, LocalFeed, localHits } from "../../web/src/pages/search/local-index.ts";
import { start, type Running } from "./helpers.ts";

let s: Running;
before(async () => {
  s = await start();
  await s.app.searchEngine.settled();
});
after(() => s.close());

test("the feed holds the room posts and the owner's own inputs, newest first, each with its text", async () => {
  const recent = await s.get<SearchResult>("/api/search/recent");
  assert.ok(recent.hits.length > 0);
  assert.equal(recent.total, recent.hits.length);
  assert.deepEqual(recent.hits.map(h => h.at), recent.hits.map(h => h.at).sort((a, b) => b - a));
  assert.ok(recent.hits.every(h => h.kind === "post" || h.role === "owner"), "only posts and the owner's inputs");
  assert.ok(recent.hits.every(h => h.snippet && !h.snippet.includes("<mark>") && h.text === undefined));
  assert.ok(recent.hits.some(h => h.kind === "post" && h.conversation.id === ids.cutoverChannel));
  assert.ok(recent.hits.some(h => h.kind === "message" && h.role === "owner"));
});

test("every message of the feed that the page matches for a word is one the server's search finds for it", async () => {
  const recent = await s.get<SearchResult>("/api/search/recent");
  const feed = new LocalFeed();
  feed.add(recent.hits);
  const local = localHits([], feed.entries(), { q: "relay", filters: NO_FILTERS, limit: 100 });
  assert.ok(local.length > 0);
  const server = await s.get<SearchResult>("/api/search?q=relay&limit=100");
  const found = new Set(server.hits.map(h => h.id));
  assert.deepEqual(local.filter(h => !found.has(h.id)).map(h => h.id), []);
  assert.ok(local.every(h => h.snippet.includes("<mark>")));
  const one = server.hits.find(h => h.id === local[0]!.id)!;
  const { text: _text, ...same } = one;
  assert.deepEqual({ ...local[0]!, snippet: "" }, { ...same, snippet: "" });
});

test("after= gives only the messages written since, so a second read is small", async () => {
  const all = await s.get<SearchResult>("/api/search/recent");
  const cut = all.hits[2]!.at;
  const newer = await s.get<SearchResult>(`/api/search/recent?after=${cut}`);
  assert.deepEqual(newer.hits.map(h => h.id), all.hits.filter(h => h.at > cut).map(h => h.id));
  assert.deepEqual((await s.get<SearchResult>(`/api/search/recent?after=${all.hits[0]!.at}`)).hits, []);
});

test("brief=1 gives the same hits and total without their longer text", async () => {
  const long = "relay ".repeat(100);
  assert.equal((await s.send("POST", `/api/c/${ids.cutoverChannel}/send`, { text: long, requestId: "recent-brief-1" })).status, 200);
  await s.app.searchEngine.settled();
  const full = await s.get<SearchResult>("/api/search?q=relay&limit=100");
  const brief = await s.get<SearchResult>("/api/search?q=relay&limit=100&brief=1");
  assert.ok(full.hits.some(h => h.text !== undefined));
  assert.ok(brief.hits.every(h => h.text === undefined));
  assert.deepEqual(brief.hits, full.hits.map(({ text: _text, ...hit }) => hit));
  assert.equal(brief.total, full.total);
  assert.ok(JSON.stringify(brief).length < JSON.stringify(full).length);
  assert.equal(entryOf(brief.hits[0]!).words.includes("relay"), true);
});
