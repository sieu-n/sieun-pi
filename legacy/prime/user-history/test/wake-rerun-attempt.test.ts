// Promote 17, run 39493311906 on 10-21: attempt 1 was cancelled at 23:16:09Z on 10-20, and the release owner reran its failed jobs, so attempt 2
// started at 01:02:37Z (failed 01:03:59Z) and attempt 3 at 01:04:12Z. Wakes set on the run fired as "cancelled" at 01:00:43Z and 01:02:43Z: the
// first read attempt 1 before any rerun, the second read the CI cache 6 s after attempt 2 started, before the next 30 s poll saw it.
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deadWakes, parseTrain } from "../src/checkin-load.ts";
import { CI_CACHE_REPO, parseWake, pendingWakes, readRunState, REAL_GH, RERUN_GAP_MS, RUN_WAKE_DUE_MS, type RunState, type Wake, Wakes, wakeText } from "../src/wakes.ts";

const RUN = 39493311906;
const URL = `https://github.com/${CI_CACHE_REPO}/actions/runs/${RUN}`;
const NOW = Date.parse("2026-10-21T01:02:43Z");
const cache = (status: string, conclusion: string | null, attempt: number) =>
  JSON.stringify({ id: RUN, status, conclusion, ghost: false, attempt, workflow: "promote.yml", headBranch: "sieun/dev", url: URL, jobs: [] });
const github = (status: string, conclusion: string, attempt: number) =>
  JSON.stringify({ status, conclusion, attempt, url: URL, workflowName: "promote", headBranch: "sieun/dev" });

/** ci-run-status answers `cached`, the real gh answers `live`; `asked` collects the commands. */
function reads(asked: string[], cached: () => string, live: () => string) {
  return async (command: string, args: string[]): Promise<string> => {
    asked.push(command);
    if (command === "ci-run-status") return cached();
    assert.equal(command, REAL_GH);
    assert.equal(args[args.indexOf("--repo") + 1], CI_CACHE_REPO);
    assert.match(args[args.indexOf("--json") + 1]!, /\battempt\b/);
    return live();
  };
}

test("a run the cache still reads as attempt 1 cancelled while GitHub runs attempt 3 keeps waiting", async () => {
  const asked: string[] = [];
  const state = await readRunState({ kind: "run", run: RUN }, reads(asked, () => cache("completed", "cancelled", 1), () => github("in_progress", "", 3)));
  assert.deepEqual(state, { done: false });
  assert.deepEqual(asked, ["ci-run-status", REAL_GH]);
});

test("a finished run reads its latest attempt from GitHub before it counts as done", async () => {
  const asked: string[] = [];
  const state = await readRunState({ kind: "run", run: RUN }, reads(asked, () => cache("completed", "cancelled", 1), () => github("completed", "success", 3)));
  assert.deepEqual(state, { done: true, conclusion: "success", attempt: 3, url: URL, label: "promote on sieun/dev" });
  const running: string[] = [];
  assert.deepEqual(await readRunState({ kind: "run", run: RUN }, reads(running, () => cache("in_progress", null, 3), () => { throw new Error("not read"); })), { done: false });
  assert.deepEqual(running, ["ci-run-status"]);
});

test("a wake set with attempt=2 waits through attempt 1's cancel and goes out when a later attempt finishes, naming it", async t => {
  const dir = await mkdtemp(join(tmpdir(), "rerun-wake-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const session = "01a1cccc-0000-7000-8000-000000000001";
  await writeFile(join(dir, `${session}-run-${RUN}.json`), JSON.stringify({ session, on: { kind: "run", run: RUN, attempt: 2 }, note: "promote 17 readback", since: NOW - 120_000 }));
  let now = NOW;
  let state: RunState = { done: true, conclusion: "cancelled", attempt: 1, url: URL, label: "promote on sieun/dev" };
  const sent: string[] = [];
  const wakes = new Wakes({ dir, now: () => now, log: () => {}, runState: async () => state, deliver: async (_session, text) => { sent.push(text); } });
  assert.equal(await wakes.tick(), 0);
  state = { done: false };
  now += 3 * 60_000;
  assert.equal(await wakes.tick(), 0);
  state = { done: true, conclusion: "success", attempt: 3, url: URL, label: "promote on sieun/dev" };
  now += 3 * 60_000;
  assert.equal(await wakes.tick(), 1);
  assert.match(sent[0]!, /^\[wake\] Run 39493311906 finished: success \(attempt 3, promote on sieun\/dev\)\./);
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith(".json")), []);
});

test("a wake's text names the attempt and how to wait for a rerun, and parseWake keeps the attempt", () => {
  const wake = parseWake({ session: "01a1cccc-0000-7000-8000-000000000002", on: { kind: "run", run: RUN, attempt: 2 }, note: "", since: NOW });
  assert.deepEqual(wake?.on, { kind: "run", run: RUN, attempt: 2 });
  assert.deepEqual(parseWake({ session: "01a1cccc-0000-7000-8000-000000000002", on: { kind: "run", run: RUN, attempt: 0 }, note: "", since: NOW })?.on, { kind: "run", run: RUN });
  const text = wakeText({ ...wake!, on: { kind: "run", run: RUN } }, { done: true, conclusion: "cancelled", attempt: 1, url: URL, label: "promote on sieun/dev" }, NOW);
  assert.match(text, /finished: cancelled \(attempt 1, promote on sieun\/dev\)\./);
  assert.match(text, /board\.wake\(run=39493311906, attempt=2\)/);
});

