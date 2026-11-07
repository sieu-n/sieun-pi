// Guards 10-31 18:31Z: ci-staging-proof-spec-red fired for hosted-zz-monitor-flow.spec.ts, red 1 run, and its triage job read the summary of the
// hosted-campaign-screening.spec.ts instance the rule held from 15:41Z, "6 in a row", since the bridge took the rule's oldest firing instance.
// A fire now names the label sets it newly saw, each with its own labels and summary, and never a held one that already got its message.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AlertBridge, alertLine, alertRulesText, advance, emptyState, parseAlerts, ruleKey, type FiringAlert } from "../src/alert-bridge.ts";
import { ALERT_ROUTES } from "../src/alert-routes.ts";

const CI = ALERT_ROUTES.find(route => route.chat === "VP of CI")!.session;
const RULE = "ci-staging-proof-spec-red";
const HELD_AT = Date.parse("2026-10-31T15:41:51Z");
const NOW = Date.parse("2026-10-31T18:31:56Z");
const raw = (fingerprint: string, spec: string, startsAt: string, summary: string, alertname = "CI staging-proof spec red 2 runs in a row") => ({ fingerprint, startsAt, generatorURL: `https://obs.virev.ai/alerting/grafana/${RULE}/view`,
  labels: { __alert_rule_uid__: RULE, alertname, grafana_folder: "metal", incident_by: "spec", spec },
  annotations: { summary }, status: { state: "active", silencedBy: [], inhibitedBy: [] } });
const SCREENING = raw("72ae24c1ae28d21c", "hosted-campaign-screening.spec.ts", "2026-10-31T15:41:10.000Z", "hosted-campaign-screening.spec.ts is red 6 in a row.",
  "CI staging-proof spec red 3 runs in a row");
const MONITOR = raw("54f0b1d7bfa8250a", "hosted-zz-monitor-flow.spec.ts", "2026-10-31T18:31:10.000Z", "hosted-zz-monitor-flow.spec.ts is red 1 in a row.");

test("a new spec on a rule that holds an announced spec gives the job only the new spec, with its own labels and summary", async () => {
  const sent: string[] = [];
  let list: unknown[] = [SCREENING];
  let now = HELD_AT;
  const bridge = new AlertBridge({ file: join(await mkdtemp(join(tmpdir(), "alert-bridge-fresh-")), "alert-bridge.json"), now: () => now, log: () => {},
    alerts: async () => parseAlerts(list), deliver: async (_session, text) => { sent.push(text); }, jobTurn: async (_job, since) => ({ ran: true, at: since }) });
  await bridge.tick();
  list = [SCREENING, MONITOR];
  now = NOW;
  await bridge.tick();
  assert.equal(sent.length, 2);
  assert.match(sent[1]!, /spec-red \(CI staging-proof spec red 2 runs in a row, firing since 2026-10-31T15:41Z, 2 label sets\)\n  Fired: spec=hosted-zz-monitor-flow\.spec\.ts\n  Summary: hosted-zz-monitor-flow\.spec\.ts is red 1 in a row\./);
  assert.doesNotMatch(sent[1]!, /campaign-screening|6 in a row|3 runs/);
});

test("a new rule names each label set that fired with it, and a reopen with no new label set names every firing one", () => {
  const [screening, monitor] = parseAlerts([SCREENING, MONITOR]) as [FiringAlert, FiringAlert];
  const firing = new Map([screening, monitor].map(alert => [`${alert.fingerprint}@${alert.startsAt}`, alert]));
  const both = advance([screening, monitor], emptyState(), () => CI, NOW).state;
  const line = alertLine(both.rules[ruleKey(CI, RULE)]!, firing);
  assert.deepEqual(line.fires.map(fire => fire.labels), [{ alertname: "CI staging-proof spec red 3 runs in a row", spec: "hosted-campaign-screening.spec.ts" }, { spec: "hosted-zz-monitor-flow.spec.ts" }]);
  assert.ok(alertRulesText([line]).includes("  Fired: spec=hosted-zz-monitor-flow.spec.ts\n  Summary: hosted-zz-monitor-flow.spec.ts is red 1 in a row.\n"));
  const reopened = { ...both.rules[ruleKey(CI, RULE)]!, wokeAt: NOW + 86_400_000 };
  const again = alertLine(reopened, firing);
  assert.equal(again.fresh, false);
  assert.equal(again.fires.length, 2);
  assert.match(alertRulesText([again]), /  Firing: alertname=CI staging-proof spec red 3 runs in a row, spec=hosted-campaign-screening\.spec\.ts/);
});
