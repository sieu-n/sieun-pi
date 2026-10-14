import assert from "node:assert/strict";
import { test } from "node:test";
import { gateFindings, gateLine } from "../src/checkin-findings.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import { mergedPrs, stepGo } from "../src/shared/chat-board.ts";
import type { ChatBoard, OwnerTodo, PlanItem } from "../src/shared/types.ts";

/*
 * slack green guy 10-14, check-in at 11:31 KST: go_missing on p94 though the owner chose "Go: turn it on" on t16, which names #247, the PR p94
 * waits for, and links p71. The same check read t17 (linked to p74) as no go for p82, p83, p85 and p86, and t18 (linked to p109) as no go for
 * p101. The steps and todos below are copied from that board at rev 827 (12:18 KST).
 */
const STEPS: PlanItem[] = [
  {"id": "p71", "text": "Ship: turn the reminder on in production after the owner sees the email", "status": "doing", "go": "needed", "note": "Owner chose Go on t16 Oct 14. #225 needs migration 033, POSTHOG_API_KEY and CONNECT_REMINDER_ENABLED=true on the Railway worker (hourly job, 11 people due now). Gap found: #225 does not check #247's setup_email_count, so a phone user could get 3 emails; approved merges adds the check in the #225 rebase, and the reminder flag stays off until it is on main.", "job": "signup emails on", "children": []},
  {"id": "p74", "text": "Ship: merge the CI minutes cut (PR #226) after the owner's go", "status": "done", "job": "merge ci minutes cut", "go": "needed", "note": "Merged Oct 13 03:17 KST as 715c39d with the owner's go on t17 (guard accepted OWNER_OK naming t17). Vercel production deploy for it is Ready; Railway skipped (no backend paths). #234 rebased to 1308072 and green on the Air (run 38289995168). Main's hosted CI run failed on the billing block, expected until #234 merges.", "children": []},
  {"id": "p94", "text": "Ship: turn on the phone setup link email after the owner's go, at most 2 emails with the 24 h reminder", "status": "todo", "waitFor": "signup emails on: #247 merged by approved merges, then PHONE_SETUP_EMAIL_AUTO_ENABLED=true on Vercel", "go": "needed", "note": "Go is t16: its text names PR #247 and the owner chose Go, but the board links t16 to p71 only. signup emails on turns PHONE_SETUP_EMAIL_AUTO_ENABLED on after approved merges merges #247.", "job": "signup emails on", "sessionId": "01a137fe-8e8b-71c2-9dcb-f6c317084c69", "children": []},
  {"id": "p109", "text": "Ship: merge the 30 minute free cap (#238) after the owner's approval", "status": "todo", "waitFor": "p124: #234 merged, then a green Air run of #238", "go": "needed", "note": "Moved under p48 because p106 closed. #238 is asked on t18 with 5 other PRs.", "job": "approved merges", "children": []},
  {"id": "p124", "text": "Ship: merge #234 (all slack-green checks on the M1 Air) after the owner's go on t18", "status": "done", "go": "needed", "note": "#234 merged as 76a3a2f on Oct 14 with the t18 go, after Air run 38495588564 went green (Frontend 1341, Backend 82). Slack Green CI now runs on the M1 Air.", "job": "approved merges", "children": []},
  {"id": "p82", "text": "Ship: merge the signup page test (#229) and launch experiment 477145 after the owner's go", "status": "blocked", "waitFor": "p124: #234 merged after the owner's go on t18, then a green re-run of #229 on the Air", "go": "needed", "note": "Go is t17. Checked Oct 13 05:15 KST: #229 open and unmerged.", "job": "approved merges", "children": []},
  {"id": "p83", "text": "Ship: merge the QA visit filter for the dashboard script (#230) after the owner's go", "status": "blocked", "waitFor": "p124: #234 merged after the owner's go on t18, then a green re-run of #230 on the Air", "go": "needed", "note": "Go is t17. Checked Oct 13 05:15 KST: #230 open and unmerged.", "job": "approved merges", "children": []},
  {"id": "p85", "text": "Ship: merge the straight-to-setup fix (#231) after the owner's go", "status": "blocked", "waitFor": "p124: #234 merged after the owner's go on t18, then a green re-run of #231 on the Air", "go": "needed", "note": "Go is t17. Checked Oct 13 05:15 KST: #231 open and unmerged.", "job": "approved merges", "children": []},
  {"id": "p86", "text": "Ship: merge the one-checkout-per-click fix (#232) after the owner's go", "status": "blocked", "waitFor": "p124: #234 merged after the owner's go on t18, then a green re-run of #232 on the Air", "go": "needed", "note": "Go is t17. Checked Oct 13 05:15 KST: #232 open and unmerged.", "job": "approved merges", "children": []},
  {"id": "p101", "text": "Ship: merge the on-topic visitor measure (#236, replaces #207) after the owner's go", "status": "todo", "waitFor": "p124: #234 merged, then a green Air run of #236", "go": "needed", "job": "approved merges", "children": []},
  {"id": "p130", "text": "Ship: merge the store return test (#250) after the owner's approval, check one real Add to Chrome return on the preview, then launch experiment 482542", "status": "todo", "waitFor": "the owner's answer on the #250 todo, then a green Air run", "go": "needed", "children": []},
];
const TODOS: OwnerTodo[] = [
  {"id": "t16", "text": "Two emails for signups who haven't connected Slack, at most 2 per person: one reminder 24 hours after signup (about 11 people in the first run), and the setup link sent once when someone first opens setup on a phone (PR #247). Turn them on?", "done": true, "choices": ["Go: turn it on", "Not yet"], "step": "p71", "from": "agent", "at": "2026-10-12T07:16:43.025Z", "reply": "Go: turn it on", "answeredBy": "owner"},
  {"id": "t17", "text": "You okayed #226, #218, #229, #230, #231 and #232. GitHub checks can't run until the M1 Air runner works, likely Oct 13. When should they merge?", "done": true, "choices": ["Go: merge after the Air checks pass", "Go: merge now on the Vercel build", "Not yet"], "step": "p74", "from": "agent", "at": "2026-10-12T07:24:49.465Z", "reply": "Go: merge after the Air checks pass", "answeredBy": "owner"},
  {"id": "t18", "text": "Seventeen changes are ready, each merging only after its checks pass on the M1 Air: checks move to the Air (#234, the rest wait on it), blog categories (#235), signup rate on real readers (#236), phone 'finish on your computer' screen (#237), free plan cut to 30 minutes (#238), subscribe popup (#239), every merge asks you first (#240), test visits out (#241), signup tests #214, #213, #245, #246, #248, #249, and sign-in routing #242, #243, #244 in order. Merge after the Air checks pass?", "done": true, "choices": ["Go: merge after the Air checks pass", "Hold some (tell me which)", "Not yet"], "step": "p109", "from": "agent", "at": "2026-10-12T07:45:18.331Z", "reply": "Go: merge after the Air checks pass", "answeredBy": "owner"},
  {"id": "t19", "text": "New test for setup is ready (#250). Today 33 of every 100 people who click Add to Chrome never come back. With this test, the Chrome store opens in a small window, setup remembers where they were, and they see 'Welcome back' with one button to go on. It stays off until you say to start it. Merge #250 once its checks pass?", "done": false, "choices": ["Go: merge after the Air checks pass", "Not yet"], "step": "p130", "from": "agent", "at": "2026-10-14T01:37:12.021Z"},
];
const board = (plan: PlanItem[] = STEPS, todos: OwnerTodo[] = TODOS): ChatBoard =>
  ({ v: 2, rev: 827, plan: [{ id: "p48", text: "Ship the slack-green changes", status: "doing", children: plan }], scratch: [], todos, updatedAt: "2026-10-14T03:18:21.746Z" }) as ChatBoard;
