import assert from "node:assert/strict";
import { test } from "node:test";
import { allRows, HOGQL_MAX_ROWS } from "../scripts/duties/hogql-rows.ts";
import { isQa, type NumbersDeps, readSignups } from "../scripts/duties/slack-green-numbers.ts";

/** PostHog's HogQL row rules as measured on 2026-11-22: no LIMIT gives the first 100 rows, an explicit LIMIT is capped at HOGQL_MAX_ROWS. */
function hogql<Row>(rows: Row[], query: string): Row[] {
  const limit = /\bLIMIT (\d+)\s*$/.exec(query);
  return rows.slice(0, limit ? Math.min(Number(limit[1]), HOGQL_MAX_ROWS) : 100);
}

/** The 11-22 window: a QA run's 170 sg-qa-connect- signups sort before the 51 real ones. */
const WINDOW: [string, string | null][] = [
  ...Array.from({ length: 170 }, (_, index): [string, string | null] => [`sg-qa-connect-${String(index).padStart(3, "0")}`, null]),
  ...Array.from({ length: 51 }, (_, index): [string, string | null] => [`user-${String(index).padStart(2, "0")}`, `u${index}@x.com`]),
];

const deps = (queries: string[]): NumbersDeps => ({
  now: () => Date.parse("2026-11-22T06:48:00Z"), dataDir: "/nowhere", sleep: async () => {},
  env: { POSTHOG_PERSONAL_API_KEY: "p", POSTHOG_PROJECT_ID: "1" },
  fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
    const query = (JSON.parse(String(init?.body)) as { query: { query: string } }).query.query;
    queries.push(query);
    const rows = query.includes("NOT startsWith(distinct_id, 'sg-qa-')") ? WINDOW.filter(([id]) => !id.startsWith("sg-qa-")) : WINDOW;
    return new Response(JSON.stringify({ results: hogql(rows, query) }), { status: 200 });
  }) as typeof fetch,
});

test("a QA burst of 170 signups in the 7-day window leaves all 51 real signups read (d5 read 28 of 51 on 11-22)", async () => {
  const queries: string[] = [];
  const signups = await readSignups(deps(queries));
  assert.equal(signups.filter(signup => !isQa(signup.id, signup.email)).length, 51);
  assert.match(queries[0]!, /ORDER BY distinct_id\nLIMIT 50000$/);
  assert.match(queries[0]!, /NOT match\(coalesce\(toString\(email\), ''\), '\^\(sg-qa-\[\^@\]\*@slack\\\\\.green\|/);
});

test("allRows throws when HogQL gives its 50000-row cap, so a cut list is a source error and never a wrong number", async () => {
  const rows = Array.from({ length: HOGQL_MAX_ROWS + 7 }, (_, index) => [index]);
  await assert.rejects(allRows("SELECT n FROM t ORDER BY n", async query => hogql(rows, query)), /50000-row cap/);
  assert.equal((await allRows("SELECT n FROM t ORDER BY n", async query => hogql(rows.slice(0, 7), query))).length, 7);
});
