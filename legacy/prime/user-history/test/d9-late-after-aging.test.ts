// Guards d9's aging read when an older run's after-job measure was taken late. At 03:59Z on 11-20 d9 counted Slack green's d3 as a red that
// owes a fix job, while its one bad send of 19:17Z on 11-19 was fixed by #575 and only waited to leave the 24 h window. The 01:00Z run of 11-19
// read met, its stalled job's after measure was written at 01:00Z on 11-20, and the miss streak dated from 01:00Z on 11-19, before the send.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agingSince, agingUntil, chronicWindow } from "../src/duty-push.ts";
import type { DutyRunRecord, MetricResult } from "../src/shared/chat-duties.ts";
import { metricStreaks } from "../src/shared/duty-streak.ts";

const t = (iso: string): number => Date.parse(`2026-${iso}Z`);
const sent = t("11-19T19:17:10");
const bad = (met: boolean): Record<string, MetricResult> => ({ bad_sends_24h: { value: met ? 0 : 1, target: 0, op: "<=", met, ...met ? {} : { lastEventAt: sent } } });
const run = (at: string, trigger: DutyRunRecord["trigger"], met: boolean, after?: { at: string; met: boolean }): DutyRunRecord => ({ duty: "d3", at: t(at), trigger,
  ms: 1, verdict: met ? "met" : "missed", summary: "", metrics: bad(met),
  ...after ? { after: { at: t(after.at), verdict: after.met ? "met" : "missed", summary: "", metrics: bad(after.met) } } : {} });

/** Slack green d3 from 11-18 to 11-20, newest first, as its runs file holds them. */
const d3 = [run("11-20T01:17:07", "verify", false), run("11-20T01:10:15", "push", false), run("11-20T01:00:15", "schedule", false),
  run("11-19T01:00:24", "schedule", true, { at: "11-20T01:00:15", met: false }), run("11-18T01:00:17", "schedule", true)];

test("a late after measure dates the streak from when it was taken, so a send before it ages out", () => {
  const streak = metricStreaks(d3)[0]!;
  assert.equal(streak.since, t("11-20T01:00:15"));
  assert.equal(streak.quietSince, sent);
  assert.equal(chronicWindow(streak, d3[0]!.at), false);
  assert.equal(agingSince(d3), sent);
  assert.equal(agingUntil(d3), sent + 86_400_000);
});

test("a run whose own reading missed still dates the streak from its start", () => {
  const own = [d3[0]!, run("11-19T01:00:24", "schedule", false, { at: "11-20T01:00:15", met: false })];
  assert.equal(metricStreaks(own)[0]!.since, t("11-19T01:00:24"));
});
