// chat-2572 on 10-24: p8 and p10 wait for production handoffs from p6, whose release job 01a10810 is live (queued in pi-pool), while the
// CI and RepoOps thread sleeps on an unrelated probe run on p12. The 07:43Z check-in read p8 and p10 as moving in its end state but still
// flagged them stalled ("act on it in this run") for the 8th and 5th time, so its job moved both under p6 and tied the probe run to them. Its
// after-job measure at 07:53Z then read goal_gaps 1 and stuck_steps 2, because p6 was no leaf any more and its live job carried nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck, convergenceMisses } from "../src/chat-checkin.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const NOW = Date.parse("2026-10-24T07:53:30Z");
const CHAT = "01a162bc-47b4-770b-a9fc-19c3a742e730";
const RELEASE = "01a10810-34b5-710f-88fe-3d369f89a8c9";
const CI = "01a1180e-6567-747f-bf44-452520ebdd1b";

const step = (id: string, text: string, extra: Partial<PlanItem> = {}): PlanItem => ({ id, text, status: "todo", children: [], ...extra } as PlanItem);
// The waits as the 07:43Z check-in read them, and as the chat wrote them after 08:03Z.
const WAITS = { "07:43Z": ["The verified production served-version handoff from p6", "The served production deployment from p6"],
  "08:03Z": ["p6's active release job to supply the production source and served versions", "p6's active release job to supply the production source and served versions"] };
let waits = WAITS["08:03Z"];
const p8 = () => step("p8", "Verify the production connection on claude.ai", { job: CHAT, sessionId: CHAT, waitFor: waits[0]! });
const p10 = () => step("p10", "Fix the proxy route used during MCP sign-in", { job: CHAT, sessionId: CHAT, waitFor: waits[1]! });
const board = (nested: boolean): ChatBoard => ({ v: 2, rev: 1, updatedAt: "2026-10-23T15:00:00Z", todos: [], lastIds: {}, plan: [{
  id: "p1", text: "Make the insight MCP work for your coworker", status: "doing",
  target: { metric: "Production checks for the endpoint, sign-in and Claude database reads", target: 3, unit: "checks", current: 0, measuredAt: "2026-10-24T07:52:00Z" },
  children: [
    step("p6", "Make the production database endpoint available and test it", { status: "doing", job: RELEASE, sessionId: RELEASE, children: nested ? [p8(), p10()] : [] }),
    ...nested ? [] : [p8(), p10()],
    step("p12", "Finish the checks needed for deployment", { status: "doing", job: CI, sessionId: CI, waitFor: "CI's first complete staging candidate with a passing full staging check" }),
    step("p15", "Repair production promotion proof", { status: "doing", job: CI, sessionId: CI, waitFor: "CI's passing full verification and successful normal promotion preflight" }),
  ] } as unknown as PlanItem] } as unknown as ChatBoard);

const facts = (release: JobFact["state"]): JobFact[] => [
  { key: `thread:${RELEASE}`, sessionId: RELEASE, name: "Look there are a bunch of prime agent threads", state: release, activityAt: NOW - 2 * 60_000,
    ...release === "working" ? { queued: { place: 10, of: 50 } as never } : {} },
  { key: `thread:${CI}`, sessionId: CI, name: "CI and RepoOps", state: "working", activityAt: NOW, wake: "a board.wake on run 40074231385" },
];
const previous = { at: NOW - 2 * 3_600_000, since: NOW - 3 * 3_600_000, steps: {} } as never;
const run = (nested: boolean, release: JobFact["state"] = "working") => {
  const found = checkInPrecheck(previous, facts(release), board(nested), NOW, { self: [CHAT], jobs: [] });
  const { metrics, flagged } = convergenceMisses(CHAT, found.steps, found, {}, 2 * 3_600_000, NOW);
  const about = (id: string) => flagged.filter(slice => slice.item === id).map(slice => slice.kind);
  return { found, metrics, about };
};

for (const [when, nested] of [["07:43Z", false], ["08:03Z", false], ["08:03Z", true]] as const) {
  const where = nested ? "under p6" : "beside p6";
  test(`steps that wait on p6's live release job ${where}, worded as at ${when}, are carried, not stalled, blocked or stuck`, () => {
    waits = WAITS[when];
    const { found, metrics, about } = run(nested);
    assert.deepEqual(about("p8"), [], `p8 got ${about("p8").join(", ")}`);
    assert.deepEqual(about("p10"), [], `p10 got ${about("p10").join(", ")}`);
    for (const id of ["p8", "p10"]) {
      const view = found.steps.find(entry => entry.item.id === id)!;
      assert.notEqual(view.cls, "stale-chase", `${id} is a chase`);
      assert.equal(view.item.job, CHAT, `${id} keeps its owner`);
      assert.equal(found.end.find(entry => entry.view.item.id === id)?.state, "moving");
    }
    assert.equal(metrics.stuck_steps, 0);
    assert.equal(metrics.goal_gaps, 0);
    const p1 = found.goals.find(push => push.goal.id === "p1")!;
    assert.equal(p1.act, "waiting");
    assert.match(p1.waits ?? "", /^on p6, which Look there are a bunch/);
    assert.equal(found.noProgress, null, "the only open steps wait on live owners");
  });
}

test("a stopped release job leaves the steps that wait on it stuck, so they still get a fix", () => {
  waits = WAITS["08:03Z"];
  for (const nested of [false, true]) {
    const { metrics, about, found } = run(nested, "ended");
    assert.ok(about("p8").includes("stuck_steps"), `p8 ${nested ? "under" : "beside"} p6 got ${about("p8").join(", ")}`);
    assert.ok(about("p10").includes("stuck_steps"));
    assert.ok(metrics.stuck_steps >= 2);
    assert.notEqual(found.goals.find(push => push.goal.id === "p1")?.act, "waiting");
  }
});
