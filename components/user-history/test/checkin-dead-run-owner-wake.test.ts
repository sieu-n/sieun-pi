import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck, convergenceMisses } from "../src/chat-checkin.ts";
import { parseTrain, withWakes } from "../src/checkin-load.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";
import type { Wake } from "../src/wakes.ts";

/*
 * Ops guy's 08:36Z check-in on 10-15 counted p192 as wait_met: its admin stack run 38698956563 was cancelled by Fable's hold AA at 08:05:33Z,
 * and the ops train job, which owns p192, slept on a board.wake at 08:40Z (set 08:04:57Z) to rerun the stack after the hold's cap.
 */
const MIN = 60_000;
const NOW = Date.parse("2026-10-15T08:36:20Z");
const OPS = ["01a11af8-962e-773d-a19a-ee4104011987", "ops guy (+observability)"];
const SESSION = "01a13ac9-c3fa-777b-a8e7-61cf8c3bdffe";
const train = parseTrain({ fetchedAt: new Date(NOW).toISOString(), runs: { "38698956563": { run: { id: 38698956563, name: "verify-dev",
  path: ".github/workflows/verify-dev.yml", head_branch: "ci/ops-admin-5", created_at: "2026-10-15T07:28:14Z", updated_at: "2026-10-15T08:05:33Z",
  status: "completed", conclusion: "cancelled" } } } })!;
const p192: PlanItem = { id: "p192", text: "Land all of this chat's ready work as one stack with one CI run", status: "doing", children: [], job: "ops train",
  sessionId: SESSION, waitFor: "the 9 per-app stack runs on tip 1dcf498bdb (38698956563 to 38699005536) go green, then land each" };
const board: ChatBoard = { v: 2, rev: 1, plan: [{ id: "p45", text: "Ops ships", status: "doing", children: [p192] }], scratch: [], todos: [],
  updatedAt: "2026-10-15T08:05:00Z" };
const idle: JobFact = { key: "sub-ops-train", name: "ops train", state: "idle", sessionId: SESSION, activityAt: Date.parse("2026-10-15T08:06:29Z") };
const wake: Wake = { session: SESSION, on: { kind: "time", at: Date.parse("2026-10-15T08:40:00Z") }, note: "After hold AA: ci-run-status on stacks",
  since: Date.parse("2026-10-15T08:04:57Z") };

function waitMet(facts: JobFact[]): number {
  const precheck = checkInPrecheck(undefined, facts, board, NOW, { self: OPS, train });
  return convergenceMisses(OPS[0]!, precheck.steps, precheck, {}, 2 * 60 * MIN, NOW).metrics.wait_met;
}

test("a cancelled run is no wait_met while the step's job sleeps on a board.wake it set to rerun it (ops guy p192, 10-15 08:36Z)", () => {
  assert.equal(waitMet([idle]), 1, "with no wake the idle job leaves the cancelled run to nobody");
  assert.equal(waitMet(withWakes([idle], [wake], () => undefined)), 0, "the 08:40Z wake makes the job the one that reruns it");
  assert.equal(waitMet([{ ...idle, state: "working" }]), 0, "a job working on the step reruns it too");
});
