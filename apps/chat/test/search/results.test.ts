import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item, TimelinePage } from "../../web/src/lib/api/types.ts";
import { contextOf, replyContextOf } from "../../web/src/pages/search/context.ts";
import { author, location, locationText, longStamp, shortAge, what, type Hit } from "../../web/src/pages/search/hit-view.ts";
import { dateLabel, dateRanges, readResults, resultCount, resultParams, searchParams } from "../../web/src/pages/search/results-model.ts";

const hit = (over: Partial<Hit> = {}): Hit => ({
  id: "c1/e5", conversation: { id: "c1", kind: "solo", name: "Vent" }, messageId: "e5", author: { id: "c1", name: "Vent", kind: "agent" },
  at: new Date(2026, 9, 28, 15, 34).getTime(), kind: "turn", role: "agent", snippet: "the <mark>relay</mark> is up", ...over,
});

test("a hit names its author with a badge, its place with an icon, and the kind of text that holds the match", () => {
  assert.deepEqual(author(hit()), { name: "Vent", badge: "AGENT", avatar: "agent", seed: "c1" });
  assert.equal(author(hit({ author: { id: "owner", name: "Sieun", kind: "owner" } })).name, "You");
  assert.equal(author(hit({ author: { id: "system", name: "Check-in", kind: "system" } })).badge, "SYSTEM");
  assert.equal(location({ id: "ch", kind: "channel", name: "pi-cutover" }).icon, "hash");
  assert.equal(locationText({ id: "ch", kind: "channel", name: "pi-cutover", archived: true }), "#pi-cutover (archived)");
  assert.equal(locationText({ id: "j", kind: "dm", name: "Vent integrations duty", parent: { id: "c1", name: "vent" } }), "vent › Vent integrations duty");
  assert.equal(location({ id: "d", kind: "dm", name: "frontend bro" }).icon, "lock");
  assert.equal(what(hit({ role: "tool", kind: "tool", tool: "bash" })), "in tool output · bash");
  assert.equal(what(hit({ role: "tool", tool: "ipython", inCall: true })), "in a tool call · ipython");
  assert.equal(what(hit({ kind: "post", threadRoot: "p1" })), "reply in thread");
  assert.equal(what(hit()), undefined);
});

test("times read like Slack's: Today at, Yesterday at, Oct 12th at, and short ages in a row", () => {
  const now = new Date(2026, 9, 28, 18, 0);
  assert.equal(longStamp(new Date(2026, 9, 28, 15, 34).getTime(), now), "Today at 3:34 PM");
  assert.equal(longStamp(new Date(2026, 9, 27, 9, 2).getTime(), now), "Yesterday at 9:02 AM");
  assert.equal(longStamp(new Date(2026, 9, 12, 15, 34).getTime(), now), "Oct 12th at 3:34 PM");
  assert.equal(longStamp(new Date(2026, 9, 1, 8, 0).getTime(), now), "Oct 1st at 8:00 AM");
  assert.equal(longStamp(new Date(2025, 9, 13, 8, 0).getTime(), now), "Oct 13th, 2025 at 8:00 AM");
  assert.equal(shortAge(now.getTime() - 5 * 60_000, now), "5m");
  assert.equal(shortAge(new Date(2026, 9, 27, 9, 0).getTime(), now), "Yesterday");
  assert.equal(shortAge(new Date(2026, 9, 2).getTime(), now), "Oct 2");
});

test("the results address keeps only set filters and reads back the same search", () => {
  const params = resultParams({ q: "relay", from: "owner", sort: "relevance", type: "messages" });
  assert.deepEqual(Object.fromEntries(Object.entries(params).filter(([, v]) => v)), { q: "relay", from: "owner", type: "messages" });
  const read = readResults({ q: " relay ", from: "agents", sort: "recent", after: "2026-10-22", before: "bad", type: "x" });
  assert.deepEqual(read, { q: "relay", from: "agents", sort: "recent", after: "2026-10-22" });
  assert.deepEqual(searchParams(read), { q: "relay", sort: "recent", from: "agents", after: "2026-10-22" });
  const now = new Date(2026, 9, 28);
  assert.equal(dateRanges(now).find(r => r.id === "7d")!.after, "2026-10-22");
  assert.equal(dateLabel({ after: "2026-10-22" }, now), "Last 7 days");
  assert.equal(dateLabel({ after: "2026-10-01", before: "2026-10-05" }, now), "2026-10-01 to 2026-10-05");
  assert.equal(resultCount(1), "1 result");
  assert.equal(resultCount(6391), "6,391 results");
});

const person = (id: string, name: string) => ({ id, kind: id === "owner" ? "owner" as const : "chat" as const, name, avatar: { initials: "XX", hue: 1 } });
const message = (id: string, text: string, from = person("owner", "Sieun")): Item => ({ kind: "message", id, at: 1, author: from, text, images: [], mentions: [], deliveries: [] });
const turn = (id: string, text: string): Item => ({ kind: "turn", id, at: 2, author: person("c1", "Vent"), text, live: false, steps: [], images: [], jobs: [] });

test("context is the message before and after the hit's item; a hit in tool output gets its turn's answer after it", () => {
  const page: TimelinePage = { items: [message("e1", "first"), turn("t1", "answer one"), message("e5", "is the relay up?"), turn("t5", "The relay is up."), message("e9", "thanks")], focus: "t5" };
  assert.deepEqual([contextOf(page, hit()).before?.text, contextOf(page, hit()).after?.text], ["is the relay up?", "thanks"]);
  assert.equal(contextOf(page, hit({ role: "tool", kind: "tool" })).after?.text, "The relay is up.");
  assert.equal(contextOf(page, hit()).before?.author, "You");
  const envelope: TimelinePage = { items: [message("e3", "[agent-message from child:vent grafana]\n\nThe folder is Vent."), turn("t3", "ok")], focus: "t3" };
  assert.deepEqual(contextOf(envelope, hit()).before, { id: "e3", author: "vent grafana", kind: "agent", at: 1, text: "The folder is Vent." });
  const thread = { root: message("p1", "what blocks the migration?"), items: [message("p2", "two items", person("c2", "Harness")), message("p3", "the relay port")] };
  assert.deepEqual(Object.values(replyContextOf(thread, hit({ messageId: "p2", threadRoot: "p1" }))).map(l => l?.text), ["what blocks the migration?", "the relay port"]);
});
