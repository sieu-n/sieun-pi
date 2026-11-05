// 11-05: crawler ops train dispatched metal-deploy run 42049999160 at 14:57Z, and pi-pool parked it on its provider quota until 17:02:30Z before
// its next step set the wake. The run failed at 15:00:03Z, the session set board.wake(run=42049999160) at 17:02:07Z, and the ticker sent it at
// 17:02:39Z. The wake named no time, so the job, CI and the AI harness VP read it as a wake that came 2 h late.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type RunState, Wakes, wakeText } from "../src/wakes.ts";

const RUN = 42049999160;
const URL = `https://github.com/sieu-n/auto-sns-agent/actions/runs/${RUN}`;
const ENDED = Date.parse("2026-11-05T15:00:03Z");
const SET = Date.parse("2026-11-05T17:02:07Z");
const TICK = Date.parse("2026-11-05T17:02:39Z");
const FAILED: RunState = { done: true, conclusion: "failure", attempt: 1, endedAt: ENDED, url: URL, label: "metal-deploy on staging" };

test("a wake set after its run ended says when the run ended and how long before the wake was set", async t => {
  const dir = await mkdtemp(join(tmpdir(), "wake-ended-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const session = "01a15984-a584-7668-aaec-d5a67c824796";
  await writeFile(join(dir, `${session}-run-${RUN}.json`), JSON.stringify({ session, on: { kind: "run", run: RUN }, note: "D1525", since: SET }));
  const sent: string[] = [];
  const wakes = new Wakes({ dir, now: () => TICK, log: () => {}, runState: async () => FAILED, deliver: async (_session, text) => { sent.push(text); } });
  assert.equal(await wakes.tick(), 1);
  assert.match(sent[0]!, /^\[wake\] Run 42049999160 finished: failure \(attempt 1, metal-deploy on staging\)\. /);
  assert.match(sent[0]!, /It ended at 2026-11-05T15:00:03Z, 122 min before you set this wake at 2026-11-05T17:02:07Z\. /);
});

test("a wake set before its run ended names only the end time", () => {
  const text = wakeText({ session: "01a15984-a584-7668-aaec-d5a67c824796", on: { kind: "run", run: RUN }, note: "", since: Date.parse("2026-11-05T14:57:10Z") }, FAILED, ENDED + 30_000);
  assert.match(text, /It ended at 2026-11-05T15:00:03Z\. https:/);
  assert.doesNotMatch(text, /before you set/);
});

test("a run read with no end time keeps the old text", () => {
  const { endedAt: _, ...noEnd } = FAILED as Extract<RunState, { done: true }>;
  const text = wakeText({ session: "01a15984-a584-7668-aaec-d5a67c824796", on: { kind: "run", run: RUN }, note: "", since: SET }, noEnd, TICK);
  assert.doesNotMatch(text, /It ended/);
});
