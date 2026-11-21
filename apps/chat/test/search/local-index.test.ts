/**
 * The Cmd K search's own matches (web/src/pages/search/local-index.ts): a keystroke shows message rows from the page's feed before the
 * server answers. On 11-20 each keystroke's rows waited 399 to 474 ms at a simulated 200 ms round trip.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { snippetOf, snippetTerms } from "../../../../packages/pi-host/src/durable/index-db.ts";
import { safeSnippet } from "../../server/search-snippet.ts";
import { NO_FILTERS, type Filters } from "../../web/src/pages/search/filters.ts";
import { entryOf, LocalFeed, localHits, localSnippet, plainOf, queryWords } from "../../web/src/pages/search/local-index.ts";
import { buildGroups, type Hit, type SearchInput } from "../../web/src/pages/search/search-model.ts";

const hit = (id: string, snippet: string, at: number, conversation = "c-vent"): Hit => ({
  id, conversation: { id: conversation, kind: "channel", name: conversation }, messageId: id, author: { id: "owner", name: "Sieun", kind: "owner" }, at, kind: "post", role: "owner", where: "root", link: `#/c/${conversation}?m=${id}`, snippet,
});
const feedOf = (...hits: Hit[]) => {
  const feed = new LocalFeed();
  feed.add(hits);
  return feed.entries();
};

test("a keystroke finds the feed's messages whose words start with every query word, best first, with its own marks", () => {
  const feed = feedOf(
    hit("a", "the relay restart is done", 1),
    hit("b", "relay relays relayed twice &amp; &lt;again&gt;", 2),
    hit("c", "nothing to see", 3),
    hit("d", "restart the relay now", 4),
  );
  assert.deepEqual(localHits([], feed, { filters: NO_FILTERS, q: "rel", limit: 20 }).map(h => h.id), ["b", "d", "a"]);
  assert.deepEqual(localHits([], feed, { filters: NO_FILTERS, q: "relay rest", limit: 20 }).map(h => h.id), ["d", "a"]);
  assert.equal(localHits([], feed, { filters: NO_FILTERS, q: "rel", limit: 20 })[0]!.snippet, "<mark>relay</mark> <mark>relays</mark> <mark>relayed</mark> twice &amp; &lt;again&gt;");
  assert.deepEqual(localHits([], feed, { filters: NO_FILTERS, q: "rel", limit: 2 }).map(h => h.id), ["b", "d"]);
  assert.deepEqual(localHits([], feed, { filters: NO_FILTERS, q: "rel", sort: "recent", limit: 20 }).map(h => h.id), ["d", "b", "a"]);
  assert.deepEqual(localHits([], feed, { filters: NO_FILTERS, q: " ", limit: 20 }), []);
});

test("the hits on screen that still match the longer word stay first in the server's order, marked for the new word", () => {
  const feed = feedOf(hit("f", "duty duty duty", 9));
  const onScreen = [hit("s1", "the <mark>dut</mark>ch oven", 1), hit("s2", "a <mark>duty</mark> run", 2), hit("s3", "<mark>duty</mark> roster", 3)];
  const next = localHits(onScreen, feed, { filters: NO_FILTERS, q: "duty", limit: 20 });
  assert.deepEqual(next.map(h => h.id), ["s2", "s3", "f"]);
  assert.equal(next[0]!.snippet, "a <mark>duty</mark> run");
});

test("a search in one conversation keeps only that conversation's messages", () => {
  const feed = feedOf(hit("a", "relay here", 1, "c-one"), hit("b", "relay there", 2, "c-two"));
  assert.deepEqual(localHits([], feed, { q: "relay", filters: { ...NO_FILTERS, in: "c-two" }, limit: 20 }).map(h => h.id), ["b"]);
});

test("the feed keeps one entry per message, newest first, and names the newest time for the next read", () => {
  const feed = new LocalFeed();
  assert.equal(feed.newest, undefined);
  feed.add([hit("a", "one", 5), hit("b", "two", 9)]);
  feed.add([hit("a", "one edited", 5), hit("c", "three", 7)]);
  assert.deepEqual(feed.entries().map(e => e.hit.id), ["b", "c", "a"]);
  assert.equal(feed.entries()[2]!.plain, "one edited");
  assert.equal(feed.newest, 9);
});

test("the page cuts and marks a snippet as the server does", () => {
  const texts = [
    "short text with relay in it",
    `${"lead words ".repeat(40)}the pi-host relay <b>restart</b> & "quotes" ${"tail words ".repeat(40)}`,
    "검색이 너무 오래 걸리거든 relay",
    "!!! ???",
  ];
  for (const text of texts) {
    for (const q of ["relay", "pi-host rest", "검색", "none"]) {
      const terms = snippetTerms(q);
      assert.deepEqual(queryWords(q), terms);
      assert.equal(localSnippet(text, terms), safeSnippet(snippetOf(text, terms, 36)), `${q} in ${text.slice(0, 30)}`);
    }
  }
  assert.equal(plainOf("a &lt;b&gt; <mark>c</mark> &amp; d"), "a <b> c & d");
  assert.equal(entryOf(hit("x", "Über <mark>Relay</mark>", 1)).words.join(" "), "uber relay");
});

test("the palette lists the page's matches while the server has not answered, with no count and no more row", () => {
  const input: SearchInput = { text: "relay", filters: NO_FILTERS, sort: "relevance", conversations: [], people: [], now: new Date(2026, 10, 20), messages: { state: "loading", hits: [hit("a", "the <mark>relay</mark>", 1)] } };
  const group = buildGroups(input).at(-1)!;
  assert.deepEqual(group.rows.map(row => row.key), ["hit:a"]);
  assert.equal(group.count, undefined);
  assert.equal(buildGroups({ ...input, messages: { state: "loading", hits: [] } }).at(-1)!.empty, "Searching messages…");
});

test("with filters set, the keystroke rows keep only hits the page can tell pass them, and none while an agent is in From", () => {
  const day = (d: number, h: number) => Date.parse(`2026-11-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00+09:00`);
  const agent = (over: Partial<Hit>): Hit => ({ ...hit("x", "relay", day(19, 12)), author: { id: "ag_vent", name: "Vent", kind: "agent" }, role: "agent", ...over });
  const feed = feedOf(
    hit("root", "relay root", day(20, 1)),
    agent({ id: "reply", where: "thread", at: day(19, 23) }),
    agent({ id: "tool", where: "tool", role: "tool", kind: "tool", at: day(18, 10) }),
    agent({ id: "old", at: day(18, 9) }),
  );
  const ids = (filters: Partial<Filters>) => localHits([], feed, { q: "relay", filters: { ...NO_FILTERS, ...filters }, sort: "recent", limit: 20 }).map(h => h.id);
  assert.deepEqual(ids({}), ["root", "reply", "tool", "old"]);
  assert.deepEqual(ids({ place: ["tools"] }), ["tool"]);
  assert.deepEqual(ids({ place: ["channels", "threads"] }), ["root", "reply", "old"]);
  assert.deepEqual(ids({ place: ["jobs", "dms"] }), []);
  assert.deepEqual(ids({ from: ["owner"] }), ["root"]);
  assert.deepEqual(ids({ from: ["agents"] }), ["reply", "tool", "old"]);
  assert.deepEqual(ids({ from: ["ag_vent"] }), []);
  // after and before are KST days: the reply at 23:00 KST on 11-19 is in 11-19, whatever the box's zone.
  assert.deepEqual(ids({ after: "2026-11-19" }), ["root", "reply"]);
  assert.deepEqual(ids({ before: "2026-11-20" }), ["reply", "tool", "old"]);
});
