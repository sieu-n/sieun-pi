import assert from "node:assert/strict";
import { test } from "node:test";
import { looksDone } from "../src/checkin-done.ts";
import type { PlanItem } from "../src/shared/types.ts";

/*
 * frontend bro 10-13: the 00:29 and 00:44 check-ins flagged p92 "looks done: its note says "merged"", the 00:44 one on release-8817cb0.
 * The notes below are p92's own board notes from 00:44 on. Each says the item is not done, and its "merged" means 5 parts were merged
 * into one version on 5180, not a PR merged or a land.
 */
const p92 = (note: string): PlanItem => ({ id: "p92", status: "doing", children: [], job: "connections from scratch", note,
  text: "Connections from the shipped screen: delete every old version, then polish the shipped Connections screen part by part" });

test("looks done: a note that says it is not done wins over a ship word, and parts merged into one version is no ship (frontend bro 10-13, p92)", () => {
  assert.equal(looksDone(p92("Not done yet. All 5 parts are merged into one version that scores 70 of 82, but Staging still has Connections on " +
    "shipped and no browser has walked it. Next the job fixes what it can of the last 12 points, runs the browser check when load drops under 20, " +
    "puts it on Staging and walks the flow there.")), null, "the note at the 00:44 run, under p102");
  assert.equal(looksDone(p92("Not done. The 5 parts are merged into one Staging version that scores 70 of 82, but Staging still has Connections on " +
    "shipped and no browser walk has passed. The browser checks run now with no load gate, the merged version last after the polish pass. Then it " +
    "goes on Staging and the flow is walked there.")), null, "the next note, under p103");
  assert.equal(looksDone(p92("The 5 parts are merged into one Staging version that scores 70 of 82.")), null, "parts merged into one version");
  assert.equal(looksDone(p92("PR 812 merged into main, staging green.")), 'its note says "merged"', "a PR merged into main still counts");
  assert.equal(looksDone(p92("The 5 parts are merged into one version, and it shipped to staging at 4f1c2a.")), 'its note says "shipped"',
    "a real ship claim beside the merge still counts");
});

/*
 * Crawler VP 10-13: the 03:30 and 03:45 KST check-ins flagged p118 "looks done: its note says "is live"". Only C3 of the four write cuts ran on
 * prod; the two runs the wait names were queued, and C2 waited on land 33. The note and waitFor below are p118's at 03:45.
 */
const p118 = (note: string): PlanItem => ({ id: "p118", status: "doing", children: [], job: "census write cuts", note,
  text: "Fix: cut NVMe bytes written per new census read so the box carries 20k profiles/min under metal's 75 MB/s step line (about 0.22 MB per " +
    "read; at the 10-09 figure of 1.24 MB the line sits near 3,600/min)",
  waitFor: "C8 (38286370276) and C3+C4 (ci/c4-cast-fix 38290806019) green, then land 33, whose deploy applies C2's Postgres recreate" });

test("looks done: a ship claim about one part of a wait that names several, or a wait for green runs the note does not report green, is not done (Crawler VP 10-13, p118)", () => {
  assert.equal(looksDone(p118("C3 is live on prod since 17:57Z: refresh_interval 30 s on content (68M docs) and profiles (40M), both green, so search " +
    "shows new docs up to 30 s later. C4 (60 s profile window), C2 (shared_buffers 48 GB plus shm_size, one recreate) and C8 (synchronous_commit off) " +
    "are pushing. Media containers went to 4 GiB live at 17:55Z, with concurrency 64; the compose change is with arbitrary limits removal.")), null,
    "the note at the 03:45 run: only C3 is live");
  assert.equal(looksDone(p118("C3 is live on prod since 17:57Z.")), null, "the wait's runs are not reported green");
  assert.equal(looksDone(p118("C3 is live on prod since 17:57Z. Runs 38286370276 and 38290806019 are green.")), null, "land 33 and C2 are not claimed");
  assert.equal(looksDone(p118("Runs 38286370276 and 38290806019 are green. Land 33 deployed C3, C4, C8 and C2's recreate to prod at 21:10Z.")),
    'its note says "deployed"', "a claim on every part still counts");
});

/*
 * AI harness 10-13: the 18:45 KST check-in found p357 flagged "looks done: its note says "released"". Fable freed the CI runners, and
 * run 38378517237 was still queued at 09:46Z. The note and waitFor below are p357's from the chat's plan_update before the 18:45 run.
 */
