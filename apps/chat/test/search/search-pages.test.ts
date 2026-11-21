/**
 * The Cmd K "Pages" group (search-model.ts pagesGroup) and the page places of the Wiki view (pages/wiki/wiki-pages.ts).
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/search/search-pages.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { NO_FILTERS } from "../../web/src/pages/search/filters.ts";
import { buildGroups, type SearchInput } from "../../web/src/pages/search/search-model.ts";
import { pagePlace, wikiHref, withoutFavorites } from "../../web/src/pages/wiki/wiki-pages.ts";

const IDEAL = "agents/agent-factory/jobs/2026/11/20/1139-slack-style-replies/ideal-replies.html";
const page = (path: string, title: string) => ({ path, title, description: null, updated: "2026-11-20" });
const base: SearchInput = { text: "", filters: NO_FILTERS, sort: "relevance", conversations: [], people: [], messages: { state: "idle" }, now: new Date(2026, 10, 22) };

test("typed words list up to 3 matching pages between the conversations and the messages", () => {
  const groups = buildGroups({
    ...base,
    text: "ideal slack replies",
    pages: [page(IDEAL, "Ideal Slack replies in sw factory rooms"), page("domains/devops/agent-memory.html", "Agent memory")],
  });
  assert.deepEqual(groups.map(group => group.label), ["All results", "Pages", "Messages"]);
  const pages = groups.find(group => group.label === "Pages")!;
  assert.deepEqual(pages.rows.map(row => [row.label, row.detail, row.action]), [
    ["Ideal Slack replies in sw factory rooms", "agent factory job · slack style replies", { type: "wiki", path: IDEAL }],
    ["Agent memory", "domains / devops", { type: "wiki", path: "domains/devops/agent-memory.html" }],
  ]);
  assert.deepEqual(pages.rows[0]!.positions?.slice(0, 3), [0, 1, 2]);
});

test("more than 3 pages end in a See all row that opens the Wiki view with the words", () => {
  const many = Array.from({ length: 20 }, (_, i) => page(`domains/p${i}.html`, `Page ${i}`));
  const rows = buildGroups({ ...base, text: "page", pages: many }).find(group => group.label === "Pages")!.rows;
  assert.equal(rows.length, 4);
  assert.deepEqual([rows[3]!.label, rows[3]!.action], ["See all 20+ pages", { type: "pages", q: "page" }]);
});

test("a search with filters or no pages shows no Pages group", () => {
  const pages = [page(IDEAL, "Ideal Slack replies in sw factory rooms")];
  assert.ok(!buildGroups({ ...base, text: "ideal", pages, filters: { ...NO_FILTERS, from: ["owner"] } }).some(group => group.label === "Pages"));
  assert.ok(!buildGroups({ ...base, text: "ideal", pages: [] }).some(group => group.label === "Pages"));
});

test("a page's place names the agent job or session it came from, else its folders", () => {
  assert.equal(pagePlace(IDEAL), "agent factory job · slack style replies");
  assert.equal(pagePlace("sessions/2026/11/22/0537-p133-walk/notes.html"), "Session · p133 walk");
  assert.equal(pagePlace("domains/devops/sw-factory-threads/index.html"), "domains / devops / sw-factory-threads");
  assert.equal(pagePlace("index.html"), "");
});

test("the Wiki view's address keeps the words, and a favorite shows once", () => {
  assert.equal(wikiHref(), "#/c/wiki");
  assert.equal(wikiHref(" agent memory "), "#/c/wiki?q=agent+memory");
  const liked = [page("a.html", "A")];
  assert.deepEqual(withoutFavorites([page("a.html", "A"), page("b.html", "B")], liked).map(p => p.path), ["b.html"]);
});
