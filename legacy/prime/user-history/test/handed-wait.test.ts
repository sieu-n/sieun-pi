// vent on 10-28: p89 and p94 waited for "the next walked prod release" (c154) on the idle job "vent latest models only" with no wake and no
// todo. Each time the job's live window lapsed, vent's check-in and d9 read both stuck (d9 at 00:57Z read stuck_steps_all 3), and they cleared
// only after a push re-steered the job. CI and RepoOps' p476 "The next production release goes out with the owner's go" carries that release
// with the release owner, so a wait that names it hands the step to that chat, which counts p476 if nobody moves it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { endState } from "../src/checkin-end-state.ts";
import type { StepView } from "../src/checkin-steps.ts";
import { type PlanInputs, planCounts } from "../scripts/duties/whole-system.ts";
import { handedStep } from "../src/shared/todo-hold.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const VENT = "01a14dd5-e9d3-705d-bd63-245c21b2eee2";
const CI = "01a1180e-6567-747f-bf44-452520ebdd1b";
const now = Date.parse("2026-10-28T00:57:00Z");
const p476 = (status: PlanItem["status"]): PlanItem => ({ id: "p476", text: "The next production release goes out with the owner's go", status,
  job: "01a10810-34b5-710f-88fe-3d369f89a8c9", children: [] });
const ciBoard = (status: PlanItem["status"]): ChatBoard => ({ v: 2, rev: 1, updatedAt: "", todos: [], plan: [p476(status)] });
const p89 = (waitFor: string): PlanItem => ({ id: "p89", text: "Take PostHog and B2 out of Vent, so the apps call them directly", status: "blocked",
  job: "vent latest models only", sessionId: "01a17e5f-2a8b-7648-9367-9c8cb3414c76", waitFor, children: [] });
const BARE = "the next walked prod release; proven on staging 10-28";
const BY_ID = `${CI} p476 (the next walked prod release); proven on staging 10-28`;
const BY_NAME = "CI and RepoOps's p476, the next walked prod release; proven on staging 10-28";
const chats = [{ id: VENT, name: "vent" }, { id: CI, name: "CI and RepoOps" }];

test("a wait whose first clause names another chat's open step hands the step to that chat, by id or by name", () => {
  const others = new Map([[CI, ciBoard("todo")]]);
  assert.equal(handedStep(p89(BY_ID), new Set([VENT]), others)?.item.id, "p476");
  assert.equal(handedStep(p89(BY_NAME), new Set([VENT]), others, chats)?.chat, CI);
  assert.equal(handedStep(p89(BARE), new Set([VENT]), others, chats), undefined);
  assert.equal(handedStep(p89(BY_ID), new Set([VENT]), new Map([[CI, ciBoard("done")]])), undefined, "a closed step hands nothing: the wait is over");
  assert.equal(handedStep(p89(`proven on staging; ${CI} p476`), new Set([VENT]), others), undefined, "only the first clause names the blocker");
});

test("vent's check-in reads such a step moving, and the bare release wait stuck", () => {
  const view = (item: PlanItem): StepView => ({ item, mine: false, cls: "waiting", changedAt: now - 3 * 3_600_000 }) as unknown as StepView;
  const rows = chats.map(chat => ({ ...chat, archived: false }));
  const linked = new Map([[CI, ciBoard("todo")]]);
  assert.equal(endState(view(p89(BARE)), [], rows, new Set([VENT]), now, [], { linked }).state, "release");
  const handed = endState(view(p89(BY_NAME)), [], rows, new Set([VENT]), now, [], { linked });
  assert.equal(handed.state, "moving");
  assert.match(handed.reason, /its wait is on p476 "The next production release goes out.*" of chat CI and RepoOps, which owns it/);
  assert.equal(endState(view(p89(BY_ID)), [], rows, new Set([VENT]), now, [], { linked: new Map([[CI, ciBoard("done")]]) }).state, "release");
});

test("d9 counts a paused chat's step handed to another chat's open step as moved", () => {
  const plan = (wait: string, ci: PlanItem["status"]) => ({ now, chats: [{ id: VENT, name: "vent", runs: [], everyMs: 21_600_000, paused: true, duties: [] },
    { id: CI, name: "CI and RepoOps", runs: [], everyMs: 3_600_000, paused: false, duties: [] }],
  boards: new Map([[VENT, { v: 2, rev: 1, updatedAt: "", todos: [], plan: [p89(wait)] }], [CI, ciBoard(ci)]]), ownerActivity: new Map<string, number>(),
    waking: new Set<string>(), poolWaiting: new Set<string>(), named: new Map<string, Map<string, string[]>>() }) as unknown as PlanInputs;
  const stuck = (input: PlanInputs) => planCounts(input).stuck.flatMap(entry => entry.items);
  assert.deepEqual(stuck(plan(BARE, "todo")), ["p89"]);
  assert.deepEqual(stuck(plan(BY_NAME, "todo")), []);
  assert.deepEqual(stuck(plan(BY_ID, "done")), ["p89"]);
});
