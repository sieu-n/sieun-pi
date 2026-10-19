// Guards 10-18: the bridge filed every firing Grafana alert as a plan step, so at 16:00Z ops guy had 14 open steps under "Firing prod alerts" and Crawler VP about 30 under p146, and the owner said "stop being paranoid in plan under p45, p221" (plan-and-duties.md). Now each firing rule gets one triage job and a later fire of it goes to that job.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AlertBridge, ESCALATE_MS, startAlertBridge, REFIRE_MS, REOPEN_MS, firingRules, parseAlerts, parseOwners, parseState, readFiringRules, ruleKey, type AlertLine, type BridgeState, type RuleJob, type TriageJob } from "../src/alert-bridge.ts";
import { ALERT_ROUTES } from "../src/alert-routes.ts";
import type { TurnSince } from "../src/held-turns.ts";

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

const ref = (job: RuleJob | TriageJob | undefined) => job && { id: job.id, name: job.name, at: job.at };

async function fixture(options: { state?: unknown; failStarts?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "alert-bridge-jobs-"));
  const file = join(dir, "alert-bridge.json");
  if (options.state) await writeFile(file, JSON.stringify(options.state));
  let now = NOW;
  let list: unknown[] = [];
  const started: { chat: string; line: AlertLine; lines: readonly AlertLine[]; previous?: TriageJob }[] = [];
  const sent: { session: string; text: string }[] = [];
  const working = new Set<string>();
  const turns = new Map<string, TurnSince>();
  const retried: string[] = [];
  const bridge = new AlertBridge({ file, now: () => now, log: () => {}, alerts: async () => parseAlerts(list), owners: async () => OWNERS,
    hasBoard: async session => session !== METAL,
    deliver: async (session, text) => { sent.push({ session, text }); },
    startJob: async (chat, lines, previous) => {
      if (options.failStarts) throw new Error("Timed out after 10000ms waiting for the Prime Agent daemon handshake.");
      started.push({ chat, line: lines[0]!, lines, ...previous ? { previous } : {} });
      const id = `job-${started.length}`;
      working.add(id);
      return { id, name: `alert ${lines[0]!.rule} ${started.length}` };
    },
    jobWorking: async job => working.has(job.id),
    jobTurn: async (job, since) => turns.get(job.id) ?? { ran: true, at: since },
    retryJob: job => { retried.push(job.id); } });
  return { file, bridge, started, sent, working, turns, retried, set: (alerts: unknown[]) => { list = alerts; }, at: (ms: number) => { now = ms; },
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
  assert.equal(raw.v, 4);
  assert.ok(Object.values(raw.rules).every(rule => !("step" in rule)), "the state holds no board step");
  assert.deepEqual(ref((await f.state()).rules[ruleKey(CI, "ci-history-stale")]!.job), { id: "job-1", name: "alert ci-history-stale 1", at: NOW });
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
  assert.match(f.sent[0]!.text, /^\[alert\] A rule of your chat, ci-history-stale \(CI history ingest .*, firing since 2026-10-18T16:05Z\) fired at 2026-10-18T16:07Z\. Summary: .* is firing\. You are this chat's triage job/);
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
  assert.deepEqual(ref(f.started[1]!.previous), { id: "job-1", name: "alert ci-history-stale 1", at: NOW });
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

test("a firing alert that a Grafana restart drops from the list comes back with the same startsAt as the same incident, however long its first evaluation takes", async () => {
  // 10-18 16:45:34Z to 16:57:35Z: two obs deploys recreated Grafana, its first alert lists lacked every firing alert until that rule's first
  // evaluation, and the bridge fired 20 rules again 29 times whose Grafana state and startsAt never changed. On 10-19 Grafana listened at 14:53:53Z
  // and sent estate-cpu-saturated, in a 5m group, at 14:58:58Z, 305 s later, so a poll at the listen time saw it back after more than REFIRE_MS.
  const f = await fixture();
  f.set([ciAlert()]);
  await f.bridge.tick();
  f.working.clear();
  f.set([]); f.at(NOW + 60_000);
  await f.bridge.tick();
  assert.equal(firingRules(await f.state(), CI).length, 0);
  const gone = 305_000 + 30_000;
  assert.ok(gone > REFIRE_MS, "the measured gap plus one poll is longer than REFIRE_MS");
  f.set([ciAlert()]); f.at(NOW + 60_000 + gone);
  await f.bridge.tick();
  assert.equal(f.started.length, 1, "the same Grafana alert starts no second job");
  assert.equal(f.sent.length, 0);
  const rule = (await f.state()).rules[ruleKey(CI, "ci-history-stale")]!;
  assert.equal(rule.wokeAt, NOW);
  assert.equal(firingRules(await f.state(), CI).length, 1);
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
  assert.match(escalations()[0]!.text, /On VP of CI, the start of its triage job failed \(Timed out after 10000ms waiting for the Prime Agent daemon handshake\.\) and is tried again each poll: ci-history-stale/);
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

const CRAWLER = ALERT_ROUTES.find(route => route.chat === "Crawler VP")!.session;
const netns = (startsAt = "2026-10-19T12:14:30.000Z") => raw("04cd74fc0bc472b6", { alertname: "Production crawler container lacks the port sysctls",
  __alert_rule_uid__: "metal-prod-crawler-netns-ports", container: "virev-prod-crawler-worker", env: "production" }, startsAt);
const SLOT_WAIT = "Failed to resolve API key for provider \"anthropic\" from shell command: /home/sieun/.config/pi-pool/bin/pi-pool-token pi-pool: this session waits for its slot at 2026-10-19T12:38:00.000Z. Try again in 20 minutes.";

// Replays 10-19: job 01a15416 for metal-prod-crawler-netns-ports started at 12:15:14Z, failed its first call on a pi-pool slot wait for
// 12:38:00Z, and had no turn at 14:46Z; the bridge counted it as holding the fire, so escalatedAt stayed empty.
test("a job that never had a turn does not hold the fire: the bridge asks for its retry at its slot, keeps it for a refire, and escalates at 30 min", async () => {
  const fired = Date.parse("2026-10-19T12:14:51.704Z");
  const f = await fixture();
  const key = ruleKey(CRAWLER, "metal-prod-crawler-netns-ports");
  f.set([netns()]); f.at(fired);
  await f.bridge.tick();
  assert.equal(f.started.length, 1);
  assert.equal(f.started[0]!.chat, CRAWLER);
  f.working.clear();
  f.turns.set("job-1", { ran: false, error: SLOT_WAIT, slotAt: Date.parse("2026-10-19T12:38:00.000Z") });
  f.at(Date.parse("2026-10-19T12:20:00Z"));
  await f.bridge.tick();
  assert.deepEqual(f.retried, [], "no retry before the slot");
  f.set([]); f.at(Date.parse("2026-10-19T12:28:42.206Z"));
  await f.bridge.tick();
  f.at(Date.parse("2026-10-19T12:38:30Z"));
  await f.bridge.tick();
  f.at(Date.parse("2026-10-19T12:39:00Z"));
  await f.bridge.tick();
  assert.deepEqual(f.retried, ["job-1"], "one retry once the slot passed");
  const escalations = () => f.sent.filter(({ session, text }) => session === OPS && text.startsWith("[alert-escalation]"));
  f.at(fired + ESCALATE_MS - 1000);
  await f.bridge.tick();
  assert.equal(escalations().length, 0);
  f.at(fired + ESCALATE_MS);
  await f.bridge.tick();
  assert.equal(escalations().length, 1, "the fire nobody worked escalates though the rule resolved");
  assert.match(escalations()[0]!.text, /On Crawler VP, its triage job alert metal-prod-crawler-netns-ports 1 has had no model turn \(its last call failed: pi-pool: this session waits for its slot at 2026-10-19T12:38.*\): metal-prod-crawler-netns-ports/);
  assert.ok((await f.state()).rules[key]!.escalatedAt === fired + ESCALATE_MS);
  f.at(fired + ESCALATE_MS + 30_000);
  await f.bridge.tick();
  assert.equal(escalations().length, 1, "once per fire");
  f.set([netns("2026-10-19T13:00:00.000Z")]); f.at(Date.parse("2026-10-19T13:00:30Z"));
  await f.bridge.tick();
  assert.equal(f.started.length, 1, "a refire goes to the job that never had a turn, not to a second job");
  assert.equal((await f.state()).rules[key]!.job!.id, "job-1");
});

test("a job whose turn ended after it took the fire holds it, so nothing escalates", async () => {
  const f = await fixture();
  f.set([ciAlert()]);
  f.turns.set("job-1", { ran: false });
  await f.bridge.tick();
  f.working.clear();
  f.at(NOW + 5 * 60_000);
  await f.bridge.tick();
  const s1 = await f.state();
  assert.equal(s1.jobs[s1.rules[ruleKey(CI, "ci-history-stale")]!.job!.id]!.ranAt, undefined);
  f.turns.set("job-1", { ran: true, at: NOW + 6 * 60_000 });
  f.at(NOW + 7 * 60_000);
  await f.bridge.tick();
  const s2 = await f.state();
  assert.equal(s2.jobs[s2.rules[ruleKey(CI, "ci-history-stale")]!.job!.id]!.ranAt, NOW + 6 * 60_000);
  f.at(NOW + ESCALATE_MS);
  await f.bridge.tick();
  assert.equal(f.sent.length, 0);
});

// Guards 10-19 14:41:36Z to 14:46:50Z: the start of vent-health-failure-rate-stg queued behind about 30 duty creates and the bridge skipped every poll.
test("a job start that never settles does not stop the polls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alert-bridge-poll-"));
  let polls = 0;
  let twice: () => void = () => {};
  const polled = new Promise<void>(resolve => { twice = resolve; });
  let starts = 0;
  const stop = startAlertBridge({ file: join(dir, "alert-bridge.json"), log: () => {}, deliver: async () => {},
    alerts: async () => { if (++polls >= 2) twice(); return parseAlerts([ciAlert()]); },
    startJob: () => { starts++; return new Promise<never>(() => {}); }, jobWorking: async () => false }, 20);
  await polled;
  stop();
  assert.ok(polls >= 2);
  assert.equal(starts, 1, "the hung start is not started again while it runs");
});

test("a fetch failure names its cause code", async () => {
  const { errorText } = await import("../src/alert-bridge.ts");
  const cause = Object.assign(new Error("getaddrinfo ENOTFOUND obs.virev.ai"), { code: "ENOTFOUND" });
  assert.equal(errorText(new TypeError("fetch failed", { cause })), "fetch failed (ENOTFOUND: getaddrinfo ENOTFOUND obs.virev.ai)");
});

const crawler = (fingerprint: string, rule: string) => raw(fingerprint, { alertname: `${rule} fires`, __alert_rule_uid__: rule, project: "crawler" }, "2026-10-19T15:00:00.000Z");

// Guards 10-19: one job per rule had made 78 fires into 78 jobs across Crawler VP, vent, VP of CI and ops guy.
test("one triage job per owner chat carries all of its fires, and a later fire of another rule joins it by one message", async () => {
  const f = await fixture();
  f.set([crawler("cccc000000000001", "crawler-a"), crawler("cccc000000000002", "crawler-b"), crawler("cccc000000000003", "crawler-c"), ciAlert()]);
  await f.bridge.tick();
  assert.equal(f.started.length, 2, "one job for Crawler VP and one for VP of CI");
  const crawlerJob = f.started.find(start => start.chat === CRAWLER)!;
  assert.deepEqual(crawlerJob.lines.map(line => line.rule).sort(), ["crawler-a", "crawler-b", "crawler-c"]);
  f.set([crawler("cccc000000000001", "crawler-a"), crawler("cccc000000000002", "crawler-b"), crawler("cccc000000000003", "crawler-c"), crawler("cccc000000000004", "crawler-d"),
    crawler("cccc000000000005", "crawler-e"), ciAlert()]);
  f.at(NOW + 60_000);
  await f.bridge.tick();
  assert.equal(f.started.length, 2, "no new job while the chat's job works");
  const id = (await f.state()).chats[CRAWLER]!;
  assert.deepEqual(f.sent.map(({ session }) => session), [id], "one message for both new fires");
  assert.match(f.sent[0]!.text, /^\[alert\] 2 rules of your chat fired: crawler-d .*; crawler-e /);
  const state = await f.state();
  assert.deepEqual(new Set(Object.values(state.rules).filter(rule => rule.chat === CRAWLER).map(rule => rule.job!.id)), new Set([id]));
});

test("a version 3 state with one never-ran job per rule moves every such rule to the chat's newest job, which gets them in one message", async () => {
  const f0 = await fixture();
  f0.set([crawler("cccc000000000001", "crawler-a"), crawler("cccc000000000002", "crawler-b"), crawler("cccc000000000003", "crawler-c")]);
  await f0.bridge.tick();
  const v4 = await f0.state();
  const rules = Object.fromEntries(Object.entries(v4.rules).map(([key, rule], index) =>
    [key, { ...rule, job: { id: `old-${index}`, name: `alert ${rule.rule}`, at: NOW + index } }]));
  const f = await fixture({ state: { v: 3, rules } });
  for (const index of [0, 1, 2]) f.turns.set(`old-${index}`, { ran: false, error: SLOT_WAIT });
  f.set([crawler("cccc000000000001", "crawler-a"), crawler("cccc000000000002", "crawler-b"), crawler("cccc000000000003", "crawler-c")]);
  await f.bridge.tick();
  assert.equal(f.started.length, 0);
  const state = await f.state();
  assert.equal(state.chats[CRAWLER], "old-2");
  assert.deepEqual(Object.values(state.rules).map(rule => rule.job!.id), ["old-2", "old-2", "old-2"]);
  assert.deepEqual(Object.keys(state.jobs), ["old-2"]);
  assert.deepEqual(f.sent.filter(({ session }) => session === "old-2").length, 1);
  assert.match(f.sent.find(({ session }) => session === "old-2")!.text, /2 rules of your chat fired: crawler-a .*crawler-b /);
  assert.deepEqual(f.sent.filter(({ session }) => session !== "old-2").map(({ session }) => session).sort(), ["old-0", "old-1"], "the old jobs are told who owns their rules");
});

// Replays 10-19 16:52:54Z: the start for crawler-prod-jobs-wait-budget-failed hung in the duty create queue and no other chat got a fire.
test("a start that hangs for one chat holds up no other chat, and its fire escalates as a start that has not finished", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alert-bridge-hang-"));
  let now = NOW;
  let list: unknown[] = [crawler("cccc000000000009", "crawler-prod-jobs-wait-budget-failed")];
  const starts: string[] = [];
  const sent: { session: string; text: string }[] = [];
  const bridge = new AlertBridge({ file: join(dir, "alert-bridge.json"), now: () => now, log: () => {}, alerts: async () => parseAlerts(list), deliver: async (session, text) => { sent.push({ session, text }); },
    startJob: (chat, lines) => {
      starts.push(chat);
      return chat === CRAWLER ? new Promise<never>(() => {}) : Promise.resolve({ id: `job-${starts.length}`, name: `alert ${lines[0]!.rule}` });
    }, jobWorking: async () => true, jobTurn: async (_job, since) => ({ ran: true, at: since }) });
  await bridge.poll();
  void bridge.dispatch();
  list = [crawler("cccc000000000009", "crawler-prod-jobs-wait-budget-failed"), ciAlert()];
  now = NOW + 30_000;
  await bridge.poll();
  await bridge.dispatch();
  assert.deepEqual(starts, [CRAWLER, CI], "VP of CI gets its job, and the hung Crawler VP start is not started again");
  now = NOW + ESCALATE_MS;
  await bridge.poll();
  const escalation = sent.find(({ session, text }) => session === OPS && text.startsWith("[alert-escalation]"));
  assert.match(escalation?.text ?? "", /On Crawler VP, the start of its triage job has waited since 2026-10-18T16:00Z and has not finished: crawler-prod-jobs-wait-budget-failed/);
});

