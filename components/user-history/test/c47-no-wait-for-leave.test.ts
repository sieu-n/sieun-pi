import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck, checkInPrecheckText } from "../src/chat-checkin.ts";
import { briefCheck, briefCheckNote } from "../src/shared/brief-check.ts";
import { applyBoardOp, BoardError, emptyBoard, goWait, leaveAsk, nextIds, parseBoardOps, stepGoWait } from "../src/shared/chat-board.ts";
import type { BoardActor, BoardOp, ChatBoard, PlanItem } from "../src/shared/types.ts";

// c47, repeated by the owner 10-12: "look, be fucking aggressive. it's ok to break things. just make it work. NEVER wait for something, or ask
// for my permission to push to Github etc." and "especially staging". The cases are real board lines and briefs from 10-10 to 10-12.
const T1 = "2026-10-12T15:00:00.000Z";
function run(board: ChatBoard, ops: unknown[], actor: BoardActor = "agent"): ChatBoard {
  for (const op of parseBoardOps(ops)) board = applyBoardOp(board, op as BoardOp, actor, T1, nextIds(board)).board;
  return board;
}
const refused = (board: ChatBoard, ops: unknown[], pattern: RegExp): void =>
  assert.throws(() => run(board, ops), error => error instanceof BoardError && error.kind === "forbidden" && pattern.test(error.message), JSON.stringify(ops));
const goal = (): ChatBoard => run(emptyBoard("2026-10-12T14:00:00.000Z"), [{ op: "plan_add", text: "Ship flow for other agents" }]);

