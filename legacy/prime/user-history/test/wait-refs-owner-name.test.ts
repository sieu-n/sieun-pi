// Ops guy 11-04: p714 waited for "the owner-walked prod promote (release owner's p147); staging checked out at 00:12Z 11-04", and three
// check-ins in a row flagged it as wait_met, because waitRefs read "owner's" as the owner's own todos on this board and waitsMet read ops guy's
// own p147, a dropped step. A name word before "owner" makes the possessive another chat's, so p147 is read on that chat's board or not at all.
import assert from "node:assert/strict";
import { test } from "node:test";
import { waitsMet } from "../src/checkin-findings.ts";
import { stepView } from "../src/checkin-steps.ts";
import { waitRefs, withLinkedBoards } from "../src/shared/todo-hold.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const OPS = "01a11af8-962e-773d-a19a-ee4104011987";
const RELEASE = "01a15427-145f-751d-ba15-d27b6c30f65f";
const now = Date.parse("2026-11-04T02:04:00Z");
const waitFor = "the owner-walked prod promote (release owner's p147); staging checked out at 00:12Z 11-04";
const p714: PlanItem = { id: "p714", text: "Ship the staging fix to prod", status: "blocked", children: [], waitFor };
const p147 = (status: PlanItem["status"]): PlanItem => ({ id: "p147", text: "The follow-up prod release", status, children: [] });
const board = (plan: PlanItem[]): ChatBoard => ({ v: 2, rev: 1, updatedAt: "2026-11-04T00:00:00Z", plan, todos: [] }) as unknown as ChatBoard;
const self = new Set([OPS, "ops guy"]);
const met = (rows: { id: string; name: string }[], others: Map<string, ChatBoard | null>) =>
  waitsMet([stepView(p714, now - 3_600_000, self, [], [], [], now)], withLinkedBoards(board([p714, p147("dropped")]), OPS, others, []), rows, self, others)
    .map(({ view, over }) => [view.item.id, over]);

test("p714's wait on the release owner's p147 is not over though ops guy's own p147 is dropped", () => {
  assert.deepEqual(met([], new Map()), []);
  assert.deepEqual(met([{ id: RELEASE, name: "release owner" }], new Map([[RELEASE, board([p147("todo")])]])), []);
});

test("an owner's id with no name word before owner stays this board's, and one after a name word is another chat's", () => {
  for (const text of ["owner's t74", "the land 36/37 promote brings the rule (owner's t28)", "by the owner's t108", "on the owner's t50"])
    assert.deepEqual(waitRefs(text).refs, [], text);
  assert.deepEqual(waitRefs(waitFor).refs, [{ id: "p147", chat: null }]);
  assert.deepEqual(waitRefs("prod waits for the release owner's p147", [{ id: RELEASE, name: "release owner" }]).refs, [{ id: "p147", chat: RELEASE }]);
});
