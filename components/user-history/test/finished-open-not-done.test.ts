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
