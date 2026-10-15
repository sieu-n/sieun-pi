import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type CheckInMemory, checkInPrecheck, checkInPrecheckText, classCounts, convergenceMisses } from "../src/chat-checkin.ts";
import type { DutyChat, DutyJobHost } from "../src/chat-duty-job.ts";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import { CHECK_IN_MS } from "../src/checkin-settings.ts";
import type { DutyJobRef } from "../src/shared/chat-duties.ts";
import type { ChatBoard } from "../src/shared/types.ts";

/**
 * Crawler VP on 10-15 at 22:00Z, its open goals as the board held them (test/fixtures/checkin-goal-push-crawler-vp-1015.json). p71 "Complete
 * index of Instagram, Meta Ads and TikTok Shop" read Instagram Tier A indexed 14.9 of 100% (19:35Z), up from 10.17% at 06:42Z. Every job on its
 * steps slept on CI wakes or had ended, and the 06:20 check-in told the chat about stuck steps 3 to 1 and board tidying, never p71's number. The
 * owner asked the chat "are you pushing through on this? is it working?", then the AI harness chat "Check in 이 일을 쭉쭉 밀어줘야되는데 it's deeply
 * flawed. fix this".
 */
const CHAT = "01a115e2-9544-7204-b8db-8ce4d5319048";
const NOW = Date.parse("2026-10-15T22:00:00Z");
const MIN = 60_000;
const board = JSON.parse(await readFile(new URL("./fixtures/checkin-goal-push-crawler-vp-1015.json", import.meta.url), "utf8")) as ChatBoard;
/** The chat's jobs as the 06:20 check-in listed them: only virev query mcp design was awake, on p542. */
const facts: JobFact[] = [
  { key: "j1", name: "virev query mcp design", state: "working", activityAt: NOW },
  { key: "j2", name: "crawler ops train", state: "working", activityAt: NOW - 2 * MIN, wake: "board.wakes on run 38790499999 and 16 more" },
  { key: "j3", name: "census canary run", state: "ended", activityAt: NOW - 104 * MIN },
  { key: "thread:lab", name: "crawler lab window", state: "working", activityAt: NOW - 7 * 60 * MIN, wake: "a board.wake at 22:00Z" },
  { key: "thread:box", name: "box backups follow through", state: "working", activityAt: NOW - 117 * MIN, wake: "a board.wake at 05:00Z" },
  { key: "thread:fix", name: "fix check-in Crawler VP 05:36", state: "working", activityAt: NOW },
];
/** The check-in's memory from a run that read p71 at 10.17% (06:42Z). */
const morning: CheckInMemory = { at: Date.parse("2026-10-15T06:50:00Z"), steps: {}, goals: { p71: { readings: [{ value: 10.17, at: Date.parse("2026-10-15T06:42:00Z") }], still: 0 } } };
/** Two or more step ids in a row: a list of step ids, which no brief or chat message carries (c80). */
const ID_LIST = /\b[pt]\d+\b(?:,?[ \t]+(?:and[ \t]+)?|[ \t]*[-/][ \t]*)[pt]\d+\b/;

async function checkInBrief(memory: CheckInMemory | undefined, jobs: readonly JobFact[] = facts) {
  const precheck = checkInPrecheck(memory, jobs, board, NOW, { self: [CHAT, "Crawler VP"], everyMs: CHECK_IN_MS });
  const output = convergenceMisses(CHAT, precheck.steps, precheck, {}, CHECK_IN_MS, NOW);
  const dir = await mkdtemp(join(tmpdir(), "checkin-goal-push-"));
  const briefs: string[] = [];
  const host: DutyJobHost = {
    async chat(chatId): Promise<DutyChat> { return { id: chatId, name: "Crawler VP", cwd: "/repo", board: `/boards/${chatId}.json` }; },
    async working() { return false; },
    async start(_chat, name, brief): Promise<DutyJobRef> { briefs.push(brief); return { id: "s1", name }; },
    async retire() {},
  };
  const duties = new Duties(new DutyStore(dir), { isChat: async () => true, jobs: host, tickMs: 0, now: () => NOW });
  await duties.checkIn(CHAT, { at: NOW, trigger: "schedule", everyMs: CHECK_IN_MS, output, classes: classCounts(precheck.steps),
    findings: checkInPrecheckText(precheck, jobs, output.flagged, NOW) });
  duties.close();
  assert.equal(briefs.length, 1);
  const brief = briefs[0]!;
  const detail = brief.match(/Every flagged item and the full precheck are in (\S+\.flagged\.md)\./)![1]!;
  return { precheck, output, brief, detail: await readFile(detail, "utf8") };
}
/** The part of the brief that comes from this run's measure: from "What the precheck found" to "How to work". */
const found = (brief: string): string => brief.slice(brief.indexOf("## What the precheck found"), brief.indexOf("## How to work"));

