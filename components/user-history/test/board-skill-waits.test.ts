// The board skill told chats that "the check-in leaves [a wait] alone until that time, or for 2 h after your last change", while the
// check-in's stuck count (`endState`) reads a wait with no mover as stuck on its next run. In the 24 h to 14:07Z on 10-23, 82 of the 132
// stuck-step flags in the check-ins outside the owner's Mac were such waits. These tests keep the skill's Waits section on the rule the code applies.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { endState } from "../src/checkin-end-state.ts";
import type { StepView } from "../src/checkin-steps.ts";
import type { PlanItem } from "../src/shared/types.ts";

const now = Date.parse("2026-10-23T14:00:00Z");
const view = (item: PlanItem): StepView => ({ item, mine: true, cls: "waiting", changedAt: now - 10 * 60_000 }) as unknown as StepView;
const step: PlanItem = { id: "p1", text: "Ship the staging fix", status: "doing", children: [] };

test("a wait the chat set 10 min ago with no mover reads stuck", () => {
  assert.equal(endState(view({ ...step, waitFor: "the staging update carries the fix" }), [], [], new Set(["chat"]), now).state, "event");
  assert.equal(endState(view({ ...step, waitUntil: "2026-10-23T16:00:00.000Z" }), [], [], new Set(["chat"]), now).state, "time");
});

test("the board skill's Waits section says a wait needs a mover and promises no 2 h grace", () => {
  const skill = readFileSync(new URL("../../../skills/board/SKILL.md", import.meta.url), "utf8");
  const waits = skill.slice(skill.indexOf("### Waits"));
  assert.doesNotMatch(waits, /leaves it alone/);
  assert.match(waits, /A wait needs something that moves it/);
  assert.match(waits, /`endState`/);
});
