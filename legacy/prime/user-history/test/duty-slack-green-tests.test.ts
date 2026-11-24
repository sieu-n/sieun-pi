import assert from "node:assert/strict";
import { test } from "node:test";
import { type ArmRow, armsQuery, type Experiment, fisherP, isLive, measureTests, posthogQuery, readDate, testsMetrics, toExperiment } from "../scripts/duties/slack-green-tests.ts";

const NOW = Date.parse("2026-11-13T12:00:00Z");
const experiment = (id: number, flag: string, start: string, extra: Partial<Experiment> = {}): Experiment =>
  ({ id, name: `${flag}: a test`, flag, start: `${start}T10:00:00+09:00`, end: null, archived: false, flagDeleted: false, description: "", ...extra });
const arm = (flag: string, arm: string, n: number, signedUp: number): ArmRow =>
  ({ flag, arm, n, signed_up: signedUp, workspace_added: 0, paid: 0, last_new: "2026-11-12T10:00:00+09:00" });

test("fisherP matches the textbook two-sided values", () => {
  assert.equal(fisherP(1, 9, 11, 3), 0.003);
  assert.equal(fisherP(5, 5, 5, 5), 1);
  assert.equal(fisherP(4, 102, 1, 110), 0.204);
});

test("the read date comes from the description line, else 28 days after the start", () => {
  const base = experiment(1, "sg-exp-a", "2026-11-01");
  assert.deepEqual(readDate({ ...base, description: "Read date: 2026-12-19\nGoal: signups." }), { date: "2026-12-19", from: "the experiment description" });
  assert.deepEqual(readDate(base), { date: "2026-11-29", from: "28 days after the start" });
});

test("only live tests past their read date count, and an ended, archived or deleted one has its call", () => {
  const experiments = [
    experiment(1, "sg-exp-late", "2026-10-01"),
    experiment(2, "sg-exp-new", "2026-11-10"),
    experiment(3, "sg-exp-ended", "2026-10-01", { end: "2026-10-30T00:00:00+09:00" }),
    experiment(4, "sg-exp-archived", "2026-10-01", { archived: true }),
    experiment(5, "sg-exp-deleted", "2026-10-01", { flagDeleted: true }),
    experiment(6, "sg-exp-draft", "2026-10-01", { start: null }),
  ];
  const { metrics, flagged } = testsMetrics(experiments, [arm("sg-exp-late", "control", 111, 1), arm("sg-exp-late", "test", 106, 4)], [], NOW);
  assert.deepEqual(metrics, { tests_overdue: 1, tests_untracked: 0, tests_live: 2, tests_live_p_under_005: 0, source_errors: 0 });
  assert.deepEqual(flagged.map(slice => [slice.kind, slice.item]), [["overdue_test", "sg-exp-late"], ["running_test", "sg-exp-new"]]);
  assert.match(flagged[0]!.excerpt, /control 111 people: 1 signed up in 7 days \(0\.9%\).*test 106 people: 4 signed up in 7 days \(3\.8%\).*signed up in 7 days 0\.204/);
});

test("an sg-exp- flag with exposures and no experiment is an untracked test with its arms", () => {
  const exposures = [{ flag: "sg-exp-email-after-d3", first: "2026-11-05T06:04:08Z", last: "2026-11-16T12:04:58Z", events: 63 },
    { flag: "sg-exp-new", first: "2026-11-10T01:00:00Z", last: "2026-11-13T01:00:00Z", events: 9 }];
  const { metrics, flagged } = testsMetrics([experiment(2, "sg-exp-new", "2026-11-10")], [arm("sg-exp-email-after-d3", "control", 30, 2)], exposures, NOW);
  assert.equal(metrics.tests_untracked, 1);
  assert.equal(metrics.tests_overdue, 0);
  const slice = flagged.find(s => s.kind === "untracked_test")!;
  assert.equal(slice.item, "sg-exp-email-after-d3");
  assert.match(slice.excerpt, /no PostHog experiment, first exposure 2026-11-05, 63 exposure events.*control 30 people: 2 signed up/);
});

test("a failed experiments read is a source error with no made-up count", async () => {
  const output = await measureTests(async () => { throw new Error("HTTP 403: missing scope"); }, NOW);
  assert.deepEqual(output.metrics, { tests_overdue: 0, source_errors: 1 });
});

