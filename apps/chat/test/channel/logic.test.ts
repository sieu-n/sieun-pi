import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutRows, STACK_MS } from "../../web/src/pages/channel/rows.ts";
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

test("openQuery finds @ and # at the caret and ignores emails and closed names", () => {
  assert.deepEqual(openQuery("hi @cra", 7), { trigger: "@", start: 3, text: "cra" });
  assert.deepEqual(openQuery("@Crawler V", 10), { trigger: "@", start: 0, text: "Crawler V" });
  assert.deepEqual(openQuery("see #pi", 7), { trigger: "#", start: 4, text: "pi" });
  assert.equal(openQuery("mail a@b", 8), null);
  assert.equal(openQuery("@ x", 3), null);
  assert.equal(openQuery("@a\nb", 4), null);
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
