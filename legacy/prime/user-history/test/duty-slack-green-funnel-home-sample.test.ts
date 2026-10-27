// 10-25 and 10-26: d1 read 66.67% (4 of 6) and 81.82% (9 of 11) on weekend 24 h windows while the same runs read 184 of 193 and 183 of 192 over 7 days.
import assert from "node:assert/strict";
import { test } from "node:test";
import { funnelMetrics, MIN_HOME_SAMPLE, type FunnelReport, type HomeTest } from "../scripts/duties/slack-green-funnel.ts";

const home = (eligible: number, eligibleExposed: number): HomeTest => ({
  eligible, eligible_exposed: eligibleExposed, exposed: eligibleExposed, eligible_7d: 192, eligible_exposed_7d: 183, home_visitors: eligible,
  flags: ["sg-exp-home-1"], signed_in_24h: 0,
});
const report = (h: HomeTest): FunnelReport => ({ window: null, window_error: null, home: h, home_error: null, cohort: null, signups: null });
const slice = (flagged: { kind: string; excerpt: string }[]) => flagged.find(item => item.kind === "home_test")!.excerpt;

test("a 24 h window under the minimum sample reads the last 7 days", () => {
  const { metrics, flagged } = funnelMetrics(report(home(11, 9)), 1);
  assert.equal(metrics.home_test_reach_pct, 95.31);
  assert.match(slice(flagged), new RegExp(`reads the last 7 days, because the last 24 h had under ${MIN_HOME_SAMPLE} visitors`));
  assert.match(slice(flagged), /last 24 h: 9 of 11 .*last 7 days: 183 of 192/);
});

test("a 24 h window at the minimum sample reads the last 24 h, so a weekday drop still misses", () => {
  const { metrics, flagged } = funnelMetrics(report(home(MIN_HOME_SAMPLE, 24)), 1);
  assert.equal(metrics.home_test_reach_pct, 80);
  assert.match(slice(flagged), /the headline reads the last 24 h;/);
});

test("a 7-day pool still misses a test that stopped sending a day ago", () => {
  const { metrics } = funnelMetrics(report({ ...home(11, 0), eligible_7d: 192, eligible_exposed_7d: 160 }), 1);
  assert.ok(metrics.home_test_reach_pct! < 90);
});