const stepOf = (id: string): PlanItem => STEPS.find(step => step.id === id)!;
const SIGNUP_EMAILS: JobFact = { key: "thread:01a137fe-8e8b-71c2-9dcb-f6c317084c69", name: "signup emails on", state: "working", sessionId: "01a137fe-8e8b-71c2-9dcb-f6c317084c69" };

test("answered go by PR: t16 names #247, the PR p94 waits for, so p94 at work has the owner's go though t16 links p71", () => {
  assert.equal(stepGo(board(), stepOf("p94"))?.id, "t16");
  const gates = gateFindings(board(), [SIGNUP_EMAILS]);
  assert.equal(gates.find(gate => gate.item.id === "p94"), undefined, "no go_missing on p94");
});

test("answered go by PR: t17 stays the go of p82, p83, p85 and p86, though the later t18 names #234, the PR they wait for", () => {
  for (const id of ["p82", "p83", "p85", "p86"]) assert.equal(stepGo(board(), stepOf(id))?.id, "t17", id);
  const gates = gateFindings(board(), []).filter(gate => ["p82", "p83", "p85", "p86"].includes(gate.item.id));
  assert.deepEqual(gates.map(gateLine), [], "no 'For you has no question for it' on the four");
  const holdWait: OwnerTodo = { id: "t22", text: "Hold #234 for now?", done: true, choices: ["Hold", "Merge"], reply: "Hold", answeredBy: "owner", step: "p130", from: "agent", at: "2026-10-14T03:30:00.000Z" };
  assert.equal(stepGo(board(STEPS, [...TODOS, holdWait]), stepOf("p82"))?.id, "t17", "a hold on #234, which p82 only waits for, leaves its go on #229");
});

