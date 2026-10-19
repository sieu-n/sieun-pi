// Guards 10-19 17:22:07Z: the first alert list of a restarted Grafana lacked every CI rule, because Grafana lists a firing alert only after
// that rule's first evaluation, and the bridge resolved them all while they still fired. Now a missing alert of a rule Grafana has not
// evaluated since it started stays on the list, and a failed rule read fails the poll.
import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, emptyState, holdUnevaluated, parseUnevaluated, type FiringAlert } from "../src/alert-bridge.ts";

const NOW = Date.parse("2026-10-19T17:22:07Z");
const alert = (uid: string, startsAt: string): FiringAlert => ({ fingerprint: `f-${uid}`, startsAt, alertname: uid, labels: { __alert_rule_uid__: uid, alertname: uid },
  summary: "", url: "" });
const WAITING = alert("ci-jobs-waiting", "2026-10-19T17:01:10.000Z");
const STEPS = alert("ci-steps-stale", "2026-10-19T11:25:10.000Z");
const rule = (uid: string, lastEvaluation: string, isPaused = false) => ({ uid, lastEvaluation, isPaused, health: "ok" });
const rules = (...list: ReturnType<typeof rule>[]) => ({ status: "success", data: { groups: [{ name: "ci-history", rules: list }] } });
const ZERO = "0001-01-01T00:00:00Z";

test("a rule Grafana lists with the zero evaluation time is unevaluated, and a paused rule is not", () => {
  const value = rules(rule("ci-jobs-waiting", ZERO), rule("ci-steps-stale", "2026-10-19T17:22:00Z"), rule("old", ZERO, true));
  assert.deepEqual([...parseUnevaluated(value)], ["ci-jobs-waiting"]);
  assert.throws(() => parseUnevaluated({ status: "error" }), /no groups/);
});

test("after a Grafana restart a missing alert of an unevaluated rule stays firing, and one of an evaluated rule resolves", async () => {
  const before = advance([WAITING, STEPS], emptyState(), () => "ci", NOW - 60_000).state;
  const list = await holdUnevaluated([WAITING, STEPS], [], async () => new Set(["ci-jobs-waiting"]));
  assert.deepEqual(list, [WAITING]);
  const after = advance(list, before, () => "ci", NOW);
  assert.equal(after.fired.size, 0);
  assert.equal(after.state.rules["ci/ci-jobs-waiting"]!.resolvedAt, undefined);
  assert.equal(after.state.rules["ci/ci-steps-stale"]!.resolvedAt, NOW);
});

test("the rule list is read only when an alert went missing, and a failed read fails the poll", async () => {
  let reads = 0;
  const unevaluated = async () => { reads += 1; throw new Error("Grafana answered 502 for the alert list"); };
  assert.deepEqual(await holdUnevaluated(null, [STEPS], unevaluated), [STEPS]);
  assert.deepEqual(await holdUnevaluated([STEPS], [STEPS, WAITING], unevaluated), [STEPS, WAITING]);
  assert.equal(reads, 0);
  await assert.rejects(holdUnevaluated([STEPS, WAITING], [STEPS], unevaluated), /502/);
  assert.equal(reads, 1);
});
