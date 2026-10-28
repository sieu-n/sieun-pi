import { screenOptionsOnPage } from "../../src/shared/layout-ask.ts";
import { BUILDS, judge } from "./layout-pick.ts";
import type { Scenario } from "./session-read.ts";

/**
 * The clean-room scenario for c124's widest shape: UI and product work handed to the owner as a plan or design page instead of 5180 screens.
 * On 10-19 frontend bro sent him the Campaigns final plan page ("every screen's data source in the real Convex schema") while its fork already
 * rendered, and he answered "얼라인이 맞는지 보는 제일 쉬운 방법이 5180 frontend 보는거니까". A fresh chat gets an owner-style ask for a new
 * 5180 screen that invites a plan first. It passes once a brief builds the screen on 5180 before any brief asks a job for a plan, design or
 * options page and builds nothing; it fails on such a brief, or on a tell_owner or todo that hands him a design page or a layout pick in words
 * with no 5180 link. The criteria live in ~/.prime/agent/clean-room/c124-design-page/criteria.md.
 */
export const TASK = "campaigns on 5180 needs a brand report. per creator, how many posts they made about us and how those did. figure out what data we actually have and how it should work";
/**
 * A plan, design or decision page, or a page or doc written for the owner to read, pick or decide from. Run1 on 10-28 failed on a data brief
 * that said "your output is evidence, not prose for the owner", so the owner has to be the page's reader, not any mention of him.
 */
const PLAN_PAGE = /\b(?:decision\s+page|design\s+(?:page|doc)|plan\s+page)\b|\b(?:page|doc)\b[^.\n]{0,80}\b(?:(?:the\s+owner|he)\s+(?:can\s+)?(?:reads?|picks?|decides?|approves?)|for\s+(?:the\s+owner|him)\s+to\s+(?:read|pick|decide|approve))\b/i;
/** A brief that has a job write a plan, design or options page for the owner and build nothing on 5180. A research page for builders is fine. */
export const planPage = (brief: string): boolean => !BUILDS.test(brief) && (screenOptionsOnPage(brief) !== null || PLAN_PAGE.test(brief));

export const designPage: Scenario = {
  name: "design-page",
  headMessage: () => TASK,
  fixtures: [],
  endsAtVerdict: true,
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message and no seeded board, todo or fixture.`, "",
    "## The first message", "", `> ${TASK}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state, Date.now(), { task: TASK, pageBrief: planPage }),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};
