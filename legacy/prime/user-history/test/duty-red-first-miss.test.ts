// 10-20 02:30Z: the Chat system duty (d9) read stuck_duties 0 while frontend bro d4, metal-management d2, CI and RepoOps d2 and Crawler VP d6 and
// d8 sat red with no fix step, because a red duty counted only after 3 missed runs in a row. c75: every missed metric gets a live fix job each run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type PlanInputs, planCounts } from "../scripts/duties/whole-system.ts";
import type { ChatBoard } from "../src/shared/types.ts";

const now = Date.parse("2026-10-20T02:30:00Z");
const CHAT = "01a115e2-9544-7204-b8db-8ce4d5319048";
const run = (verdict: "met" | "missed", at: number) => ({ duty: "d8", at, trigger: "schedule", verdict, ms: 1,
  metrics: { staging_image_links_ok_pct: { value: verdict === "met" ? 100 : 99.7, target: 100, op: ">=", met: verdict === "met" } } });
const empty = { v: 2, rev: 1, updatedAt: "2026-10-20T02:00:00Z", todos: [], plan: [] } as unknown as ChatBoard;
const plan = (runs: object[], board: ChatBoard = empty) => ({ now, chats: [{ id: CHAT, name: "Crawler VP", runs, everyMs: 900_000, paused: false,
  duties: [{ id: "d8", name: "Crawler images" }] }], boards: new Map([[CHAT, board]]), ownerActivity: new Map([["s-fix", now - 10_000]]),
  waking: new Set<string>(), poolWaiting: new Set<string>(), named: new Map<string, Map<string, string[]>>() }) as unknown as PlanInputs;

test("a duty red on its first run with no fix step counts as a red duty with no live fix", () => {
  const red = planCounts(plan([run("missed", now - 60_000), run("met", now - 86_400_000)])).redDuties;
  assert.equal(red.length, 1);
  assert.match(red[0]!.line, /^Crawler VP: Crawler images read off target in its last run, and no open step linked to it \(duty field d8\/staging_image_links_ok_pct\)/);
});

test("a green duty and a first-run red with a live fix step are not counted", () => {
  assert.equal(planCounts(plan([run("met", now - 60_000)])).redDuties.length, 0);
  const fixed = { ...empty, plan: [{ id: "p860", text: "Fix the staging avatar link", status: "doing", duty: "d8/staging_image_links_ok_pct", job: "image fix",
    sessionId: "s-fix", children: [] }] } as unknown as ChatBoard;
  assert.equal(planCounts(plan([run("missed", now - 60_000)], fixed)).redDuties.length, 0);
});
