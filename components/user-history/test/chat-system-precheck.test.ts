// Guards the Chat system duty's precheck (d9), built 10-19 for the owner's rule that a plan holds only tasks that finish (msg mvfb7zt0).
import assert from "node:assert/strict";
import { test } from "node:test";
import { chatSystemOutput, goalsWithNoJob, ownerMessages, planUpkeep, pushList, pushReached, spread } from "../scripts/duties/chat-system.ts";
import type { ChatBoard } from "../src/shared/types.ts";

const board = { v: 2, rev: 1, updatedAt: "2026-10-19T13:40:00Z", todos: [], plan: [
  { id: "p453", text: "Every duty in every chat is green", status: "doing", note: "Done when 109 of 109", children: [
    { id: "p454", text: "Fix the cache read share metric", status: "doing", children: [] },
    { id: "p455", text: "Fix the wiki search", status: "doing", note: "Done when a search for crawler finds the page", children: [] },
    { id: "p456", text: "Lift cache reads", status: "todo", duty: "d7/cache_ratio", children: [] },
    { id: "p457", text: "Ship the old fix", status: "done", children: [] }] },
] } as unknown as ChatBoard;

test("plan_upkeep_all counts an open upkeep item and an open step with no done line, once each", () => {
  assert.deepEqual(planUpkeep("c1", board).map(item => [item.id, item.why]),
    [["p453", 'reads like upkeep ("Every duty in every chat is green")'], ["p454", "has no Done when line"]]);
});

test("examples spread over chats and stop at 3, while the count line names every item and the detail file", () => {
  const items = ["a", "a", "a", "b", "c"].map((chat, index) => ({ chat, id: `p${index}`, text: `step ${index}`, why: "has no Done when line" }));
  assert.deepEqual(spread(items, 3).map(item => item.chat), ["a", "b", "c"]);
  const out = chatSystemOutput({ names: new Map([["a", "chat A"]]), stuck: [{ chat: "a", id: "p9", text: "Fix X" }], upkeep: items,
    fleet: { pct: 50, red: [] }, stuckDuties: [], idleGoals: [], followUps: [], detail: "/tmp/d9.md" });
  assert.deepEqual(out.metrics, { stuck_steps_all: 1, plan_upkeep_all: 5, duties_green_pct: 50, stuck_duties: 0 });
  const upkeep = out.flagged!.filter(slice => slice.kind === "plan_upkeep");
  assert.equal(upkeep.length, 4);
  assert.match(upkeep[0]!.excerpt, /^5 open plan items .* in 3 chats; every one is in \/tmp\/d9\.md\.$/);
  assert.match(upkeep[1]!.excerpt, /^chat A: p0 "step 0" has no Done when line\.$/);
});

test("the spot audit quotes the owner's own messages and his board picks, never a job's or check-in's line", () => {
  const line = (text: string) => JSON.stringify({ type: "message", timestamp: "2026-10-19T13:40:00Z", message: { role: "user", content: [{ type: "text", text }] } });
  const lines = [line("keep crawler working"), line("[job] x failed"), line("[check-in] restarted y"), line('[board] Owner chose "Keep it"'),
    JSON.stringify({ message: { role: "assistant", content: "ok" } })];
  assert.deepEqual(ownerMessages(lines, 8).map(entry => entry.text), ["keep crawler working", '[board] Owner chose "Keep it"']);
});

// Owner msg mvffndxl, 10-19: each d9 run pushes the chats, not just scores them.
test("a goal counts as having no live job only when none of its open items has a live owner on either box", () => {
  const now = Date.parse("2026-10-19T16:00:00Z");
  const goals = { v: 2, rev: 1, updatedAt: "2026-10-19T15:00:00Z", todos: [], plan: [
    { id: "p1", text: "Ship A", status: "doing", children: [{ id: "p2", text: "Fix A", status: "doing", sessionId: "s-local", children: [] }] },
    { id: "p3", text: "Ship B", status: "doing", children: [{ id: "p4", text: "Fix B", status: "doing", job: "mac job", children: [] }] },
    { id: "p5", text: "Ship C", status: "doing", children: [{ id: "p6", text: "Fix C", status: "todo", children: [] }] },
    { id: "p7", text: "Ship D", status: "done", children: [] }] } as unknown as ChatBoard;
  const reads = { now, named: new Map(), activity: new Map([["s-local", now - 5 * 60_000]]), waking: new Set<string>(), poolWaiting: new Set<string>(),
    jobs: [{ sessionId: "s-mac", sessionName: "mac job", activity: "working" }] };
  assert.deepEqual(goalsWithNoJob(goals, reads).map(goal => goal.id), ["p5"]);
  assert.deepEqual(goalsWithNoJob(goals, { ...reads, jobs: [], activity: new Map([["s-local", now - 3 * 3_600_000]]) }).map(goal => goal.id), ["p1", "p3", "p5"]);
});

test("the push list joins a chat's idle goals and stuck duties, and the follow-up reads the tag and an answer after it", () => {
  const goal = { id: "p5", text: "Ship C", status: "doing", children: [] } as unknown as ChatBoard["plan"][number];
  assert.deepEqual(pushList({ idleGoals: [{ chat: "a", goals: [goal] }, { chat: "b", goals: [] }], stuckDuties: [{ chat: "a", line: "a: d1 red" }, { chat: "c", line: "c: d2 red" }], upkeep: [] })
    .map(entry => [entry.chat, entry.goals.length, entry.duties.length]), [["a", 1, 1], ["c", 0, 1]]);
  const tag = "[d9 push 2026-10-19T16:00Z]";
  const sent = JSON.stringify({ type: "custom_message", customType: "agent_message", content: `[agent-message from x]\n\n${tag} give p5 a job` });
  const answer = JSON.stringify({ type: "message", message: { role: "assistant", content: "on it" } });
  assert.deepEqual(pushReached([sent], tag), { delivered: true, read: false });
  assert.deepEqual(pushReached([answer, sent, answer], tag), { delivered: true, read: true });
  assert.deepEqual(pushReached([answer], tag), { delivered: false, read: false });
});

test("a chat whose only miss is plan items with no done line is on the push list with those items", () => {
  // 10-19 20:22Z: 26 such items sat in 6 chats, and 4 of the chats (Crawler VP with 7) were on no push list, so no run messaged them.
  const upkeep = planUpkeep("d", board);
  const pushes = pushList({ idleGoals: [], stuckDuties: [{ chat: "c", line: "c: d2 red" }], upkeep });
  assert.deepEqual(pushes.map(entry => [entry.chat, entry.duties.length, entry.upkeep.map(item => item.id)]), [["c", 1, []], ["d", 0, ["p453", "p454"]]]);
  const output = chatSystemOutput({ names: new Map(), stuck: [], upkeep, fleet: { pct: 100, red: [] }, stuckDuties: [], idleGoals: [], followUps: [], detail: "/tmp/d.md" });
  assert.ok(output.flagged?.some(slice => slice.kind === "push" && slice.excerpt.includes("plan item")));
});
