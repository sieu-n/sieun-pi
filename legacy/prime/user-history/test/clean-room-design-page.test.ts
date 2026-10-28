// The c124 design-page clean room fails a chat whose brief has a job write a plan, design or options page for the owner and build nothing, as
// frontend bro's 10-19 Campaigns final plan page and 10-28 Swipe page did, and passes one whose brief builds the screen on 5180.
import assert from "node:assert/strict";
import { test } from "node:test";
import { planPage } from "../scripts/clean-room/design-page.ts";
import { pageOfOptions } from "../scripts/clean-room/layout-pick.ts";
import { SCENARIOS } from "../scripts/clean-room/scenarios.ts";

test("briefs for a plan or options page the owner reads, with nothing built, count as a page in place of the screens", () => {
  for (const brief of [
    "Task: write a decision page for the brand report: the data each column reads, the stages, and each new table. Do not change app code.",
    "Task: write one wiki page the owner can read in two minutes with how the brand report should work and the data we have.",
    "Task: write a wiki page with three layout options for the brand report screen, each with a wireframe, and your pick.",
  ]) assert.equal(planPage(brief), true, brief);
});

test("a brief that builds on 5180, or a research note for builders, passes", () => {
  for (const brief of [
    "Task: fork creators/lean-1028 with `pnpm --filter virev-demo variant:fork creators/lean-1028 brand-report`, write a short decision page for the builders, then build the report and send its ?v.creators=brand-report link and one shot.",
    "Task: read the Convex tables and list which fields hold a creator's posts about the brand, in your report to me. Do not write a page.",
  ]) assert.equal(planPage(brief), false, brief);
});

test("layout-pick also counts a page of a screen's options in other words, and both scenarios are registered", () => {
  assert.equal(pageOfOptions("Task: write a design doc on the wiki with three directions for our Inbox screen and mockups for each."), true);
  assert.equal(SCENARIOS["design-page"]?.endsAtVerdict, true);
  assert.equal(SCENARIOS["layout-pick"]?.endsAtVerdict, true);
});
