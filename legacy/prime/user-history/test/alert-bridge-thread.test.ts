// A Grafana rule that owners.json routes to a pi-host thread (vent, 230bbdbf, from 10-29) goes to that thread as one agent message per fire, and
// the thread starts its own triage with rlm.spawn (c22). Prime's daemon knows no thread, so a Prime triage job start for it threw "no chat".
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AlertBridge, ESCALATE_MS, REFIRE_MS, REOPEN_MS, TRIAGE_WORK, firingRules, parseAlerts, parseOwners, parseState, ruleKey } from "../src/alert-bridge.ts";
import { ALERT_ROUTES } from "../src/alert-routes.ts";
import { entriesTurnSince, type TurnSince } from "../src/held-turns.ts";

const NOW = Date.parse("2026-10-29T03:00:00Z");
const VENT = "230bbdbf-4d84-475f-95d2-63db2f90ca34";
const OPS = ALERT_ROUTES.find(route => route.chat === "ops guy")!.session;
const RULE = "vent-health-failure-rate-prod";
const KEY = ruleKey(VENT, RULE);
const OWNERS = parseOwners({ owners: { Vent: VENT, "ops guy": OPS }, fallback: "ops guy", routes: [{ name: "vent", match: { __alert_rule_uid__: "^vent-" }, owner: "Vent" }] });

const alert = (fingerprint = "cccc000000000001", startsAt = "2026-10-29T02:58:00.000Z", rule = RULE) => ({ fingerprint, startsAt,
  labels: { alertname: "Vent health checks fail on prod", __alert_rule_uid__: rule }, annotations: { summary: "Vent failure rate is 12%.", __values__: '{"B":0.12}' },
  generatorURL: `https://obs.virev.ai/alerting/grafana/${rule}/view`, status: { state: "active", silencedBy: [], inhibitedBy: [] } });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "alert-bridge-thread-"));
  const file = join(dir, "alert-bridge.json");
  let now = NOW;
  let list: unknown[] = [];
  const toThread: { thread: string; text: string; requestId: string }[] = [];
  const delivered: { session: string; text: string }[] = [];
  const started: string[] = [];
  const turns = new Map<string, TurnSince>();
  let failSends = 0;
  let failList = false;
  const bridge = new AlertBridge({ file, now: () => now, log: () => {}, alerts: async () => parseAlerts(list), owners: async () => OWNERS,
    // boards.read finds no board for a thread id, so the thread check has to come first.
    hasBoard: async session => session !== VENT,
    deliver: async (session, text) => { delivered.push({ session, text }); },
    startJob: async chat => { started.push(chat); return { id: `job-${started.length}`, name: "a Prime job" }; },
    threads: {
      list: async () => { if (failList) throw new Error("pi-host did not answer"); return new Map([[VENT, "vent"]]); },
      send: async (thread, text, requestId) => {
        if (failSends > 0) { failSends--; throw new Error("pi-host did not answer"); }
        toThread.push({ thread, text, requestId });
      },
      turn: async (_thread, since) => turns.get(VENT) ?? { ran: true, at: since },
    },
    jobWorking: async () => true, jobTurn: async (_job, since) => ({ ran: true, at: since }) });
  return { bridge, toThread, delivered, started, turns, failSend: (count: number) => { failSends = count; }, failList: (on: boolean) => { failList = on; },
    set: (alerts: unknown[]) => { list = alerts; }, at: (ms: number) => { now = ms; }, state: async () => parseState(JSON.parse(await readFile(file, "utf8"))) };
}

const escalations = (f: Awaited<ReturnType<typeof fixture>>) => f.delivered.filter(({ session, text }) => session === OPS && text.startsWith("[alert-escalation]"));

test("a fire of a rule a pi-host thread owns goes to the thread as one agent message with the brief's rule lines, and starts no Prime job", async () => {
  const f = await fixture();
  f.set([alert()]);
  for (let tick = 0; tick < 4; tick++) { f.at(NOW + tick * 30_000); await f.bridge.tick(); }
  assert.equal(f.toThread.length, 1);
  assert.deepEqual([f.toThread[0]!.thread, f.toThread[0]!.requestId], [VENT, `alert:${RULE}@${NOW}`]);
  const text = f.toThread[0]!.text;
  assert.ok(text.startsWith("[alert] A Grafana rule this thread owns fired."));
  assert.ok(text.includes(`- ${RULE} (Vent health checks fail on prod, firing since 2026-10-29T02:58Z)\n  Summary: Vent failure rate is 12%.\n  Values: B=0.12.\n` +
    `  Grafana: https://obs.virev.ai/alerting/grafana/${RULE}/view`));
  assert.ok(text.includes(TRIAGE_WORK) && text.includes("rlm.spawn"));
  assert.deepEqual([f.started, f.delivered], [[], []]);
  const state = await f.state();
  assert.deepEqual([state.rules[KEY]!.job?.id, state.chats[VENT]], [VENT, VENT]);
  assert.equal(firingRules(state, VENT).length, 1);
});

