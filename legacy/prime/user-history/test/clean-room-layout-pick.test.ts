// The c124 layout-pick clean room judges a chat by its briefs: the 10-28 frontend bro brief that asked a job for Swipe layouts on a wiki page
// fails it, and the 15:09Z brief that forked one variant per layout passes it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILDS, forkRun, pageOfOptions } from "../scripts/clean-room/layout-pick.ts";
import { SCENARIOS } from "../scripts/clean-room/scenarios.ts";

const PAGE_BRIEF = `rlm.spawn(b_swipe) Task: write ONE wiki page (open a wiki session, apps/llm-wiki skill) the owner can read in two minutes.
5. Two or three redesign options, each with a one-line pitch, a small wireframe (mermaid or an HTML mock), what it keeps and what it drops, and your pick first with the reason.
Do not change app code. Only research and write the page.`;
const BUILD_BRIEF = "rlm.spawn(...) one job with 3 builders in parallel, one per layout (swipe-a, swipe-b, swipe-c). Each forks creators/lean-1028 with " +
  "`pnpm --filter virev-demo variant:fork creators/lean-1028 swipe-a`";

test("the 02:27Z brief that asked for Swipe layouts on a wiki page reads as a page of options", () => {
  assert.equal(pageOfOptions(PAGE_BRIEF), true);
  assert.equal(BUILDS.test(PAGE_BRIEF), false);
});

test("the 15:09Z brief that forks one variant per layout builds on 5180", () => {
  assert.equal(BUILDS.test(BUILD_BRIEF), true);
  assert.equal(pageOfOptions(BUILD_BRIEF), false);
  assert.equal(pageOfOptions("Write a short wiki page on what Watchlist is for, from the code."), false, "a purpose page with no layout options is fine");
});

test("the scenario is registered and ends at its first verdict", () => {
  assert.equal(SCENARIOS["layout-pick"]?.endsAtVerdict, true);
});

test("a history search for variant:fork is no fork, and a pnpm run of it is", () => {
  assert.equal(forkRun("search_history", JSON.stringify({ query: "variant:fork kind:tool box:us-metal02", limit: 8 })), false);
  assert.equal(forkRun("ipython", JSON.stringify({ code: "r = await bash('cd ~/Documents/Github/auto-sns-agent && pnpm --filter virev-demo variant:fork watchlist/lean-1028 feed-a')" })), true);
  assert.equal(forkRun("ipython", JSON.stringify({ code: "await search_history(query='variant:fork')" })), false);
});
