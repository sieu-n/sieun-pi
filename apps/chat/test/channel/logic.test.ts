import { test } from "node:test";
import assert from "node:assert/strict";
import { dayGroups, keepGroups, layoutRows, newestRows, STACK_MS } from "../../web/src/pages/channel/rows.ts";
import { exactUnique, matchCandidates, openQuery } from "../../web/src/pages/channel/typeahead.ts";

const now = new Date(2026, 9, 28, 15, 0).getTime();
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();

test("posts by one author within 5 minutes stack, with the avatar on the last", () => {
  const owner = { id: "owner" };
  const agent = { id: "agent:a" };
  const items = [
    { id: "1", at: at(28, 10), kind: "message", author: owner },
    { id: "2", at: at(28, 10, 2), kind: "message", author: owner },
    { id: "3", at: at(28, 10, 3), kind: "turn", author: agent },
    { id: "4", at: at(28, 10, 3) + STACK_MS, kind: "turn", author: agent },
    { id: "5", at: at(28, 10, 9), kind: "system" },
    { id: "6", at: at(28, 10, 10), kind: "turn", author: agent },
  ];
  const rows = layoutRows(items);
  assert.deepEqual(rows.map(row => row.kind === "post" ? `${row.key}:${row.first ? "F" : ""}${row.last ? "L" : ""}` : row.kind),
    ["day", "1:F", "2:L", "3:FL", "4:FL", "system", "6:FL"]);
});

test("a new day starts with a divider and breaks the stack", () => {
  const owner = { id: "owner" };
  const rows = layoutRows([
    { id: "1", at: at(27, 23, 58), kind: "message", author: owner },
    { id: "2", at: at(28, 0, 1), kind: "message", author: owner },
  ]);
  assert.deepEqual(rows.map(row => row.kind === "post" ? (row.first ? "F" : "-") : row.kind), ["day", "F", "day", "F"]);
});

test("a thread's first reply starts its own group under the root, with its byline", () => {
  const owner = { id: "owner" };
  const rows = layoutRows([
    { id: "root", at: at(28, 10), kind: "message", author: owner },
    { id: "r1", at: at(28, 10, 1), kind: "message", author: owner },
    { id: "r2", at: at(28, 10, 2), kind: "message", author: owner },
  ], "root");
  assert.deepEqual(rows.map(row => row.kind === "post" ? `${row.key}:${row.first ? "F" : ""}${row.last ? "L" : ""}` : row.kind), ["day", "root:FL", "r1:F", "r2:L"]);
});

test("rows group by day under their divider, and the first paint keeps the newest rows under their own day", () => {
  const owner = { id: "owner" };
  const groups = dayGroups(layoutRows([
    { id: "1", at: at(26, 9), kind: "message", author: owner },
    { id: "2", at: at(27, 9), kind: "message", author: owner },
    { id: "3", at: at(27, 9, 10), kind: "message", author: owner },
    { id: "4", at: at(28, 9), kind: "message", author: owner },
  ]));
  const day = (date: number) => new Date(at(date, 0)).toDateString();
  assert.deepEqual(groups.map(group => [group.key, group.rows.map(row => row.key)]), [[day(26), ["1"]], [day(27), ["2", "3"]], [day(28), ["4"]]]);
  assert.deepEqual(newestRows(groups, 2).map(group => [group.key, group.rows.map(row => row.key)]), [[day(27), ["3"]], [day(28), ["4"]]]);
  assert.equal(newestRows(groups, 9).length, 3);
});

test("a send keeps its row when the stored post replaces it, and an update redraws only the rows it changed", () => {
  const owner = { id: "owner" };
  const agent = { id: "agent:a" };
  const old = { id: "1", at: at(27, 9), kind: "turn", author: agent };
  const reply = { id: "2", at: at(28, 9), kind: "turn", author: agent };
  const pending = { id: "r:abc", at: at(28, 10), kind: "message", author: owner, requestId: "abc" };
  const before = keepGroups([], dayGroups(layoutRows([old, reply, pending])));
  const stored = { id: "p3", at: at(28, 10), kind: "message", author: owner, requestId: "abc" };
  const after = keepGroups(before, dayGroups(layoutRows([old, reply, stored])));
  assert.deepEqual(after.map(group => group.rows.map(row => row.key)), [["1"], ["2", "r:abc"]]);
  assert.equal(after[0], before[0], "a day the update did not touch is the same object");
  assert.equal(after[1]!.rows[0], before[1]!.rows[0], "an untouched row is the same object");
  assert.notEqual(after[1]!.rows[1], before[1]!.rows[1]);
  const again = keepGroups(after, dayGroups(layoutRows([old, reply, stored])));
  assert.equal(again[1], after[1], "a redraw with nothing new keeps every group");
  const twice = layoutRows([stored, { ...stored, id: "p4" }]);
  assert.deepEqual(twice.map(row => row.key), ["day-r:abc", "r:abc", "p4"], "a second item with one requestId keys by its id, so no key repeats");
});

test("openQuery finds @ and # at the caret and ignores emails and closed names", () => {
  assert.deepEqual(openQuery("hi @cra", 7), { trigger: "@", start: 3, text: "cra" });
  assert.deepEqual(openQuery("@Crawler V", 10), { trigger: "@", start: 0, text: "Crawler V" });
  assert.deepEqual(openQuery("see #pi", 7), { trigger: "#", start: 4, text: "pi" });
  assert.equal(openQuery("mail a@b", 8), null);
  assert.equal(openQuery("@ x", 3), null);
  assert.equal(openQuery("@a\nb", 4), null);
  assert.equal(openQuery("\ufffc ", 2), null);
  assert.equal(openQuery("@cr\ufffc x", 6), null);
  assert.deepEqual(openQuery("\ufffc @v", 4), { trigger: "@", start: 2, text: "v" });
});

test("matchCandidates ranks prefix, then word prefix, then substring, stable inside a rank", () => {
  const list = [
    { id: "1", name: "CI and RepoOps", kind: "chat" },
    { id: "2", name: "Crawler VP", kind: "chat" },
    { id: "3", name: "pi cutover prep", kind: "job" },
    { id: "4", name: "Vent", kind: "chat" },
  ];
  assert.deepEqual(matchCandidates(list, "c").map(c => c.id), ["1", "2", "3"]);
  assert.deepEqual(matchCandidates(list, "cut").map(c => c.id), ["3"]);
  assert.deepEqual(matchCandidates(list, "").map(c => c.id), ["1", "2", "3", "4"]);
  assert.equal(exactUnique(list, "vent")?.id, "4");
  assert.equal(exactUnique(list, "ven"), null);
});
