// AI harness 11-24: p1664 waited only on the owner's own Naver password, which c178 keeps off For you. ownerHold read it as held for d5,
// unmovedSteps and d9, but the check-in classed it a stale chase, and two check-ins in a row flagged it in stalled_steps.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck, convergenceMisses } from "../src/chat-checkin.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const HARNESS = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const start = Date.parse("2026-11-23T21:40:00Z");
const later = start + 3 * 60 * 60_000;
const p1664: PlanItem = { id: "p1664", text: "krenerd77's Claude grant renews once the owner signs Aside into Naver", status: "blocked",
  waitFor: "the owner's own password for krenerd77@naver.com's Naver mail, since Claude mails that account's sign-in link there and the password saved in Aside fails since 10-27 (c178 keeps it off For you)",
  note: "Waits only on the owner's own password. Under c178 this stays off For you.", children: [] };
const p700: PlanItem = { id: "p700", text: "Every pool account stays signed in", status: "doing", children: [p1664] };
const board = { v: 2, rev: 1, updatedAt: "2026-11-23T21:40:00Z", todos: [], plan: [p700] } as unknown as ChatBoard;

test("a step that waits only on the owner's own password reads For you and never stalled_steps", () => {
  const first = checkInPrecheck(undefined, [], board, start, { self: [HARNESS] });
  const precheck = checkInPrecheck(first.memory, [], board, later, { self: [HARNESS] });
  const out = convergenceMisses(HARNESS, precheck.steps, precheck, {}, 15 * 60_000, later);
  assert.equal(precheck.steps.find(view => view.item.id === "p1664")?.cls, "foryou");
  assert.deepEqual(precheck.stalled, []);
  assert.equal(out.metrics.stalled_steps, 0);
  assert.deepEqual(out.flagged.filter(slice => slice.item === "p1664").map(slice => slice.kind), []);
});

test("the same step reads stalled once its wait names no sign-in prompt of the owner's", () => {
  const plain = { ...board, plan: [{ ...p700, children: [{ ...p1664, waitFor: "krenerd77@naver.com's Naver mail" }] }] } as ChatBoard;
  const first = checkInPrecheck(undefined, [], plain, start, { self: [HARNESS] });
  const precheck = checkInPrecheck(first.memory, [], plain, later, { self: [HARNESS] });
  assert.deepEqual(precheck.stalled.map(stall => stall.view.item.id), ["p1664"]);
});
