// Guards 10-18: the bridge filed every firing Grafana alert as a plan step, so at 16:00Z ops guy had 14 open steps under "Firing prod alerts" and Crawler VP about 30 under p146, and the owner said "stop being paranoid in plan under p45, p221" (plan-and-duties.md). Now each firing rule gets one triage job and a later fire of it goes to that job.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AlertBridge, ESCALATE_MS, startAlertBridge, REFIRE_MS, REOPEN_MS, firingRules, parseAlerts, parseOwners, parseState, readFiringRules, ruleKey, type AlertLine, type BridgeState, type RuleJob, type TriageJob } from "../src/alert-bridge.ts";
import { ALERT_ROUTES } from "../src/alert-routes.ts";
import { turnSince, type TurnSince } from "../src/held-turns.ts";
import { jobLive, RESENT_MS } from "../src/job-live.ts";
import type { QueuePlace } from "../src/shared/types.ts";

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

async function fixture(options: { state?: unknown; failStarts?: boolean; jobLive?: (session: string, now: number) => Promise<string | null> } = {}) {
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
  const freeAt = new Map<string, number>();
  const queue = new Map<string, QueuePlace>();
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
    retryJob: job => { retried.push(job.id); }, poolFreeAt: async tree => freeAt.get(tree) ?? null, turnQueued: async session => queue.get(session) ?? null,
    ...options.jobLive ? { jobLive: options.jobLive } : {} });
  return { file, bridge, started, sent, working, turns, retried, freeAt, queue, set: (alerts: unknown[]) => { list = alerts; }, at: (ms: number) => { now = ms; },
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

test("an alert labelled notify=none pages no chat, and the same rule without it does", () => {
  // Crawler ops, 2026-10-21: crawler-acq-interactive-wait owns the writer lag page, and crawler-acquisitions-writer-lag, which
  // paged the same spikes beside it at 19:22Z, 19:40Z and 00:54Z on 10-20, carries notify=none so it stays on Grafana only.
  const quiet = raw("bbbb000000000001", { alertname: "Captured pages waiting on crawler:acquisitions (writer lag)", __alert_rule_uid__: "crawler-acquisitions-writer-lag", notify: "none" }, "2026-10-20T19:22:00.000Z");
  assert.deepEqual(parseAlerts([quiet]), []);
  assert.equal(parseAlerts([ciAlert()]).length, 1);
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

// Replays 10-20: job 01a1578b for crawler-prod-watch-rows-absent failed every call on a pi-pool slot wait, for 06:06:27Z from 05:13Z, and the
// bridge escalated it at 05:17Z as a job with no model turn. pi-pool let it in and it ran at 05:40Z.
test("a job pi-pool holds for a slot still ahead reads as waiting, and escalates only once that slot passed with no turn", async () => {
  const fired = Date.parse("2026-10-20T04:47:28Z");
  const slot = Date.parse("2026-10-20T06:06:27Z");
  const wait = SLOT_WAIT.replace("2026-10-19T12:38:00.000Z", "2026-10-20T06:06:27.000Z");
  const f = await fixture();
  const escalations = () => f.sent.filter(({ session, text }) => session === OPS && text.startsWith("[alert-escalation]"));
  f.set([netns("2026-10-20T04:46:30.000Z")]); f.at(fired);
  await f.bridge.tick();
  f.working.clear();
  f.turns.set("job-1", { ran: false, error: wait, slotAt: slot });
  f.at(fired + ESCALATE_MS);
  await f.bridge.tick();
  f.at(slot - 30_000);
  await f.bridge.tick();
  assert.equal(escalations().length, 0, "no escalation while the slot is ahead");
  f.at(slot + 10_000);
  await f.bridge.tick();
  assert.deepEqual(f.retried, ["job-1"], "the slot passed, so the resume pass is asked to continue it");
  assert.equal(escalations().length, 0, "the retry gets one poll to show its turn");
  f.at(slot + 40_000);
  await f.bridge.tick();
  assert.equal(escalations().length, 1, "still no turn a poll after the retry");
  assert.match(escalations()[0]!.text, /has had no model turn \(its last call failed: pi-pool: this session waits for its slot at 2026-10-20T06:06:27/);
});

// Replays 10-20: triage job 01a15aac of VP of CI took ci-turbo-force-failed at 18:56:56Z and pi-pool held each call. Its last one, at 20:08:08Z,
// ended on dhx.3's credential wait marker for 20:12:17Z. The bridge escalated at 20:12:54Z, while pi-pool waited for rotation and gave the
// next call at 20:13:18Z a backoff to 20:27:51Z. The job ran at 20:58:56Z, once an account served.
test("a job past its slot that pi-pool still holds reads as waiting, and escalates once the pool lets it in with no turn", async () => {
  const fired = Date.parse("2026-10-20T18:56:53.286Z");
  const slot = Date.parse("2026-10-20T20:12:17.000Z");
  const marker = { type: "message", id: "708fdbc3", parentId: "9da3ef81", timestamp: "2026-10-20T20:08:08.600Z",
    message: { role: "assistant", content: [], api: "anthropic-messages", provider: "anthropic", model: "claude-opus-5-5",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "error", errorMessage: "API key for provider \"anthropic\" is temporarily unavailable until 2026-10-20T20:12:17.000Z: waiting for an account slot",
      timestamp: 1792526888600,
      diagnostics: [{ type: "provider_stream_failure", timestamp: 1792526888600, details: { kind: "credential_unavailable", retryAtMs: slot, retryAfterMs: 248400 } }] } };
  const f = await fixture();
  const escalations = () => f.sent.filter(({ session, text }) => session === OPS && text.startsWith("[alert-escalation]"));
  f.set([raw("cee6e41218bc6678", { alertname: "CI nightly turbo --force run failed", __alert_rule_uid__: "ci-turbo-force-failed" }, "2026-10-20T18:56:10.000Z")]);
  f.at(fired);
  await f.bridge.tick();
  f.working.clear();
  f.turns.set("job-1", turnSince(JSON.stringify(marker), fired));
  f.freeAt.set("job-1", Date.parse("2026-10-20T20:27:51.000Z"));
  f.at(Date.parse("2026-10-20T20:12:24.188Z"));
  await f.bridge.tick();
  assert.deepEqual(f.retried, ["job-1"], "the slot passed, so the resume pass is asked to continue it");
  f.at(Date.parse("2026-10-20T20:12:54.155Z"));
  await f.bridge.tick();
  f.at(Date.parse("2026-10-20T20:27:00Z"));
  await f.bridge.tick();
  assert.equal(escalations().length, 0, "pi-pool still names a time ahead for the tree");
  f.freeAt.set("job-1", Date.parse("2026-10-20T20:28:00Z"));
  f.at(Date.parse("2026-10-20T20:28:00Z"));
  await f.bridge.tick();
  assert.equal(escalations().length, 1, "the pool lets the tree in now and the job still has no turn");
  assert.match(escalations()[0]!.text, /has had no model turn \(its last call failed: token hook gave no token \(credential_unavailable\): pi-pool: this session waits for its slot at 2026-10-20T20:12:17/);
});

// Replays 10-21: triage job 01a15bc4 of vent took vent-health-failure-rate-prod at 00:02:20Z. Its first call failed on the token hook with
// no slot in its text, pi-pool held its tree until 01:50:03Z, and the bridge escalated the rule at 00:32:12Z.
test("a job whose failed call names no slot reads as waiting while pi-pool holds its tree", async () => {
  const fired = Date.parse("2026-10-21T00:02:20.602Z");
  const failed = { type: "message", id: "a1", parentId: "a0", timestamp: "2026-10-21T00:02:20.000Z",
    message: { role: "assistant", content: [], api: "anthropic-messages", provider: "anthropic", model: "claude-opus-5-5", stopReason: "error",
      errorMessage: "Failed to resolve API key for provider \"anthropic\" from shell command: pi-pool-token pi-pool: the token hook gave no token; the retry uses a new hook run." } };
  const f = await fixture();
  const escalations = () => f.sent.filter(({ session, text }) => session === OPS && text.startsWith("[alert-escalation]"));
  f.set([ciAlert("aaaa0000000000e1", "2026-10-21T00:01:10.000Z")]); f.at(fired);
  await f.bridge.tick();
  f.working.clear();
  f.turns.set("job-1", turnSince(JSON.stringify(failed), fired - 60_000));
  f.freeAt.set("job-1", Date.parse("2026-10-21T01:50:03Z"));
  f.at(fired + ESCALATE_MS + 30_000);
  await f.bridge.tick();
  assert.equal(escalations().length, 0, "pi-pool still names a time ahead for the tree");
  assert.deepEqual(f.retried, [], "no slot passed, so no retry");
  f.at(Date.parse("2026-10-21T01:51:00Z"));
  await f.bridge.tick();
  assert.equal(escalations().length, 1, "past the pool's time the job still has no turn");
  assert.match(escalations()[0]!.text, /has had no model turn \(its last call failed: pi-pool: the token hook gave no token/);
});

// Replays 10-22: Crawler VP's triage job 01a16080 took crawler-prod-sticky-block-rotations-jump at 11:53:27Z while its run sat in pi-pool's
// turn queue from 11:28:22Z (126 queued, 6 working). The bridge escalated it at 12:23:43Z as a job with no model turn and nothing on the
// queue, and pi-pool let the run in at 12:57:04Z after 5,321.8 s.
test("a job whose run waits in pi-pool's turn queue escalates with its place in that queue", async () => {
  const fired = Date.parse("2026-10-22T11:53:27.222Z");
  const f = await fixture();
  const escalations = () => f.sent.filter(({ session, text }) => session === OPS && text.startsWith("[alert-escalation]"));
  f.set([ciAlert("aaaa0000000000f1", "2026-10-22T11:52:00.000Z")]); f.at(fired);
  await f.bridge.tick();
  f.working.clear();
  f.turns.set("job-1", { ran: false });
  f.queue.set("job-1", { position: 126, total: 126, since: Date.parse("2026-10-22T11:28:22Z") });
  f.at(fired + ESCALATE_MS + 30_000);
  await f.bridge.tick();
  assert.equal(escalations().length, 1);
  assert.match(escalations()[0]!.text, /On VP of CI, its triage job alert ci-history-stale 1 has had no model turn, because its run waits in pi-pool's turn queue \(126 of 126, since 2026-10-22T11:28Z\): ci-history-stale/);
  assert.equal(f.started.length, 1, "a fresh job would queue behind it, so the queued job keeps the fire");
});

// Ops guy, 10-22: when a chat's triage job has ended, the bridge should start a fresh one, where before it waited for the next fire or 24 h.
test("a triage job that ended with no turn after it took a fire hands the fire to a fresh job at once, with the old one as its previous", async () => {
  const fired = Date.parse("2026-10-22T11:53:27.222Z");
  const f = await fixture();
  f.set([ciAlert("aaaa0000000000f2", "2026-10-22T11:52:00.000Z")]); f.at(fired);
  await f.bridge.tick();
  f.turns.set("job-1", { ran: false });
  f.at(fired + 30_000);
  await f.bridge.tick();
  assert.equal(f.started.length, 1, "a job that still works keeps the fire");
  f.working.delete("job-1");
  f.at(fired + 60_000);
  await f.bridge.tick();
  assert.equal(f.started.length, 2, "the ended job's fire goes to a fresh job on the next poll");
  assert.equal(f.started[1]!.previous?.id, "job-1");
  assert.equal(f.started[1]!.line.rule, "ci-history-stale");
  const state = await f.state();
  assert.equal(state.chats[CI], "job-2");
  assert.equal(state.rules[ruleKey(CI, "ci-history-stale")]!.job!.id, "job-2");
  f.at(fired + 90_000);
  await f.bridge.tick();
  assert.equal(f.started.length, 2, "one fresh job");
});

test("a triage job that settled on a failed call naming no pool wait counts as ended, and one that failed on a pool wait keeps its place", async () => {
  const fired = Date.parse("2026-10-22T11:53:27.222Z");
  const f = await fixture();
  f.set([ciAlert("aaaa0000000000f3", "2026-10-22T11:52:00.000Z")]); f.at(fired);
  await f.bridge.tick();
  f.working.clear();
  f.turns.set("job-1", { ran: false, error: "pi-pool: this session waits for its slot at 2026-10-22T11:50:00.000Z", slotAt: Date.parse("2026-10-22T11:50:00Z"), provider: "anthropic" });
  f.at(fired + 30_000);
  await f.bridge.tick();
  assert.equal(f.started.length, 1, "the resume pass continues a job held on a pool wait");
  f.turns.set("job-1", { ran: false, error: "400 invalid_request_error: messages: text content blocks must be non-empty", provider: "anthropic" });
  f.at(fired + 60_000);
  await f.bridge.tick();
  assert.equal(f.started.length, 2);
  assert.equal(f.started[1]!.previous?.id, "job-1");
});

// Ops guy, 10-26: alert triage Crawler VP 07:43 (01a1753b) took crawler-prod-sticky-block-rotations-jump at 22:43:39Z on 10-25, and us-metal02
// lost its uplink from 23:13Z to 23:30Z. A triage job whose call fails on "Connection error." in such a gap gets its continue from the resume pass,
// which the catalog runs at once on the cut, so the bridge keeps the job and its fires, starts no second job, and escalates with the error.
test("a triage job whose call failed on a lost connection keeps its fires for the resume pass's continue and escalates with the error", async () => {
  const fired = Date.parse("2026-10-25T22:43:39.470Z");
  const f = await fixture();
  const escalations = () => f.sent.filter(({ session, text }) => session === OPS && text.startsWith("[alert-escalation]"));
  const failed = { type: "message", id: "a1", parentId: "u1", timestamp: "2026-10-25T23:14:02.000Z",
    message: { role: "assistant", content: [], provider: "anthropic", model: "claude-opus-5-5", stopReason: "error", errorMessage: "Connection error." } };
  f.at(fired);
  f.set([crawler("cccc0000000000a1", "crawler-prod-sticky-block-rotations-jump")]);
  await f.bridge.tick();
  assert.equal(f.started.length, 1);
  f.working.clear();
  f.turns.set("job-1", turnSince(JSON.stringify(failed), fired));
  f.at(Date.parse("2026-10-25T23:30:49Z"));
  await f.bridge.tick();
  assert.equal(f.started.length, 1, "the job the resume pass continues keeps the fire");
  assert.equal((await f.state()).jobs["job-1"]!.replacedAt, undefined);
  f.set([crawler("cccc0000000000a1", "crawler-prod-sticky-block-rotations-jump"), crawler("cccc0000000000a2", "crawler-prod-lanes-link-down")]);
  f.at(Date.parse("2026-10-25T23:31:19Z"));
  await f.bridge.tick();
  assert.equal(f.started.length, 1, "a later fire goes to the same job");
  assert.deepEqual(f.sent.filter(({ text }) => text.startsWith("[alert] A rule")).map(({ session }) => session), ["job-1"]);
  f.at(fired + ESCALATE_MS + 30_000);
  await f.bridge.tick();
  assert.equal(escalations().length, 1);
  assert.match(escalations()[0]!.text, /its triage job alert crawler-prod-sticky-block-rotations-jump 1 has had no model turn \(its last call failed: Connection error\.\)/);
  f.turns.set("job-1", { ran: true, at: Date.parse("2026-10-25T23:56:33Z") });
  f.at(Date.parse("2026-10-25T23:57:00Z"));
  await f.bridge.tick();
  assert.equal(f.started.length, 1);
});

// Replays 10-25: the watchdog found alert triage Crawler VP 07:43 (01a1753b) with a tool marked running 35.1 min and no live process, and
// stopped it and sent it a continue at 23:49:35Z. The bridge read it as ended at 23:50:07Z, since it had no turn after the 23:30:49Z fire,
// and started 08:50 on the same fires, while the continue's run reached pi-pool's queue at 23:50:12Z and ran at 23:56Z.
test("a triage job the watchdog just sent a continue, or whose run waits in pi-pool's queue, is not ended, and one past both is", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alert-bridge-live-"));
  const paths = { wakes: join(dir, "wakes"), turns: join(dir, "turns.json"), watchdogLog: join(dir, "log.jsonl") };
  const f = await fixture({ jobLive: (session, now) => jobLive(paths, session, now) });
  f.at(Date.parse("2026-10-25T22:43:39.470Z"));
  f.set([crawler("cccc0000000000b1", "crawler-prod-sticky-block-rotations-jump")]);
  f.turns.set("job-1", { ran: true, at: Date.parse("2026-10-25T22:50:24Z") });
  await f.bridge.tick();
  f.at(Date.parse("2026-10-25T23:30:49.012Z"));
  f.set([crawler("cccc0000000000b1", "crawler-prod-sticky-block-rotations-jump"), crawler("cccc0000000000b2", "crawler-prod-lanes-link-down")]);
  f.turns.set("job-1", { ran: false });
  await f.bridge.tick();
  assert.deepEqual(f.sent.filter(({ text }) => text.startsWith("[alert] A rule")).map(({ session }) => session), ["job-1"]);
  f.working.clear();
  await writeFile(paths.watchdogLog, JSON.stringify({ id: "5f899fe960ef", sid: "job-1", name: "alert triage Crawler VP 07:43", depth: 0, stale_min: 35.1,
    why: "tool marked running 35.1m with no live process", method: "stop+send", stop_rc: 0, stop_out: "ok", send_rc: 0, send_out: "Sent to job-1",
    at: "2026-10-25T23:49:35.551946+00:00" }) + "\n");
  f.at(Date.parse("2026-10-25T23:50:07.986Z"));
  await f.bridge.tick();
  assert.equal(f.started.length, 1, "the job the watchdog just sent a continue is not ended");
  await writeFile(paths.turns, JSON.stringify({ working: {}, queued: { "job-1": { tree: "job-1", since: 1792972212 } }, owner: {}, lead: [], kept: {} }));
  f.at(Date.parse("2026-10-25T23:50:12Z") + RESENT_MS);
  await f.bridge.tick();
  assert.equal(f.started.length, 1, "its run waits in pi-pool's turn queue");
  await writeFile(paths.turns, JSON.stringify({ working: {}, queued: {}, owner: {}, lead: [], kept: {} }));
  f.at(Date.parse("2026-10-25T23:50:42Z") + RESENT_MS);
  await f.bridge.tick();
  assert.equal(f.started.length, 2, "with no continue landing and no queued run, the fires go to a fresh job");
});

test("a held job that runs at its slot holds the fire, so nothing escalates", async () => {
  const fired = Date.parse("2026-10-20T04:26:58Z");
  const slot = Date.parse("2026-10-20T05:06:00Z");
  const f = await fixture();
  f.set([ciAlert("aaaa0000000000d1", "2026-10-20T04:26:00.000Z")]); f.at(fired);
  await f.bridge.tick();
  f.working.clear();
  f.turns.set("job-1", { ran: false, error: SLOT_WAIT, slotAt: slot });
  f.at(fired + ESCALATE_MS);
  await f.bridge.tick();
  f.turns.set("job-1", { ran: true, at: slot + 2_000 });
  f.at(slot + 30_000);
  await f.bridge.tick();
  assert.equal(f.sent.filter(({ session }) => session === OPS).length, 0);
});

test("a job whose turn ended after it took the fire holds it, so nothing escalates", async () => {
  const f = await fixture();
  f.set([ciAlert()]);
  f.turns.set("job-1", { ran: false });
  await f.bridge.tick();
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
