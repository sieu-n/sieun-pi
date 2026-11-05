// Guards 10-19 17:22:07Z: the first alert list of a restarted Grafana lacked every CI rule, because Grafana lists a firing alert only after
// that rule's first evaluation, and the bridge resolved them all while they still fired. 10-29 15:42:52Z: after the obs deploy of 7a2f0d2868
// recreated Grafana, its alert list lacked the firing CI rules after they had evaluated again, the bridge resolved them for one poll, and d4
// read alerts_firing 0. Now a missing alert stays on the list while its rule is unevaluated or Grafana counts more of its instances alerting
// than the list holds, and a failed rule read fails the poll. A missing state file fails the duty's read instead of counting 0. 11-03 22:44Z:
// an obs deploy that changed crawler-prod-kafka-writer-lag reset its firing sets, they fired again an hour later, and the bridge paged again.
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { advance, dueReopens, emptyState, holdStillFiring, owed, parsePendingSets, parseRuleStates, readFiringRules, setKey, type BridgeState, type FiringAlert, type RuleState } from "../src/alert-bridge.ts";

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
const ruleState = (unevaluated: boolean, alerting: number, more: Partial<RuleState> = {}): RuleState => ({ unevaluated, alerting, pending: 0, evaluatedAt: unevaluated ? 0 : NOW, ...more });

test("the rule list gives each rule whether it is unevaluated and how many of its instances alert, and leaves out a paused rule", () => {
  const value = rules(rule("ci-jobs-waiting", ZERO), rule("ci-steps-stale", EVALUATED, { alerting: 2, recovering: 1, normal: 4 }), rule("old", ZERO, {}, true));
  assert.deepEqual([...parseRuleStates(value)], [["ci-jobs-waiting", ruleState(true, 0)], ["ci-steps-stale", ruleState(false, 3, { evaluatedAt: Date.parse(EVALUATED) })]]);
  assert.throws(() => parseRuleStates({ status: "error" }), /no groups/);
});

test("after a Grafana restart a missing alert of an unevaluated rule stays firing, and one of an evaluated rule with no alerting instance resolves", async () => {
  const before = advance([WAITING, STEPS], emptyState(), () => "ci", NOW - 60_000).state;
  const list = await holdStillFiring([WAITING, STEPS], [], states({ "ci-jobs-waiting": ruleState(true, 0), "ci-steps-stale": ruleState(false, 0) }));
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
  const list = await holdStillFiring([TURBO, RED], [], states({ "ci-turbo-force-failed": ruleState(false, 1), "ci-staging-check-task-red": ruleState(false, 3) }));
  assert.deepEqual(list, [TURBO, RED]);
  const after = advance(list, before, () => "ci", NOW);
  assert.equal(after.state.rules["ci/ci-turbo-force-failed"]!.resolvedAt, undefined);
  assert.equal(after.state.rules["ci/ci-staging-check-task-red"]!.resolvedAt, undefined);
});

