// d9 at 17:57Z on 10-27 counted vent's check-in as a red duty with no live fix. Its newest reading was the after-job measure of its 12:20Z run, taken
// at 16:49Z with goal_gaps 2, and vent's check-in runs every 6 h. By 17:57Z live jobs worked on each of vent's goals p85, p89 and p94, and d9's own
// idle-goal read for vent was empty. d9 now reads a check-in's goal_gaps from the live board, and a check-in with a goal still unowned stays red.
import assert from "node:assert/strict";
import { test } from "node:test";
import { goalsWithNoJob, withLiveGoalGaps } from "../scripts/duties/chat-system.ts";
import { type PlanInputs, planCounts } from "../scripts/duties/whole-system.ts";
import type { DutyRunRecord, MetricResult } from "../src/shared/chat-duties.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const VENT = "01a14dd5-e9d3-705d-bd63-245c21b2eee2";
const at = (clock: string) => Date.parse(`2026-10-27T${clock}Z`);
const off = (value: number): MetricResult => ({ value, target: 0, op: "<=", met: value <= 0 });
const metrics = (gaps: number, stuck: number) => ({ goal_gaps: off(gaps), stuck_steps: off(stuck), no_done_line: off(0), plan_risks: off(0) });
const P85 = "01a17ae8-abc5-754c-a08e-959af4255815";
const P89 = "01a17e4c-2473-720a-95e7-a8cf004afd6e";
const P94 = "01a17e5f-2a8b-7648-9367-9c8cb3414c76";
const goal = (id: string, text: string, sessionId: string, children: PlanItem[] = []): PlanItem =>
  ({ id, text, status: "doing", sessionId, note: "Done when the owner's check passes.", children });
const board = (p94Session: string): ChatBoard => ({ v: 2, rev: 1, updatedAt: "2026-10-27T17:50:00Z", todos: [], plan: [
  goal("p85", "Vent fakes every call aimed at a test target, so no test email or payment reaches a real provider", P85),
  goal("p89", "Take PostHog and B2 out of Vent, so the apps call them directly", P89,
    [{ id: "p93", text: "Delete the PostHog and B2 integrations from Vent", status: "doing", sessionId: P89, children: [] }]),
  goal("p94", "Vent allows only the newest model of each tier and refuses every other model", p94Session)] });
/** The 12:20Z scheduled check-in, whose job "check-in vent 21:20" ended with the 16:49Z after-job measure. */
const run: DutyRunRecord = { duty: "checkin", at: at("12:20:38"), trigger: "schedule", ms: 1, verdict: "missed", summary: "", metrics: metrics(0, 2),
  flagged: [{ kind: "stuck_steps", excerpt: "", item: "p85" }, { kind: "stuck_steps", excerpt: "", item: "p89" }],
  job: { id: "01a17d70-a75e-70c8-8c9d-65cb2008f15a", name: "check-in vent 21:20" },
  after: { at: at("16:49:26"), verdict: "missed", metrics: metrics(2, 4), summary: "goal_gaps 2 (target at most 0), stuck_steps 4 (target at most 0)" } };
const now = at("17:57:52");
const activity = new Map([[P85, at("17:55:00")], [P89, at("17:56:00")], [P94, at("17:50:00")]]);
const inputs = (plan: ChatBoard): PlanInputs => ({ now, chats: [{ id: VENT, name: "vent", runs: [run], duties: [{ id: "checkin", name: "Check-in" }], everyMs: 6 * 3_600_000 }],
  boards: new Map([[VENT, plan]]), ownerActivity: activity, waking: new Set(), poolWaiting: new Set(), named: new Map() });
const gaps = (plan: ChatBoard) => new Map([[VENT, goalsWithNoJob(plan, { now, named: new Map(), jobs: [], activity, waking: new Set(), poolWaiting: new Set() }).length]]);

test("d9 counts no check-in whose only owed miss is goal_gaps once every goal on the live board has a live job (vent, 17:57Z)", () => {
  const owned = board(P94);
  const red = planCounts(inputs(owned)).redDuties;
  assert.deepEqual(red.map(entry => [entry.duty, entry.keys]), [["checkin", ["goal_gaps"]]], "planCounts still judges the 16:49Z after-job measure");
  assert.deepEqual(withLiveGoalGaps(red, gaps(owned)), []);
});

test("a check-in with a goal that still has no live job stays a red duty with no live fix", () => {
  const idle = board("01a10000-0000-7000-8000-000000000094");
  const red = planCounts(inputs(idle)).redDuties;
  assert.equal(gaps(idle).get(VENT), 1);
  assert.deepEqual(withLiveGoalGaps(red, gaps(idle)).map(entry => entry.duty), ["checkin"]);
});

test("a check-in that owes another miss besides goal_gaps stays, and other duties pass through", () => {
  const red = [{ chat: VENT, duty: "checkin", keys: ["goal_gaps", "stuck_steps"], line: "" }, { chat: VENT, duty: "d1", keys: ["goal_gaps"], line: "" }];
  assert.deepEqual(withLiveGoalGaps(red, new Map([[VENT, 0]])).map(entry => entry.duty), ["checkin", "d1"]);
  assert.deepEqual(withLiveGoalGaps([{ chat: VENT, duty: "checkin", keys: ["goal_gaps"], line: "" }], new Map()).length, 1, "a chat with no live read stays");
});
