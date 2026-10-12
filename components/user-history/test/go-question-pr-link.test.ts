import assert from "node:assert/strict";
import { test } from "node:test";
import { gateFindings, gateLine } from "../src/checkin-findings.ts";
import { todoForStep } from "../src/checkin-steps.ts";
import { stepGo } from "../src/shared/chat-board.ts";
import type { ChatBoard, OwnerTodo, PlanItem } from "../src/shared/types.ts";

/*
 * slack green guy 10-13, check-in at 05:13 KST: the precheck said "For you has no question for it" on eleven merge steps that t18 asks by PR
 * number, and on five whose go is t17, because a todo can link one step. The steps and todos below are copied from that board at 05:16 KST
 * (p74 trimmed to its text; p74 is done, the rest open).
 */
const T17_STEPS = ["p57", "p85", "p82", "p83", "p86"];
const T18_STEPS = ["p115", "p97", "p101", "p102", "p116", "p120", "p121", "p119", "p112", "p50", "p124"];
const STEPS: PlanItem[] = [
    {"id": "p74", "text": "Ship: merge the CI minutes cut (PR #226) after the owner's go", "status": "done", "go": "needed", "children": []},
    {"id": "p109", "text": "Ship: merge the 30 minute free cap (#238) after the owner's approval", "status": "todo", "waitFor": "the owner's answer on t18, which names #238, then the M1 Air checks", "go": "needed", "children": []},
    {"id": "p115", "text": "Ship: merge the land skill change (#240) after the owner's approval", "status": "todo", "waitFor": "the owner's answer on t18, which names #240, then the M1 Air checks", "go": "needed", "children": []},
    {"id": "p97", "text": "Ship: merge the blog category fix (#235) after the owner's go, and check the SEO agent only writes allowed categories", "status": "todo", "waitFor": "the owner's answer on t18, which names #235, then the M1 Air checks", "go": "needed", "children": []},
    {"id": "p101", "text": "Ship: merge the on-topic visitor measure (#236, replaces #207) after the owner's go", "status": "todo", "waitFor": "the owner's answer on t18, which names #236, then the M1 Air checks", "go": "needed", "children": []},
    {"id": "p102", "text": "Ship: merge the phone setup hand-off screen (#237) after the owner's go", "status": "todo", "waitFor": "the owner's answer on t18, which names #237, then the M1 Air checks", "go": "needed", "children": []},
    {"id": "p116", "text": "Ship: merge the preview and speed-test filter (#241) after the owner's approval, then rerun both dashboard scripts", "status": "todo", "waitFor": "the owner's answer on t18, which names #241, then the M1 Air checks", "go": "needed", "children": []},
    {"id": "p120", "text": "Ship: merge the subscribe popup (#239) after the owner's approval", "status": "todo", "waitFor": "the owner's answer on t18, which now names #239, then the M1 Air checks", "go": "needed", "children": []},
    {"id": "p121", "text": "Ship: merge the blog Google button test (#246) and launch experiment 479904 after the owner's approval", "status": "todo", "waitFor": "the owner's answer on t18, which now names #246, then the M1 Air checks", "go": "needed", "children": []},
    {"id": "p119", "text": "Ship: merge the Active hours test (#245) and launch experiment 479899 after the owner's approval", "status": "todo", "waitFor": "the owner's answer on t18, which now names #245, then the M1 Air checks; which arms to launch is asked at launch", "go": "needed", "children": []},
    {"id": "p112", "text": "Ship: merge R1 to R3 one by one after the owner's approval of each", "status": "todo", "waitFor": "the owner's answer on t18, which now names #242, #243 and #244, then the M1 Air checks; merge in that order", "go": "needed", "children": []},
    {"id": "p50", "text": "Ship: merge the home hero test (#214) and the Google One Tap test (#213) and launch them after the owner's approval", "status": "blocked", "waitFor": "the owner's answer on t18, which now names #214 and #213, then the M1 Air checks", "go": "needed", "children": []},
    {"id": "p124", "text": "Ship: merge #234 (all slack-green checks on the M1 Air) after the owner's go on t18, then re-run #218, #229, #230, #231, #232 on the Air and merge them one by one", "status": "todo", "waitFor": "the owner's answer on t18, which names #234; #234 head 1308072 is green on the Air (run 38289995168)", "go": "needed", "children": []},
    {"id": "p57", "text": "Ship: merge validated onboarding replay into the shared app after owner go", "status": "blocked", "waitFor": "p124: #234 merged after the owner's go on t18, then a green re-run of #218 on the Air", "go": "needed", "children": []},
    {"id": "p85", "text": "Ship: merge the straight-to-setup fix (#231) after the owner's go", "status": "blocked", "waitFor": "p124: #234 merged after the owner's go on t18, then a green re-run of #231 on the Air", "go": "needed", "children": []},
    {"id": "p82", "text": "Ship: merge the signup page test (#229) and launch experiment 477145 after the owner's go", "status": "blocked", "waitFor": "p124: #234 merged after the owner's go on t18, then a green re-run of #229 on the Air", "go": "needed", "children": []},
    {"id": "p83", "text": "Ship: merge the QA visit filter for the dashboard script (#230) after the owner's go", "status": "blocked", "waitFor": "p124: #234 merged after the owner's go on t18, then a green re-run of #230 on the Air", "go": "needed", "children": []},
    {"id": "p86", "text": "Ship: merge the one-checkout-per-click fix (#232) after the owner's go", "status": "blocked", "waitFor": "p124: #234 merged after the owner's go on t18, then a green re-run of #232 on the Air", "go": "needed", "children": []},
];
const TODOS: OwnerTodo[] = [
    {"id": "t17", "text": "You okayed #226, #218, #229, #230, #231 and #232. GitHub checks can't run until the M1 Air runner works, likely Oct 13. When should they merge?", "done": true, "choices": ["Go: merge after the Air checks pass", "Go: merge now on the Vercel build", "Not yet"], "step": "p74", "from": "agent", "at": "2026-10-12T07:24:49.465Z", "reply": "Go: merge after the Air checks pass", "answeredBy": "owner"},
    {"id": "t18", "text": "Fifteen changes are ready, each merging only after its checks pass on the M1 Air: the switch moving checks onto the Air (#234, the rest wait on it), blog category names (#235), signup rate on real readers (#236), phone 'finish on your computer' screen (#237), free plan cut to 30 minutes (#238), subscribe popup (#239), every merge asks you first (#240), test visits out (#241), signup tests #214, #213, #245, #246, and sign-in routing #242, #243, #244 in order. Merge after the Air checks pass?", "done": false, "choices": ["Go: merge after the Air checks pass", "Hold some (tell me which)", "Not yet"], "step": "p109", "from": "agent", "at": "2026-10-12T07:45:18.331Z"},
];
const board = (plan: PlanItem[] = STEPS, todos: OwnerTodo[] = TODOS): ChatBoard =>
  ({ v: 2, rev: 1, plan: [{ id: "p48", text: "Ship the slack-green changes", status: "doing", children: plan }], scratch: [], todos, updatedAt: "2026-10-12T20:16:00.000Z" }) as ChatBoard;
