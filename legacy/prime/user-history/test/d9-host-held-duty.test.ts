// 10-26 11:13 KST: d9 read stuck_duties 1 for slack green guy's d1 (home_test_reach_pct 83.3 against >= 90) alone. That chat's session lived on
// the owner's Mac, which Tailscale read offline, so no duty job and no push could reach it: the
// duty runner's launch read "the catalog does not list the chat" on every run. A red duty of a chat on an offline box waits for the box,
// as a step whose job runs there does, and counts as stuck again once the box answers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chatSystemOutput, hostGroups } from "../scripts/duties/chat-system.ts";
import { type PlanInputs, planCounts } from "../scripts/duties/whole-system.ts";
import type { ChatBoard } from "../src/shared/types.ts";

const now = Date.parse("2026-10-26T02:13:00Z");
const SLACK = "01a11b0b-7c15-73da-9481-8de15903eab4";
const run = { duty: "d1", at: now - 60_000, trigger: "push", verdict: "missed", ms: 8000, summary: "skipped: the catalog does not list the chat",
  metrics: { home_test_reach_pct: { value: 83.3, target: 90, op: ">=", met: false } } };
const board = { v: 2, rev: 1, updatedAt: "2026-10-25T08:00:00Z", todos: [], plan: [] } as unknown as ChatBoard;
const inputs = (away: string[]): PlanInputs => ({ now, chats: [{ id: SLACK, name: "slack green guy", runs: [run], everyMs: 3_600_000, paused: false,
  duties: [{ id: "d1", name: "Visitors become paying users" }] }], boards: new Map([[SLACK, board]]), ownerActivity: new Map(),
  waking: new Set<string>(), poolWaiting: new Set<string>(), named: new Map(), hosts: new Map([[SLACK, "mac"]]), away: new Set(away),
  holds: new Map(away.map(host => [host, { host }])) }) as unknown as PlanInputs;

test("a red duty of a chat on an offline box is host-held, and counts as stuck once the box answers", () => {
  const held = planCounts(inputs(["mac"]));
  assert.equal(held.redDuties.length, 0);
  assert.deepEqual(held.hostHeld.map(item => [item.chat.id, item.id, item.host, item.duty]), [[SLACK, "d1", "mac", "Visitors become paying users"]]);
  const back = planCounts(inputs([]));
  assert.equal(back.redDuties.length, 1);
  assert.deepEqual(back.hostHeld, []);
});

test("the host-held line names the held duty beside the held steps, and stuck_duties leaves it out", () => {
  const hostHeld = [{ chat: SLACK, id: "d1", host: "mac", duty: "Visitors become paying users" },
    { chat: "01a11ba8", id: "p330", host: "mac" }, { chat: "01a11ba8", id: "p332", host: "mac" }];
  assert.equal(hostGroups(hostHeld)[0]!.title, "2 steps and 1 red duty wait on mac");
  const out = chatSystemOutput({ names: new Map([[SLACK, "slack green guy"]]), stuck: [], upkeep: [], fleet: { pct: 90, red: [] }, stuckDuties: [],
    idleGoals: [], followUps: [], detail: "/tmp/d9.md", hostHeld });
  assert.equal(out.metrics.stuck_duties, 0);
  const line = out.flagged!.find(slice => slice.kind === "host_held")!.excerpt;
  assert.match(line, /^2 steps and 1 red duty wait on mac: the steps' jobs and the duty's chat run on mac, which Tailscale reads offline/);
});
