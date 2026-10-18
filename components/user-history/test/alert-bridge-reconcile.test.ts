// Guards 10-18: prod ClickHouse, Redis and Postgres backup alerts fired from 10-16 for over 3 days with no open board step anywhere, because the bridge placed a step only when a rule first fired.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AlertBridge, ESCALATE_MS, REOPEN_MS, alertKey, parseAlerts, ruleKey, type BridgeState, type FiringAlert } from "../src/alert-bridge.ts";
import { ALERT_ROUTES } from "../src/alert-routes.ts";
import { BoardStore } from "../src/chat-board-store.ts";
import { walkItems } from "../src/shared/chat-board.ts";
import type { PlanItem } from "../src/shared/types.ts";

const NOW = Date.parse("2026-10-18T06:30:00Z");
const CI = ALERT_ROUTES.find(route => route.chat === "VP of CI")!.session;
const OPS = ALERT_ROUTES.find(route => route.chat === "ops guy")!.session;
const METAL = "01a11d24-ac9b-757d-ac51-9b2b7598782f";

const raw = (fingerprint: string, labels: Record<string, string>, startsAt: string) => ({ fingerprint, startsAt, labels, annotations: { summary: `${labels.alertname} is firing.` },
  generatorURL: `https://obs.virev.ai/alerting/grafana/${labels.__alert_rule_uid__}/view`, status: { state: "active", silencedBy: [], inhibitedBy: [] } });
const ciAlert = raw("aaaa000000000001", { alertname: "CI runner queue over 30 min", __alert_rule_uid__: "ci-queue-wait", environment: "production" }, "2026-10-18T06:00:00.000Z");
const backup = raw("34a8c0c62d402cb1", { alertname: "ClickHouse or Redis backup older than 9h, or ClickHouse full older than 26h", __alert_rule_uid__: "metal-backup-ch-redis-age",
  box: "us-metal01" }, "2026-10-16T06:19:30.000Z");

async function fixture(list: unknown[], state?: BridgeState) {
  const dir = await mkdtemp(join(tmpdir(), "alert-reconcile-"));
  const file = join(dir, "alert-bridge.json");
  if (state) await writeFile(file, JSON.stringify(state));
  const boards = new BoardStore(dir);
  let now = NOW;
  const sent: { session: string; text: string }[] = [];
  const bridge = new AlertBridge({ file, boards, now: () => now, log: () => {}, alerts: async () => parseAlerts(list), owners: async () => null,
    hasBoard: async session => session !== METAL, deliver: async (session, text) => { sent.push({ session, text }); return "sent"; } });
  const steps = async (id: string): Promise<PlanItem[]> => {
    const found: PlanItem[] = [];
    walkItems((await boards.read(id))?.plan ?? [], item => { if (item.note?.startsWith("Grafana alert ")) found.push(item); });
    return found;
  };
  return { boards, bridge, sent, steps, at: (ms: number) => { now = ms; }, state: async () => JSON.parse(await readFile(file, "utf8")) as BridgeState };
}

const recorded = (alert: FiringAlert, chat: string, at: number): BridgeState => ({ v: 2, rules: { [ruleKey(chat, alert.labels.__alert_rule_uid__!)]: {
  chat, step: null, rule: alert.labels.__alert_rule_uid__!, alertname: alert.alertname, startsAt: alert.startsAt, wokeAt: at, firstWokeAt: at,
  instances: { [alertKey(alert)]: { startsAt: alert.startsAt, labels: alert.labels } } } } });

test("reconcile: a rule recorded with no step gets one, noted as found by reconcile, and escalates 30 min after that", async () => {
  const [alert] = parseAlerts([ciAlert]);
  const f = await fixture([ciAlert], recorded(alert!, CI, NOW - 3 * 86_400_000));
  await f.bridge.tick();
  const [step, ...more] = await f.steps(CI);
  assert.equal(more.length, 0);
  assert.equal(step!.status, "todo");
  assert.match(step!.note!, /^Firing since 2026-10-18T06:00:00\.000Z, found by reconcile at 2026-10-18T06:30:00\.000Z with no open step on this board\.$/m);
  assert.equal((await f.state()).rules[ruleKey(CI, "ci-queue-wait")]!.step, step!.id);
  assert.equal(f.sent.length, 0);
  f.at(NOW + ESCALATE_MS);
  await f.bridge.tick();
  assert.equal(f.sent.filter(({ text }) => text.startsWith("[alert-escalation]")).length, 1);
});

test("reconcile: a backup rule recorded for metal box owner, which has no board, moves to ops guy's board", async () => {
  const [alert] = parseAlerts([backup]);
  const f = await fixture([backup], recorded(alert!, METAL, Date.parse("2026-10-16T06:20:10Z")));
  await f.bridge.tick();
  const [step, ...more] = await f.steps(OPS);
  assert.equal(more.length, 0);
  assert.match(step!.note!, /found by reconcile .* has no board, so the step is on this one\.$/m);
  const state = await f.state();
  assert.deepEqual(Object.keys(state.rules), [ruleKey(OPS, "metal-backup-ch-redis-age")]);
  assert.equal(state.rules[ruleKey(OPS, "metal-backup-ch-redis-age")]!.step, step!.id);
});

