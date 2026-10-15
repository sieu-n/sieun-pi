import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { NO_MISSES } from "../src/chat-checkin.ts";
import { CHECK_IN_DUTY, type DutyMetric, dutyShapeProblem, judge, MAX_DUTY_METRICS, parseDutyInput, type PrecheckOutput, shapeNote, verdictMetrics } from "../src/shared/chat-duties.ts";

/** Three duties as stored on 10-15 and the saved precheck output of each one's latest run. */
type Slice = { chat: string; duty: { name: string; metrics: DutyMetric[] }; output: PrecheckOutput; recordedVerdict: string };
const fixture = JSON.parse(await readFile(join(import.meta.dirname, "fixtures", "duty-shape-1015.json"), "utf8")) as Record<"chatSystem" | "crawlerPipeline" | "ciSystem", Slice>;
const definition = (metrics: unknown[]) => ({ name: "Chat system", ownerWords: "keep it healthy", goal: "Chats never sit stopped.", onMiss: "Fix what missed.",
  metrics, schedule: { kind: "daily", at: "07:00" }, precheck: { command: ["node", "-e", "0"], cwd: tmpdir() } });
const metric = (key: string, headline = false) => ({ key, label: `Count of ${key.replace(/_/g, " ")}`, op: "<=", target: 0, ...(headline ? { headline: true } : {}) });
const FIX = 'Fix it: keep the one number the owner would ask about as the headline ("headline": true), keep up to 3 supporting numbers he can read, ' +
  "and leave the rest in the precheck output, where the run detail shows them.";

test("a stored 38-metric duty (Chat system, 10-15) is judged on its headline plus the next 3 metrics, and its summary asks for a rework", () => {
  const { duty, output, recordedVerdict } = fixture.chatSystem;
  assert.equal(duty.metrics.length, 38);
  assert.equal(recordedVerdict, "missed");
  const counted = verdictMetrics(duty.metrics).map(entry => entry.key);
  assert.deepEqual(counted, ["end_state_pct", "stuck_steps", "corrections", "repeat_corrections"]);
  const judged = judge(duty.metrics, output);
  assert.equal(judged.verdict, "missed");
  assert.deepEqual(Object.keys(judged.metrics), counted, "the other 34 numbers stay in the precheck output");
  assert.equal(judged.summary, "end_state_pct 69.1% (target at least 100%), stuck_steps 55 (target at most 0), corrections 3 (target at most 1), " +
    "repeat_corrections 1 (target at most 0); this duty is over the shape limit (38 metrics, 1 headline), so the verdict counts only end_state_pct, " +
    "stuck_steps, corrections, repeat_corrections; tell the chat to rework it with scripts/duties/add.ts: keep the one number the owner would ask about " +
    'as the headline ("headline": true), keep up to 3 supporting numbers he can read, and leave the rest in the precheck output, where the run detail shows them');
  const onTarget = judge(duty.metrics, { metrics: { ...output.metrics, end_state_pct: 100, stuck_steps: 0, corrections: 1, repeat_corrections: 0 } });
  assert.equal(onTarget.verdict, "met", "off_brief 15 and blocked_on_others 13 still miss in the output, and the verdict is met");
  assert.match(onTarget.summary, /^end_state_pct 100% \(on target\); all 4 on target; this duty is over the shape limit/);
  assert.throws(() => parseDutyInput(definition(duty.metrics), "d1", 0), new Error(`metrics: a duty has one headline metric and at most 3 supporting ones; this one has 38 metrics, over the limit of 4. ${FIX}`));
});

test("a stored duty with no headline (Crawler pipeline, 11 metrics) is judged on its first 4 metrics in file order", () => {
  const { duty, output } = fixture.crawlerPipeline;
  assert.deepEqual(verdictMetrics(duty.metrics).map(entry => entry.key), duty.metrics.slice(0, 4).map(entry => entry.key));
  const judged = judge(duty.metrics, output);
  assert.deepEqual(Object.keys(judged.metrics), duty.metrics.slice(0, 4).map(entry => entry.key));
  assert.match(judged.summary, /; this duty is over the shape limit \(11 metrics, 0 headlines\), so the verdict counts only ig_reads_per_s, /);
  assert.match(shapeNote(duty.metrics)!, /rework it with scripts\/duties\/add\.ts/);
  const missing = { ...output.metrics };
  delete missing.paused_minutes;
  assert.notEqual(judge(duty.metrics, { metrics: missing }).verdict, "error", "a number outside the counted 4 may be absent");
});

