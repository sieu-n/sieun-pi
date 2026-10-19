// Guards the Chat system duty's precheck (d9), built 10-19 for the owner's rule that a plan holds only tasks that finish (msg mvfb7zt0).
import assert from "node:assert/strict";
import { test } from "node:test";
import { chatSystemOutput, ownerMessages, planUpkeep, spread } from "../scripts/duties/chat-system.ts";
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
    fleet: { pct: 50, red: [] }, stuckDuties: [], detail: "/tmp/d9.md" });
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