test("reconcile: a rule whose step is open gets no second step on later ticks", async () => {
  const f = await fixture([ciAlert]);
  for (let tick = 0; tick < 5; tick++) { f.at(NOW + tick * 30_000); await f.bridge.tick(); }
  const steps = await f.steps(CI);
  assert.equal(steps.length, 1);
  assert.doesNotMatch(steps[0]!.note!, /found by reconcile/);
});

test("reconcile: a step closed while its rule fires reopens after 24 h, and its escalation runs again", async () => {
  const f = await fixture([ciAlert]);
  await f.bridge.tick();
  const [step] = await f.steps(CI);
  await f.boards.apply(CI, [{ op: "plan_update", id: step!.id, status: "done" }], "agent");
  f.at(NOW + 60_000);
  await f.bridge.tick();
  f.at(NOW + 60_000 + REOPEN_MS - 30_000);
  await f.bridge.tick();
  assert.equal((await f.steps(CI))[0]!.status, "done");
  assert.equal(f.sent.length, 0);
  const reopenAt = NOW + 60_000 + REOPEN_MS;
  f.at(reopenAt);
  await f.bridge.tick();
  const [again, ...more] = await f.steps(CI);
  assert.equal(more.length, 0);
  assert.equal(again!.id, step!.id);
  assert.equal(again!.status, "todo");
  assert.match(again!.note!, /^Reopened by reconcile at .*: this step was closed for over 24 h and the rule still fires, firing since 2026-10-18T06:00:00\.000Z\.$/m);
  f.at(reopenAt + ESCALATE_MS);
  await f.bridge.tick();
  assert.equal(f.sent.filter(({ text }) => text.startsWith("[alert-escalation]")).length, 1);
});

// Guards 10-18 05:50:35Z: one staging Prometheus restart put 20 DatasourceError steps on ops guy's board with no owner, they resolved by 05:54Z,
// and they sat until the 06:49Z check-in started a job, so d7 read 27 stuck steps.
test("owner: an alert burst's new steps go to one job at once, a working job gets the next burst by message, and an ended one is replaced", async () => {
  const datasource = (n: number, at: string) => raw(`dddd00000000000${n}`, { alertname: "DatasourceError", __alert_rule_uid__: `metal-rule-${n}`,
    datasource_uid: "estate_prometheus_stg" }, at);
  let list: unknown[] = [1, 2, 3].map(n => datasource(n, "2026-10-18T05:49:30.000Z"));
  const dir = await mkdtemp(join(tmpdir(), "alert-owner-"));
  const boards = new BoardStore(dir);
  let now = Date.parse("2026-10-18T05:50:35Z");
  const started: { chat: string; steps: string[] }[] = [];
  const sent: { session: string; text: string }[] = [];
  let working = true;
  const bridge = new AlertBridge({ file: join(dir, "alert-bridge.json"), boards, now: () => now, log: () => {}, alerts: async () => parseAlerts(list),
    owners: async () => null, deliver: async (session, text) => { sent.push({ session, text }); return "sent"; },
    startJob: async (chat, steps) => { started.push({ chat, steps: steps.map(line => line.step) }); return { id: `job-${started.length}`, name: `alert ops guy ${started.length}` }; },
    jobWorking: async () => working });
  const steps = async (): Promise<PlanItem[]> => {
    const found: PlanItem[] = [];
    walkItems((await boards.read(OPS))?.plan ?? [], item => { if (item.note?.startsWith("Grafana alert ")) found.push(item); });
    return found;
  };
  await bridge.tick();
  const burst = await steps();
  assert.equal(burst.length, 3);
  assert.deepEqual(started, [{ chat: OPS, steps: burst.map(item => item.id) }]);
  for (const item of burst) assert.deepEqual([item.job, item.sessionId], ["alert ops guy 1", "job-1"]);
  list = [];
  now += 30_000;
  await bridge.tick();
  assert.equal(started.length, 1);
  assert.ok((await steps()).every(item => item.sessionId === "job-1" && item.status === "todo"));
  list = [datasource(4, "2026-10-18T06:04:00.000Z")];
  now += 30_000;
  await bridge.tick();
  const fourth = (await steps()).find(item => !burst.some(old => old.id === item.id))!;
  assert.equal(started.length, 1);
  assert.equal(fourth.sessionId, "job-1");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.session, "job-1");
  assert.match(sent[0]!.text, new RegExp(`^\\[alert\\] The alert bridge put one more alert step on this chat's board and gave it to you: ${fourth.id} "DatasourceError"`));
  working = false;
  list = [datasource(4, "2026-10-18T06:04:00.000Z"), datasource(5, "2026-10-18T06:40:00.000Z")];
  now += 30_000;
  await bridge.tick();
  const fifth = (await steps()).find(item => item.id !== fourth.id && !burst.some(old => old.id === item.id))!;
  assert.equal(started.length, 2);
  assert.deepEqual(started[1]!.steps, [fifth.id]);
  assert.equal(fifth.sessionId, "job-2");
  assert.equal(sent.length, 1);
});
