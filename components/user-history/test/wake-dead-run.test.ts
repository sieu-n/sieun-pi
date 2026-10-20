// Crawler VP's check-in 10-20 07:45Z: promote run 39323562100 was cancelled on 10-19 at 21:07Z before any job ran. ci-run-status read it as
// "ghost, no result" with jobs [], the wake ticker took only "completed" as final, and about 15 jobs slept on that wake for 10 h while the
// check-in precheck listed them as asleep on it.
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkInPrecheck } from "../src/chat-checkin.ts";
import { deadWakes, parseTrain, withDeadWakes, withWakes } from "../src/checkin-load.ts";
import { ownerState, type JobFact } from "../src/checkin-steps.ts";
import { readRunState, RUN_WAKE_DUE_MS, type Wake, Wakes } from "../src/wakes.ts";

const RUN = 39323562100;
const ENDED = Date.parse("2026-10-19T21:07:11Z");
const NOW = Date.parse("2026-10-20T07:45:00Z");
const GHOST = JSON.stringify({ id: RUN, status: "ghost, no result", conclusion: null, ghost: false, workflow: "promote.yml", headBranch: "sieun/dev",
  url: `https://github.com/sieu-n/auto-sns-agent/actions/runs/${RUN}`, jobs: [] });
const CANCELLED = JSON.stringify({ id: RUN, status: "completed", conclusion: "cancelled", ghost: false, workflow: "promote.yml", headBranch: "sieun/dev",
  url: `https://github.com/sieu-n/auto-sns-agent/actions/runs/${RUN}`, jobs: [] });
const cacheSays = (out: string) => async (command: string): Promise<string> => { assert.equal(command, "ci-run-status"); return out; };

test("a run the CI cache reads as ghost, no result is final, and its wake says why", async () => {
  const state = await readRunState({ kind: "run", run: RUN }, cacheSays(GHOST));
  assert.ok("done" in state && state.done);
  assert.equal(state.conclusion, "no result");
  assert.match(state.why ?? "", /ghost/);
});

test("a cancelled run with no job is final with its conclusion", async () => {
  assert.deepEqual(await readRunState({ kind: "run", run: RUN }, cacheSays(CANCELLED)),
    { done: true, conclusion: "cancelled", url: `https://github.com/sieu-n/auto-sns-agent/actions/runs/${RUN}`, label: "promote.yml on sieun/dev" });
});

test("the ticker wakes every job asleep on a ghost run in one tick, with the reason in the text", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ghost-run-wake-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessions = ["01a1aaaa-0000-7000-8000-000000000001", "01a1aaaa-0000-7000-8000-000000000002"];
  for (const session of sessions) await writeFile(join(dir, `${session}-1.json`), JSON.stringify({ session, on: { kind: "run", run: RUN }, note: "promote", since: ENDED - 600_000 }));
  const sent: { session: string; text: string }[] = [];
  const wakes = new Wakes({ dir, now: () => NOW, log: () => {}, runState: on => readRunState(on, cacheSays(GHOST)),
    deliver: async (session, text) => { sent.push({ session, text }); } });
  assert.equal(await wakes.tick(), 2);
  assert.deepEqual(sent.map(({ session }) => session).sort(), sessions);
  assert.match(sent[0]!.text, /^\[wake\] Run 39323562100 finished: no result \(promote\.yml on sieun\/dev\)\. The CI cache reads it as a ghost/);
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith(".json")), []);
});

const train = (run: Record<string, unknown>, ghost = false) => parseTrain({ fetchedAt: "2026-10-20T07:44:50Z",
  runs: { [RUN]: { run: { id: RUN, name: "promote", path: ".github/workflows/promote.yml", head_branch: "sieun/dev", event: "workflow_dispatch",
    created_at: "2026-10-19T20:57:05Z", updated_at: new Date(ENDED).toISOString(), ...run }, ...ghost ? { ghost: true } : {} } } });
const SESSION = "01a1bbbb-0000-7000-8000-000000000001";
const wake: Wake = { session: SESSION, on: { kind: "run", run: RUN }, note: "", since: ENDED - 600_000 };
const idle: JobFact = { key: "sub-promote-watch", name: "promote watch", state: "ended", sessionId: SESSION };

test("a wake on a run the cache reads as ended is a dead wait once a ticking service would have sent it", () => {
  const done = train({ status: "completed", conclusion: "cancelled" });
  assert.deepEqual(deadWakes([wake], done, NOW).dead, [{ wake, why: "run 39323562100 ended cancelled at 21:07Z" }]);
  assert.deepEqual(deadWakes([wake], done, ENDED + RUN_WAKE_DUE_MS).live, [wake]);
  assert.deepEqual(deadWakes([wake], train({ status: "queued", conclusion: null }), NOW).live, [wake]);
  assert.equal(deadWakes([wake], train({ status: "queued", conclusion: null }, true), NOW).dead[0]?.why, "run 39323562100 ended as a ghost with no result at 21:07Z");
  assert.deepEqual(deadWakes([{ ...wake, on: { kind: "run", run: RUN, repo: "sieu-n/slack-green" } }], done, NOW).dead, []);
});

test("the check-in precheck flags a job asleep only on a dead wait, and counts it idle", () => {
  const { live, dead } = deadWakes([wake], train({ status: "completed", conclusion: "cancelled" }), NOW);
  const facts = withDeadWakes(withWakes([idle], live, () => undefined), dead, () => undefined);
  assert.equal(facts[0]!.state, "ended");
  assert.equal(ownerState(facts[0]!), "idle, asleep on a dead wait: a board.wake on run 39323562100, but run 39323562100 ended cancelled at 21:07Z");
  const notes = checkInPrecheck(undefined, facts, null, NOW).facts;
  assert.deepEqual(notes, ["job promote watch is a dead wait: it sleeps on a board.wake on run 39323562100, but run 39323562100 ended cancelled at 21:07Z, " +
    "and the wake never went out. Tell it the run's result now so it acts on it"]);
  const working = withDeadWakes([{ ...idle, state: "working" }], dead, () => undefined);
  assert.equal(working[0]!.deadWake, undefined);
});
