// Guards c219 (11-07): while every Claude account was limited, each alert triage job the bridge started waited behind 10 to 26 other runs in
// pi-pool's queue, 56 min at the median (ops guy's t49), and the owner said "don't complicate shit. and when things back up, process it as 1
// batched request to AI-chat thread don't' queue them". Each fire now goes to its chat's own thread, and fires that back up go as one message.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AlertBridge, ESCALATE_MS, REOPEN_MS, errorText, firingRules, parseAlerts, parseOwners, parseSetStates, parseState, readFiringRules, ruleKey, startAlertBridge, type FiringAlert, type FiringCall } from "../src/alert-bridge.ts";
import { ALERT_ROUTES } from "../src/alert-routes.ts";
import type { TurnSince } from "../src/held-turns.ts";

const NOW = Date.parse("2026-11-07T08:00:00Z");
const session = (chat: string) => ALERT_ROUTES.find(route => route.chat === chat)!.session;
const CI = session("VP of CI");
const OPS = session("ops guy");
const CRAWLER = session("Crawler VP");
const METAL = "01a11d24-ac9b-757d-ac51-9b2b7598782f";

const raw = (fingerprint: string, labels: Record<string, string>, startsAt: string) => ({ fingerprint, startsAt, labels, annotations: { summary: `${labels.alertname} is firing.` },
  generatorURL: `https://obs.virev.ai/alerting/grafana/${labels.__alert_rule_uid__}/view`, status: { state: "active", silencedBy: [], inhibitedBy: [] } });
const alert = (n: number, rule: string, project: string, startsAt = new Date(NOW + n * 60_000).toISOString()) =>
  raw(`f${String(n).padStart(15, "0")}`, { alertname: `${rule} fires`, __alert_rule_uid__: rule, project }, startsAt);
const ciAlert = (fingerprint = "aaaa000000000001", startsAt = "2026-11-07T07:58:00.000Z") =>
  raw(fingerprint, { alertname: "CI history ingest has not read GitHub for 15 min", __alert_rule_uid__: "ci-history-stale" }, startsAt);
const backup = raw("34a8c0c62d402cb1", { alertname: "ClickHouse or Redis backup older than 9h", __alert_rule_uid__: "metal-backup-ch-redis-age" }, "2026-11-06T06:19:30.000Z");
const OWNERS = parseOwners({ owners: { "metal box owner": METAL, "ops guy": OPS }, fallback: "ops guy",
  routes: [{ name: "box backups", match: { __alert_rule_uid__: "^metal-backup-" }, owner: "metal box owner" }] });

async function fixture(options: { state?: unknown; firingCall?: (chat: string) => Promise<FiringCall | null>; deliver?: (session: string, text: string) => Promise<void>;
  setStates?: (alert: FiringAlert) => Promise<ReadonlyMap<string, { state: string; since: number }>> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "alert-bridge-chat-"));
  const file = join(dir, "alert-bridge.json");
  if (options.state) await writeFile(file, JSON.stringify(options.state));
  let now = NOW;
  let list: unknown[] = [];
  const sent: { session: string; text: string; root?: string }[] = [];
  const turns = new Map<string, TurnSince>();
  const held = new Set<string>();
  const bridge = new AlertBridge({ file, now: () => now, log: () => {}, alerts: async () => parseAlerts(list), owners: async () => OWNERS,
    hasBoard: async id => id !== METAL,
    deliver: options.deliver ?? (async (id, text, root) => { sent.push({ session: id, text, ...root ? { root } : {} }); }),
    jobTurn: async (job, since) => turns.get(job.id) ?? { ran: true, at: since },
    held: async id => held.has(id), ...options.firingCall ? { firingCall: options.firingCall } : {}, ...options.setStates ? { setStates: options.setStates } : {} });
  return { file, bridge, sent, turns, held, set: (alerts: unknown[]) => { list = alerts; }, at: (ms: number) => { now = ms; },
    alerts: () => sent.filter(({ text }) => text.startsWith("[alert] ")), escalations: () => sent.filter(({ session: id, text }) => id === OPS && text.startsWith("[alert-escalation]")),
    state: async () => parseState(JSON.parse(await readFile(file, "utf8"))) };
}

