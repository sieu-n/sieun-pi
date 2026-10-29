// sep launch!! and Railway Breach 10-23: the owner's MacBook Pro slept off Tailscale from about 10:10Z, the chat service's copy of its sessions
// stayed at 09:52Z, and every job there read ended, so the check-in counted 39 and 2 stuck steps and d9 read stuck_steps_all 44 at 12:27Z while
// For you t96 (13:36Z) asked the owner to wake the Mac. Such a step waits for the box, listed apart, and counts as stuck again once the box is back.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chatSystemOutput, goalsWithNoJob } from "../scripts/duties/chat-system.ts";
import { type PlanInputs, planCounts } from "../scripts/duties/whole-system.ts";
import { checkInPrecheck, convergenceMisses } from "../src/chat-checkin.ts";
import { endState } from "../src/checkin-end-state.ts";
import { type JobFact, stepView } from "../src/checkin-steps.ts";
import type { DutyRunRecord, FlaggedSlice } from "../src/shared/chat-duties.ts";
import { hostHolds } from "../src/shared/host-hold.ts";
import type { ChatBoard, PlanItem, SessionRow } from "../src/shared/types.ts";

const MIN = 60_000;
const at = (clock: string) => Date.parse(`2026-10-23T${clock}Z`);
const SEP = "01a15427-145f-751d-ba15-d27b6c30f65f";
const mac = { name: "mac", lastSeen: "2026-10-23T10:09:00Z" };
const p35: PlanItem = { id: "p35", text: "Campaigns works: Scout, Jev screening, Swipe, Creators and auto-send", status: "todo", job: "5180 into the real app",
  sessionId: "01a16159-0000-7000-8000-000000000035", note: "Done when it passes on staging", children: [] };
const p69: PlanItem = { id: "p69", text: "The design page fixes the key and table of each concept", status: "todo", job: "data model",
  sessionId: "01a16200-0000-7000-8000-000000000069", note: "Done when the page lists them", children: [] };
const p2: PlanItem = { id: "p2", text: "Every 5180 app works in the real app", status: "doing", note: "Done when 70 of 70 steps pass", children: [p35, p69] };
const board = { v: 2, rev: 1059, updatedAt: "2026-10-23T09:40:00Z", todos: [], plan: [p2] } as unknown as ChatBoard;
const ended = (item: PlanItem): JobFact => ({ key: `child-${item.id}`, name: item.job!, state: "ended", sessionId: item.sessionId!, activityAt: at("09:52:00") });
const facts = [ended(p35), ended(p69)];
const rows = [{ id: SEP, name: "sep launch!!", host: "mac" }] as unknown as SessionRow[];
const now = at("13:45:16");

const stateOf = (held: ReturnType<typeof hostHolds>): string =>
  endState(stepView(p35, at("09:40:00") - 33 * 60 * MIN, new Set([SEP]), facts, [], rows, now), [], rows, new Set([SEP]), now, facts,
    { hosts: { chatHost: "mac", held } }).state;

test("a step whose job runs on the offline Mac waits for it, and counts as stuck when the Mac is back", () => {
  assert.equal(stateOf(hostHolds([mac])), "host");
  assert.equal(stateOf(hostHolds([])), "job_ended", "the Mac reads online");
});

test("the check-in counts held steps out of stuck_steps and lists each under host_held, with no orphan or job-end ask", () => {
  const precheck = checkInPrecheck(undefined, facts, board, now, { self: [SEP], rows, hosts: { chatHost: "mac", held: hostHolds([mac]) } });
  const out = convergenceMisses(SEP, precheck.steps, precheck, {}, 15 * MIN, now);
  assert.equal(out.metrics.stuck_steps, 0);
  assert.equal(out.metrics.orphan_steps + out.metrics.job_end_unrecorded, 0);
  const held = out.flagged.filter(slice => slice.kind === "host_held");
  assert.deepEqual(held.map(slice => [slice.item, slice.host]), [["p35", "mac"], ["p69", "mac"]]);
  const back = checkInPrecheck(undefined, facts, board, now, { self: [SEP], rows, hosts: { chatHost: "mac", held: new Map() } });
  assert.equal(convergenceMisses(SEP, back.steps, back, {}, 15 * MIN, now).metrics.stuck_steps, 2);
});

const slice = (item: string): FlaggedSlice => ({ chat: SEP, at: at("13:45:16"), kind: "host_held", item, host: "mac", excerpt: "" });
const run: DutyRunRecord = { duty: "checkin", at: at("13:45:16"), trigger: "schedule", ms: 1, verdict: "met", summary: "",
  metrics: { stuck_steps: { value: 0, target: 0, op: "<=", met: true } }, flagged: [slice("p35"), slice("p69")] };
const inputs = (away: string[], activity = new Map<string, number>()) => ({ now: at("13:50:00"), away: new Set(away),
  chats: [{ id: SEP, name: "sep launch!!", runs: [run], duties: [{ id: "checkin", name: "Check-in" }], paused: false, everyMs: 15 * MIN }],
  boards: new Map([[SEP, board]]), ownerActivity: activity, waking: new Set<string>(), poolWaiting: new Set<string>(), named: new Map() }) as unknown as PlanInputs;

test("d9 lists held steps apart while the Mac is offline, and counts them stuck once it answers until their jobs write", () => {
  const away = planCounts(inputs(["mac"]));
  assert.equal(away.stuck.length, 0);
  assert.deepEqual(away.hostHeld.map(step => [step.id, step.host]), [["p35", "mac"], ["p69", "mac"]]);
  const back = planCounts(inputs([]));
  assert.deepEqual(back.stuck.map(entry => [entry.value, entry.items]), [[2, ["p35", "p69"]]]);
  assert.equal(back.hostHeld.length, 0);
  const moving = planCounts(inputs([], new Map([[p35.sessionId!, at("13:48:00")]])));
  assert.deepEqual(moving.stuck.map(entry => entry.items), [["p69"]]);
});

test("d9 names the held steps in their own flag, pushes no goal on them, and leaves stuck_steps_all at 0", () => {
  const hostHeld = [{ chat: SEP, id: "p35", host: "mac" }, { chat: SEP, id: "p69", host: "mac" }];
  const out = chatSystemOutput({ names: new Map([[SEP, "sep launch!!"]]), stuck: [], upkeep: [], fleet: { pct: 100, red: [] }, stuckDuties: [], idleGoals: [],
    followUps: [], detail: "/tmp/d9.md", hostHeld });
  assert.equal(out.metrics.stuck_steps_all, 0);
  assert.match(out.flagged!.find(entry => entry.kind === "host_held")?.excerpt ?? "", /^2 steps wait on mac: their jobs run on mac/);
  const reads = { now, named: new Map(), jobs: [], activity: new Map(), waking: new Set<string>(), poolWaiting: new Set<string>() };
  assert.deepEqual(goalsWithNoJob(board, reads).map(goal => goal.id), ["p2"]);
  assert.deepEqual(goalsWithNoJob(board, { ...reads, onHost: new Set(["p35", "p69"]) }), []);
});
