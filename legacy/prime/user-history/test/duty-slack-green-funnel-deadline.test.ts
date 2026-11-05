// 11-05 09:30 KST: d1 read home_test_reach_pct 0 and source_errors 4 in 128 s, because one slow PostHog query held the python past the
// 110 s kill and every source's numbers were lost with it. A rerun read 100 and 0 in 17 s.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { funnelMetrics, type FunnelReport } from "../scripts/duties/slack-green-funnel.ts";

const run = promisify(execFile);
const wrapper = join(import.meta.dirname, "../scripts/duties/slack-green-funnel.py");

/** Fake slack-green modules: the cohort query hangs, the others answer at once. */
async function fakeSeoAgent(dir: string): Promise<void> {
  await writeFile(join(dir, "conversion_targets.py"), [
    "from datetime import timezone", "PROJECT_TZ = timezone.utc", "FILTERS = None", "APP_PATHS = '^/app'", "ENTRY_CLASS = \"'home'\"",
    "LIKELY_BOT = '0'", "ON_TOPIC_CLASSES = ['home']", "PURCHASES = \"'x'\"", "def window_report(start, end):",
    "    return {'start': str(start), 'end': str(end), 'visitors': 500, 'signed_up': 10, 'workspace_added': 6, 'pro_or_cli': 1, 'on_topic_visitors': 400,",
    "            'on_topic_signed_up': 8, 'off_topic_share': 20.0, 'on_topic_visit_to_signup': 2.0, 'visit_to_signup': 2.0, 'signup_to_workspace': 60.0,",
    "            'signup_to_pro_or_cli': 10.0, 'entry_classes': {}}", "",
  ].join("\n"));
  await writeFile(join(dir, "setup_acquisition_dashboard.py"), "LIKELY_BOT = '0'\nLOCALE = '/(en|ko)'\n");
  await writeFile(join(dir, "posthog_blog.py"), [
    "import time", "def hogql(query, filters):", "    if 'windowFunnel' in query: time.sleep(600)",
    "    if 'eligible_exposed' in query: return [[40, 38, 38, 200, 190, 41, ['sg-exp-home-1'], 0]]", "    return [[50, 5]]", "",
  ].join("\n"));
}

test("a hung PostHog query costs only its own source: the python prints by its deadline and the home test still counts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sg-funnel-deadline-"));
  try {
    await fakeSeoAgent(dir);
    const started = Date.now();
    const { stdout } = await run("python3", [wrapper, dir, "28", "0", "2"], { timeout: 30_000 });
    assert.ok(Date.now() - started < 15_000, "the python waited on the hung query");
    const report = JSON.parse(stdout) as FunnelReport;
    assert.equal(report.cohort, null);
    assert.equal(report.cohort_error, "posthog query still running after 2 s");
    const { metrics } = funnelMetrics(report, 1);
    assert.equal(metrics.source_errors, 1);
    assert.equal(metrics.home_test_reach_pct, 95);
    assert.equal(metrics.signup_to_workspace_pct, 60);
    assert.equal(metrics.signup_to_paid_16d_pct, 10);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
