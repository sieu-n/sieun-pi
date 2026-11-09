// Guards d9's aging read of windowed counts that miss day after day. At 01:20Z on 11-09 d9 called four reds "red only on counts that age out,
// so it owes no fix job", because it read only whether the newest counted event came before the run before. ops guy's d3 had missed
// noisy_rules_24h at every run since 23:46Z on 11-02 with a new flap each day, and api portal vp's d1 had missed probe_uptime_24h_pct since
// 18:19Z on 11-07. A streak that has lasted its whole window with a counted event after its first miss is chronic, and owes a fix job.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agingSince, agingUntil, fixNotMoving, unquietChronic, type RedDuty } from "../scripts/duties/chat-system.ts";
import { chronicWindow } from "../src/duty-push.ts";
import type { DutyRunRecord, FixLink } from "../src/shared/chat-duties.ts";
import { fixStepStreak, metricStreaks } from "../src/shared/duty-streak.ts";

const t = (iso: string): number => Date.parse(`2026-${iso}Z`);

/** One ops guy d3 run: noisy_rules_24h as the precheck read it, with its newest flap. */
const d3 = (at: string, value: number, newest: string): DutyRunRecord => ({ duty: "d3", at: t(at), trigger: "schedule", ms: 1, verdict: "missed", summary: "",
  metrics: { noisy_rules_24h: { value, target: 0, op: "<=", met: false, lastEventAt: t(newest) } } });

/** ops guy d3 from 11-02 to 11-09, every run red with a flap after the run before, then two runs with no newer flap. */
const opsD3 = [d3("11-08T23:51:00", 2, "11-08T18:25:00"), d3("11-08T23:46:00", 2, "11-08T18:25:00"), d3("11-08T11:48:00", 3, "11-08T10:54:00"),
  d3("11-07T23:46:00", 5, "11-07T19:22:00"), d3("11-06T23:46:00", 3, "11-06T20:10:00"), d3("11-05T23:46:00", 4, "11-05T21:02:00"),
  d3("11-04T23:46:00", 2, "11-04T15:40:00"), d3("11-03T23:46:00", 3, "11-03T22:15:00"), d3("11-02T23:46:00", 2, "11-02T23:30:00")];

const p52: FixLink = { step: "p52", job: "probe uptime", live: true };
/** One api portal vp d1 run under its fix step p52: probe_uptime_24h_pct and its newest failed probe. */
const d1 = (at: string, value: number, newest: string): DutyRunRecord => ({ duty: "d1", at: t(at), trigger: "push", ms: 1, verdict: "missed", summary: "",
  fixes: { probe_uptime_24h_pct: p52 }, metrics: { probe_uptime_24h_pct: { value, target: 100, op: ">=", met: false, lastEventAt: t(newest) } } });
const apiD1 = [d1("11-09T00:33:00", 98.13, "11-08T15:25:00"), d1("11-08T22:29:00", 98.13, "11-08T15:25:00"), d1("11-08T21:16:00", 98.13, "11-08T15:25:00"),
  d1("11-07T21:27:00", 98.13, "11-07T21:20:00"), d1("11-07T18:19:00", 98.13, "11-07T18:10:00")];

test("ops guy d3: a miss streak of six days with a flap each day is chronic, not aging, though its newest flap came before the run before", () => {
  const streak = metricStreaks(opsD3)[0]!;
  assert.equal(streak.quietSince, t("11-08T18:25:00"), "the duty runner's own quiet read is unchanged");
  assert.equal(chronicWindow(streak, opsD3[0]!.at), true);
  assert.equal(agingSince(opsD3), undefined);
  assert.equal(agingUntil(opsD3), undefined);
});

test("the same miss inside its first 24 h, or with no flap after its first miss, still only ages out", () => {
  const young = opsD3.slice(0, 3);
  assert.equal(agingSince(young), t("11-08T18:25:00"), "11:48Z to 23:51Z is under the 24 h window");
  const old = [d3("11-04T23:46:00", 2, "11-03T22:15:00"), d3("11-04T05:00:00", 2, "11-03T22:15:00"), d3("11-03T22:00:00", 3, "11-03T21:55:00")];
  assert.equal(agingSince(old.slice(0, 2)), t("11-03T22:15:00"), "no counted flap came after 05:00Z, the first miss");
});

test("api portal vp d1: a chronic red under its fix step reads as a fix that does not move, not as aging", () => {
  const metric = unquietChronic({ ...metricStreaks(apiD1)[0]!, fix: { step: "p52", live: true } }, apiD1[0]!.at);
  assert.equal(metric.quietSince, undefined);
  const since = agingSince(apiD1);
  const duty: RedDuty = { chat: "api", duty: "d1", name: "Probe uptime", green: false, misses: metric.misses, stuck: false, metric, fix: "p52",
    underFix: fixStepStreak(apiD1, "probe_uptime_24h_pct", "p52"), ...since === undefined ? {} : { agingSince: since } };
  assert.equal(duty.agingSince, undefined);
  const lines = fixNotMoving([duty], () => "api portal vp");
  assert.equal(lines.length, 1);
  assert.match(lines[0]!.line, /missed probe_uptime_24h_pct 5 runs in a row, 5 of them under its fix step p52/);
});
