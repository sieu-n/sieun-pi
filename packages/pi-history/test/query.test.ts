import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseDate, parseQuery, QueryError } from "../src/core/query.ts";
import { makeIndex } from "./fixture.ts";

const KST_DAY = (day: string): number => Date.parse(`${day}T00:00:00+09:00`);

test("each rewrite rule turns the typed text into its MATCH text", () => {
  const cases: [string, string | null][] = [
    ["rate limit", `"rate" "limit"`],
    ['"did not answer in"', `"did not answer in"`],
    ["쓰레드", `"쓰레드"*`],
    ["문제 해결", `"문제"* "해결"*`],
    ["svelte-check", `"svelte-check"`],
    ["board.wake", `"board.wake"`],
    ["components/user-history", `"components/user-history"`],
    ["tool_call_id", `"tool_call_id"`],
    ["compac*", `"compac"*`],
    ["staging AND promote", `"staging" AND "promote"`],
    ["AND staging OR", `"staging"`],
    ['say "hi"there', `"say" "hi""there"`],
    ["-", null],
    ["(x)", `"x"`],
  ];
  for (const [q, match] of cases) assert.equal(parseQuery({ q }).match, match, q);
});

test("a bare session id or 8-hex prefix also asks for that session's files", () => {
  const short = parseQuery({ q: "01a1164b rate" });
  assert.equal(short.match, `"01a1164b" "rate"`);
  assert.deepEqual(short.sessionIds, ["01a1164b"]);
  assert.equal(short.rest, `"rate"`);
  const full = parseQuery({ q: "01A1164B-4a2d-742d-b27a-82f086ed0200" });
  assert.deepEqual(full.sessionIds, ["01a1164b-4a2d-742d-b27a-82f086ed0200"]);
  assert.equal(full.rest, null);
  assert.deepEqual(parseQuery({ q: "rate" }).sessionIds, []);
});

test("-word excludes, and is:error, from:, in:, box: and kind: become filters", () => {
  const query = parseQuery({ q: 'relay -canary is:error from:owner in:"frontend bro" box:mac kind:tool' });
  assert.equal(query.match, `"relay"`);
  assert.equal(query.exclude, `"canary"`);
  assert.equal(query.filters.isError, true);
  assert.deepEqual(query.filters.from, ["owner"]);
  assert.deepEqual(query.filters.in, ["frontend bro"]);
  assert.deepEqual(query.filters.boxes, ["mac"]);
  assert.deepEqual(query.filters.kinds, ["tool_call", "tool_result"]);
  assert.equal(query.thinking, false);
});

test("thinking shows only when kind:thinking or kind=thinking asks for it", () => {
  assert.equal(parseQuery({ q: "x" }).thinking, false);
  assert.equal(parseQuery({ q: "x kind:message" }).thinking, false);
  assert.equal(parseQuery({ q: "x kind:thinking" }).thinking, true);
  assert.equal(parseQuery({ q: "x", kind: "thinking" }).thinking, true);
  assert.deepEqual(parseQuery({ q: "x", kind: "tool_result,user" }).filters.kinds, ["tool_result", "user"]);
  assert.throws(() => parseQuery({ q: "x kind:nope" }), QueryError);
});

test("dates read as KST days; before: and after: leave out their own day, on: and since/until keep it", () => {
  assert.equal(parseDate("2026-10-20"), KST_DAY("2026-10-20"));
  assert.equal(parseDate("2026-10-20T03:00:00Z"), Date.parse("2026-10-20T03:00:00Z"));
  assert.throws(() => parseDate("yesterday"), QueryError);
  const range = parseQuery({ q: "x after:2026-10-20 before:2026-10-23" }).filters;
  assert.equal(range.since, KST_DAY("2026-10-21"));
  assert.equal(range.until, KST_DAY("2026-10-23"));
  const on = parseQuery({ q: "x on:2026-10-20" }).filters;
  assert.deepEqual([on.since, on.until], [KST_DAY("2026-10-20"), KST_DAY("2026-10-21")]);
  const params = parseQuery({ q: "x", since: "2026-10-20", until: "2026-10-20" }).filters;
  assert.deepEqual([params.since, params.until], [KST_DAY("2026-10-20"), KST_DAY("2026-10-21")]);
});

test("Korean stems find their inflected words in a real FTS5 table: 쓰레드 finds 쓰레드에서, 문제 finds 문제를", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-history-query-"));
  const db = makeIndex(join(dir, "h.db"), [{ session: "s1" }], [
    { session: "s1", at: 1, kind: "user", text: "이 쓰레드에서 계속하자" },
    { session: "s1", at: 2, kind: "user", text: "쓰레드를 새로 열어" },
    { session: "s1", at: 3, kind: "user", text: "문제를 찾았다" },
    { session: "s1", at: 4, kind: "user", text: "the svelte check passed" },
    { session: "s1", at: 5, kind: "user", text: "svelte-check failed" },
    { session: "s1", at: 6, kind: "user", text: "check svelte later" },
  ]);
  const hits = (q: string): number[] => (db.prepare("SELECT rowid FROM fts WHERE fts MATCH ? ORDER BY rowid").all(parseQuery({ q }).match!) as { rowid: number }[])
    .map(row => Number(row.rowid) >> 10);
  assert.deepEqual(hits("쓰레드"), [1, 2]);
  assert.deepEqual(hits("문제"), [3]);
  // A punctuated word is a phrase, so its parts must sit side by side in order; unicode61 reads "svelte check" the same way.
  assert.deepEqual(hits("svelte-check"), [4, 5]);
  assert.deepEqual(hits("svelte check"), [4, 5, 6]);
  db.close();
});
