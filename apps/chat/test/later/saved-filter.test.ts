/**
 * The Saved page's search box and filters (web/src/lib/saved-items.ts).
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/later/saved-filter.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LaterRow, Principal } from "../../web/src/lib/api/types.ts";
import { filterOf, filteredCounts, filtering, kindOf, matches, savedPage, savedRooms } from "../../web/src/lib/saved-items.ts";

const owner = { id: "owner", name: "You", kind: "person" } as unknown as Principal;
const post = (id: string, room: string, roomName: string, text: string, state: LaterRow["state"], memo?: string): LaterRow => ({
  id: `${room}:${id}`, by: "owner", savedAt: 1, state, room, post: id, roomKind: "channel", roomName, author: owner, text, at: 1, images: 0, ...(memo ? { memo } : {}),
});
const note = (id: string, text: string, state: LaterRow["state"], memo?: string): LaterRow => ({
  id: `note:${id}`, by: "owner", savedAt: 1, state, note: text, author: owner, text, at: 1, images: 0, ...(memo ? { memo } : {}),
});

const lists = {
  open: [
    post("p1", "ch_a", "#crawler", "census numbers for monday", "open", "ask Crawler guy about the dip"),
    post("p2", "ch_b", "#general", "release notes", "open"),
    note("n1", "[Proxy plan](wiki:sessions/proxy.html)", "open", "read before the call"),
    note("n2", "renew the domain", "open"),
  ],
  archived: [post("p3", "ch_a", "#crawler", "old census", "archived")],
  done: [note("n3", "[Census design](wiki:sessions/census.html)", "done")],
};

test("a row is a message, a wiki page or a reminder", () => {
  assert.deepEqual(lists.open.map(kindOf), ["message", "message", "page", "reminder"]);
  assert.deepEqual(savedPage("[Proxy plan](wiki:sessions/proxy.html)"), { title: "Proxy plan", path: "sessions/proxy.html" });
});

test("the URL's q, kind and in read as the filter, and a kind it does not know reads as none", () => {
  assert.deepEqual(filterOf({ q: "dip", kind: "page", in: "ch_a" }), { q: "dip", kind: "page", room: "ch_a" });
  assert.deepEqual(filterOf({ kind: "later" }), { q: "", kind: null, room: null });
  assert.equal(filtering(filterOf({})), false);
  assert.equal(filtering(filterOf({ q: "  " })), false);
});

test("search matches the text, a wiki page's title, the room's name and the memo, in any case", () => {
  const shown = (q: string) => lists.open.filter((row) => matches(row, filterOf({ q }))).map((row) => row.id);
  assert.deepEqual(shown("DIP"), ["ch_a:p1"]);
  assert.deepEqual(shown("proxy plan"), ["note:n1"]);
  assert.deepEqual(shown("wiki:"), []);
  assert.deepEqual(shown("#general"), ["ch_b:p2"]);
  assert.deepEqual(shown("before the call"), ["note:n1"]);
});

test("each tab counts the rows the filter keeps, and the rooms list every room a saved post sits in", () => {
  assert.deepEqual(filteredCounts(lists, filterOf({ q: "census" })), { open: 1, archived: 1, done: 1 });
  assert.deepEqual(filteredCounts(lists, filterOf({ kind: "reminder" })), { open: 1, archived: 0, done: 0 });
  assert.deepEqual(filteredCounts(lists, filterOf({ in: "ch_a" })), { open: 1, archived: 1, done: 0 });
  assert.deepEqual(savedRooms(lists).map((r) => r.name), ["#crawler", "#general"]);
});
