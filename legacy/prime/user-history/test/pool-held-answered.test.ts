// Guards the 10-23 01:01Z loop: census writer lag (01a165b1) was held with no pool time on a token hook failure while poolAdmits read its tree
// as admitted, so every chat tick started a dry run and a send pass of resume_paused.py, and every send pass held it again.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PoolHeldJobs } from "../src/chat-resume.ts";
import type { PoolHeldRun } from "../src/shared/interrupted.ts";

const session = "01a165b1-d156-7374-a2c1-0426ae5a97cd";
const run = (fields: Partial<PoolHeldRun> = {}): PoolHeldRun => ({ id: session, name: "census writer lag", session_id: session, head: session,
  head_session_id: session, tree: session, provider: "anthropic", errored_at: "2026-10-23T00:48:16.535Z",
  held_by: "the token hook gave no anthropic token (exit 1)", pool_at: null, ...fields });
const now = Date.parse("2026-10-23T01:02:00Z");

test("a held run whose pass held it again on the same answer starts no pass of its own until the answer changes", async () => {
  const jobs = new PoolHeldJobs(async () => true);
  await jobs.set([run()]);
  assert.deepEqual((await jobs.admitted(now)).map(held => held.session_id), [session], "the first tick at its pool time starts a pass");
  await jobs.set([run()]);
  assert.deepEqual(await jobs.admitted(now + 30_000), [], "the pass held it on the same answer, so the next tick starts none");
  await jobs.set([run()]);
  assert.deepEqual(await jobs.admitted(now + 600_000), [], "the sweep's own pass held it on the same answer too");
  assert.deepEqual([...jobs.sessions()], [session], "it still reads as held for the duty runner");
  await jobs.set([run({ pool_at: "2026-10-23T01:20:00+00:00", held_by: "pi-pool gave this session a slot at 2026-10-23T01:20:00+00:00" })]);
  assert.deepEqual(await jobs.admitted(now + 600_000), [], "a new pool time in the future waits for it");
  assert.deepEqual((await jobs.admitted(Date.parse("2026-10-23T01:20:00Z"))).map(held => held.session_id), [session], "a changed answer starts a pass at its time");
});

test("a held run the sweep's pass lists, not one admitted released, still starts a pass at its pool time", async () => {
  const jobs = new PoolHeldJobs(async () => true);
  await jobs.set([run()]);
  await jobs.set([run()]);
  assert.deepEqual((await jobs.admitted(now)).map(held => held.session_id), [session]);
});

test("a held run that only moved in pi-pool's queue gave the same answer, so it starts no pass of its own", async () => {
  const queued = (place: number) => run({ errored_at: "2026-10-23T08:36:57.342Z", held_by: `queued in pi-pool for a working slot, place ${place} of 107` });
  const jobs = new PoolHeldJobs(async () => true);
  await jobs.set([queued(7)]);
  assert.equal((await jobs.admitted(now)).length, 1);
  await jobs.set([queued(4)]);
  assert.deepEqual(await jobs.admitted(now + 30_000), [], "on 10-23 the moved place read as a new answer, and the sweep ran 16 passes in 10 min");
});