test("a triage job pi-pool holds after it ran stays the chat's job, and a job that had the rule before is told who owns it", async () => {
  const f = await fixture();
  f.set([ciAlert()]);
  await f.bridge.tick();
  f.working.clear();
  f.turns.set("job-1", { ran: true, at: NOW + 10_000 });
  f.at(NOW + 60_000);
  await f.bridge.tick();
  f.turns.set("job-1", { ran: false, error: SLOT_WAIT, slotAt: NOW + 20 * 60_000 });
  f.set([ciAlert(), raw("aaaa0000000000c2", { alertname: "CI steps stale", __alert_rule_uid__: "ci-steps-stale" }, "2026-10-18T16:01:00.000Z")]);
  f.at(NOW + 2 * 60_000);
  await f.bridge.tick();
  assert.equal(f.started.length, 1, "the held job keeps the chat");
  assert.deepEqual(f.sent.map(({ session }) => session), ["job-1"]);
});

test("a rule's old per-rule job is told the chat's triage job owns it", async () => {
  const f0 = await fixture();
  f0.set([crawler("cccc000000000001", "crawler-a"), crawler("cccc000000000002", "crawler-b")]);
  await f0.bridge.tick();
  const v4 = await f0.state();
  const rules = Object.fromEntries(Object.entries(v4.rules).map(([key, rule], index) => [key, { ...rule, job: { id: `old-${index}`, name: `alert ${rule.rule}`, at: NOW + index } }]));
  const f = await fixture({ state: { v: 3, rules } });
  f.turns.set("old-0", { ran: false, error: SLOT_WAIT });
  f.turns.set("old-1", { ran: false, error: SLOT_WAIT });
  f.set([crawler("cccc000000000001", "crawler-a"), crawler("cccc000000000002", "crawler-b")]);
  await f.bridge.tick();
  const told = f.sent.find(({ session }) => session === "old-0");
  assert.match(told?.text ?? "", /^\[alert\] crawler-a now belongs to this chat's triage job "alert crawler-b" \(session old-1\)/);
});