test("the check-in counts a wake for a later attempt of an ended run as live", () => {
  const ended = Date.parse("2026-10-20T23:16:09Z");
  const train = parseTrain({ fetchedAt: "2026-10-21T01:00:30Z", runs: { [RUN]: { run: { id: RUN, name: "promote", path: ".github/workflows/promote.yml",
    head_branch: "sieun/dev", event: "workflow_dispatch", status: "completed", conclusion: "cancelled", run_attempt: 1,
    created_at: "2026-10-20T20:35:43Z", updated_at: new Date(ended).toISOString() } } } });
  const now = ended + RUN_WAKE_DUE_MS + 60_000;
  const later: Wake = { session: "01a1cccc-0000-7000-8000-000000000003", on: { kind: "run", run: RUN, attempt: 2 }, note: "", since: now };
  const any: Wake = { ...later, on: { kind: "run", run: RUN } };
  const { live, dead } = deadWakes([later, any], train, now);
  assert.deepEqual(live, [later]);
  assert.deepEqual(dead.map(({ wake }) => wake), [any]);
});

// Promote 18, run 39574490195: attempt 1 failed at 09:48:25Z on 10-21 and was never rerun, and on 10-24 seven wakes still waited for attempt 2.
test("a wake for attempt 2 of a run that ended at attempt 1 goes out once no rerun started for RERUN_GAP_MS, and is no longer pending", async t => {
  const dir = await mkdtemp(join(tmpdir(), "rerun-missed-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = 39574490195;
  const ended = Date.parse("2026-10-21T09:48:25Z");
  const session = "01a1cccc-0000-7000-8000-000000000004";
  await writeFile(join(dir, `${session}-run-${run}.json`), JSON.stringify({ session, on: { kind: "run", run, attempt: 2 }, note: "promote 18 attempt 2", since: ended + 60_000 }));
  let now = ended + 106 * 60_000;
  const state: RunState = { done: true, conclusion: "failure", attempt: 1, endedAt: ended, url: URL, label: "promote on sieun/dev" };
  const sent: { session: string; text: string }[] = [];
  const wakes = new Wakes({ dir, now: () => now, log: () => {}, runState: async () => state, deliver: async (to, text) => { sent.push({ session: to, text }); } });
  assert.equal(await wakes.tick(), 0);
  assert.equal((await pendingWakes(dir, now)).length, 1);
  now = ended + RERUN_GAP_MS + RUN_WAKE_DUE_MS;
  assert.equal(await wakes.tick(), 1);
  assert.equal(sent[0]?.session, session);
  assert.match(sent[0]!.text, /^\[wake\] Run 39574490195: you waited for attempt 2, but the rerun never started\. Attempt 1 ended failure at 2026-10-21T09:48Z/);
  assert.match(sent[0]!.text, /Your note: promote 18 attempt 2$/);
  assert.deepEqual(await pendingWakes(dir, now), []);
});

test("a finished run's state carries when it ended, from GitHub's updatedAt", async () => {
  const live = () => JSON.stringify({ status: "completed", conclusion: "failure", attempt: 1, url: URL, workflowName: "promote", headBranch: "sieun/dev", updatedAt: "2026-10-21T09:48:25Z" });
  const state = await readRunState({ kind: "run", run: RUN }, reads([], () => cache("completed", "failure", 1), live));
  assert.deepEqual(state, { done: true, conclusion: "failure", attempt: 1, endedAt: Date.parse("2026-10-21T09:48:25Z"), url: URL, label: "promote on sieun/dev" });
});

test("the check-in counts a wake for a later attempt as dead once the rerun gap and the send delay passed", () => {
  const ended = Date.parse("2026-10-21T09:48:25Z");
  const train = parseTrain({ fetchedAt: "2026-10-24T04:30:00Z", runs: { [RUN]: { run: { id: RUN, name: "promote", path: ".github/workflows/promote.yml",
    head_branch: "sieun/dev", event: "workflow_dispatch", status: "completed", conclusion: "failure", run_attempt: 1,
    created_at: "2026-10-21T09:07:18Z", updated_at: new Date(ended).toISOString() } } } });
  const later: Wake = { session: "01a1cccc-0000-7000-8000-000000000005", on: { kind: "run", run: RUN, attempt: 2 }, note: "", since: ended };
  assert.deepEqual(deadWakes([later], train, ended + RERUN_GAP_MS).live, [later]);
  assert.deepEqual(deadWakes([later], train, ended + RERUN_GAP_MS + RUN_WAKE_DUE_MS + 1).dead,
    [{ wake: later, why: "run 39493311906 ended failure at 09:48Z and its rerun never started" }]);
});