test("c47: the board refuses a non-production step that waits on another thread's go, word or slot, or on the owner's ok for a push", () => {
  const board = goal();
  const waits: [string, string][] = [
    ["Build: Convex webhook ledger", "Fable's 'land 32b ON STAGING' word (about 14:15 to 14:20Z); then push objects 0233fe1271 to a fresh ci ref"],
    ["First-in-first-out probe dispatcher", "Fable's 'on staging' word, then a re-push of the combined run"],
    ["Fix the 5 routes whose answers differ from the crawler", "CI keeper's 32b on staging call, then push fifth in line"],
    ["CI test run for the wiki dream commits", "Fable's go for our slot about 06:45Z"],
    ["Build: two more TikTok signers", "land 32b probe, TikTok Shop stack item 8 at about 06:50Z in Fable's order"],
    ["Push the ci/ fix for the e2e test", "the owner's ok"],
    ["Land the Inbox fix on staging", "your go"],
  ];
  for (const [text, waitFor] of waits) refused(board, [{ op: "plan_add", parent: "p1", text, waitFor, status: "blocked" }], /wait.*\(c47, c50; the owner 10-12/);
  refused(board, [{ op: "plan_add", parent: "p1", text: "Push the stack to a ci/ ref after Fable's go" }], /another thread's go, word or slot \("Fable's go"\)/);
  refused(board, [{ op: "plan_add", parent: "p1", text: "Land 32b on staging once the owner approves" }], /the owner's ok on a push or a staging land/);
});

test("c47: production, real events, rule text and steps the change leaves alone pass the board", () => {
  const board = goal();
  const pass = (op: Record<string, unknown>) => assert.doesNotThrow(() => run(board, [{ op: "plan_add", parent: "p1", status: "blocked", ...op }]), JSON.stringify(op));
  pass({ text: "Ship: promote land 33 to prod tonight", waitFor: "Fable's go after staging checks out" });
  pass({ text: "Ship: merge it so Railway deploys the worker", waitFor: "the owner's go on t13 for #233" });
  pass({ text: "Ship: turn on the phone setup email", waitFor: "the owner's go on the reminder email ask in For you" });
  pass({ text: "Ship: publish extension 1.3 to the Chrome Web Store", waitFor: "the owner's go" });
  pass({ text: "Verify: walk Inbox on staging", waitFor: "land 32b on staging (dispatched 12:18Z, ETA 13:05 to 13:20Z)" });
  pass({ text: "Fix: stop and ramp rules judge job outcomes", waitFor: "verify-dev 38259504939 green, then the job's commit" });
  pass({ text: "Build: tool pages from the keyword list", waitFor: "Owner says 5180 is good enough" });
  pass({ text: "Push ci/ refs without waiting for Fable's word" });
  // A step written before the check keeps working: a note edit or a status change does not trip it, a new wait does.
  const old: PlanItem = { id: "p2", text: "Re-push the combined run", status: "doing", waitFor: "Fable's 'on staging' word", children: [] };
  const legacy: ChatBoard = { ...board, plan: [{ ...board.plan[0]!, children: [old] }] };
  assert.doesNotThrow(() => run(legacy, [{ op: "plan_update", id: "p2", note: "chased Fable at 14:20Z" }, { op: "plan_update", id: "p2", status: "blocked" }]));
  refused(legacy, [{ op: "plan_update", id: "p2", waitFor: "Fable's go for our slot" }], /c47/);
  assert.doesNotThrow(() => run(legacy, [{ op: "plan_update", id: "p2", waitFor: null }]), "clearing the wait is the fix");
});

test("c47: an agent todo that asks the owner's leave for a push, a staging land or another thread's slot is refused", () => {
  const board = goal();
  const asks = [
    { text: "Go on staging the deep-walk fixes after the green land-31 probe? They let a year walk continue; prod stays unchanged.", choices: ["Go after green probe", "Not yet"] },
    { text: "Approve the next staging release? It carries the crawler and Watchlist fixes. Prod stays as it is.", choices: ["Yes, approve for staging", "No"] },
    { text: "Go ahead with the reviewed CI fixes through Fable's probe slots and the release owner's land flow?", choices: ["Go through the reviewed ship flow", "Not yet"] },
    { text: "Can we push the ci/ fix for the signed-in e2e test?", choices: ["Yes, push it", "Not yet"] },
  ];
  for (const ask of asks) {
    assert.equal(leaveAsk(ask), true, ask.text);
    refused(board, [{ op: "todo_add", ...ask }], /asks the owner for leave on a non-production move/);
  }
  const keeps = [
    { text: "Can the release owner promote land 33 to prod tonight, once staging checks out?", choices: ["Yes, promote tonight", "Wait for me"] },
    { text: "The token expired email removal is ready (PR #233). Merge it?", choices: ["Go: merge now", "Not yet"] },
    { text: "Land 32b goes to staging first. Once it works there, can we put it on prod too?", choices: ["Yes, put it on prod", "Not yet"] },
    { text: "Seven sessions pushed straight to the dev branch today. They can, because every agent shares your token.", choices: ["Yes, I'll create the token", "Not now"] },
    { text: "Which staging sign-in route should the walk use?", choices: ["Clerk test user", "Google"] },
  ];
  for (const ask of keeps) {
    assert.equal(leaveAsk(ask), false, ask.text);
    assert.doesNotThrow(() => run(board, [{ op: "todo_add", ...ask }]), ask.text);
  }
});

test("c47: a brief that has the job wait for another thread's word or the owner's ok is a brief check finding", () => {
  const owner = [{ text: "just make it work", at: 1_000 }];
  const brief = (task: string) => `Owner's words (verbatim):\n1. "just make it work"\nMy read: VP of CI held ci/ pushes for Fable's "ON STAGING" word.\nSplit: inline.\n${task}`;
  const check = (task: string) => briefCheck({ brief: brief(task), owner, turnOwner: owner[0]!, previousSpawnAt: null }).filter(finding => finding.kind === "waits-for-leave");
  assert.deepEqual(check("Build the stack. Push to a fresh ci/ ref only after I relay Fable's word."), [{ kind: "waits-for-leave", wait: { kind: "thread", phrase: "Fable's word" } }]);
  assert.deepEqual(check("CI pushes wait until I relay Fable's land 32b on staging call."), [{ kind: "waits-for-leave", wait: { kind: "thread", phrase: "on staging call" } }]);
  assert.deepEqual(check("Land it on staging after the owner's ok."), [{ kind: "waits-for-leave", wait: { kind: "owner", phrase: "the owner's ok" } }]);
  assert.deepEqual(check("Build the stack and push your ci/ ref, then land it on staging."), [], "My read may say what went wrong");
  assert.deepEqual(check("The chat merges after the owner's go. Promote to prod only after his go on that PR (c49)."), [], "production keeps the go");
  assert.deepEqual(check("Never ask the owner to confirm a staging land or deploy; never merge a PR into production without his go on a For you todo (c49)."), []);
  assert.deepEqual(check("- c50 Staging deploys and lands never need the owner's confirmation; ship to staging when checks are green and ask only for prod promotes."), []);
  const note = briefCheckNote("ci fixes", [{ kind: "waits-for-leave", wait: { kind: "thread", phrase: "Fable's word" } }]);
  assert.match(note, /^\[brief check\] Your brief for \[ci fixes\]\(job:ci fixes\) breaks the Jobs rule:\n- It has the job wait: it waits for another thread's go, word or slot \("Fable's word"\)\. Staging, sieun\/dev, ci\/ and other GitHub pushes/);
  assert.equal(goWait("metal GO about 14:00Z", { cued: true })?.phrase, "GO");
  assert.equal(goWait("OK?"), null, "a plain question is no wait");
});

test("c47: the check-in lists an open step written before the check that waits for leave", () => {
  const plan: PlanItem[] = [{ id: "p1", text: "Ship flow for other agents", status: "doing", children: [
    { id: "p2", text: "Re-push the combined run", status: "doing", waitFor: "Fable's 'on staging' word", children: [] },
    { id: "p3", text: "Ship: promote land 33 to prod", status: "blocked", waitFor: "Fable's go", children: [] },
  ] }];
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: T1, scratch: [], todos: [], plan };
  assert.deepEqual(stepGoWait(plan[0]!.children[0]!), { kind: "thread", phrase: "Fable's 'on staging' word" });
  const precheck = checkInPrecheck(undefined, [], board, Date.parse(T1));
  assert.deepEqual(precheck.facts.filter(fact => fact.includes("c47")), [`p2 "Re-push the combined run" waits for another thread's go, word or slot ("Fable's 'on staging' word"), ` +
    "a wait nobody needs (c47): take the action now and clear the waitFor"]);
  assert.match(checkInPrecheckText(precheck, [], [], Date.parse(T1)), /### Other facts\n- p2 .*c47/);
});