test("one instance of a firing rule resolves when the alert list holds as many of the rule's instances as Grafana counts alerting", async () => {
  const one = alert("ci-staging-check-task-red", "2026-10-29T05:10:10.000Z", "f-one");
  const two = alert("ci-staging-check-task-red", "2026-10-29T09:46:10.000Z", "f-two");
  assert.deepEqual(await holdStillFiring([one, two], [two], states({ "ci-staging-check-task-red": ruleState(false, 1) })), [two]);
  assert.deepEqual(await holdStillFiring([one, two], [two], states({ "ci-staging-check-task-red": ruleState(false, 2) })), [two, one]);
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

test("11-03: a deploy that resets a changed rule's firing sets holds them through Pending, and their fire an hour later pages nobody again", async () => {
  const uid = "crawler-prod-kafka-writer-lag";
  const title = "Production Kafka writer group lags 50,000 records for an hour";
  const lag = (group: string, startsAt: string): FiringAlert => ({ fingerprint: `f-${group}`, startsAt, alertname: title, summary: "", url: "",
    labels: { __alert_rule_uid__: uid, alertname: title, grafana_folder: "metal", group } });
  const at = (time: string) => Date.parse(`2026-11-03T${time}Z`);
  const [os, pg] = [lag("instagram-census-os", "2026-11-02T17:50:30.000Z"), lag("instagram-census-pg", "2026-11-02T17:50:30.000Z")];
  const first = advance([os, pg], emptyState(), () => "crawler", at("22:43:45"));
  assert.equal(first.fired.size, 1);
  const key = [...first.fired][0]!;
  const job = { id: "j1", name: "triage", at: at("22:43:50") };
  let state: BridgeState = { ...first.state, rules: { [key]: { ...first.state.rules[key]!, job } }, jobs: { j1: { ...job, chat: "crawler", ranAt: at("22:50:00") } }, chats: { crawler: "j1" } };
  const instances = (group: string, labelState: string) => ({ labels: { alertname: title, grafana_folder: "metal", group }, state: labelState });
  const ruleList = (...alerts: ReturnType<typeof instances>[]) => ({ data: { groups: [{ rules: [{ uid, alerts }, { uid: "other", alerts: [instances("instagram-census-os", "Pending")] }] }] } });
  const pending = (value: unknown) => async (alert: FiringAlert) => parsePendingSets(value, alert.labels.__alert_rule_uid__!);
  assert.deepEqual([...parsePendingSets(ruleList(instances("instagram-census-os", "Pending"), instances("tiktok-shop-pg", "Normal")), uid)], [setKey(os.labels)]);

  // 22:44:20Z the reload resets both sets to "Normal (Updated)" with no evaluation, so the next list lacks them.
  let list = await holdStillFiring([os, pg], [], states({ [uid]: ruleState(false, 0, { evaluatedAt: at("22:43:30") }) }),
    { since: at("22:43:45"), pending: pending(ruleList()) });
  assert.deepEqual(list, [os, pg]);
  state = advance(list, state, () => "crawler", at("22:44:25")).state;
  // 22:44:30Z the first evaluation after the reset puts both sets into Pending, where they wait out the rule's hour.
  list = await holdStillFiring(list, [], states({ [uid]: ruleState(false, 0, { pending: 2, evaluatedAt: at("22:44:30") }) }),
    { since: at("22:44:25"), pending: pending(ruleList(instances("instagram-census-os", "Pending"), instances("instagram-census-pg", "Pending"))) });
  assert.deepEqual(list, [os, pg]);
  state = advance(list, state, () => "crawler", at("22:44:55")).state;
  assert.equal(state.rules[key]!.resolvedAt, undefined);
  // 23:44:30Z both fire again with a new startsAt: the same incident, and the job that held it owes nothing.
  const again = [lag("instagram-census-os", "2026-11-03T23:44:30.000Z"), lag("instagram-census-pg", "2026-11-03T23:44:30.000Z")];
  list = await holdStillFiring(list, again, states({ [uid]: ruleState(false, 2, { evaluatedAt: at("23:44:30") }) }),
    { since: at("23:44:05"), pending: pending(ruleList(instances("instagram-census-os", "Alerting"), instances("instagram-census-pg", "Alerting"))) });
  assert.deepEqual(list, again);
  const after = advance(list, state, () => "crawler", at("23:44:35"));
  assert.equal(after.fired.size, 0);
  assert.equal(after.state.rules[key]!.resolvedAt, undefined);
  assert.equal(after.state.rules[key]!.job?.id, "j1");
  assert.equal(owed(after.state, after.state.rules[key]!), false);
  assert.deepEqual(dueReopens(after.state, at("23:45:05")), []);
});

test("with the reset check, a set that resolved on an evaluation since the last list still resolves while another set of its rule pends", async () => {
  const set = (group: string): FiringAlert => ({ ...alert("lag", "2026-11-05T08:00:00.000Z", `f-${group}`), labels: { __alert_rule_uid__: "lag", alertname: "lag", group } });
  const list = await holdStillFiring([set("a")], [], states({ lag: ruleState(false, 0, { pending: 1, evaluatedAt: NOW }) }),
    { since: NOW - 30_000, pending: async () => new Set([setKey(set("b").labels)]) });
  assert.deepEqual(list, []);
});

test("a held set resolves at the first evaluation that leaves it Normal, and a held set Grafana lists again with a new startsAt drops at once", async () => {
  const set = (startsAt: string): FiringAlert => ({ ...alert("lag", startsAt, "f-a"), labels: { __alert_rule_uid__: "lag", alertname: "lag", group: "a" } });
  const old = set("2026-11-05T08:00:00.000Z");
  const none = { since: NOW - 30_000, pending: async () => new Set<string>() };
  assert.deepEqual(await holdStillFiring([old], [], states({ lag: ruleState(false, 0, { evaluatedAt: NOW - 45_000 }) }), none), [old]);
  assert.deepEqual(await holdStillFiring([old], [], states({ lag: ruleState(false, 0, { evaluatedAt: NOW - 10_000 }) }), none), []);
  const again = set("2026-11-05T09:00:00.000Z");
  assert.deepEqual(await holdStillFiring([old], [again], states({ lag: ruleState(false, 1, { evaluatedAt: NOW - 45_000 }) }), none), [again]);
});

test("11-05: a set the rule list writes with an empty label matches the alert list's set, which leaves the empty label out", () => {
  const listed = { alertname: "over pace", owner: "ops", vendor: "railway" };
  const value = { data: { groups: [{ rules: [{ uid: "vendor-bill-over-pace", alerts: [{ labels: { ...listed, project: "" }, state: "Pending" }] }] }] } };
  assert.deepEqual([...parsePendingSets(value, "vendor-bill-over-pace")], [setKey({ __alert_rule_uid__: "vendor-bill-over-pace", ...listed })]);
});
