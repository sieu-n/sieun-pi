// Guards 10-19 17:22:07Z: the first alert list of a restarted Grafana lacked every CI rule, because Grafana lists a firing alert only after
// that rule's first evaluation, and the bridge resolved them all while they still fired. 10-29 15:42:52Z: after the obs deploy of 7a2f0d2868
// recreated Grafana, its alert list lacked the firing CI rules after they had evaluated again, the bridge resolved them for one poll, and d4
// read alerts_firing 0. Now a missing alert stays on the list while its rule is unevaluated or Grafana counts more of its instances alerting
// than the list holds, and a failed rule read fails the poll. A missing state file fails the duty's read instead of counting 0.
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { advance, emptyState, holdStillFiring, parseRuleStates, readFiringRules, type FiringAlert, type RuleState } from "../src/alert-bridge.ts";

const NOW = Date.parse("2026-10-19T17:22:07Z");
const alert = (uid: string, startsAt: string, fingerprint = `f-${uid}`): FiringAlert => ({ fingerprint, startsAt, alertname: uid,
  labels: { __alert_rule_uid__: uid, alertname: uid }, summary: "", url: "" });
const WAITING = alert("ci-jobs-waiting", "2026-10-19T17:01:10.000Z");
const STEPS = alert("ci-steps-stale", "2026-10-19T11:25:10.000Z");
const rule = (uid: string, lastEvaluation: string, totals: Record<string, number> = {}, isPaused = false) => ({ uid, lastEvaluation, isPaused, totals, health: "ok" });
const rules = (...list: ReturnType<typeof rule>[]) => ({ status: "success", data: { groups: [{ name: "ci-history", rules: list }] } });
const ZERO = "0001-01-01T00:00:00Z";
const EVALUATED = "2026-10-29T15:42:50Z";
const states = (entries: Record<string, RuleState>) => async () => new Map(Object.entries(entries));

test("the rule list gives each rule whether it is unevaluated and how many of its instances alert, and leaves out a paused rule", () => {
  const value = rules(rule("ci-jobs-waiting", ZERO), rule("ci-steps-stale", EVALUATED, { alerting: 2, recovering: 1, normal: 4 }), rule("old", ZERO, {}, true));
  assert.deepEqual([...parseRuleStates(value)], [["ci-jobs-waiting", { unevaluated: true, alerting: 0 }], ["ci-steps-stale", { unevaluated: false, alerting: 3 }]]);
  assert.throws(() => parseRuleStates({ status: "error" }), /no groups/);
});

test("after a Grafana restart a missing alert of an unevaluated rule stays firing, and one of an evaluated rule with no alerting instance resolves", async () => {
  const before = advance([WAITING, STEPS], emptyState(), () => "ci", NOW - 60_000).state;
  const list = await holdStillFiring([WAITING, STEPS], [], states({ "ci-jobs-waiting": { unevaluated: true, alerting: 0 }, "ci-steps-stale": { unevaluated: false, alerting: 0 } }));
  assert.deepEqual(list, [WAITING]);
  const after = advance(list, before, () => "ci", NOW);
  assert.equal(after.fired.size, 0);
  assert.equal(after.state.rules["ci/ci-jobs-waiting"]!.resolvedAt, undefined);
  assert.equal(after.state.rules["ci/ci-steps-stale"]!.resolvedAt, NOW);
});

test("10-29: an evaluated rule Grafana still counts alerting stays firing while the alert list lacks it, so the chat's count does not drop to 0", async () => {
  const TURBO = alert("ci-turbo-force-failed", "2026-10-27T22:46:10.000Z");
  const RED = alert("ci-staging-check-task-red", "2026-10-29T15:06:10.000Z");
  const before = advance([TURBO, RED], emptyState(), () => "ci", NOW - 60_000).state;
  const list = await holdStillFiring([TURBO, RED], [], states({ "ci-turbo-force-failed": { unevaluated: false, alerting: 1 }, "ci-staging-check-task-red": { unevaluated: false, alerting: 3 } }));
  assert.deepEqual(list, [TURBO, RED]);
  const after = advance(list, before, () => "ci", NOW);
  assert.equal(after.state.rules["ci/ci-turbo-force-failed"]!.resolvedAt, undefined);
  assert.equal(after.state.rules["ci/ci-staging-check-task-red"]!.resolvedAt, undefined);
});

test("one instance of a firing rule resolves when the alert list holds as many of the rule's instances as Grafana counts alerting", async () => {
  const one = alert("ci-staging-check-task-red", "2026-10-29T05:10:10.000Z", "f-one");
  const two = alert("ci-staging-check-task-red", "2026-10-29T09:46:10.000Z", "f-two");
  assert.deepEqual(await holdStillFiring([one, two], [two], states({ "ci-staging-check-task-red": { unevaluated: false, alerting: 1 } })), [two]);
  assert.deepEqual(await holdStillFiring([one, two], [two], states({ "ci-staging-check-task-red": { unevaluated: false, alerting: 2 } })), [two, one]);
});

test("the rule list is read only when an alert went missing, and a failed read fails the poll", async () => {
  let reads = 0;
  const failing = async (): Promise<Map<string, RuleState>> => { reads += 1; throw new Error("Grafana answered 502 for the alert list"); };
  assert.deepEqual(await holdStillFiring(null, [STEPS], failing), [STEPS]);
  assert.deepEqual(await holdStillFiring([STEPS], [STEPS, WAITING], failing), [STEPS, WAITING]);
  assert.equal(reads, 0);
  await assert.rejects(holdStillFiring([STEPS, WAITING], [STEPS], failing), /502/);
  assert.equal(reads, 1);
});

test("a duty's read of a missing bridge state file fails, so its precheck reports a source error and not alerts_firing 0", async () => {
  await assert.rejects(readFiringRules(join(tmpdir(), `no-alert-bridge-${process.pid}.json`), "ci"), /ENOENT/);
});