const p357 = (note: string): PlanItem => ({ id: "p357", status: "doing", children: [], job: "stale tree sync", note,
  text: "commit.mjs also catches a real edit made on an old base (35 such files in the shared tree now), so committing it cannot silently revert " +
    "lines a newer commit added",
  waitFor: "verify-dev run 38378517237 (ci/stale-tree-guard-9) goes green; stale tree sync lands it by CAS" });

test("looks done: a quoted ship word or one another actor did, and a note that acts on green, is not done (AI harness 10-13, p357)", () => {
  assert.equal(looksDone(p357("After Fable's 'released' at 09:43Z, stale tree sync pushed the guard fresh: ci/stale-tree-guard-9, object 2cfe601a35 " +
    "on tip 436aa18957, verify-dev run 38378517237, with the same 7 blobs. The id went to Fable. Earlier probes 6 to 8 were cancelled in promote " +
    "9's runner clears. The job CAS-lands the 7 files on green.")), null, "the note before the 18:45 run");
  assert.equal(looksDone(p357("Fable 'released' the runners, so ci/stale-tree-guard-9 run 38378517237 went green.")), null, "a quoted ship word");
  assert.equal(looksDone(p357("After Fable's runner clear released, ci/stale-tree-guard-9 run 38378517237 went green.")), null,
    "a ship word after another actor's name");
  assert.equal(looksDone(p357("ci/stale-tree-guard-9 run 38378517237 deployed, and the job lands the 7 files on green.")), null,
    "a note that acts on green reports no green");
  assert.equal(looksDone(p357("Run 38378517237 went green, and stale tree sync landed ci/stale-tree-guard-9 by CAS at 10:20Z.")),
    'its note says "landed"', "a real green and land still count");
});

/*
 * VP of CI 10-14: the check-ins at 00:4xZ, 01:0xZ and 01:4xZ flagged p150 "looks done: its note says "landed"". The step waits until 22:30Z to
 * re-measure, and "the 4 queue cuts landed" is the change it measures, which its title names. The text, note and waitUntil are p150's board.
 */
const p150 = (note: string): PlanItem => ({ id: "p150", status: "todo", children: [], job: "ci queue demand", note, waitUntil: "2026-10-14T22:30:00.000Z",
  text: "Re-measure heavy-runner demand a day after the queue cuts landed, to check the forecast of about a fifth less" });
const P150_NOTE = "Status 00:4xZ: the 4 queue cuts landed at 22:16Z on 10-13 (green run 38435171151). The job holds until the re-measure at 22:30Z " +
  "on 10-14 with the same script. Its timer can die on a Mac restart (the heartbeat skill failed with an ImportError), so this step's waitUntil is " +
  "the backup wake.";

test("looks done: a step before its waitUntil, or a ship claim about what its title measures after, is not done (VP of CI 10-14, p150)", () => {
  assert.equal(looksDone(p150(P150_NOTE), Date.parse("2026-10-14T01:45:00Z")), null, "the 01:4xZ check-in, before the waitUntil");
  assert.equal(looksDone(p150(P150_NOTE), Date.parse("2026-10-14T23:00:00Z")), null, "after the waitUntil, the queue cuts are the starting point");
  assert.equal(looksDone(p150("The re-measure report merged in PR 900 at 23:10Z."), Date.parse("2026-10-14T23:20:00Z")), 'its note says "merged"',
    "a ship claim about the step's own work still counts");
  assert.equal(looksDone({ ...p150(P150_NOTE), text: "Ship the queue cuts" }, Date.parse("2026-10-14T23:00:00Z")), 'its note says "landed"',
    "a step whose own work is the cuts still counts");
});

/*
 * AI harness 10-15: the 21:02 KST check-in counted finished_open 2 on p454 "shipped" and p456 "is live", and p455 "shipped" joined them by
 * 22:40. All three are open: p454 and p455 name what is still missed or red, and p456's "is live" is a fix job being alive, which its owner
 * checks. The notes are the board's own at 22:40 KST. p25 from the 10-15 SEO board is a real ship whose note names a failure handed to another step.
 */
const P454_NOTE = "Parts 1 to 5 shipped, but 16 duties in 9 chats still missed 3+ runs with no live fix job and every sampled run record has fixes null, " +
  "so the send-back gate does not hold in practice. Job 'stuck duties gate' (01a13f21) reproduces why a missed run ends with no fix step and lands the root fix with a test.";