test("answered go by PR: t18 names #236, so it is p101's go; the #207 that p101 replaces is not a PR it merges", () => {
  assert.deepEqual(mergedPrs(stepOf("p101").text), ["236"]);
  assert.equal(stepGo(board(), stepOf("p101"))?.id, "t18");
  assert.equal(gateFindings(board(), []).find(gate => gate.item.id === "p101"), undefined);
});

test("answered go by PR, control: a step whose PR no answered go names is still flagged", () => {
  const gates = gateFindings(board(), [SIGNUP_EMAILS]);
  const p130 = gates.find(gate => gate.item.id === "p130");
  assert.equal(p130?.kind === "go_waiting" ? p130.todo?.id : undefined, "t19", "p130 (#250) waits for the open t19");
  const p95: PlanItem = { ...stepOf("p94"), id: "p95", waitFor: "#999 merged, then PHONE_SETUP_EMAIL_AUTO_ENABLED=true on Vercel", note: "" };
  assert.equal(gateFindings(board([...STEPS, p95]), [SIGNUP_EMAILS]).find(gate => gate.item.id === "p95")?.kind, "go_missing", "a go on #247 is no go for a step on #999");
  assert.equal(stepGo(board(), { id: "p200", text: "Ship: merge #229 and #999 after the owner's go" }), null, "a merge needs a go that names each PR it merges");
  const hold: OwnerTodo = { id: "t21", text: "Hold #229 for now?", done: true, choices: ["Hold", "Merge"], reply: "Hold", answeredBy: "owner", step: "p130", from: "agent", at: "2026-10-14T03:30:00.000Z" };
  assert.equal(stepGo(board(STEPS, [...TODOS, hold]), stepOf("p82")), null, "a later hold that names #229 takes t17's go on p82 back");
});

/*
 * The same board at rev 827: p133 waits for "t20: the owner's go (For you)", and t20 links p132, the goal above it. The check-in said For you had
 * no question for p133.
 */
const P133: PlanItem = {"id": "p133", "text": "Ship: make a new Resend key, switch the app to it, cancel the old one and delete the script, after the owner's go on t20", "status": "todo", "waitFor": "t20: the owner's go (For you)", "go": "needed", "children": []};
const T20: OwnerTodo = {"id": "t20", "text": "The password our app uses to send email (Resend) is written in plain text in an old script in our code. The code is private, but anyone with access can read it. Can I make a new one, switch the app over to it, cancel the old one and delete that script? Emails keep sending during the switch.", "done": false, "choices": ["Go: make a new one", "Not yet"], "step": "p132", "from": "agent", "at": "2026-10-14T01:50:34.522Z"};

test("answered go by todo id: a step that names t20 is covered by t20, so p133 waits on it, and a go on t20 is p133's go", () => {
  const gate = gateFindings(board([...STEPS, P133], [...TODOS, T20]), []).find(entry => entry.item.id === "p133");
  assert.equal(gate?.kind === "go_waiting" ? gate.todo?.id : undefined, "t20");
  assert.doesNotMatch(gateLine(gate!), /no question for it/);
  const go: OwnerTodo = { ...T20, done: true, reply: "Go: make a new one", answeredBy: "owner" };
  assert.equal(stepGo(board([...STEPS, P133], [...TODOS, go]), P133)?.id, "t20");
});

test("answered go by todo id, control: a step that names a todo whose answer is no go, or a todo not answered, still has no go", () => {
  const held: OwnerTodo = { ...T20, done: true, reply: "Not yet", answeredBy: "owner" };
  assert.equal(stepGo(board([...STEPS, P133], [...TODOS, held]), P133), null, "a Not yet on t20 is no go for p133");
  const atWork: PlanItem = { ...P133, status: "doing" };
  assert.equal(gateFindings(board([...STEPS, atWork], [...TODOS, held]), []).find(gate => gate.item.id === "p133")?.kind, "go_missing");
  const onT19: PlanItem = { ...P133, id: "p134", status: "doing", text: "Ship: launch experiment 482542 after the owner's go on t19", waitFor: "t19" };
  assert.equal(gateFindings(board([...STEPS, onT19], [...TODOS, T20]), []).find(gate => gate.item.id === "p134")?.kind, "go_missing", "t19 is not answered");
  const onT2: PlanItem = { ...P133, id: "p135", text: "Ship: rotate the key after the owner's go on t2", waitFor: "t2" };
  const go: OwnerTodo = { ...T20, done: true, reply: "Go: make a new one", answeredBy: "owner" };
  assert.equal(stepGo(board([...STEPS, onT2], [...TODOS, go]), onT2), null, "a step that names t2 is not about t20");
});
