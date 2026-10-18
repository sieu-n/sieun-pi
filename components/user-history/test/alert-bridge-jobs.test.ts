// Guards 10-18: the bridge filed every firing Grafana alert as a plan step, so at 16:00Z ops guy had 14 open steps under "Firing prod alerts" and Crawler VP about 30 under p146, and the owner said "stop being paranoid in plan under p45, p221" (plan-and-duties.md). Now each firing rule gets one triage job and a later fire of it goes to that job.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AlertBridge, ESCALATE_MS, REFIRE_MS, REOPEN_MS, firingRules, parseAlerts, parseOwners, parseState, readFiringRules, ruleKey, type AlertLine, type BridgeState, type RuleJob } from "../src/alert-bridge.ts";
import { ALERT_ROUTES } from "../src/alert-routes.ts";

const NOW = Date.parse("2026-10-18T16:00:00Z");
const CI = ALERT_ROUTES.find(route => route.chat === "VP of CI")!.session;
const OPS = ALERT_ROUTES.find(route => route.chat === "ops guy")!.session;
const METAL = "01a11d24-ac9b-757d-ac51-9b2b7598782f";

const raw = (fingerprint: string, labels: Record<string, string>, startsAt: string) => ({ fingerprint, startsAt, labels, annotations: { summary: `${labels.alertname} is firing.` },
  generatorURL: `https://obs.virev.ai/alerting/grafana/${labels.__alert_rule_uid__}/view`, status: { state: "active", silencedBy: [], inhibitedBy: [] } });
const ciAlert = (fingerprint = "aaaa000000000001", startsAt = "2026-10-18T15:58:00.000Z") =>
  raw(fingerprint, { alertname: "CI history ingest has not read GitHub for 15 min", __alert_rule_uid__: "ci-history-stale" }, startsAt);
const backup = raw("34a8c0c62d402cb1", { alertname: "ClickHouse or Redis backup older than 9h", __alert_rule_uid__: "metal-backup-ch-redis-age" }, "2026-10-16T06:19:30.000Z");

const OWNERS = parseOwners({ owners: { "metal box owner": METAL, "ops guy": OPS }, fallback: "ops guy",
  routes: [{ name: "box backups", match: { __alert_rule_uid__: "^metal-backup-" }, owner: "metal box owner" }] });

async function fixture(options: { state?: unknown; failStarts?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "alert-bridge-jobs-"));
  const file = join(dir, "alert-bridge.json");
  if (options.state) await writeFile(file, JSON.stringify(options.state));
  let now = NOW;
  let list: unknown[] = [];
  const started: { chat: string; line: AlertLine; previous?: RuleJob }[] = [];
  const sent: { session: string; text: string }[] = [];
  const working = new Set<string>();
  const bridge = new AlertBridge({ file, now: () => now, log: () => {}, alerts: async () => parseAlerts(list), owners: async () => OWNERS,
    hasBoard: async session => session !== METAL,
    deliver: async (session, text) => { sent.push({ session, text }); },
    startJob: async (chat, line, previous) => {
      if (options.failStarts) throw new Error("Timed out after 10000ms waiting for the Prime Agent daemon handshake.");
      started.push({ chat, line, ...previous ? { previous } : {} });
      const id = `job-${started.length}`;
      working.add(id);
      return { id, name: `alert ${line.rule} ${started.length}` };
    },
    jobWorking: async job => working.has(job.id) });
  return { file, bridge, started, sent, working, set: (alerts: unknown[]) => { list = alerts; }, at: (ms: number) => { now = ms; },
    state: async () => parseState(JSON.parse(await readFile(file, "utf8"))) };
}

test("a firing alert starts one triage job of its chat, files no step, and counts as firing for that chat until it resolves", async () => {
  const f = await fixture();
  f.set([ciAlert()]);
  for (let tick = 0; tick < 4; tick++) { f.at(NOW + tick * 30_000); await f.bridge.tick(); }
  assert.equal(f.started.length, 1);
  assert.equal(f.started[0]!.chat, CI);
  assert.equal(f.started[0]!.line.rule, "ci-history-stale");
  assert.equal(f.started[0]!.line.summary, "CI history ingest has not read GitHub for 15 min is firing.");
  const raw = JSON.parse(await readFile(f.file, "utf8")) as { v: number; rules: Record<string, Record<string, unknown>> };
  assert.equal(raw.v, 3);
  assert.ok(Object.values(raw.rules).every(rule => !("step" in rule)), "the state holds no board step");
  assert.deepEqual((await f.state()).rules[ruleKey(CI, "ci-history-stale")]!.job, { id: "job-1", name: "alert ci-history-stale 1", at: NOW });
  assert.equal((await readFiringRules(f.file, CI)).length, 1);
  assert.equal(f.sent.length, 0);
  f.set([]); f.at(NOW + 150_000);
  await f.bridge.tick();
  assert.equal(firingRules(await f.state(), CI).length, 0);
});