const P455_NOTE = "d3 Skills and harness is green (09:44:55Z) and d5 Skills and tools is green (12:38:11Z). d1, d4 and d6 are still red. d1's headline is the " +
  "fleet green share, d6 is usable minutes and needs p449. The duty system part shipped: all five parts plus check-in fix 1e9537b are live in release-c16c66c.";
const P456_NOTE = "The 11:00Z chase time passed. At 19:30 the 8 other chats hold 13 stuck duties with no linked fix step. 'duties green fleet' messages " +
  "each owning chat and checks each fix job is live.";
const goal = (id: string, text: string, job: string, note: string): PlanItem => ({ id, status: "doing", children: [], job, note, text });

test("looks done: a note that says what is still missed or red, or that a job is live, is not done (AI harness 10-15, p454, p455, p456)", () => {
  const p454 = goal("p454", "The duty system holds each duty to a few readable metrics and keeps fixing every miss until green", "stuck duties gate", P454_NOTE);
  const p455 = goal("p455", "This chat's five duties are reshaped and green", "duties reshape", P455_NOTE);
  const p456 = goal("p456", "The 8 other chats with duties reshape theirs and start a fix job for every miss", "duties green fleet", P456_NOTE);
  assert.equal(looksDone(p454), null, "16 duties still missed 3+ runs");
  assert.equal(looksDone(p455), null, "d1, d4 and d6 are still red");
  assert.equal(looksDone(p456), null, "a fix job that is live is a job running, and checks names a check");
  assert.equal(looksDone({ ...p454, note: "Parts 1 to 5 shipped to staging at 1e9537b." }), 'its note says "shipped"', "the ship claim alone still counts");
  assert.equal(looksDone({ ...p455, note: "All five duties are green, and check-in fix 1e9537b is live in release-c16c66c." }), 'its note says "is live"',
    "a fix that is live still counts");
  assert.equal(looksDone({ ...p456, note: "The job verified each fix is live on staging." }), 'its note says "is live"', "a verified fix still counts");
  assert.equal(looksDone(goal("p25", "Set the public tools daily live reads to 500, 100 of them for transcripts, after the GeoNode cutover", "tools live reads",
    "Live on production after promote 7: env-var verify exits 0 for both limits, and the crawler now makes live reads for the tools. A live check found " +
    "the lookup page still fails visitors; that fix is its own step.")), 'its note says "Live on production"', "a failure handed to another step");
});

/*
 * ops guy 10-16: the 01:08 KST check-in counted finished_open 1 on p258 "looks done: its note says "landed"". The note says none of the drops
 * has landed, because the ops train stopped. The text, job and note are p258's at 01:08. p133 on the same board said the Vercel fix "hasn't landed".
 */
const P258_NOTE = "Cause: 264 of 265 unbacked limits have a drop on a ci/ ref, but none has landed, because the ops train stopped at 14:12Z. The ops " +
  "train has been re-driven. It pushes chain A f5835170cf as ci/limits-d2-chain-a (reads 176) and chain B 6ec9170ccb as ci/limits-d2-chain-b (adds " +
  "infra, reads 144, with metal-deploy-tests and ack 29), and lands each on green. limits duty green rebuilds the 4 conflicting stacks and the " +
  "FL_MAX_PAGES leftover. This job remeasures after each land.";
const p258 = (note: string): PlanItem => ({ id: "p258", status: "doing", children: [], job: "fix limits rest on evidence ops guy (+observability) 23:28", note,
  text: "Unbacked limits still in the code in the Limits rest on evidence duty reaches at most 0, from 930 on" });

test("looks done: a ship word after none or a negated verb, or a land still to come, is not done (ops guy 10-16, p258)", () => {
  assert.equal(looksDone(p258(P258_NOTE)), null, "the note at the 01:08 check-in");
  for (const note of ["None of the 264 drops have landed.", "The Vercel fix hasn't landed.", "Chain A is not landed yet.", "Chain A lands next.",
    "Chain A waits to land on green.", "Neither chain merged.", "The drops didn't land before the train stopped."]) {
    assert.equal(looksDone(p258(note)), null, note);
  }
  assert.equal(looksDone(p258("Chain A landed on sieun/dev as f5835170cf.")), 'its note says "landed"', "a real land still counts");
  assert.equal(looksDone(p258("Both chains landed on sieun/dev as f5835170cf and 6ec9170ccb, so none of the 265 limits is left.")), 'its note says "landed"',
    "a none after the ship word names what is left, and the land still counts");
});
