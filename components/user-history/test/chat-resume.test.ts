import assert from "node:assert/strict";
import { test } from "node:test";
import { InterruptedRuns } from "../src/chat-resume.ts";
import type { InterruptedReport, InterruptedRun } from "../src/shared/interrupted.ts";

const run = (id: string, reason: InterruptedRun["reason"], head: string): InterruptedRun =>
  ({ id, name: id, reason, session_id: `full-${id}`, error: "x", errored_at: "2026-10-12T08:51:43Z", head, head_session_id: `full-${head}` });

/**
 * 10-12: a Prime worker died and left its head and 22 children reading "working". Resume aborted each child, and every abort and the head's
 * message failed with "Session worker is failed", so the 22 came back on the next check. Resume now reopens the head of a dead worker once.
 */
test("Resume reopens each dead worker's head once and aborts only hung runs", async () => {
  const planned: InterruptedReport = { paused: [run("head1", "worker_failed", "head1"), run("kid1", "worker_failed", "head1"), run("kid2", "worker_failed", "head1"),
    run("stuck", "hung", "other")], heads: [], checked_at: "now" };
  const calls: string[][] = [];
  const runs = new InterruptedRuns(async args => { calls.push([...args]); return planned; });
  const aborted: string[] = [];
  const reopened: string[] = [];
  await runs.resume(async id => { aborted.push(id); }, async id => { reopened.push(id); });
  assert.deepEqual(reopened, ["full-head1"]);
  assert.deepEqual(aborted, ["full-stuck"]);
  assert.deepEqual(calls, [["--dry-run"], ["--unstuck", "full-stuck"]]);
});
