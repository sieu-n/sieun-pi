// 10-25 06:05Z: d9 counted SEO guy's p101 as stuck. Its job field held the session id of the thread "sep launch!!", which ran on the offline
// Mac that For you t30 asked the owner to bring back, and it had no sessionId, so the step read as running on the chat's own box.
import assert from "node:assert/strict";
import { test } from "node:test";
import { pausedHold, type PlanInputs, planCounts } from "../scripts/duties/whole-system.ts";
import { stepSessions } from "../src/unmoved-steps.ts";
import type { ChatBoard } from "../src/shared/types.ts";

const THREAD = "01a15427-145f-751d-ba15-d27b6c30f65f";
const SEO = "01a11a24-a46e-77ff-adf7-671d01d462e2";
const hosts = new Map([[SEO, "us-metal02"], [THREAD, "mac"]]);
const holds = new Map([["mac", { host: "mac", todo: "t30" }]]);

test("a job field that holds a session id names that session, and a job name still resolves through the chat's jobs", () => {
  assert.deepEqual(stepSessions({ job: THREAD }, new Map()), [THREAD]);
  assert.deepEqual(stepSessions({ job: "seo indexing" }, new Map([["seo indexing", ["s-1"]]])), ["s-1"]);
  assert.deepEqual(stepSessions({ job: "seo indexing" }, new Map()), []);
});

test("a paused chat's step whose job is a session id on an offline box waits on the todo that asks the owner to bring it back", () => {
  assert.deepEqual(pausedHold({ job: THREAD }, SEO, new Map(), hosts, holds), { host: "mac", todo: "t30" });
  assert.equal(pausedHold({ job: "seo indexing" }, SEO, new Map(), hosts, holds), undefined);
});

// 10-25 08:19Z: d9 still counted p101 after the job-field fix, because the paused-chat path read only SEO guy's own todos, so its wait on
// sep launch!!'s open t30 held nothing, and no host hold applied once the catalog no longer placed that thread on the offline Mac.
test("a paused chat's blocked step that waits on another chat's open For you todo waits on the owner, wherever that chat runs", () => {
  const now = Date.parse("2026-10-25T08:19:41Z");
  const seo = { v: 2, rev: 1, updatedAt: "2026-10-25T06:10:00Z", todos: [], plan: [
    { id: "p56", text: "Reach 10,000 blog and tool visits a day on virev.ai", status: "doing", children: [
      { id: "p101", text: "Send Google indexing requests again once the owner's MacBook is back online", status: "blocked", job: THREAD, sessionId: THREAD,
        duty: "d2/new_unindexed_3d", children: [],
        waitFor: `${THREAD} t30 (owner brings the MacBook Pro online); then the box watcher sgu-mac-export wakes second google user, which copies sieun@virev.ai and runs both request windows` }] }] };
  const thread = { v: 2, rev: 1, updatedAt: "2026-10-23T13:52:19Z", plan: [], todos: [
    { id: "t30", text: "Your MacBook Pro has been offline on Tailscale since about 10:50Z. Can you wake it when you're back?", done: false, step: "p2", from: "agent", at: "2026-10-23T13:52:19.817Z" }] };
  const input = (todoDone: boolean): PlanInputs => ({ now, named: new Map(), poolWaiting: new Set<string>(), waking: new Set<string>(),
    ownerActivity: new Map([[THREAD, Date.parse("2026-10-23T10:50:00Z")]]),
    boards: new Map<string, unknown>([[SEO, seo], [THREAD, { ...thread, todos: thread.todos.map(todo => ({ ...todo, done: todoDone })) }]]) as Map<string, ChatBoard>,
    chats: [{ id: SEO, name: "SEO guy", runs: [], everyMs: 7_200_000, paused: true, duties: [] }] }) as unknown as PlanInputs;
  assert.deepEqual(planCounts(input(false)).stuck, []);
  assert.deepEqual(planCounts(input(true)).stuck.flatMap(entry => entry.items), ["p101"]);
});