test("the arms query reads first exposures with each outcome's window and drops QA people and two-arm people", () => {
  const query = armsQuery(["sg-exp-home-1"], "2026-10-14");
  assert.match(query, /INTERVAL 7 DAY/);
  assert.match(query, /INTERVAL 28 DAY/);
  assert.match(query, /ex\.narms = 1/);
  assert.match(query, /match\(coalesce\(toString\(properties\.email\), ''\), '\(\?i\)sgqa\|sg-qa\|@slack\\\\\.green/);
});

/**
 * On 11-16 the duty read a tests.json written on 11-13 for its read dates and email tests, which had missed ten experiments started since. The
 * precheck now reads PostHog only, so this holds that every started experiment with no call and every sg-exp- flag with exposures and no
 * experiment comes out of measureTests as a slice, whatever the rows hold.
 */
test("every started experiment and every untracked exposed flag is in the precheck output", async () => {
  const rows: unknown[][] = [];
  for (let id = 1; id <= 60; id++) {
    const started = id % 5 !== 0 ? `2026-${id % 2 ? "10" : "11"}-${String(1 + (id % 28)).padStart(2, "0")}T10:00:00+09:00` : null;
    const ended = id % 7 === 0 ? "2026-11-12T00:00:00+09:00" : null;
    const description = id % 3 ? `Read date: 2026-11-${String(10 + (id % 18)).padStart(2, "0")}\nwhat it tests` : "";
    rows.push([id, `test ${id}`, id % 11 ? `sg-exp-t${id}` : null, started, ended, id % 13 === 0, id % 17 === 0, description]);
  }
  const exposures = [["sg-exp-t4", "2026-11-01T00:00:00Z", "2026-11-13T00:00:00Z", 5], ["sg-exp-email-a", "2026-11-02T00:00:00Z", "2026-11-13T00:00:00Z", 8],
    ["sg-exp-email-b", "2026-11-09T00:00:00Z", "2026-11-12T00:00:00Z", 2]];
  const query = async (hogql: string) => hogql.includes("system.experiments") ? rows : hogql.includes("HAVING max(timestamp)") ? exposures : [];
  const output = await measureTests(query, NOW);
  const items = new Set(output.flagged!.map(slice => slice.item));
  const started = rows.map(toExperiment).filter(isLive);
  assert.ok(started.length > 20);
  for (const e of started) assert.ok(items.has(e.flag ?? String(e.id)), `started experiment ${e.id} (${e.flag}) is missing from the precheck output`);
  for (const flag of ["sg-exp-email-a", "sg-exp-email-b"]) assert.ok(items.has(flag), `untracked ${flag} is missing from the precheck output`);
  assert.equal(output.metrics.tests_live, started.length);
  assert.equal(output.metrics.tests_untracked, 2);
  assert.equal(output.flagged!.length, started.length + 2);
});

test("posthogQuery runs async and polls until the query finishes, so a query past PostHog's 10 s blocking limit still reads", async () => {
  const calls: { url: string; body: string | undefined }[] = [];
  const answers = [
    { status: 202, body: { query_status: { id: "q1", complete: false } } },
    { status: 200, body: { query_status: { id: "q1", complete: true, error: false, results: { results: [["sg-exp-a", "2026-11-01", "2026-11-13", 5]] } } } },
  ];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body as string | undefined });
    const answer = answers.shift()!;
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
  const rows = await posthogQuery("phx_key", "226805", "https://ph.test", fetcher)("SELECT 1");
  assert.deepEqual(rows, [["sg-exp-a", "2026-11-01", "2026-11-13", 5]]);
  assert.equal(JSON.parse(calls[0]!.body!).refresh, "force_async");
  assert.equal(calls[1]!.url, "https://ph.test/api/projects/226805/query/q1/");
});

test("posthogQuery fails on a query error and on a non-2xx answer", async () => {
  const failing = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  await assert.rejects(posthogQuery("k", "1", "https://ph.test", failing(200, { query_status: { id: "q", complete: true, error: true, error_message: "Query has hit the max execution time" } }))("SELECT 1"),
    /max execution time/);
  await assert.rejects(posthogQuery("k", "1", "https://ph.test", failing(504, { detail: "Query has hit the max execution time" }))("SELECT 1"), /HTTP 504/);
});