// The backed-up hour: 30 fires for 3 chats while pi-pool holds their trees, then the trees get a slot.
test("30 fires for 3 chats while their trees are held reach each chat's thread as one message listing every fire, and start no job", async () => {
  const f = await fixture();
  const chats = { crawler: CRAWLER, ci: CI, ops: OPS } as const;
  const projects = { crawler: "crawler", ci: "ci", ops: "search" } as const;
  for (const chat of Object.values(chats)) f.held.add(chat);
  const fired: unknown[] = [];
  for (let n = 0; n < 30; n++) {
    const which = (["crawler", "ci", "ops"] as const)[n % 3]!;
    fired.push(alert(n, `${which}-rule-${Math.floor(n / 3)}`, projects[which]));
    f.set([...fired]); f.at(NOW + n * 2 * 60_000);
    await f.bridge.tick();
  }
  assert.equal(f.sent.length, 0, "nothing goes while the pool holds the trees, and nothing escalates");
  for (const chat of Object.values(chats)) f.held.delete(chat);
  for (const tick of [0, 1, 2]) { f.at(NOW + 61 * 60_000 + tick * 30_000); await f.bridge.tick(); }
  assert.equal(f.sent.length, 3, "one message per chat thread");
  for (const [which, chat] of Object.entries(chats)) {
    const to = f.sent.filter(sent => sent.session === chat);
    assert.equal(to.length, 1, `${which} gets one message`);
    assert.equal(to[0]!.root, chat, "the message goes to the chat's own thread");
    assert.match(to[0]!.text, /^\[alert\] 10 Grafana rules this thread owns fired\./);
    for (let rule = 0; rule < 10; rule++) assert.ok(to[0]!.text.includes(`- ${which}-rule-${rule} (`), `${which}-rule-${rule} is listed`);
  }
  const state = await f.state();
  assert.deepEqual(Object.keys(state.jobs).sort(), Object.values(chats).sort(), "each chat's thread holds its fires, and no triage job exists");
  assert.ok(Object.values(state.rules).every(rule => rule.job?.id === rule.chat));
});

// 11-10: viewer-wall-walls-spike fired at 03:34:30Z at A=26, C=1 and waited for ops guy's thread until 06:21Z. Grafana read it Recovering
// from 04:34:30Z and Normal from 05:34:30Z, its alert list still held it, and the message printed A=0, C=0 as if the rule were broken.
test("a fire held until after it resolved goes with the values it fired at and says when Grafana resolved it", async () => {
  const at = (iso: string) => Date.parse(iso);
  const labels = { alertname: "The viewer tools walled 20 or more signed-out profile views in an hour (otel)", __alert_rule_uid__: "viewer-wall-walls-spike", project: "search" };
  const listed = (values: string) => ({ ...raw("8bb3afdd4bf27cc7", labels, "2026-11-10T03:34:30.000Z"), annotations: { summary: "Walls spiked.", __values__: values } });
  const ruleList = { data: { groups: [{ rules: [{ uid: "viewer-wall-walls-spike", alerts: [{ labels, state: "Normal", activeAt: "2026-11-10T05:34:30Z" }] }] }] } };
  const f = await fixture({ setStates: async alert => parseSetStates(ruleList, alert.labels.__alert_rule_uid__!) });
  f.held.add(OPS);
  for (const [time, values] of [["03:35:30", '{"A":26,"C":1}'], ["04:35:30", '{"A":12,"C":0}'], ["05:35:30", '{"A":0,"C":0}']] as const) {
    f.set([listed(values)]); f.at(at(`2026-11-10T${time}Z`));
    await f.bridge.tick();
  }
  assert.equal(f.alerts().length, 0, "the pool holds ops guy's thread");
  f.held.delete(OPS); f.at(at("2026-11-10T06:21:33Z"));
  await f.bridge.tick();
  const text = f.alerts()[0]!.text;
  assert.match(text, /- viewer-wall-walls-spike \(The viewer tools.*, fired at 2026-11-10T03:34Z, resolved at 2026-11-10T05:34Z\)/);
  assert.match(text, /  Values at the fire: A=26, C=1\.\n  Values now: A=0, C=0\.\n  Resolved at 2026-11-10T05:34Z \(Grafana: Normal\)\./);
});

// 11-13: devbox-wiki-public-down fired at 15:56Z, and the rule list's Normal activeAt from its 11-03 episode made it read as resolved 10 days earlier.
test("a fire whose rule list state predates it reads as still firing", async () => {
  const labels = { alertname: "The public wiki is down", __alert_rule_uid__: "devbox-wiki-public-down", project: "devbox" };
  const ruleList = { data: { groups: [{ rules: [{ uid: "devbox-wiki-public-down", alerts: [{ labels, state: "Normal", activeAt: "2026-11-03T22:45:00Z" }] }] }] } };
  const f = await fixture({ setStates: async alert => parseSetStates(ruleList, alert.labels.__alert_rule_uid__!) });
  f.set([raw("5c1d2e3f4a5b6c7d", labels, "2026-11-13T15:56:00.000Z")]); f.at(Date.parse("2026-11-13T15:57:00Z"));
  await f.bridge.tick();
  const text = f.alerts()[0]!.text;
  assert.match(text, /- devbox-wiki-public-down \(The public wiki is down, firing since 2026-11-13T15:56Z\)/);
  assert.doesNotMatch(text, /resolved at/i);
});

