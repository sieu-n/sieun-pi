// sep launch!! 10-30: p124's job "5180 port plan" ran on the owner's Mac, off Tailscale from 18:53Z on 10-29, and its unpushed work sat on the
// Mac's disk. The check-in held p124 on that box (host_held) and still flagged it stalled_steps, "act on it in this run", in 4 check-ins in a
// row. A held step is listed under host_held alone, and its other per-step findings come back once the box answers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck, checkInPrecheckText, convergenceMisses } from "../src/chat-checkin.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import { hostHolds } from "../src/shared/host-hold.ts";
import type { ChatBoard, PlanItem, SessionRow } from "../src/shared/types.ts";

const MIN = 60_000;
const SEP = "01a15427-145f-751d-ba15-d27b6c30f65f";
const now = Date.parse("2026-10-29T22:47:00Z");
const p124: PlanItem = { id: "p124", text: "The real app gets the finished 5180 design, then staging, then prod", status: "doing", job: "5180 port plan",
  sessionId: "01a18000-0000-7000-8000-000000000124", waitFor: "the Mac (offline since 18:53Z): ports through 17:42Z landed, the rest is unpushed on its disk",
  note: "Done when every 5180 screen runs the same in the real app on staging.", children: [] };
const p2: PlanItem = { id: "p2", text: "Every 5180 app works in the real app", status: "doing", note: "Done when every screen passes on staging", children: [p124] };
const board = { v: 2, rev: 1, updatedAt: "2026-10-29T19:40:00Z", todos: [], plan: [p2] } as unknown as ChatBoard;
const facts: JobFact[] = [{ key: "child-p124", name: "5180 port plan", state: "ended", sessionId: p124.sessionId!, activityAt: Date.parse("2026-10-29T17:45:00Z") }];
const rows = [{ id: SEP, name: "sep launch!!", host: "mac" }] as unknown as SessionRow[];
const mac = { name: "mac", lastSeen: "2026-10-29T18:53:00Z" };

const run = (held: ReturnType<typeof hostHolds>) => {
  const precheck = checkInPrecheck(undefined, facts, board, now, { self: [SEP], rows, hosts: { chatHost: "mac", held } });
  const out = convergenceMisses(SEP, precheck.steps, precheck, {}, 15 * MIN, now);
  return { precheck, out, text: checkInPrecheckText(precheck, facts, out.flagged, now) };
};
const kinds = (out: ReturnType<typeof run>["out"]) => out.flagged.filter(slice => slice.item === "p124").map(slice => slice.kind);

test("a step held on the offline Mac reads host_held alone, with no stalled_steps on it", () => {
  const { precheck, out, text } = run(hostHolds([mac]));
  assert.deepEqual(kinds(out), ["host_held"]);
  assert.equal(out.metrics.stalled_steps, 0);
  assert.deepEqual(precheck.stalled, []);
  assert.doesNotMatch(text, /act on it in this run/);
  assert.match(text, /### Held on an offline box[^\n]*\n- p124 /);
});

test("the same step reads stalled again once the Mac is back on Tailscale", () => {
  const { out } = run(new Map());
  assert.ok(kinds(out).includes("stalled_steps"), kinds(out).join(", "));
  assert.ok(!kinds(out).includes("host_held"));
});
