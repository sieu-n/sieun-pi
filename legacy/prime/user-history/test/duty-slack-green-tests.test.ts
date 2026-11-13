import assert from "node:assert/strict";
import { test } from "node:test";
import { type ArmRow, armsQuery, type Experiment, fisherP, measureTests, readDate, testsMetrics } from "../scripts/duties/slack-green-tests.ts";

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

test("the read date comes from the description line, then tests.json, then 28 days after the start", () => {
  const base = experiment(1, "sg-exp-a", "2026-11-01");
  assert.deepEqual(readDate({ ...base, description: "Goal: signups. Read date: 2026-11-19." }, []), { date: "2026-11-19", from: "the experiment description" });
  assert.deepEqual(readDate(base, [{ flag: "sg-exp-a", experiment_id: null, read_date: "2026-11-20" }]), { date: "2026-11-20", from: "tests.json" });
  assert.deepEqual(readDate(base, []), { date: "2026-11-29", from: "28 days after the start" });
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
  assert.deepEqual(metrics, { tests_overdue: 1, tests_live: 2, tests_live_p_under_005: 0, source_errors: 0 });
  assert.deepEqual(flagged.map(slice => [slice.kind, slice.item]), [["overdue_test", "sg-exp-late"], ["running_test", "sg-exp-new"]]);
  assert.match(flagged[0]!.excerpt, /control 111 people: 1 signed up in 7 days \(0\.9%\).*test 106 people: 4 signed up in 7 days \(3\.8%\).*signed up in 7 days 0\.204/);
});

test("a tests.json test outside PostHog counts once its read date passes", () => {
  const table = [{ flag: "email-day3-cohort", experiment_id: null, read_date: "2026-11-10" }, { flag: "email-later", experiment_id: null, read_date: "2026-12-01" }];
  const { metrics, flagged } = testsMetrics([], [], table, NOW);
  assert.equal(metrics.tests_overdue, 1);
  assert.equal(flagged[0]!.item, "email-day3-cohort");
});

test("a failed experiments read is a source error with no made-up count", async () => {
  const output = await measureTests(async () => { throw new Error("HTTP 403: missing scope"); }, [], undefined, NOW);
  assert.deepEqual(output.metrics, { tests_overdue: 0, source_errors: 1 });
});

test("the arms query reads first exposures with each outcome's window and drops QA people and two-arm people", () => {
  const query = armsQuery(["sg-exp-home-1"], "2026-10-14");
  assert.match(query, /INTERVAL 7 DAY/);
  assert.match(query, /INTERVAL 28 DAY/);
  assert.match(query, /ex\.narms = 1/);
  assert.match(query, /match\(coalesce\(toString\(properties\.email\), ''\), '\(\?i\)sgqa\|sg-qa\|@slack\\\\\.green/);
});
