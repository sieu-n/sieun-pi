// 10-20: d1's paid cohort missed 00fb6658, who signed up before PostHog saw a public pageview and paid on day 26, and its signup to paid read only same-window payments (2 of 76) while Stripe showed 7 of 78.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { funnelMetrics, type FunnelReport } from "../scripts/duties/slack-green-funnel.ts";

const run = promisify(execFile);
const wrapper = join(import.meta.dirname, "../scripts/duties/slack-green-funnel.py");

/** Fake slack-green modules: hogql logs each query and answers the cohort, the signup cohort and the home test with fixed rows. */
async function fakeSeoAgent(dir: string): Promise<void> {
  await writeFile(join(dir, "conversion_targets.py"), [
    "from datetime import timezone", "PROJECT_TZ = timezone.utc", "FILTERS = None", "APP_PATHS = '^/app'", "ENTRY_CLASS = \"'home'\"",
    "LIKELY_BOT = '0'", "ON_TOPIC_CLASSES = ['home']", "PURCHASES = \"'x'\"", "def window_report(start, end):",
    "    return {'start': str(start), 'end': str(end), 'visitors': 100, 'signed_up': 4, 'workspace_added': 1, 'pro_or_cli': 0, 'on_topic_visitors': 50,",
    "            'on_topic_signed_up': 4, 'off_topic_share': 50, 'on_topic_visit_to_signup': 8, 'visit_to_signup': 4, 'signup_to_workspace': 25,",
    "            'signup_to_pro_or_cli': 0, 'entry_classes': {}}", "",
  ].join("\n"));
  await writeFile(join(dir, "setup_acquisition_dashboard.py"), "LIKELY_BOT = '0'\nLOCALE = '/(en|ko)'\n");
  await writeFile(join(dir, "posthog_blog.py"), [
    "import os", "def hogql(query, filters):", "    with open(os.environ['QUERY_LOG'], 'a') as f: f.write(query + '\\n----\\n')",
    "    if 'eligible_exposed' in query: return [[26, 24, 24, 176, 103, 27, ['sg-exp-home-1'], 1]]",
    "    if 'entry_class' in query: return [['home', 1583, 62, 9]]", "    return [[78, 7]]", "",
  ].join("\n"));
}

test("a signup before the first tracked public pageview counts in the cohort, and signup to paid follows each signup 16 days", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sg-funnel-paid-"));
  try {
    await fakeSeoAgent(dir);
    const log = join(dir, "queries.txt");
    const { stdout } = await run("python3", [wrapper, dir, "28", "2"], { env: { ...process.env, QUERY_LOG: log } });
    const report = JSON.parse(stdout) as FunnelReport;
    const queries = (await readFile(log, "utf8")).split("\n----\n");
    const cohort = queries.find(text => text.includes("entry_class"))!;
    assert.match(cohort, /countIf\(level >= 2 OR \(signups > 0 AND signup_at <= entry_at \+ INTERVAL 28 DAY\)\) AS signed_up/);
    assert.match(cohort, /arrayExists\(t -> t > signup_at AND t <= entry_at \+ INTERVAL 28 DAY, purchases\)/);
    const signups = queries.filter(text => text.includes("signup_at + INTERVAL 16 DAY"));
    assert.equal(signups.length, 3);
    assert.deepEqual(report.signups, { ...report.signups!, follow_days: 16, signed_up: 78, paid: 7 });
    assert.equal(report.signup_weeks?.length, 2);
    const { metrics, flagged } = funnelMetrics(report, 1);
    assert.equal(metrics.source_errors, 0);
    assert.equal(metrics.on_topic_visit_to_paid_pct, 0.57);
    assert.equal(metrics.signup_to_paid_16d_pct, 8.97);
    assert.equal(metrics.signup_to_paid_pct, undefined);
    assert.match(flagged.find(slice => slice.kind === "signup_cohort")!.excerpt, /78 signed up, 7 started Pro or bought the CLI within 16 days/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a failed signup to paid query is a source error that holds the headline at 0", () => {
  const report = { window: null, window_error: "x", home: null, home_error: "x", cohort: null, cohort_error: "x", signups: null, signups_error: "HTTP 500" } as FunnelReport;
  const { metrics, flagged } = funnelMetrics(report, 1);
  assert.equal(metrics.source_errors, 4);
  assert.match(flagged.map(slice => slice.excerpt).join("\n"), /signup to paid query failed: HTTP 500/);
});
