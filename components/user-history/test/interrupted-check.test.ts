// Guards the 10-18 owner report on us-metal02: every page check of interrupted runs aborted at 90 s while the dry run ran back to back.
import assert from "node:assert/strict";
import { test } from "node:test";
import { InterruptedRuns } from "../src/chat-resume.ts";
import type { InterruptedReport } from "../src/shared/interrupted.ts";

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
    Date.now = () => realNow() + 60_000;
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
