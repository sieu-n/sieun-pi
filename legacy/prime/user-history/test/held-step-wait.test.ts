// 10-24 11:25Z: d9 counted frontend bro's p333 as stuck. Its job ran on us-metal02, and its done line waited for p332 to push 216b06239a from the
// Mac, which Tailscale read offline while For you asked the owner to bring it back. A step whose wait names a step held on an offline box waits
// on the same box and todo; a wait on a step that is stuck or moving on a reachable box holds nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type PlanInputs, planCounts } from "../scripts/duties/whole-system.ts";
import { checkInPrecheck, convergenceMisses } from "../src/chat-checkin.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import type { ChatBoard, PlanItem, SessionRow } from "../src/shared/types.ts";

const MIN = 60_000;
const FRONT = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";
const now = Date.parse("2026-10-24T11:25:00Z");
const step = (id: string, extra: Partial<PlanItem>): PlanItem => ({ id, text: `step ${id}`, status: "doing", children: [], ...extra });
const plan = (): PlanItem[] => [step("p300", { text: "Demo work reaches staging", children: [
  step("p332", { job: "mac branch pusher", sessionId: "s-mac" }),
  step("p333", { job: "staging design fix outreach", sessionId: "s-metal", waitFor: "p332: 216b06239a sits only on the Mac branch dev/sieun-mac-a" }),
  step("p334", { job: "chained", sessionId: "s-metal-2", waitFor: "p333 lands first" }),
  step("p309", { job: "schema promotes keep serving", sessionId: "s-metal-3" }),
  step("p335", { job: "waits on metal", sessionId: "s-metal-4", waitFor: "p309 ships" })] })];

test("a paused chat's step whose wait names a step held on an offline box waits on the same box and todo, and a wait on a reachable stuck step counts", () => {
  const board = { v: 2, rev: 1, updatedAt: "2026-10-24T08:00:00Z", todos: [], plan: plan() } as unknown as ChatBoard;
  const input = { now, boards: new Map([[FRONT, board]]), named: new Map(), poolWaiting: new Set<string>(), waking: new Set<string>(),
    ownerActivity: new Map([["s-mac", now - 20 * 3_600_000], ["s-metal", now - 26 * 3_600_000]]),
    hosts: new Map([[FRONT, "us-metal02"], ["s-mac", "mac"], ["s-metal", "us-metal02"], ["s-metal-2", "us-metal02"], ["s-metal-3", "us-metal02"], ["s-metal-4", "us-metal02"]]),
    away: new Set(["mac"]), holds: new Map([["mac", { host: "mac", todo: "t30" }]]),
    chats: [{ id: FRONT, name: "frontend bro", runs: [], everyMs: 7_200_000, paused: true, duties: [] }] } as unknown as PlanInputs;
  const counts = planCounts(input);
  assert.deepEqual(counts.stuck.flatMap(entry => entry.items), ["p309", "p335"]);
  assert.deepEqual(counts.hostHeld.map(held => [held.id, held.host, held.todo, held.waitsOn]),
    [["p332", "mac", "t30", undefined], ["p333", "mac", "t30", "p332"], ["p334", "mac", "t30", "p333"]]);
  const back = planCounts({ ...input, away: new Set(), holds: new Map() });
  assert.deepEqual(back.stuck.flatMap(entry => entry.items), ["p332", "p333", "p334", "p309", "p335"]);
});

test("a check-in holds a step whose wait names a step on the offline box, with a host_held line, and counts a wait on a reachable stuck step", () => {
  const items = plan();
  const board = { v: 2, rev: 1, updatedAt: "2026-10-24T08:00:00Z", todos: [], plan: items } as unknown as ChatBoard;
  const rows = [{ id: FRONT, name: "frontend bro", host: "us-metal02" }, ...["s-mac", "s-metal", "s-metal-2", "s-metal-3", "s-metal-4"].map(id =>
    ({ id, name: id, host: id === "s-mac" ? "mac" : "us-metal02" }))] as unknown as SessionRow[];
  const facts: JobFact[] = items[0]!.children.map(item => ({ key: `thread:${item.sessionId}`, name: item.job!, state: "ended", sessionId: item.sessionId!, activityAt: now - 26 * 60 * MIN }));
  const precheck = checkInPrecheck(undefined, facts, board, now, { self: [FRONT], rows, hosts: { chatHost: "us-metal02", held: new Map([["mac", { host: "mac", todo: "t30" }]]) } });
  const out = convergenceMisses(FRONT, precheck.steps, precheck, {}, 15 * MIN, now);
  assert.deepEqual(out.flagged.filter(slice => slice.kind === "host_held").map(slice => [slice.item, slice.host, slice.todo]),
    [["p332", "mac", "t30"], ["p333", "mac", "t30"], ["p334", "mac", "t30"]]);
  assert.deepEqual(out.flagged.filter(slice => slice.kind === "stuck_steps").map(slice => slice.item), ["p309", "p335"]);
});
