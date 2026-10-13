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
