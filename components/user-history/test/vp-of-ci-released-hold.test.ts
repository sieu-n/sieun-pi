import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkInPrecheck, convergenceMisses } from "../src/chat-checkin.ts";
import { plannedEnd, trainMoves } from "../src/checkin-findings.ts";
import type { Train } from "../src/checkin-load.ts";
import type { JobFact, StepMemo } from "../src/checkin-steps.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";
import { trainAt as cacheAt } from "./train-at.ts";

/**
 * VP of CI's real board (chat 01a1180e, rev 3289, before its 06:12 KST check-in set waitUntil 22:30Z) with p25, p26, p30, p110 and p134
 * waiting for "Fable's 'released'; then promote gates rework pushes ... fresh and lands it", unchanged since 19:12:03Z. Their job, promote gates
 * rework, went idle at 20:07:01Z. The check-ins at 20:42Z and 21:12Z (05:42 and 06:12 KST) flagged all five as blocked_on_others "on promote"
 * and as stale_steps. Scratch note s250 (19:36Z) says Fable holds every runner for the land 34 critical set "until 'released', ETA about
 * 22:00Z". The fixture holds the service's step memos from the 21:12Z run and the CI cache (~/.cache/virev/ci-runs.json, read 21:20Z) trimmed to
 * its land and promote runs and the runs on ci/ branches that GitHub updated after 18:00Z.
 */
const CHAT = "01a1180e-6567-747f-bf44-452520ebdd1b";
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/vp-of-ci-released-hold-board.json", import.meta.url), "utf8")) as {
  board: ChatBoard; steps: Record<string, StepMemo>; ciCache: { runs: Record<string, { run: Record<string, unknown> }> };
};
const MIN = 60_000;
const EVERY = 30 * MIN;
const HOLD = ["p110", "p134", "p25", "p26", "p30"];
/** The job's row in the daemon roster (lastActivityAt). */
const JOB: JobFact = { key: "01a11d82-7723-7405-a1c3-75b775c99ff2", name: "promote gates rework", state: "ended", activityAt: Date.parse("2026-10-13T20:07:01.423Z"),
  sessionId: "01a11d82-7723-7405-a1c3-75b775c99ff2" };
/** The chat's check-in slots (service.log "duty 01a1180e/checkin"; the 21:12Z memo's `at`). */
const SLOTS = { "20:42": Date.parse("2026-10-13T20:42:40.004Z"), "21:12": Date.parse("2026-10-13T21:12:39.516Z") } as const;
const trainAt = (now: number, shiftMs = 0): Train => cacheAt(FIXTURE.ciCache.runs, now, shiftMs);

/** The blocked_on_others and stale_steps flags among the five at `now`, with `waitFor` (when given) in place of each real one. */
function flagsAt(now: number, { train, waitFor }: { train?: Train; waitFor?: string } = {}): { blocked: string[]; stale: string[] } {
  const swap = (item: PlanItem): PlanItem => ({ ...item, ...(waitFor && HOLD.includes(item.id) ? { waitFor } : {}), children: item.children.map(swap) });
  const board = { ...FIXTURE.board, updatedAt: new Date(now).toISOString(), plan: FIXTURE.board.plan.map(swap) };
  const steps = Object.fromEntries(Object.entries(FIXTURE.steps).map(([id, memo]) => {
    const real = HOLD.includes(id) && waitFor ? JSON.parse(memo.sig) as string[] : undefined;
    return [id, real ? { ...memo, sig: JSON.stringify([...real.slice(0, -1), waitFor]), wait: JSON.stringify([waitFor, "", "promote gates rework"]) } : memo];
  }));
  const precheck = checkInPrecheck({ at: now - EVERY, since: now - 3 * 60 * MIN, steps }, [JOB], board, now,
    { self: [CHAT, "VP of CI"], rows: [], everyMs: EVERY, ...(train ? { train } : {}) });
  const { flagged } = convergenceMisses(CHAT, precheck.steps, precheck, {}, EVERY, now);
  const ids = (kind: string) => flagged.filter(slice => slice.kind === kind && HOLD.includes(slice.item ?? "")).map(slice => slice.item!).sort();
  return { blocked: ids("blocked_on_others"), stale: ids("stale_steps") };
}

test("VP of CI p25, p26, p30, p110 and p134: a wait on Fable's 'released' is not blocked_on_others or a stale step at the 20:42Z and 21:12Z check-ins", () => {
  for (const [slot, now] of Object.entries(SLOTS)) {
    assert.deepEqual(flagsAt(now, { train: trainAt(now) }), { blocked: [], stale: [] }, `${slot}: the land 34 critical set moves on ci/ branches`);
  }
});

test("VP of CI controls: no CI cache and a hold idle past 110 min still flag both; a promote wait with no hold is parked the same way", () => {
  const all = { blocked: HOLD, stale: HOLD };
  for (const [slot, now] of Object.entries(SLOTS)) {
    assert.deepEqual(flagsAt(now), all, `${slot}, no CI cache: no step names s250, so nothing names an end`);
    assert.deepEqual(flagsAt(now, { train: trainAt(now, 3 * 60 * MIN) }), all, `${slot}: a hold whose runs last moved over TRAIN_IDLE_MS before does not move`);
    assert.deepEqual(flagsAt(now, { train: trainAt(now), waitFor: "promote 10; then promote gates rework pushes the promote gates stack fresh and lands it" }),
      { blocked: [], stale: [] }, `${slot}: a promote wait that names no hold is on the same release path, which the critical set's ci/ runs move`);
  }
});

test("a released wait that names s250 is not blocked until its \"ETA about 22:00Z\" plus the grace, and flags once it passes with the hold idle", () => {
  const waitFor = "Fable's 'released' (s250); then promote gates rework pushes the promote gates stack fresh and lands it";
  const item = { id: "p25", text: "", status: "doing", children: [], waitFor } as unknown as PlanItem;
  assert.equal(new Date(plannedEnd(item, Date.parse("2026-10-13T19:12:03.536Z"), FIXTURE.board.scratch)!).toISOString(), "2026-10-13T22:00:00.000Z");
  assert.deepEqual(flagsAt(SLOTS["21:12"], { waitFor }), { blocked: [], stale: HOLD },
    "21:12Z, no CI cache: 22:00Z plus the grace is ahead, which parks the blocker; the idle job still owes a record unless the path moves");
  const late = Date.parse("2026-10-13T22:31:00Z");
  assert.deepEqual(flagsAt(late, { waitFor }), { blocked: HOLD, stale: HOLD }, "22:31Z, no CI cache: the ETA passed");
  assert.deepEqual(flagsAt(late, { waitFor, train: trainAt(late, 4 * 60 * MIN) }), { blocked: HOLD, stale: HOLD }, "22:31Z: the ETA passed and the hold is idle");
});

test("the release owner's release word and a promote number put a wait on the release path; a plain \"released\" does not", () => {
  const now = SLOTS["21:12"];
  const train = trainAt(now);
  const moves = (waitFor: string) => trainMoves({ id: "p1", text: "", status: "doing", children: [], waitFor } as unknown as PlanItem, train, now);
  assert.equal(moves("the release owner's 'released'; then one fresh push"), true);
  assert.equal(moves("Fable's \u2018released\u2019, then r15 lands"), true);
  assert.equal(moves("Fable's release of the critical set; then one fresh push"), true);
  assert.equal(moves("the fix released to staging, then a recheck"), false);
  assert.equal(moves("promote 10, then one fresh push"), true, "a promote by number is on the release path too");
  assert.equal(moves("the copy review, then one fresh push"), false);
});
