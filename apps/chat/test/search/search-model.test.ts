import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGroups, type Conversation, type Person, type SearchInput } from "../../web/src/pages/search/search-model.ts";

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

test("plain text shows Chats, Channels and Agents before messages, with live chats first", () => {
  assert.deepEqual(labels({ text: "ven" }), ["Chats: Vent, Venue notes", "Agents: Venom checker", "Most relevant: "]);
  assert.deepEqual(labels({ text: "relay" }), ["Agents: hosts relay job", "Most relevant: "]);
  assert.deepEqual(labels({ text: "cut" }), ["Channels: pi-cutover", "Most relevant: "]);
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

test("operators ask for messages only, and the count is the server's exact total", () => {
  const groups = buildGroups({
    ...base,
    text: "rate",
    operators: [{ kind: "in", id: "c-cut", label: "pi-cutover" }],
    messages: {
      state: "ready", total: 1234, more: true, loadingMore: false,
      hits: [{ id: "h1", conversation: { id: "c-cut", kind: "channel", name: "pi-cutover" }, messageId: "m1", author: { id: "owner", name: "Sieun", kind: "owner" }, at: new Date(2026, 9, 27).getTime(), kind: "post", snippet: "hit a <mark>rate</mark> limit" }],
    },
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.count, 1234);
  assert.equal(groups[0]!.rows[0]!.detail, "pi-cutover · Sieun · Oct 27");
  assert.deepEqual(groups[0]!.rows[0]!.action, { type: "open", conversation: "c-cut", messageId: "m1" });
});

test("scoped search shows only messages, with a Show more row", () => {
  const groups = buildGroups({ ...base, scope: "c-cut", sort: "recent", text: "x", messages: { state: "ready", hits: [], total: 0, more: true, loadingMore: false } });
  assert.deepEqual(groups.map(group => group.label), ["Most recent"]);
  assert.equal(groups[0]!.rows.at(-1)!.key, "more-messages");
});

test("loading says it is searching, and an error says search is unavailable", () => {
  assert.equal(buildGroups({ ...base, text: "a", messages: { state: "loading" } }).at(-1)!.empty, "Searching messages…");
  assert.equal(buildGroups({ ...base, text: "a", messages: { state: "error", message: "x" } }).at(-1)!.empty, "Message search is unavailable.");
});
