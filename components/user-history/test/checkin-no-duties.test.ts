// sep launch!! 10-27: goals_without_duty flagged p2 in 10 check-ins in a row. The owner made that chat an implementor chat with no duties
// (c156, 10-22, msg mvj2es2m: "remove all the duties related to mac-management here"), and p2's requirement "for a list of thousands of
// monitoring brands" read as standing work, where "monitoring" names a kind of brand.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck, convergenceMisses } from "../src/chat-checkin.ts";
import { asksStanding } from "../src/checkin-findings.ts";
import { parseDutyFile } from "../src/shared/chat-duties.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const now = Date.parse("2026-10-27T03:36:00Z");
const board = (plan: PlanItem[]): ChatBoard => ({ v: 2, rev: 1, updatedAt: new Date(now - 60_000).toISOString(), plan, todos: [] }) as unknown as ChatBoard;
const goal = (line: string): PlanItem => ({ id: "p2", text: "The 5180 app works for real on local and staging", status: "doing", children: [],
  requirements: [{ text: line, status: "open" }] }) as unknown as PlanItem;
const flagged = (plan: PlanItem[], noDuties?: string) => {
  const precheck = checkInPrecheck(undefined, [], board(plan), now, { duties: [], ...(noDuties ? { noDuties } : {}) });
  return convergenceMisses("chat", precheck.steps, precheck, {}, 15 * 60_000, now).flagged.filter(slice => slice.kind === "goals_without_duty").map(slice => slice.item);
};

test("a chat the owner keeps free of duties gets no goals_without_duty finding", () => {
  const standing = goal("keep the daily brand pipeline running every day");
  assert.deepEqual(flagged([standing]), ["p2"]);
  assert.deepEqual(flagged([standing], "c156"), []);
});

test("the duties file keeps the owner correction that makes a chat duty-free", () => {
  assert.equal(parseDutyFile({ version: 1, duties: [], noDuties: "c156" }).noDuties, "c156");
  assert.equal(parseDutyFile({ version: 1, duties: [] }).noDuties, undefined);
  assert.equal(parseDutyFile({ version: 1, duties: [], noDuties: "" }).noDuties, undefined);
});

test("monitoring before a noun it names a kind of is no standing work", () => {
  const p2 = "sign up -> Add brand -> Jev filter work -> Create email template -> Auto-send via email template -> data flows to the Dashboards flow " +
    "should work, for a list of thousands of monitoring brands";
  for (const line of [p2, "Build the monitoring system", "a monitoring dashboard for the crawler"]) assert.equal(asksStanding(goal(line)), false, line);
  assert.deepEqual(flagged([goal(p2)]), []);
});

test("monitoring as ongoing work still counts", () => {
  for (const line of ["keep X monitoring", "monitoring of the crawl queue", "start monitoring the queue", "set up monitoring.", "and keep up the monitoring",
    "monitor the prod errors", "the probe monitors signups"]) assert.equal(asksStanding(goal(line)), true, line);
});
