// 10-30 from 18:53Z (03:53 KST): the owner's MacBook Pro slept off Tailscale while designer bro's jobs on it held p405, p413 and p414. A step
// counted as held on an offline box only while an open For you todo asked the owner to wake it, so the check-in added t122 and d9's 04:08 KST
// run added designer bro's t60 ("Wake the Mac when you're up"), and every sleep of the Mac became an owner ask (c178). The hold now reads the
// box's Tailscale state alone, with no todo on any board.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chatSystemOutput } from "../scripts/duties/chat-system.ts";
import { type PlanInputs, planCounts } from "../scripts/duties/whole-system.ts";
import { checkInPrecheck, checkInPrecheckText, convergenceMisses } from "../src/chat-checkin.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import { hostHolds } from "../src/shared/host-hold.ts";
import type { ChatBoard, PlanItem, SessionRow } from "../src/shared/types.ts";

const MIN = 60_000;
const DESIGNER = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";
const now = Date.parse("2026-10-29T20:00:00Z");
const mac = { name: "mac", lastSeen: "2026-10-29T18:53:00Z" };
const step = (id: string, job: string, sessionId: string): PlanItem => ({ id, text: `step ${id}`, status: "doing", job, sessionId, note: "Done when it ships", children: [] });
const steps = [step("p405", "dm compose polish", "01a18790-a8be-7255-8cd5-4e1da09b6780"), step("p413", "shared date picker", "01a1889f-d20b-773a-83d5-a70e6e853b2a"),
  step("p414", "ink charts", "01a18865-6f11-7789-9784-040ab0f8548e")];
const board = { v: 2, rev: 4216, updatedAt: "2026-10-29T19:00:00Z", todos: [],
  plan: [{ id: "p400", text: "5180 polish", status: "doing", note: "Done when every step is done", children: steps }] } as unknown as ChatBoard;
const rows = [{ id: DESIGNER, name: "designer bro", host: "mac" }] as unknown as SessionRow[];
const facts: JobFact[] = steps.map(item => ({ key: `child-${item.id}`, name: item.job!, state: "ended", sessionId: item.sessionId!, activityAt: now - 70 * MIN }));

test("the check-in holds steps whose jobs run on the offline Mac with no For you todo on any board, and asks for none", () => {
  const precheck = checkInPrecheck(undefined, facts, board, now, { self: [DESIGNER], rows, hosts: { chatHost: "mac", held: hostHolds([mac]) } });
  const out = convergenceMisses(DESIGNER, precheck.steps, precheck, {}, 15 * MIN, now);
  assert.equal(out.metrics.stuck_steps, 0);
  const held = out.flagged.filter(slice => slice.kind === "host_held");
  assert.deepEqual(held.map(slice => [slice.item, slice.host]), [["p405", "mac"], ["p413", "mac"], ["p414", "mac"]]);
  assert.match(held[0]!.excerpt, /mac, offline on Tailscale since 18:53Z\. Add no For you todo for it/);
  const text = checkInPrecheckText(precheck, facts, out.flagged, now);
  assert.match(text, /Held on an offline box \(no action and no For you todo here/);
  assert.doesNotMatch(text, /asks (him|the owner) to bring it back/);
});

test("d9 lists the steps apart while the Mac is offline with no wake todo, tells its job to add none, and counts them stuck once it is back", () => {
  const inputs = (away: string[]) => ({ now, boards: new Map([[DESIGNER, board]]), named: new Map(), poolWaiting: new Set<string>(), waking: new Set<string>(),
    ownerActivity: new Map(steps.map(item => [item.sessionId!, now - 70 * MIN])), hosts: new Map([[DESIGNER, "mac"], ...steps.map(item => [item.sessionId!, "mac"] as const)]),
    away: new Set(away), holds: hostHolds(away.map(name => ({ name }))),
    chats: [{ id: DESIGNER, name: "designer bro", runs: [], everyMs: 7_200_000, paused: true, duties: [] }] }) as unknown as PlanInputs;
  const away = planCounts(inputs(["mac"]));
  assert.deepEqual(away.stuck, []);
  assert.deepEqual(away.hostHeld.map(item => [item.id, item.host]), [["p405", "mac"], ["p413", "mac"], ["p414", "mac"]]);
  assert.deepEqual(planCounts(inputs([])).stuck.flatMap(entry => entry.items), ["p405", "p413", "p414"]);
  const out = chatSystemOutput({ names: new Map([[DESIGNER, "designer bro"]]), stuck: [], upkeep: [], fleet: { pct: 100, red: [] }, stuckDuties: [], idleGoals: [],
    followUps: [], detail: "/tmp/d9.md", hostHeld: away.hostHeld.map(item => ({ chat: item.chat.id, id: item.id, host: item.host })) });
  const line = out.flagged!.find(slice => slice.kind === "host_held")!.excerpt;
  assert.match(line, /^3 steps wait on mac: their jobs run on mac, which Tailscale reads offline, so they wait for the box; push nothing and add no For you todo/);
});