test("Crawler VP 10-15 22:00Z: the check-in brief leads with p71's number, its gap and the ask to start the one job that moves it", async () => {
  const { precheck, output, brief, detail } = await checkInBrief(undefined);
  assert.match(found(brief), /Instagram Tier A indexed 14\.9 of 100%/, "the brief names p71's number");
  assert.match(found(brief), /no live job owns it: add a push step under p71 for one job that names and attacks the biggest blocker/, "and the start ask");
  assert.doesNotMatch(found(brief), ID_LIST, "the brief's findings carry no list of step ids");
  const p71 = precheck.goals.find(push => push.goal.id === "p71")!;
  assert.equal(p71.act, "start", "no awake job owns p71's number: crawler ops train sleeps on CI runs and census canary run ended");
  assert.equal(output.metrics.goal_gaps, 1);
  assert.match(brief, /This run is judged on moving one number: Open goals off pace or with no live job that owns their number \(goal_gaps <= 0\)/);
  assert.match(brief, /The headline number this run is goal_gaps at 1, target at most 0/);
  const items = found(brief).split("\n").filter(line => line.startsWith("- "));
  assert.equal(items[0], "- p71 Instagram Tier A indexed 14.9 of 100%, first reading, no trend yet; no live job owns it: add a push step under p71 for one job that names and attacks the biggest blocker",
    "the first item of the brief is p71's number and the start");
  assert.match(brief, /For a goal that says start, add one push step under the goal with duty "checkin\/goal_gaps" and its job set to one job that names and attacks the biggest blocker/);
  assert.doesNotMatch(brief, /goal_gaps \(Open goals[^\n]*land a code change/, "the generic fix-job line does not contradict the goal ask");
  assert.match(brief, /never start a second/);
  assert.match(brief, /Otherwise send the chat one report of at most 3 plain lines when your work is done: the number and gap of the goal furthest from its target/);
  assert.doesNotMatch(found(brief), ID_LIST, "the brief's findings carry no list of step ids");
  assert.doesNotMatch(brief, /stuck_steps p\d|goal_gaps p\d/, "no finding kind next to a step id");
  assert.ok(detail.indexOf("### Goals") < detail.indexOf("### Stuck steps"), "the detail file has the goals first, the stuck steps after");
  assert.match(detail, /Owner's words for p71 "Complete index of Instagram, Meta Ads and TikTok Shop \(owne…" \(verbatim\):\n\n(?: {2}> .*\n)* {2}> "we need complete index of Instagram"\n/);
  assert.match(detail, /Instagram Tier A indexed 14\.9 of 100%, first reading, no trend yet\. Name the biggest blocker on this number and attack it now\./);
});

test("Crawler VP 10-15 22:00Z: with the morning reading in the check-in's memory, p71 reads +4.73 points since 06:42Z and about 10 days to target, off pace", async () => {
  const { precheck, brief } = await checkInBrief(morning);
  const p71 = precheck.goals.find(push => push.goal.id === "p71")!;
  assert.equal(p71.trend?.kind, "moving");
  assert.match(found(brief), /p71 Instagram Tier A indexed 14\.9 of 100%, \+4\.73 points since 10-15 06:42Z, about 10 days to target at this rate; no live job owns it: add a push step under p71/);
  assert.deepEqual(precheck.memory.goals!.p71!.readings.map(reading => reading.value), [10.17, 14.9], "the check-in keeps the reading for the next run's trend");
});

test("Crawler VP 10-15 22:00Z: once a push step's job is alive, the check-in steers it and never asks for a second job", async () => {
  const pushed: ChatBoard = structuredClone(board);
  pushed.plan.find(goal => goal.id === "p71")!.children.push({ id: "p900", text: "Move Instagram Tier A indexed toward 100%: name and attack the biggest blocker", status: "doing",
    job: "p71 index push", duty: "checkin/goal_gaps", children: [] });
  const precheck = checkInPrecheck(morning, [...facts, { key: "j9", name: "p71 index push", state: "working", activityAt: NOW - 5 * MIN }], pushed, NOW, { self: [CHAT, "Crawler VP"], everyMs: CHECK_IN_MS });
  const p71 = precheck.goals.find(push => push.goal.id === "p71")!;
  assert.equal(p71.act, "steer", "10 days to target is off pace (PACE_MS is 7 days)");
  assert.equal(p71.owner?.name, "p71 index push");
  const output = convergenceMisses(CHAT, precheck.steps, precheck, {}, CHECK_IN_MS, NOW);
  const line = output.flagged.find(slice => slice.kind === "goal_gaps" && slice.item === "p71")!.excerpt;
  assert.match(line, /about 10 days to target at this rate; job p71 index push owns it and it is off pace: steer it to name and attack the biggest blocker now$/);
  assert.doesNotMatch(line, /add a push step/);
  const ended = checkInPrecheck(morning, [...facts, { key: "j9", name: "p71 index push", state: "ended", activityAt: NOW - 60 * MIN }], pushed, NOW, { self: [CHAT, "Crawler VP"], everyMs: CHECK_IN_MS });
  const restart = convergenceMisses(CHAT, ended.steps, ended, {}, CHECK_IN_MS, NOW).flagged.find(slice => slice.kind === "goal_gaps" && slice.item === "p71")!.excerpt;
  assert.match(restart, /its push step p900 has no live job: set one job on it that names and attacks the biggest blocker$/, "an ended owner is replaced on its own step, never a second step");
});
