import assert from "node:assert/strict";
import { test } from "node:test";
import { answered, buildGroups, pendingNotes, SEE_ALL, type Conversation, type Hit, type Person, type SearchInput } from "../../web/src/pages/search/search-model.ts";

const conversations: Conversation[] = [
  { id: "c-vent", kind: "solo", name: "Vent", lastActivityAt: 5, preview: "tests pass" },
  { id: "c-cut", kind: "channel", name: "pi-cutover", lastActivityAt: 9 },
  { id: "c-old", kind: "solo", name: "Venue notes", lastActivityAt: 1, archived: true },
  { id: "c-dm", kind: "dm", name: "frontend bro", lastActivityAt: 7, preview: "done" },
  { id: "c-job", kind: "job", name: "hosts relay job", lastActivityAt: 3 },
];
const people: Person[] = [
  { id: "owner", name: "Sieun", kind: "owner", aliases: ["owner", "me"] },
  { id: "c-dm", name: "frontend bro", kind: "agent", conversationId: "c-dm" },
  { id: "c-vent", name: "Vent", kind: "agent", conversationId: "c-vent" },
  { id: "c-job", name: "hosts relay job", kind: "agent", conversationId: "c-job", detail: "Job of Vent" },
  { id: "c-venom", name: "Venom checker", kind: "agent", conversationId: "c-venom", detail: "Job of Vent" },
];
const base: SearchInput = { text: "", operators: [], sort: "relevance", conversations, people, messages: { state: "idle" }, now: new Date(2026, 9, 28) };
const labels = (input: Partial<SearchInput>) => buildGroups({ ...base, ...input }).map(group => `${group.label}: ${group.rows.map(row => row.label).join(", ")}`);

test("an empty field shows this conversation and the 4 newest live conversations", () => {
  assert.deepEqual(labels({ current: "c-cut" }), [
    "This conversation: Search in pi-cutover",
    "Recent activity: pi-cutover, frontend bro, Vent, hosts relay job",
  ]);
});

test("plain text leads with See all results, then Conversations, Agents and Channels before messages, with live chats first", () => {
  assert.deepEqual(labels({ text: "ven" }), ["All results: See all results for “ven”", "Conversations: Vent, Venue notes", "Agents: Venom checker", "Messages: "]);
  assert.deepEqual(labels({ text: "relay" }), ["All results: See all results for “relay”", "Agents: hosts relay job", "Messages: "]);
  assert.deepEqual(labels({ text: "cut" }), ["All results: See all results for “cut”", "Channels: pi-cutover", "Messages: "]);
});

test("See all results is the first row, opens the full page and says how many there are", () => {
  const groups = buildGroups({ ...base, text: "rate", messages: { state: "ready", total: 1234, more: true, loadingMore: false, hits: [] } });
  const first = groups[0]!.rows[0]!;
  assert.equal(first.key, SEE_ALL);
  assert.deepEqual(first.action, { type: "page" });
  assert.equal(first.detail, "1,234 results · Enter opens the full page");
  assert.equal(groups[0]!.hideLabel, true);
});

test("from: offers people and agents, and choosing one makes a chip", () => {
  const groups = buildGroups({ ...base, text: "deploy from:fro" });
  assert.deepEqual(groups.map(group => group.rows.map(row => row.label)), [[], ["frontend bro"]]);
  assert.deepEqual(groups[1]!.rows[0]!.action, { type: "operator", operator: { kind: "from", id: "c-dm", label: "frontend bro" } });
});

test("from: finds the owner by an alias", () => {
  assert.deepEqual(buildGroups({ ...base, text: "from:own" })[0]!.rows.map(row => row.label), ["Sieun"]);
});

test("after: offers date presets until a full date is typed", () => {
  assert.equal(buildGroups({ ...base, text: "after:" })[0]!.label, "Dates");
  assert.equal(buildGroups({ ...base, text: "after:2026-10-0" })[0]!.label, "Dates");
});