const stepOf = (id: string): PlanItem => STEPS.find(step => step.id === id)!;

test("go question: a todo that names a step's PR asks about that step, though its step field links another one", () => {
  STEPS.find(step => step.id === "p74")!.status = "done";
  const gates = gateFindings(board(), []);
  for (const id of T18_STEPS) {
    const gate = gates.find(entry => entry.item.id === id);
    assert.equal(gate?.kind, "go_waiting", id);
    assert.equal(gate.kind === "go_waiting" ? gate.todo?.id : undefined, "t18", `${id} waits for the answer on t18`);
    assert.doesNotMatch(gateLine(gate), /no question for it/, id);
  }
  for (const id of T18_STEPS) assert.equal(todoForStep(stepOf(id), TODOS.filter(todo => !todo.done)), true, `${id} is For you on t18`);
});

test("go question: an answered go that names the PR of a merge step is that step's go, through its text or its waitFor", () => {
  for (const id of T17_STEPS) assert.equal(stepGo(board(), stepOf(id))?.id, "t17", id);
  assert.equal(gateFindings(board(), []).filter(gate => T17_STEPS.includes(gate.item.id)).length, 0, "the five have their go");
});

test("go question: a merge step whose PR no todo names still has no question, and a go on #231 is no go for #999", () => {
  const lone: PlanItem = { id: "p200", text: "Ship: merge the pricing page (#999) after the owner's go", status: "todo", go: "needed", children: [] };
  const gate = gateFindings(board([...STEPS, lone]), []).find(entry => entry.item.id === "p200")!;
  assert.match(gateLine(gate), /For you has no question for it/);
  assert.equal(todoForStep(lone, TODOS), false);
  const go231: OwnerTodo = { id: "t30", text: "Merge #231 now?", done: true, choices: ["Go", "Not yet"], reply: "Go", answeredBy: "owner", step: "p85", from: "agent", at: "2026-10-12T21:00:00.000Z" };
  assert.equal(stepGo(board(STEPS, [...TODOS, go231]), { ...lone, waitFor: "#231 merged first" }), null, "a go that names #231 does not name #999");
  assert.equal(stepGo(board(STEPS, [...TODOS, go231]), { id: "p201", text: "Ship: merge #999 and #231 after the owner's go", waitFor: "" }), null,
    "a go must name every PR the step's text names");
});
