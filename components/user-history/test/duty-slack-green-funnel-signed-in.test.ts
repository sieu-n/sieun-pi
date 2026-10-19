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

/** Fake slack-green modules: hogql writes each query to a file and gives a home test row with 1 signed-in person. */
async function fakeSeoAgent(dir: string): Promise<void> {
  await writeFile(join(dir, "conversion_targets.py"), [
    "from datetime import timezone", "PROJECT_TZ = timezone.utc", "FILTERS = None", "APP_PATHS = '^/app'", "ENTRY_CLASS = \"'home'\"",
    "LIKELY_BOT = '0'", "ON_TOPIC_CLASSES = ['home']", "PURCHASES = \"'x'\"", "def window_report(start, end):", "    raise RuntimeError('not in this test')", "",
  ].join("\n"));
  await writeFile(join(dir, "setup_acquisition_dashboard.py"), "LIKELY_BOT = '0'\nLOCALE = '/(en|ko)'\n");
  await writeFile(join(dir, "posthog_blog.py"), [
    "import os", "def hogql(query, filters):", "    with open(os.environ['QUERY_LOG'], 'a') as f: f.write(query + '\\n----\\n')",
    "    if 'eligible_exposed' in query: return [[26, 24, 24, 176, 103, 27, ['sg-exp-home-1'], 1]]", "    return []", "",
  ].join("\n"));
}

test("a home view after sign-in in the same visit is not a signed-out home visitor (10-19, 25 of 28 with a One Tap signup counted)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sg-funnel-test-"));
  try {
    await fakeSeoAgent(dir);
    const log = join(dir, "queries.txt");
    const { stdout } = await run("python3", [wrapper, dir, "28"], { env: { ...process.env, QUERY_LOG: log } });
    const report = JSON.parse(stdout) as FunnelReport;
    assert.equal(report.home_error, null);
    assert.equal(report.home?.signed_in_24h, 1);
    const query = (await readFile(log, "utf8")).split("\n----\n").find(text => text.includes("eligible_exposed"))!;
    assert.match(query, /event IN \('\$feature_flag_called', '\$pageview', '\$identify'\)/);
    assert.match(query, /GROUP BY person_id, session/);
    assert.match(query, /identified = 0 OR first_home_24h < signed_in_at/);
    const { metrics, flagged } = funnelMetrics({ ...report, window: null, cohort: null }, 1);
    assert.equal(metrics.home_test_reach_pct, 92.31);
    assert.match(flagged.find(slice => slice.kind === "home_test")!.excerpt, /1 left out as signed in/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