test("a thread's rule dedupes a dropped alert, keeps a refire within REFIRE_MS as one incident, resolves, and sends a later refire again", async () => {
  const f = await fixture();
  f.set([alert()]);
  await f.bridge.tick();
  f.set([]); f.at(NOW + 60_000);
  await f.bridge.tick();
  assert.equal(firingRules(await f.state(), VENT).length, 0, "the rule resolves once its alert leaves the list");
  f.set([alert()]); f.at(NOW + 60_000 + REFIRE_MS + 60_000);
  await f.bridge.tick();
  assert.equal(f.toThread.length, 1, "the same Grafana alert back in the list is no new fire");
  f.set([]); f.at(NOW + 10 * 60_000);
  await f.bridge.tick();
  f.set([alert("cccc000000000002", "2026-10-29T03:12:00.000Z")]); f.at(NOW + 13 * 60_000);
  await f.bridge.tick();
  assert.equal(f.toThread.length, 1, "a new alert within REFIRE_MS of the resolve is the same incident");
  f.set([]); f.at(NOW + 20 * 60_000);
  await f.bridge.tick();
  assert.equal(firingRules(await f.state(), VENT).length, 0);
  const later = NOW + 20 * 60_000 + REFIRE_MS + 30_000;
  f.set([alert("cccc000000000003", "2026-10-29T03:26:00.000Z")]); f.at(later);
  await f.bridge.tick();
  assert.equal(f.toThread.length, 2);
  assert.equal(f.toThread[1]!.requestId, `alert:${RULE}@${later}`);
  assert.ok(f.toThread[1]!.text.includes("firing since 2026-10-29T03:26Z"));
  assert.deepEqual(f.started, []);
});

test("a thread with no turn after a fire escalates it to ops guy once at ESCALATE_MS, and one whose turn ended holds it", async () => {
  const f = await fixture();
  f.turns.set(VENT, { ran: false });
  f.set([alert()]);
  await f.bridge.tick();
  f.at(NOW + ESCALATE_MS - 1000);
  await f.bridge.tick();
  assert.equal(escalations(f).length, 0);
  f.at(NOW + ESCALATE_MS);
  await f.bridge.tick();
  assert.equal(escalations(f).length, 1);
  assert.match(escalations(f)[0]!.text, new RegExp(`On vent, its triage job vent has had no model turn: ${RULE}`));
  f.at(NOW + ESCALATE_MS + 30_000);
  await f.bridge.tick();
  assert.deepEqual([escalations(f).length, f.toThread.length], [1, 1], "once per fire, and the thread is not sent the fire again");

  const held = await fixture();
  held.set([alert()]);
  await held.bridge.tick();
  held.at(NOW + ESCALATE_MS + 30_000);
  await held.bridge.tick();
  assert.equal(escalations(held).length, 0);
  assert.equal((await held.state()).jobs[VENT]!.ranAt, NOW);
});

test("a thread's rule that still fires REOPEN_MS after the thread took it goes to the thread again", async () => {
  const f = await fixture();
  f.set([alert()]);
  await f.bridge.tick();
  f.at(NOW + REOPEN_MS - 30_000);
  await f.bridge.tick();
  assert.equal(f.toThread.length, 1);
  f.at(NOW + REOPEN_MS);
  await f.bridge.tick();
  assert.equal(f.toThread.length, 2);
  assert.equal(f.toThread[1]!.requestId, `alert:${RULE}@${NOW + REOPEN_MS}`);
});

test("a failed send goes again next poll with the same request id, and a failed thread list keeps the last one", async () => {
  const f = await fixture();
  f.failSend(1);
  f.set([alert()]);
  await f.bridge.tick();
  assert.equal(f.toThread.length, 0);
  f.at(NOW + 30_000);
  await f.bridge.tick();
  assert.deepEqual(f.toThread.map(send => send.requestId), [`alert:${RULE}@${NOW}`]);
  f.failList(true);
  f.set([alert(), alert("cccc000000000009", "2026-10-29T03:05:00.000Z", "vent-queue-stuck")]); f.at(NOW + 6 * 60_000);
  await f.bridge.tick();
  assert.equal(f.toThread.length, 2, "the new rule still goes to the thread");
  assert.ok(f.toThread[1]!.text.includes("vent-queue-stuck"));
  assert.deepEqual([f.started, f.delivered], [[], []]);
});

test("a thread's turn reads from its root entries: a reply after `since` ran, and a 429 alone did not", () => {
  const entries = [
    { kind: "pi.assistant", model: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limit", timestamp: NOW + 2000 }] },
    { kind: "agent.message", model: [{ role: "user", content: [{ type: "text", text: "[alert] ..." }], timestamp: NOW + 1000 }] },
    { kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: NOW - 5000 }] },
  ];
  assert.deepEqual(entriesTurnSince(entries, NOW), { ran: false, error: "429 rate limit" });
  assert.deepEqual(entriesTurnSince(entries, NOW - 10_000), { ran: true, at: NOW - 5000 });
  const replied = [{ kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "on it" }], stopReason: "stop", timestamp: NOW + 3000 }] }, ...entries];
  assert.deepEqual(entriesTurnSince(replied, NOW), { ran: true, at: NOW + 3000 });
});
