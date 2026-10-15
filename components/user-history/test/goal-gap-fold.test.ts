import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck, checkInPrecheckText, convergenceMisses } from "../src/chat-checkin.ts";
import type { DutyRef } from "../src/checkin-findings.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

/**
 * slack green guy p48, unfixed_flags goal_gaps in 6 check-ins in a row (10-12 18:02 to 10-13 00:11 KST). At 00:11 the chat's duty d1
 * "Visitors become paying users" (boardGoal p48, made at 23:58) ran the goal's work, and the check-in got two asks for one goal: goals_to_fold
 * "close the goal" and goal_gaps "push the next step that closes the gap". The run folded p48. This replays p48 as it read at 00:11: its
 * target (0.5 of 2%, measured 18:15 KST) and its 14 open steps, every one waiting on the owner's answer on t18 or a dated check.
 */
const CHAT = "01a11b0b-7c15-73da-9481-8de15903eab4";
const NOW = Date.parse("2026-10-12T15:11:32.277Z");
const EVERY = 60 * 60_000;
const D1: DutyRef = { id: "d1", name: "Visitors become paying users", status: "active", boardGoal: "p48",
  goal: "Over the last 28 full days, 2% of on-topic real visitors sign up, 60% of signups connect a Slack workspace, and 10% of signups start Pro or buy the CLI. " +
    "A home page test runs on real traffic every day, so the home page keeps getting better." };
const STEPS: PlanItem[] = [
    {"id": "p50", "text": "Ship: merge the home hero test (#214) and the Google One Tap test (#213) and launch them after the owner's approval", "status": "blocked", "children": [], "waitFor": "the owner's answer on t18, which now names #214 and #213, then the M1 Air checks", "go": "needed"},
    {"id": "p52", "text": "Verify: weekly signup rate by source on the new dashboard", "status": "todo", "children": [], "waitFor": "#236 merged (asked on t18; it replaces #207, which now conflicts), then the M1 Air checks", "waitUntil": "2026-10-17T00:00:00.000Z", "job": "conversion growth"},
    {"id": "p54", "text": "Build: ongoing home page A/B experiments, signup rate as key metric", "status": "todo", "children": [], "waitFor": "#214 merged and launched (asked on t18), then the M1 Air checks", "job": "conversion growth"},
    {"id": "p74", "text": "Ship: merge the CI minutes cut (PR #226) after the owner's go", "status": "blocked", "children": [], "job": "merge ci minutes cut", "go": "needed"},
    {"id": "p82", "text": "Ship: merge the signup page test (#229) and launch experiment 477145 after the owner's go", "status": "blocked", "children": [], "waitFor": "p124: #234 merged after the owner's go on t18, then a green re-run of #229 on the Air", "go": "needed"},
    {"id": "p83", "text": "Ship: merge the QA visit filter for the dashboard script (#230) after the owner's go", "status": "blocked", "children": [], "waitFor": "p124: #234 merged after the owner's go on t18, then a green re-run of #230 on the Air", "go": "needed"},
    {"id": "p86", "text": "Ship: merge the one-checkout-per-click fix (#232) after the owner's go", "status": "blocked", "children": [], "waitFor": "p124: #234 merged after the owner's go on t18, then a green re-run of #232 on the Air", "go": "needed"},
    {"id": "p97", "text": "Ship: merge the blog category fix (#235) after the owner's go, and check the SEO agent only writes allowed categories", "status": "todo", "children": [], "waitFor": "the owner's answer on t18, which names #235, then the M1 Air checks", "go": "needed"},
    {"id": "p30", "text": "Verify: blog reader to signup rate on the dashboard", "status": "todo", "children": [], "waitUntil": "2026-10-29T00:00:00.000Z", "job": "01a11b0b-7c15-73da-9481-8de15903eab4"},
    {"id": "p101", "text": "Ship: merge the on-topic visitor measure (#236, replaces #207) after the owner's go", "status": "todo", "children": [], "waitFor": "the owner's answer on t18, which names #236, then the M1 Air checks", "go": "needed"},
    {"id": "p116", "text": "Ship: merge the preview and speed-test filter (#241) after the owner's approval, then rerun both dashboard scripts", "status": "todo", "children": [], "waitFor": "the owner's answer on t18, which names #241, then the M1 Air checks", "go": "needed"},
    {"id": "p109", "text": "Ship: merge the 30 minute free cap (#238) after the owner's approval", "status": "todo", "children": [], "waitFor": "the owner's answer on t18, which names #238, then the M1 Air checks", "go": "needed"},
    {"id": "p120", "text": "Ship: merge the subscribe popup (#239) after the owner's approval", "status": "todo", "children": [], "waitFor": "the owner's answer on t18, which now names #239, then the M1 Air checks", "go": "needed"},
    {"id": "p121", "text": "Ship: merge the blog Google button test (#246) and launch experiment 479904 after the owner's approval", "status": "todo", "children": [], "waitFor": "the owner's answer on t18, which now names #246, then the M1 Air checks", "go": "needed"},
];
const board = (): ChatBoard => ({ v: 2, rev: 1, updatedAt: "2026-10-12T14:00:00.000Z",
  todos: [{ id: "t18", text: "Approve these PRs to merge", done: false, from: "agent", at: "2026-10-12T05:00:00.000Z" }],
  plan: [{ id: "p48", text: "Visitor to signup 2% (now 0.59%), signup to workspace 60% (now 32%), signup to paid 10% (now 6%)", status: "doing",
    target: {"metric": "visitor-to-signup conversion rate", "target": 2, "unit": "%", "current": 0.5, "measuredAt": "2026-10-12T09:15:00.000Z", "source": "PostHog HogQL, 28 days, QA, preview and Lighthouse excluded: 60 of 11,948; on-topic visitors per #236: 58 of 4,131 = 1.40%"},
    children: structuredClone(STEPS) }] });
const findings = (duties: DutyRef[]) => {
  const precheck = checkInPrecheck(undefined, [], board(), NOW, { self: [CHAT, "slack green guy"], rows: [], everyMs: EVERY, duties });
  const output = convergenceMisses(CHAT, precheck.steps, precheck, {}, EVERY, NOW);
  return { output, text: checkInPrecheckText(precheck, [], output.flagged, NOW) };
};
const section = (text: string, head: string) => text.split("\n\n").find(part => part.startsWith(head)) ?? "";

test("goal gap: a goal the check-in folds into its duty gets the fold alone, not a goal gap too (slack green guy p48, 10-13 00:11 KST)", () => {
  const { output, text } = findings([D1]);
  assert.deepEqual(output.flagged.filter(slice => slice.kind === "goals_to_fold").map(slice => slice.item), ["p48"]);
  assert.equal(output.metrics.goal_gaps, 0, "the duty d1 carries the target; one ask per goal");
  assert.doesNotMatch(section(text, "### Goals, "), /\bp48\b/);
});

test("goal gap: the same goal with no duty that runs it stays a goal gap (slack green guy p48, 10-12 18:02 to 22:04 KST)", () => {
  const { output, text } = findings([]);
  assert.equal(output.metrics.goals_to_fold, 0);
  assert.deepEqual(output.flagged.filter(slice => slice.kind === "goal_gaps").map(slice => slice.item), ["p48"]);
  assert.match(section(text, "### Goals, "), /p48 visitor-to-signup conversion rate 0\.5 of 2%, first reading, no trend yet, and its last measurement is from 10-12 09:15Z; no live job owns it/);
});