test("operators ask for messages only, and each row says who said it, where and when, with the server's exact total", () => {
  const groups = buildGroups({
    ...base,
    text: "rate",
    operators: [{ kind: "in", id: "c-cut", label: "pi-cutover" }],
    messages: {
      state: "ready", total: 1234, more: true, loadingMore: false,
      hits: [
        { id: "h1", conversation: { id: "c-cut", kind: "channel", name: "pi-cutover" }, messageId: "m1", author: { id: "owner", name: "Sieun", kind: "owner" }, at: new Date(2026, 9, 27).getTime(), kind: "post", role: "owner", snippet: "hit a <mark>rate</mark> limit" },
        {
          id: "h2", conversation: { id: "c-job", kind: "dm", name: "Vent integrations duty", parent: { id: "c-vent", name: "vent" } }, messageId: "e9",
          author: { id: "c-job", name: "Vent integrations duty", kind: "agent" }, at: new Date(2026, 9, 26).getTime(), kind: "tool", role: "tool", tool: "bash", snippet: "<mark>rate</mark>: 5/s",
        },
      ],
    },
  });
  assert.deepEqual(groups.map(group => group.label), ["All results", "Messages"]);
  const messages = groups[1]!;
  assert.equal(messages.count, 1234);
  assert.equal(messages.rows[0]!.detail, "You · #pi-cutover · Oct 27");
  assert.equal(messages.rows[1]!.detail, "Vent integrations duty · vent › Vent integrations duty · in tool output · bash · Oct 26");
  assert.equal(messages.rows[1]!.hit?.id, "h2");
  assert.deepEqual(messages.rows[0]!.action, { type: "open", conversation: "c-cut", messageId: "m1" });
});

test("scoped search shows only messages, with a Show more row", () => {
  const groups = buildGroups({ ...base, scope: "c-cut", sort: "recent", text: "x", messages: { state: "ready", hits: [], total: 0, more: true, loadingMore: false } });
  assert.deepEqual(groups.map(group => group.label), ["All results", "Most recent"]);
  assert.equal(groups[1]!.rows.at(-1)!.key, "more-messages");
});

test("global search always reads Messages, whatever the scoped sort was", () => {
  assert.equal(buildGroups({ ...base, sort: "recent", text: "x" }).at(-1)!.label, "Messages");
});

test("loading says it is searching, and an error says search is unavailable", () => {
  assert.equal(buildGroups({ ...base, text: "a", messages: { state: "loading" } }).at(-1)!.empty, "Searching messages…");
  assert.equal(buildGroups({ ...base, text: "a", messages: { state: "error", message: "x" } }).at(-1)!.empty, "Message search is unavailable.");
});

const hit = (id: string): Hit => ({
  id, conversation: { id: "c-cut", kind: "channel", name: "#pi-cutover" }, messageId: `m-${id}`,
  author: { id: "owner", name: "Sieun", kind: "owner" }, at: new Date(2026, 9, 27).getTime(), kind: "message", snippet: `<mark>${id}</mark>`,
});

test("a this-box answer with pending boxes shows its hits, counts no number and offers no next page", () => {
  const messages = answered({ hits: [hit("a")], total: 7, nextCursor: "20", pending: ["mac"] });
  assert.deepEqual(messages, { state: "ready", hits: [hit("a")], total: "counting", more: false, loadingMore: false });
  const groups = buildGroups({ ...base, text: "a", messages });
  assert.equal(groups[0]!.rows[0]!.detail, "Counting… · Enter opens the full page");
  assert.equal(groups.at(-1)!.count, "counting");
  assert.deepEqual(groups.at(-1)!.rows.map(row => row.key), ["hit:a"]);
});

test("a this-box answer with no hits yet still says it is searching while a box is pending", () => {
  const messages = answered({ hits: [], total: 0, pending: ["mac"] });
  assert.equal(buildGroups({ ...base, text: "a", messages }).at(-1)!.empty, "Searching messages…");
});

test("the full answer replaces the this-box hits with every box's hits, its exact total and its cursor", () => {
  const full = answered({ hits: [hit("mac1"), hit("a")], total: 9, nextCursor: "20" });
  assert.deepEqual(full, { state: "ready", hits: [hit("mac1"), hit("a")], total: 9, more: true, loadingMore: false });
  assert.equal(buildGroups({ ...base, text: "a", messages: full })[0]!.rows[0]!.detail, "9 results · Enter opens the full page");
});

test("a next page appends only hits not already shown", () => {
  const next = answered({ hits: [hit("a"), hit("b")], total: 9 }, [hit("a")]);
  assert.deepEqual(next.hits.map(one => one.id), ["a", "b"]);
  assert.equal(next.more, false);
});

test("a pending box the full search could not bring gets the server's missing note", () => {
  assert.deepEqual(pendingNotes(["mac"], new Error("timed out")), [
    { box: "mac", note: "mac did not answer the search (timed out), so its threads are not in these results." },
  ]);
});
