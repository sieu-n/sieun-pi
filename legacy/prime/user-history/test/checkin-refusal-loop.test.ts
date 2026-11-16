// Prospect feature bro 11-16: "watchlist collabs throughput 11-16" (01a1e481) refused every turn from 13:24:51Z, because its history replayed one
// 65 KB tool result. The check-in restarted it after a refusal at 13:46Z, and its later turns up to 18:11Z refused the same way. A job gets one
// restart after a refusal; when its turn refuses again, the check-in sends it nothing and tells the chat once.
import assert from "node:assert/strict";
import { test } from "node:test";
import { jobPushes, jobPushLine } from "../src/checkin-jobs.ts";
import type { JobFact, StepView } from "../src/checkin-steps.ts";

const everyMs = 15 * 60_000;
const start = Date.parse("2026-11-16T13:46:00Z");
const refusal = "Model refused to respond (refusal): reasoning_extraction: This request was blocked as it seems to violate Anthropic's Terms";
const job: JobFact = { key: "thread:01a1e481-1ee7-7598-adfa-ff15fa0156a5", name: "watchlist collabs throughput 11-16", state: "failed", error: refusal,
  sessionId: "01a1e481-1ee7-7598-adfa-ff15fa0156a5" };
const step = { item: { id: "p1", text: "collab rows for the watchlist", status: "doing" }, owner: job } as unknown as StepView;
const run = (facts: JobFact[], memos: Parameters<typeof jobPushes>[2], at: number) => jobPushes(facts, [step], memos, everyMs, at, () => true, () => 0);

test("a job that refused again after its restart gets no second restart and shows up once in the chat line", () => {
  const first = run([job], undefined, start);
  assert.equal(first.pushes[0]?.act, "restart");
  const second = run([job], first.memos, start + everyMs);
  assert.deepEqual(second.pushes.map(push => push.act), ["refusing"]);
  const line = jobPushLine(second.pushes) ?? "";
  assert.match(line, /watchlist collabs throughput 11-16 thread \(01a1e481-1ee7-7598-adfa-ff15fa0156a5\) ended its last turn in a model refusal again/);
  assert.doesNotMatch(line, /restarted/);
  let memos = second.memos;
  for (const n of [2, 3, 6]) {
    const next = run([job], memos, start + n * everyMs);
    assert.deepEqual(next.pushes, [], `check-in ${n}`);
    memos = next.memos;
  }
});

test("a refusal after the job answered again gets its one restart again", () => {
  const first = run([job], undefined, start);
  const answered = run([{ key: job.key, name: job.name, state: "ended" }], first.memos, start + everyMs);
  assert.equal(answered.memos[job.key]?.refused, undefined);
  assert.equal(run([job], answered.memos, start + 3 * everyMs).pushes[0]?.act, "restart");
});

test("a job that failed on another error is restarted each interval as before", () => {
  const socket = { ...job, error: "socket hang up" };
  const first = run([socket], undefined, start);
  const second = run([socket], first.memos, start + everyMs);
  assert.deepEqual([first.pushes[0]?.act, second.pushes[0]?.act], ["restart", "restart"]);
});
