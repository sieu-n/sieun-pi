// Guards the 10-18 owner report on us-metal02: every page check of interrupted runs aborted at 90 s while the dry run ran back to back.
import assert from "node:assert/strict";
import { test } from "node:test";
import { JOB_CLEANUP_EVERY_MS } from "../src/chat-checkin.ts";
import { InterruptedRuns } from "../src/chat-resume.ts";
import type { InterruptedReport, InterruptedRun } from "../src/shared/interrupted.ts";

/**
 * On 10-18 the resume script's dry run took 45 to 58 s on us-metal02. Each page check older than 15 s queued one more run behind the last,
 * so the server ran the script without a break and every GET api/interrupted the Aside tab sent (45 in 6 min) aborted at 90 s.
 */
const report = (checked: string): InterruptedReport => ({ paused: [], heads: [], checked_at: checked });
const tick = () => new Promise(resolve => setImmediate(resolve));

function gated() {
  const calls: string[][] = [];
  const gates: Array<(value: InterruptedReport) => void> = [];
  const runs = new InterruptedRuns(args => { calls.push([...args]); return new Promise(resolve => { gates.push(resolve); }); });
  return { runs, calls, gates };
}

test("checks that land during a slow dry run share it and answer at once, and later checks answer with the last report", async () => {
  const { runs, calls, gates } = gated();
  // Before the first run ends a check holds no request open: on 10-18 each page load waited 90 to 120 s on it.
  for (const each of await Promise.all([runs.check(), runs.check(), runs.check()])) assert.deepEqual(each, report(""));
  await tick();
  assert.equal(calls.length, 1);
  gates[0]!(report("1"));
  await tick();
  assert.equal((await runs.check()).checked_at, "1");

  const realNow = Date.now;
  try {
    // A tab checks each minute; on 10-23 each check ran a 20 s CPU dry run. The report stays good until the job sweep's next pass is overdue.
    Date.now = () => realNow() + 60_000;
    assert.equal((await runs.check()).checked_at, "1");
    await tick();
    assert.equal(calls.length, 1);
    Date.now = () => realNow() + JOB_CLEANUP_EVERY_MS + 90_000;
    assert.equal((await runs.check()).checked_at, "1");
    assert.equal((await runs.check()).checked_at, "1");
    await tick();
    assert.equal(calls.length, 2);
    gates[1]!(report("2"));
    await tick();
    assert.equal((await runs.check()).checked_at, "2");
    assert.equal(calls.length, 2);
  } finally { Date.now = realNow; }
});

test("a check after a resume never answers the report from before it, and the next check gets a run that started after it", async () => {
  const { runs, calls, gates } = gated();
  const before = runs.check();
  await tick();
  gates[0]!(report("1"));
  await before;
  const resumed = runs.resume(async () => {}, async () => {});
  assert.equal((await runs.check()).checked_at, "", "the report from before the resume is gone");
  await tick();
  gates[1]!(report("plan"));
  await tick();
  gates[2]!(report("resumed"));
  await resumed;
  await tick();
  gates[3]!(report("3"));
  await tick();
  assert.equal((await runs.check()).checked_at, "3");
  assert.deepEqual(calls, [["--dry-run"], ["--dry-run"], [], ["--dry-run"]]);
});

test("a job sweep pass gives the page its report, so a tab's checks run no dry run of their own", async () => {
  const run = (id: string, reason: InterruptedRun["reason"]): InterruptedRun => ({ id, name: id, reason, session_id: id, error: "x", errored_at: "t", head: "h", head_session_id: "h" });
  const planned: InterruptedReport = { paused: [run("job", "error"), run("other", "cut_off")], heads: [], checked_at: "sweep",
    unowed: [{ id: "old", name: "old", session_id: "old", head: "h", head_session_id: "h", cut: "error", cut_error: "429", cut_at: "t" }] };
  const sent: InterruptedReport = { paused: [], heads: [], checked_at: "sent", children: [{ id: "job", name: "job", head: "h", result: { deliveryStatus: "sent" } }] };
  const calls: string[][] = [];
  const runs = new InterruptedRuns(async args => { calls.push([...args]); return args.includes("--dry-run") ? planned : sent; });
  await runs.resumeJobs(each => each.session_id === "job", async () => {});
  await tick();
  const shown = await runs.check();
  assert.equal(shown.checked_at, "sweep");
  assert.deepEqual(shown.paused.map(each => [each.id, each.reason, each.error]), [["other", "cut_off", "x"], ["old", "error", "429"]],
    "the job the pass continued is gone, and a cut run --owed left alone still shows");
  await tick();
  assert.equal(calls.filter(args => args.length === 1 && args[0] === "--dry-run").length, 0);
});