test("a fire that comes while the thread's last alert message waits for its turn joins the next message, sent once the thread had a turn", async () => {
  const f = await fixture();
  f.set([alert(1, "crawler-a", "crawler")]);
  await f.bridge.tick();
  assert.equal(f.alerts().length, 1);
  assert.match(f.alerts()[0]!.text, /^\[alert\] A Grafana rule this thread owns fired\./);
  f.turns.set(CRAWLER, { ran: false });
  f.set([alert(1, "crawler-a", "crawler"), alert(2, "crawler-b", "crawler")]); f.at(NOW + 60_000);
  await f.bridge.tick();
  f.set([alert(1, "crawler-a", "crawler"), alert(2, "crawler-b", "crawler"), alert(3, "crawler-c", "crawler")]); f.at(NOW + 90_000);
  await f.bridge.tick();
  assert.equal(f.alerts().length, 1, "the thread has not read the first message yet");
  f.turns.set(CRAWLER, { ran: true, at: NOW + 100_000 });
  f.at(NOW + 120_000);
  await f.bridge.tick();
  assert.equal(f.alerts().length, 2);
  assert.match(f.alerts()[1]!.text, /^\[alert\] 2 Grafana rules this thread owns fired\.[^]*- crawler-b \([^]*- crawler-c \(/);
});

test("a firing alert counts for its chat until it resolves, and a rule of metal box owner, which has no board, is told to that session", async () => {
  const f = await fixture();
  f.set([ciAlert(), backup]);
  await f.bridge.tick();
  assert.deepEqual(f.sent.map(({ session: id }) => id).sort(), [CI, METAL].sort());
  assert.match(f.sent.find(({ session: id }) => id === METAL)!.text, /^\[alert\] A Grafana rule you own is firing, .*metal-backup-ch-redis-age/);
  assert.equal((await readFiringRules(f.file, CI)).length, 1);
  f.set([]); f.at(NOW + 150_000);
  await f.bridge.tick();
  assert.equal(firingRules(await f.state(), CI).length, 0);
});

test("a thread with no turn 30 min after a fire escalates it to ops guy once, and one the pool holds does not", async () => {
  const f = await fixture();
  f.set([ciAlert()]);
  await f.bridge.tick();
  f.turns.set(CI, { ran: false, error: "pi-pool: this run waits for a working slot, place 3 of 9" });
  f.at(NOW + ESCALATE_MS);
  f.held.add(CI);
  await f.bridge.tick();
  assert.equal(f.escalations().length, 0, "the pool holds the thread");
  f.held.delete(CI);
  f.at(NOW + ESCALATE_MS + 30_000);
  await f.bridge.tick();
  assert.equal(f.escalations().length, 0, "the poll right after the hold still spares it");
  f.at(NOW + ESCALATE_MS + 60_000);
  await f.bridge.tick();
  assert.equal(f.escalations().length, 1);
  assert.match(f.escalations()[0]!.text, /On VP of CI, its thread has had no model turn since it took the fire \(its last call failed: pi-pool: this run waits/);
  f.at(NOW + ESCALATE_MS + 90_000);
  await f.bridge.tick();
  assert.equal(f.escalations().length, 1, "once per fire");
});

test("a send that fails is tried again each poll and escalates with its error", async () => {
  let fail = true;
  const sent: string[] = [];
  const f = await fixture({ deliver: async (id, text) => { if (fail && id === CI) throw new Error("outbox disk full"); sent.push(`${id} ${text.slice(0, 20)}`); } });
  f.set([ciAlert()]);
  await f.bridge.tick();
  f.at(NOW + ESCALATE_MS);
  await f.bridge.tick();
  assert.ok(sent.some(line => line.startsWith(OPS) && line.includes("[alert-escalation]")));
  fail = false;
  f.at(NOW + ESCALATE_MS + 30_000);
  await f.bridge.tick();
  assert.ok(sent.some(line => line.startsWith(`${CI} [alert]`)));
});

test("a rule still firing a day after its thread took it goes again, and a new label set goes once the thread had a turn", async () => {
  const f = await fixture();
  f.set([ciAlert()]);
  await f.bridge.tick();
  f.set([ciAlert(), ciAlert("aaaa000000000004", "2026-11-07T08:30:00.000Z")]); f.at(NOW + 30 * 60_000);
  await f.bridge.tick();
  await f.bridge.tick();
  assert.equal(f.alerts().length, 2, "the new label set goes as the next message");
  assert.match(f.alerts()[1]!.text, /^\[alert\] A Grafana rule this thread owns fired\.[^]*- ci-history-stale \(/);
  f.at(NOW + 30 * 60_000 + REOPEN_MS);
  await f.bridge.tick();
  assert.equal(f.alerts().length, 3);
});

test("a chat whose duty keeps fault calls gets each firing key and the call command in its alert message, and other chats get neither", async () => {
  const call = { command: "python3 ops/fault_call.py <key>", cwd: "/home/sieun/Documents/Github/auto-sns-agent" };
  const f = await fixture({ firingCall: async chat => chat === CI ? call : null });
  f.set([ciAlert(), alert(1, "crawler-a", "crawler")]);
  await f.bridge.tick();
  assert.match(f.alerts().find(({ session: id }) => id === CI)!.text, /firing key is ci-history-stale@2026-11-07T08:00:00Z\./);
  assert.ok(!f.alerts().find(({ session: id }) => id === CRAWLER)!.text.includes("firing key"));
});

test("fires an old triage job took and never ran move to the chat's thread, and fires a job that ran stay with it", async () => {
  const f0 = await fixture();
  f0.set([alert(1, "crawler-a", "crawler"), alert(2, "crawler-b", "crawler")]);
  await f0.bridge.tick();
  const v4 = await f0.state();
  const ids = ["queued-job", "ran-job"];
  const rules = Object.fromEntries(Object.entries(v4.rules).map(([key, rule], index) => [key, { ...rule, job: { id: ids[index]!, name: `alert triage ${index}`, at: NOW } }]));
  const f = await fixture({ state: { v: 4, rules, jobs: { "queued-job": { id: "queued-job", name: "alert triage 0", chat: CRAWLER, at: NOW },
    "ran-job": { id: "ran-job", name: "alert triage 1", chat: CRAWLER, at: NOW, ranAt: NOW + 1 } }, chats: { [CRAWLER]: "queued-job" } } });
  f.turns.set("queued-job", { ran: false });
  f.set([alert(1, "crawler-a", "crawler"), alert(2, "crawler-b", "crawler")]); f.at(NOW + 30_000);
  await f.bridge.tick();
  assert.equal(f.alerts().length, 1);
  assert.equal(f.alerts()[0]!.session, CRAWLER);
  assert.match(f.alerts()[0]!.text, /crawler-a/);
  assert.ok(!f.alerts()[0]!.text.includes("crawler-b"));
});

test("a send that never settles does not stop the polls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alert-bridge-poll-"));
  let after = 0;
  let thrice: () => void = () => {};
  const polled = new Promise<void>(resolve => { thrice = resolve; });
  let sends = 0;
  const stop = startAlertBridge({ file: join(dir, "alert-bridge.json"), log: () => {},
    deliver: () => { sends++; return new Promise<never>(() => {}); },
    alerts: async () => { if (sends && ++after >= 3) thrice(); return parseAlerts([ciAlert()]); } }, 20);
  await polled;
  stop();
  assert.equal(sends, 1, "the hung send is not started again while it runs");
});

test("an alert labelled notify=none pages no chat, and the same rule without it does", () => {
  const quiet = raw("bbbb000000000001", { alertname: "Captured pages waiting (writer lag)", __alert_rule_uid__: "crawler-acquisitions-writer-lag", notify: "none" }, "2026-10-20T19:22:00.000Z");
  assert.deepEqual(parseAlerts([quiet]), []);
  assert.equal(parseAlerts([ciAlert()]).length, 1);
});

test("a version 2 state loses its steps and keeps the job a step carried", async () => {
  const [one] = parseAlerts([ciAlert()]);
  const key = ruleKey(CI, "ci-history-stale");
  const f = await fixture({ state: { v: 2, rules: { [key]: { chat: CI, step: "p273", closedAt: NOW - 1, rule: "ci-history-stale", alertname: one!.alertname,
    startsAt: one!.startsAt, wokeAt: NOW - 60_000, firstWokeAt: NOW - 60_000, instances: { [`${one!.fingerprint}@${one!.startsAt}`]: { startsAt: one!.startsAt, labels: one!.labels } },
    job: { id: "old-job", name: "alert VP of CI 15:59", at: NOW - 30_000 } } } } });
  f.set([ciAlert()]);
  await f.bridge.tick();
  const rule = (await f.state()).rules[key]! as unknown as Record<string, unknown>;
  assert.ok(!("step" in rule) && !("closedAt" in rule));
  assert.equal(f.alerts().length, 0, "the old job ran, so it holds the fire");
});

test("a fetch failure names its cause code", () => {
  const cause = Object.assign(new Error("getaddrinfo ENOTFOUND obs.virev.ai"), { code: "ENOTFOUND" });
  assert.equal(errorText(new TypeError("fetch failed", { cause })), "fetch failed (ENOTFOUND: getaddrinfo ENOTFOUND obs.virev.ai)");
});
