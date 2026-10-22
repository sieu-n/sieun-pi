// slack green guy 10-15: job "email confirm loss" merged #258 as ecfaebb at 10:57Z (Vercel production READY) and reported at 10:59Z with
// p144 doing. No one closed p144 until the check-in did at about 11:58Z, so the 11:18Z check-in read no_progress 1. Job "main merges" waited in
// the pi-pool queue from its 10:22Z CI wake to 11:52Z, but p71 still had 7 PRs to merge and could not close that hour. When the job ends, the
// chat must get p144 at once, with or without a wait on the step.
import assert from "node:assert/strict";
import { test } from "node:test";
import { endedJobs, handBackSteps, handBackText, leftOpenSteps, openStepsNotice } from "../src/chat-checkin.ts";
import type { JobMessage } from "../src/checkin-steps.ts";
import type { ChatBoard, ChildAgent, PlanItem } from "../src/shared/types.ts";

const reportAt = Date.parse("2026-10-15T10:59:00Z");
const p144 = (fields: Partial<PlanItem> = {}): PlanItem => ({ id: "p144", status: "doing", job: "email confirm loss", children: [],
  text: "Build: most people who sign up with email finish signing in, instead of 13 of 20 stopping at the confirm email", ...fields });
const p71: PlanItem = { id: "p71", status: "doing", job: "main merges", children: [],
  text: "Ship: merge #254, #252, #253, #225, #250, #255, #256 and #257, then turn the reminder on in production" };
const board = (step: PlanItem): ChatBoard => ({ v: 2, rev: 1, updatedAt: "2026-10-15T10:59:00Z", plan: [step, p71], todos: [] }) as unknown as ChatBoard;
const job = (label: string, status: ChildAgent["status"], fields: Partial<ChildAgent> = {}): ChildAgent =>
  ({ id: `rlm-${label.replace(/ /g, "-")}`, label, sessionName: label, status, lastActivityAt: reportAt, ...fields });
const emailRunning = job("email confirm loss", "running");
const emailDone = job("email confirm loss", "done", { repliedSinceTask: true });
const merges = job("main merges", "queued");
const said = new Map<string, JobMessage>([["email confirm loss",
  { at: reportAt, text: "#258 merged as ecfaebb at 10:57Z, Vercel production READY; someone needs to confirm the deploy lands" }]]);

test("p144 with no wait goes back to the chat as soon as its job reports, and p71's queued job keeps its step", () => {
  assert.deepEqual(endedJobs([emailRunning, merges], [emailDone, merges]).map(child => child.label), ["email confirm loss"]);
  const handed = handBackSteps([emailDone, merges], board(p144()), said);
  assert.deepEqual(handed.map(({ child, steps }) => [child.label, steps.map(step => step.id)]), [["email confirm loss", ["p144"]]]);
  assert.match(handBackText(emailDone, handed[0]!.steps), /^email confirm loss reported, and its open step is yours now: p144 .*Close or continue p144\.$/);
});

test("p144 waiting on the deploy still reaches the chat when its job's turn ends, with its wait named", () => {
  const waiting = board(p144({ status: "blocked", waitFor: "Vercel production deploy of ecfaebb lands" }));
  assert.deepEqual(handBackSteps([emailDone, merges], waiting, said), []);
  const left = leftOpenSteps(emailDone, [emailDone, merges], waiting);
  assert.deepEqual(left.map(step => step.id), ["p144"]);
  assert.match(openStepsNotice(emailDone, left), /^email confirm loss ended its turn, and this open step names it: p144 .* waits for "Vercel production deploy of ecfaebb lands"\. Read its last report now, then close each step whose work is done/);
});
