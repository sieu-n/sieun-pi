import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { DutyStore } from "../src/chat-duty-store.ts";
import { judge, parseDutyInput } from "../src/shared/chat-duties.ts";
import { type Exec, type FunnelDeps, type FunnelReport, funnelMetrics, measureFunnel, pickRef, trend, type WindowReport } from "../scripts/duties/slack-green-funnel.ts";

const NOW = Date.parse("2026-10-13T00:30:00Z");
const row = (visitors: number, signed_up: number) => ({ visitors, signed_up, workspace_added: 0, pro_or_cli: 0, visit_to_signup: visitors ? Math.round(10000 * signed_up / visitors) / 100 : null });
const WINDOW: WindowReport = {
  start: "2026-09-15", end: "2026-10-13", visitors: 12097, signed_up: 60, workspace_added: 20, pro_or_cli: 4, on_topic_visitors: 4189, on_topic_signed_up: 58,
  off_topic_share: 65.37, on_topic_visit_to_signup: 1.38, visit_to_signup: 0.5, signup_to_workspace: 33.33, signup_to_pro_or_cli: 6.67,
  entry_classes: { home: row(394, 34), blog_on_topic: row(3156, 19), blog_off_topic: row(7908, 2), tool: row(0, 0), other: row(639, 5) },
};
const REPORT: FunnelReport = { window: WINDOW, window_error: null, home: { exposed: 0, home_visitors: 37, flags: [] }, home_error: null };
const sliceKinds = (flagged: { kind: string }[] | undefined) => (flagged ?? []).map(item => item.kind);

test("funnel: the report's rates become the metrics, with the window, every entry class and the home test as context", () => {
  const { metrics, flagged } = funnelMetrics(REPORT, NOW);
  assert.deepEqual(metrics, { on_topic_visit_to_signup_pct: 1.38, signup_to_workspace_pct: 33.33, signup_to_paid_pct: 6.67, home_test_people_24h: 0, source_errors: 0 });
  assert.deepEqual(sliceKinds(flagged), ["window", "entry_class", "entry_class", "entry_class", "entry_class", "entry_class", "home_test"]);
  assert.match(flagged.at(-1)!.excerpt, /0 real people .*no sg-exp-home flag was called.* 37 real home page visitors/);
});

test("funnel: a failed query or a window with no visitors is a source error and a miss, never a good value", () => {
  const failed = funnelMetrics({ ...REPORT, window: null, window_error: "{\"error\": \"posthog_api_error\", \"status\": 401}" }, NOW);
  assert.equal(failed.metrics.source_errors, 1);
  assert.equal(failed.metrics.signup_to_workspace_pct, 0);
  assert.equal(failed.metrics.home_test_people_24h, 0);
  const empty = funnelMetrics({ ...REPORT, window: { ...WINDOW, visitors: 0 }, home: null, home_error: "timeout" }, NOW);
  assert.equal(empty.metrics.source_errors, 2);
  const none = funnelMetrics(null, NOW, "python3: not found");
  assert.equal(none.metrics.source_errors, 2);
  assert.match(none.flagged[0]!.excerpt, /python3: not found/);
  const noSignups = funnelMetrics({ ...REPORT, window: { ...WINDOW, signed_up: 0, signup_to_workspace: null, signup_to_pro_or_cli: null } }, NOW);
  assert.equal(noSignups.metrics.source_errors, 0, "0 signups with real visitors is a real 0");
  assert.equal(noSignups.metrics.signup_to_paid_pct, 0);
});

test("funnel: the trend slice names how each metric moved since the last run", () => {
  assert.deepEqual(trend(undefined, { a: 1 }, NOW), []);
  const [slice] = trend({ at: NOW - 86_400_000, metrics: { signup_to_workspace_pct: 32, source_errors: 0 } }, { signup_to_workspace_pct: 33.33, source_errors: 0 }, NOW);
  assert.match(slice!.excerpt, /signup_to_workspace_pct 32 to 33.33$/);
});

