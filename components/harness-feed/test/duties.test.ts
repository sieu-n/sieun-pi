import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rename, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chatNames, dueAt, read, readRuns, toolProblems } from "../readers/duties.ts";
import type { Context, Sample } from "../otlp.ts";

process.env.TZ = "UTC";
const NOW = Date.parse("2026-10-19T12:00:00Z");
const MIN = 60_000;
const CHAT = "01a00000-0000-7000-8000-000000000001";
const FIXTURE = join(import.meta.dirname, "fixtures/duties/home");
const effective = (run: any) => run.after ?? run;

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "duties-test-"));
  await cp(FIXTURE, dir, { recursive: true });
  return dir;
}
const ctx = (dir: string, state = new Map<string, unknown>(), now = NOW): Context => ({ home: dir, host: "t", platform: "linux", now, chatHost: true, state });
const value = (samples: Sample[], name: string, labels: Record<string, string> = {}): number | undefined =>
  samples.find(s => s.name === name && Object.entries(labels).every(([k, v]) => s.labels?.[k] === v))?.value;

test("a box that does not run the chat service reads nothing", async () => {
  assert.deepEqual(await read({ ...ctx(FIXTURE), chatHost: false }), []);
});

test("the fixture chat reads as the Duties card, the check-in card and the board show it", async () => {
  const dir = await home();
  try {
    const samples = await read(ctx(dir));
    const chat = "fixture chat";
    assert.ok(samples.every(s => s.labels?.chat === undefined || s.labels.chat === chat || s.labels.chat === "01a00000"), "the archived chat stays out");
    assert.equal(value(samples, "harness.duties.duty_late", { chat: "01a00000" }), undefined, "a new chat's first check-in has no due time yet");
    assert.equal(value(samples, "harness.duties.count", { chat: "01a00000", state: "new" }), 1);
    assert.equal(value(samples, "harness.duties.fleet_green_share"), 0.6);
    assert.equal(value(samples, "harness.duties.green_share", { chat }), 0.6);
    for (const [state, n] of Object.entries({ met: 3, missed: 2, error: 0, paused: 1, new: 1 })) assert.equal(value(samples, "harness.duties.count", { chat, state }), n, state);
    assert.equal(value(samples, "harness.duties.duty_green", { chat, duty: "Check-in" }), 1, "the after-job measure counts");
    assert.equal(value(samples, "harness.duties.duty_green", { chat, duty: "Daily report" }), 0);
    assert.equal(value(samples, "harness.duties.duty_green", { chat, duty: "Never ran" }), undefined, "pending");
    assert.equal(value(samples, "harness.duties.overdue", { chat }), 1);
    assert.equal(value(samples, "harness.duties.duty_late", { chat, duty: "Never ran" }), 4 * 3600);
    assert.equal(value(samples, "harness.duties.duty_late", { chat, duty: "Daily report" }), 0, "the skipped slot covers today");
    assert.equal(value(samples, "harness.checkin.last_run_age", { chat }), 300);
    assert.equal(value(samples, "harness.checkin.metric", { chat, key: "stuck_steps" }), 0);
    assert.equal(value(samples, "harness.checkin.steps", { chat, class: "orphan" }), 1);
    assert.equal(value(samples, "harness.checkin.findings", { chat }), 2);
    assert.equal(value(samples, "harness.checkin.findings_by_kind", { kind: "goal_gaps" }), 1);
    assert.equal(value(samples, "harness.plan.open_steps", { chat }), 4);
    assert.equal(value(samples, "harness.plan.items", { chat }), 6);
    assert.equal(value(samples, "harness.plan.done_items", { chat }), 2);
    assert.equal(value(samples, "harness.plan.upkeep_age", { chat }), 3600);
    for (const [reading, n] of Object.entries({ live: 1, stale: 1, unmeasured: 0, no_target: 1 })) assert.equal(value(samples, "harness.plan.goals", { chat, reading }), n, reading);
    assert.equal(value(samples, "harness.plan.goals_on_target", { chat }), 1);
    assert.equal(value(samples, "harness.chat_system.metric", { key: "stuck_duties" }), 1);
    assert.equal(value(samples, "harness.chat_system.run_age"), 600);
    assert.equal(value(samples, "harness.plan.for_you_open", { chat }), 2);
    assert.equal(value(samples, "harness.plan.for_you_asks", { chat }), 1, "the header dot counts only the agent's asks");
    assert.equal(value(samples, "harness.duties.metric_target", { chat, duty: "Fast loop", metric: "k" }), 0);
    assert.equal(value(samples, "harness.duties.metric_value", { chat, duty: "Daily report", metric: "k" }), 3, "the newest run that is not skipped");
    assert.equal(value(samples, "harness.duties.metric_met", { chat, duty: "Check-in", metric: "stuck_steps" }), 1, "after its job");
    assert.equal(value(samples, "harness.duties.recent_runs", { chat, duty: "Daily report", verdict: "skipped" }), 1);
    assert.equal(value(samples, "harness.duties.recent_runs", { chat, duty: "Daily report", verdict: "missed" }), 1);
    assert.equal(value(samples, "harness.duties.metric_misses", { chat, duty: "Daily report", metric: "k" }), 1);
    assert.equal(value(samples, "harness.duties.metric_stuck", { chat, duty: "Daily report", metric: "k", fix: "none" }), 0);
    assert.equal(value(samples, "harness.duties.stuck_no_fix", { chat }), 0);
    assert.equal(value(samples, "harness.tools_daily.checks", { chat, duty: "Skills and tools" }), 5, "with no saved output the run's own checks_run counts");
    assert.equal(value(samples, "harness.tools_daily.run_age", { chat }), 3600);
    assert.equal(value(samples, "harness.tools_daily.still_failing", { chat }), 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a new run line moves the numbers on the next round, and a rewritten runs file is read whole again", async () => {
  const dir = await home();
  try {
    const runs = join(dir, ".prime/agent/browser-chat/duties", `${CHAT}.runs.jsonl`);
    const state = new Map<string, unknown>();
    await read(ctx(dir, state));
    const line = JSON.stringify({ duty: "d2", at: NOW, trigger: "owner", ms: 1, verdict: "met", metrics: { k: { value: 0, target: 0, op: "<=", met: true } }, summary: "ok" });
    await appendFile(runs, line.slice(0, 20));
    assert.equal(value(await read(ctx(dir, state)), "harness.duties.fleet_green_share"), 0.6, "half a line waits");
    await appendFile(runs, line.slice(20) + "\n");
    assert.equal(value(await read(ctx(dir, state)), "harness.duties.fleet_green_share"), 0.8);
    const kept = (await readFile(runs, "utf8")).split("\n").filter(text => text && !text.includes('"d5"')).join("\n") + "\n";
    await writeFile(runs + ".tmp", kept);
    await rename(runs + ".tmp", runs);
    assert.equal(value(await read(ctx(dir, state)), "harness.duties.fleet_green_share"), 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("readRuns keeps each duty's newest, newest shown and newest measured run", async () => {
  const dir = await home();
  try {
    const tail = await readRuns(join(dir, ".prime/agent/browser-chat/duties", `${CHAT}.runs.jsonl`), undefined, effective);
    const checkIn = tail.duties.get("checkin")!;
    assert.equal(checkIn.newest!.verdict, "skipped");
    assert.equal(checkIn.shown!.at, NOW - 30 * MIN);
    assert.equal(checkIn.measured!.at, NOW - 30 * MIN);
    assert.equal((await readRuns(join(dir, "missing.jsonl"), undefined, effective)).duties.size, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("dueAt follows the schedule and chatNames keeps names apart", () => {
  const slot = (at: string, now: number) => { const d = new Date(now); const [h, m] = at.split(":").map(Number); d.setUTCHours(h!, m!, 0, 0); if (d.getTime() > now) d.setUTCDate(d.getUTCDate() - 1); return d.getTime(); };
  assert.equal(dueAt({ kind: "every", minutes: 30 }, NOW, slot), NOW + 30 * MIN);
  assert.equal(dueAt({ kind: "daily", at: "09:00" }, Date.parse("2026-10-19T08:00:00Z"), slot), Date.parse("2026-10-19T09:00:00Z"));
  assert.equal(dueAt({ kind: "daily", at: "09:00" }, Date.parse("2026-10-19T10:30:00Z"), slot), Date.parse("2026-10-20T09:00:00Z"));
  const names = chatNames(["aaaaaaaa-1", "bbbbbbbb-2", "cccccccc-3"], new Map([["aaaaaaaa-1", { name: "x" }], ["bbbbbbbb-2", { name: "x" }]]));
  assert.deepEqual([...names.values()], ["x (aaaaaaaa)", "x (bbbbbbbb)", "cccccccc"]);
});

test("toolProblems keeps failing and off checks with their newest re-check after the run", () => {
  const output = { flagged: [{ kind: "fail_agent", item: "aside_tabs" }, { kind: "fail_owner", item: "cua_mcp" }, { kind: "off", item: "websearch_query" }, { kind: "passed" }] };
  const rechecks = [
    { at: 5, results: [{ id: "aside_tabs", status: "pass" }] },
    { at: 20, results: [{ id: "aside_tabs", status: "fail" }] },
    { at: 30, results: [{ id: "aside_tabs", status: "pass" }, { id: "cua_mcp", status: "fail" }] },
  ].map(entry => JSON.stringify(entry)).join("\n") + "\nnot json";
  assert.deepEqual(toolProblems(output, rechecks, 10), [
    { id: "aside_tabs", status: "fail", recheck: "pass" }, { id: "cua_mcp", status: "fail", recheck: "fail" }, { id: "websearch_query", status: "off" }]);
  assert.deepEqual(toolProblems(null, "", 0), []);
});

test("three misses with no move are stuck, and a fix counts live only while its step is open", async () => {
  const dir = await home();
  try {
    const runs = join(dir, ".prime/agent/browser-chat/duties", `${CHAT}.runs.jsonl`);
    const miss = (at: number, step: string) => JSON.stringify({ duty: "d1", at, trigger: "schedule", ms: 1, verdict: "missed", summary: "s",
      metrics: { k: { value: 2, target: 0, op: "<=", met: false } }, fixes: { k: { step, job: "fix k", live: true } } }) + "\n";
    await appendFile(runs, miss(NOW - 3 * MIN, "p3") + miss(NOW - 2 * MIN, "p3") + miss(NOW - MIN, "p3"));
    let samples = await read(ctx(dir));
    const at = { chat: "fixture chat", duty: "Fast loop", metric: "k" };
    assert.equal(value(samples, "harness.duties.metric_misses", at), 3);
    assert.equal(value(samples, "harness.duties.metric_stuck", { ...at, fix: "live" }), 1);
    assert.equal(value(samples, "harness.duties.stuck_no_fix", { chat: at.chat }), 0);
    await appendFile(runs, miss(NOW - 30_000, "p4"));
    samples = await read(ctx(dir));
    assert.equal(value(samples, "harness.duties.metric_stuck", { ...at, fix: "none" }), 0, "only the one miss that names the new fix counts (fixMisses)");
    await appendFile(runs, miss(NOW - 20_000, "p4") + miss(NOW - 10_000, "p4"));
    samples = await read(ctx(dir));
    assert.equal(value(samples, "harness.duties.metric_misses", at), 6);
    assert.equal(value(samples, "harness.duties.metric_stuck", { ...at, fix: "none" }), 1, "p4 is done, so it is no fix");
    assert.equal(value(samples, "harness.duties.stuck_no_fix", { chat: at.chat }), 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