test("a reshaped duty (CI system, 10-15) is judged on its headline and 3 supporting metrics; the other numbers its precheck reports never flip it", () => {
  const { duty, output } = fixture.ciSystem;
  assert.equal(dutyShapeProblem(duty.metrics), null);
  assert.equal(shapeNote(duty.metrics), null);
  const live = judge(duty.metrics, output);
  assert.equal(live.verdict, "missed");
  assert.equal(live.summary, "verify_dev_p90_min 110.4 min (target at most 10 min), queue_heavy_p90_min 125.5 min (target at most 10 min), " +
    "queue_light_p90_min 89.1 min (target at most 10 min), land_success_pct 28.6% (target at least 80%)");
  // promote_success_pct 20, land_p50_min 126.9 and health_run_ok 0 are far off any target and are no metric of the duty.
  const green = judge(duty.metrics, { metrics: { ...output.metrics, verify_dev_p90_min: 8, queue_heavy_p90_min: 9, queue_light_p90_min: 4, land_success_pct: 85 } });
  assert.deepEqual([green.verdict, green.summary], ["met", "verify_dev_p90_min 8 min (on target); all 4 on target"]);
  assert.deepEqual(Object.keys(green.metrics), duty.metrics.map(entry => entry.key));
  assert.equal(parseDutyInput(definition(duty.metrics), "d1", 0).metrics.length, 4);
});

test("parseDutyInput refuses 5 metrics, no headline and two headlines, with what to do; one metric is its own headline", () => {
  assert.equal(MAX_DUTY_METRICS, 4);
  const five = [metric("a_count", true), metric("b_count"), metric("c_count"), metric("d_count"), metric("e_count")];
  assert.throws(() => parseDutyInput(definition(five), "d1", 0),
    new Error(`metrics: a duty has one headline metric and at most 3 supporting ones; this one has 5 metrics, over the limit of 4. ${FIX}`));
  assert.throws(() => parseDutyInput(definition([metric("a_count"), metric("b_count")]), "d1", 0),
    new Error(`metrics: a duty has one headline metric and at most 3 supporting ones; this one has no headline metric. ${FIX}`));
  assert.throws(() => parseDutyInput(definition([metric("a_count", true), metric("b_count", true)]), "d1", 0),
    new Error(`metrics: a duty has one headline metric and at most 3 supporting ones; this one has 2 headlines, a_count and b_count. ${FIX}`));
  assert.throws(() => parseDutyInput(definition([]), "d1", 0), /^Error: metrics: 1 to 4, one of them the headline\.$/);
  assert.deepEqual(parseDutyInput(definition([metric("a_count")]), "d1", 0).metrics, [{ ...metric("a_count"), headline: true }]);
  assert.equal(parseDutyInput(definition(five.slice(0, 4)), "d1", 0).metrics.length, 4);
});

test("add.ts prints the shape refusal for the chat and exits 1, leaving the chat's duties as they were", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-shape-"));
  const file = join(dir, "wide.duty.json");
  await writeFile(file, JSON.stringify(definition([metric("a_count", true), metric("b_count"), metric("c_count"), metric("d_count"), metric("e_count")])));
  const result = await promisify(execFile)(process.execPath, ["--import", "tsx", join(import.meta.dirname, "..", "scripts", "duties", "add.ts"), "chat1", file, "--data-dir", dir],
    { cwd: join(import.meta.dirname, "..") }).then(() => null, (error: { code: number; stderr: string }) => error);
  assert.equal(result?.code, 1);
  assert.equal(result.stderr, `refused ${file}: metrics: a duty has one headline metric and at most 3 supporting ones; this one has 5 metrics, over the limit of 4. ${FIX}\n`);
  assert.equal(await readFile(join(dir, "duties", "chat1.json"), "utf8").catch(() => "absent"), "absent");
});

test("the check-in duty has one headline, goal_gaps, and 3 supporting metrics, stuck_steps first; its other counts stay in the measure output", () => {
  assert.equal(dutyShapeProblem(CHECK_IN_DUTY.metrics), null);
  assert.deepEqual(CHECK_IN_DUTY.metrics.map(entry => [entry.key, entry.headline ?? false]),
    [["goal_gaps", true], ["stuck_steps", false], ["finished_open", false], ["stalled_steps", false]]);
  for (const entry of CHECK_IN_DUTY.metrics) assert.ok(entry.key in NO_MISSES, entry.key);
  // 10-15 in AI harness: loose_goals counted as a miss after the run gave p447 a step; a count like it now lives in the findings only.
  const judged = judge(CHECK_IN_DUTY.metrics, { metrics: { ...NO_MISSES, loose_goals: 1, blocked_on_others: 3 } });
  assert.deepEqual([judged.verdict, judged.summary], ["met", "goal_gaps 0 (on target); all 4 on target"]);
  assert.equal(judge(CHECK_IN_DUTY.metrics, { metrics: { ...NO_MISSES, stalled_steps: 2 } }).summary, "goal_gaps 0 (on target), stalled_steps 2 (target at most 0)");
});