function fakeGit(options: { mainHasScript: boolean; fetchFails?: boolean; report?: string }): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    if (file === "git" && args[2] === "fetch") { if (options.fetchFails) throw new Error("index.lock busy"); return ""; }
    if (file === "git" && args[2] === "cat-file") {
      if (args[4]!.startsWith("refs/remotes/origin/main:") && !options.mainHasScript) throw new Error("missing");
      return "";
    }
    if (file === "git" && args[2] === "archive") return "";
    if (file === "tar") return "";
    if (file === "py") return options.report ?? JSON.stringify(REPORT);
    throw new Error(`unexpected ${file}`);
  };
  return { exec, calls };
}
const deps = (exec: Exec, env: Record<string, string> = { POSTHOG_PERSONAL_API_KEY: "phx_test" }): FunnelDeps =>
  ({ exec, now: () => NOW, repo: "/sg", python: "py", wrapper: "/w/slack-green-funnel.py", env });

test("funnel: reads the script from origin/main once it has it, else from the PR #236 branch, and never from the checkout's own files", async () => {
  const before = fakeGit({ mainHasScript: false });
  const picked = await pickRef(deps(before.exec));
  assert.ok("ref" in picked && picked.ref === "refs/remotes/origin/feature/on-topic-visit-target");
  const after = fakeGit({ mainHasScript: true });
  const merged = await pickRef(deps(after.exec));
  assert.ok("ref" in merged && merged.ref === "refs/remotes/origin/main");
  assert.ok(!after.calls.some(call => call.join(" ").includes("feature/on-topic-visit-target")), "no PR branch fetch once main has the script");
  const { output, state } = await measureFunnel(deps(after.exec), undefined);
  assert.equal(output.metrics.signup_to_workspace_pct, 33.33);
  assert.deepEqual(state?.metrics, output.metrics);
  const archive = after.calls.find(call => call[3] === "archive")!;
  assert.deepEqual(archive.slice(5), ["refs/remotes/origin/main", "scripts/seo-agent", "scripts/posthog"]);
  assert.ok(!after.calls.some(call => ["checkout", "switch", "worktree", "reset", "stash", "merge"].includes(call[3]!)));
});

test("funnel: a failed fetch keeps the last ref; no key or no script is a source error with every metric present", async () => {
  const stale = fakeGit({ mainHasScript: true, fetchFails: true });
  const { output } = await measureFunnel(deps(stale.exec), undefined);
  assert.equal(output.metrics.source_errors, 0);
  assert.ok(sliceKinds(output.flagged).includes("source_note"));
  const noKey = await measureFunnel(deps(fakeGit({ mainHasScript: true }).exec, {}), undefined);
  assert.equal(noKey.output.metrics.source_errors, 2);
  assert.equal(noKey.state, undefined, "a run with a source error does not become the trend baseline");
  const missing: Exec = async (file, args) => { if (args[2] === "cat-file") throw new Error("missing"); return ""; };
  const nothing = await measureFunnel(deps(missing), undefined);
  assert.equal(nothing.output.metrics.source_errors, 2);
  assert.equal(Object.keys(nothing.output.metrics).length, 5);
});

test("funnel duty file parses, every metric is a key the precheck writes, and today's numbers judge as missed", async () => {
  const duty = parseDutyInput(JSON.parse(await readFile(join(import.meta.dirname, "..", "scripts", "duties", "slack-green-funnel.duty.json"), "utf8")), "d", NOW);
  assert.deepEqual(duty.schedule, { kind: "daily", at: "09:30" });
  const { metrics } = funnelMetrics(REPORT, NOW);
  assert.deepEqual(duty.metrics.map(metric => metric.key).sort(), Object.keys(metrics).sort());
  const verdict = judge(duty.metrics, { metrics });
  assert.equal(verdict.verdict, "missed");
  assert.equal(verdict.metrics.source_errors?.met, true);
});

test("add.ts stores the funnel duty with its precheck cwd resolved to this component", async () => {
  const component = join(import.meta.dirname, "..");
  const dataDir = await mkdtemp(join(tmpdir(), "duty-add-"));
  try {
    await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/duties/add.ts", "chat1", join(component, "scripts/duties/slack-green-funnel.duty.json"), "--data-dir", dataDir], { cwd: component });
    const [duty] = await new DutyStore(dataDir).list("chat1");
    assert.equal(duty?.name, "Visitors become paying users");
    assert.equal(duty?.precheck.cwd, component);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