test("a second fire of the same rule uid goes to its live job by message and starts no second job, and a fire after the job ended starts a new job that reads the old one", async () => {
  const f = await fixture();
  f.set([ciAlert()]);
  await f.bridge.tick();
  f.set([]); f.at(NOW + 60_000);
  await f.bridge.tick();
  f.set([ciAlert("aaaa000000000002", "2026-10-18T16:05:00.000Z")]); f.at(NOW + 7 * 60_000);
  await f.bridge.tick();
  assert.equal(f.started.length, 1, "the live job gets the fire");
  assert.deepEqual(f.sent.map(({ session }) => session), ["job-1"]);
  assert.match(f.sent[0]!.text, /^\[alert\] Your rule ci-history-stale \(CI history ingest .*, firing since 2026-10-18T16:05Z\) fired again at 2026-10-18T16:07Z\./);
  assert.deepEqual(Object.keys((await f.state()).rules), [ruleKey(CI, "ci-history-stale")]);
  f.at(NOW + 7.5 * 60_000);
  await f.bridge.tick();
  assert.equal(f.sent.length, 1, "a rule that keeps firing is not sent again");
  f.set([]); f.at(NOW + 8 * 60_000);
  await f.bridge.tick();
  f.working.clear();
  f.set([ciAlert("aaaa000000000002", "2026-10-18T16:20:00.000Z")]); f.at(NOW + 8 * 60_000 + REFIRE_MS + 30_000);
  await f.bridge.tick();
  assert.equal(f.started.length, 2);
  assert.deepEqual(f.started[1]!.previous, { id: "job-1", name: "alert ci-history-stale 1", at: NOW + 7 * 60_000 });
  assert.equal(f.sent.length, 1);
});

test("a rule that Grafana resets to Normal (Updated) and fires again minutes later stays one incident, so its ended job gets no successor", async () => {
  const f = await fixture();
  f.set([ciAlert()]);
  await f.bridge.tick();
  f.working.clear();
  f.set([]); f.at(NOW + 10 * 60_000);
  await f.bridge.tick();
  f.set([ciAlert("aaaa000000000003", "2026-10-18T16:13:00.000Z")]); f.at(NOW + 14 * 60_000);
  await f.bridge.tick();
  assert.equal(f.started.length, 1, "the refire after a rule update starts no second job");
  assert.equal(f.sent.length, 0);
  const rule = (await f.state()).rules[ruleKey(CI, "ci-history-stale")]!;
  assert.equal(rule.startsAt, "2026-10-18T15:58:00.000Z");
  assert.equal(rule.wokeAt, NOW);
  assert.equal(firingRules(await f.state(), CI).length, 1);
  f.at(NOW + REOPEN_MS);
  await f.bridge.tick();
  assert.equal(f.started.length, 2, "the day-later reopen still applies");
});

test("a rule that still fires a day after its job took it and ended gets a new job, and one whose job still works does not", async () => {
  const f = await fixture();
  f.set([ciAlert()]);
  await f.bridge.tick();
  f.at(NOW + REOPEN_MS);
  await f.bridge.tick();
  assert.equal(f.started.length, 1, "the job still works");
  f.working.clear();
  f.at(NOW + REOPEN_MS + 30_000);
  await f.bridge.tick();
  assert.equal(f.started.length, 2);
  assert.equal(f.started[1]!.previous?.id, "job-1");
});

test("a fire whose job cannot start escalates to ops guy once after 30 min, and a rule of metal box owner, which has no board, is told to that session", async () => {
  const f = await fixture({ failStarts: true });
  f.set([ciAlert(), backup]);
  await f.bridge.tick();
  assert.deepEqual(f.sent.map(({ session }) => session), [METAL]);
  assert.match(f.sent[0]!.text, /^\[alert\] A Grafana rule you own is firing, .*metal-backup-ch-redis-age/);
  f.at(NOW + ESCALATE_MS);
  await f.bridge.tick();
  const escalations = () => f.sent.filter(({ session, text }) => session === OPS && text.startsWith("[alert-escalation]"));
  assert.equal(escalations().length, 1);
  assert.match(escalations()[0]!.text, /ci-history-stale .* on VP of CI/);
  f.at(NOW + ESCALATE_MS + 30_000);
  await f.bridge.tick();
  assert.equal(escalations().length, 1);
});

test("a version 2 state loses its steps and keeps the job a step carried, so the release starts no second job for a rule a job already held", async () => {
  const [alert] = parseAlerts([ciAlert()]);
  const key = ruleKey(CI, "ci-history-stale");
  const f = await fixture({ state: { v: 2, rules: { [key]: { chat: CI, step: "p273", closedAt: NOW - 1, rule: "ci-history-stale", alertname: alert!.alertname,
    startsAt: alert!.startsAt, wokeAt: NOW - 60_000, firstWokeAt: NOW - 60_000, instances: { [`${alert!.fingerprint}@${alert!.startsAt}`]: { startsAt: alert!.startsAt, labels: alert!.labels } },
    job: { id: "old-job", name: "alert VP of CI 15:59", at: NOW - 30_000 } } } } });
  f.set([ciAlert()]);
  await f.bridge.tick();
  assert.equal(f.started.length, 0);
  const rule = (await f.state()).rules[key]! as unknown as Record<string, unknown>;
  assert.ok(!("step" in rule) && !("closedAt" in rule));
});
