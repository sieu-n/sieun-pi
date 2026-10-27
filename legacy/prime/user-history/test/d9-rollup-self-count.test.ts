// 10-23 18:41Z and 19:40Z: the Chat system duty (d9) counted itself in stuck_duties, "Chat system read off target in its last 54 runs, and no
// open step linked to it (duty field d9/stuck_steps_all or d9/duties_green_pct) has a live owner now". d9 misses only as the other duties miss,
// and each of those gets its own line, as duty-fleet's readsTheShare keeps d9 out of duties_green_pct.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type PlanInputs, planCounts } from "../scripts/duties/whole-system.ts";
import type { ChatBoard } from "../src/shared/types.ts";

const now = Date.parse("2026-10-23T19:40:50Z");
const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const metric = (value: number, target: number, op: "<=" | ">=") => ({ value, target, op, met: op === "<=" ? value <= target : value >= target });
const d9run = { duty: "d9", at: now - 3_600_000, trigger: "schedule", verdict: "missed", ms: 1, after: { at: now - 3_000_000, verdict: "missed", metrics: {
  stuck_steps_all: metric(1, 0, "<="), stuck_duties: metric(0, 0, "<="), fix_not_moving: metric(0, 0, "<="), duties_green_pct: metric(61.4, 100, ">=") } },
  metrics: { stuck_steps_all: metric(0, 0, "<="), stuck_duties: metric(2, 0, "<="), fix_not_moving: metric(0, 0, "<="), duties_green_pct: metric(61.4, 100, ">=") } };
const d5run = { duty: "d5", at: now - 600_000, trigger: "schedule", verdict: "missed", ms: 1, metrics: { owner_fixes: metric(1, 0, "<=") } };
const board = { v: 2, rev: 1, updatedAt: "2026-10-23T19:42:59Z", todos: [], plan: [] } as unknown as ChatBoard;
const keys = ["stuck_steps_all", "stuck_duties", "fix_not_moving", "duties_green_pct"].map(key => ({ key }));
const plan = { now, chats: [{ id: CHAT, name: "AI harness developer environment VP", runs: [d5run, d9run], everyMs: 3_600_000, paused: false,
  duties: [{ id: "d9", name: "Chat system", metrics: keys }, { id: "d5", name: "Skills and tools", metrics: [{ key: "owner_fixes" }] }] }],
  boards: new Map([[CHAT, board]]), ownerActivity: new Map(), waking: new Set<string>(), poolWaiting: new Set<string>(),
  named: new Map<string, Map<string, string[]>>() } as unknown as PlanInputs;

test("the duty that reads the fleet's share is no red duty of its own, and the duties it rolls up still are", () => {
  const red = planCounts(plan).redDuties;
  assert.deepEqual(red.map(entry => entry.duty), ["d5"]);
  assert.match(red[0]!.line, /^AI harness developer environment VP: Skills and tools read off target in its last run/);
});
