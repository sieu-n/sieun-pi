import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkInPrecheck, convergenceMisses } from "../src/chat-checkin.ts";
import type { Train } from "../src/checkin-load.ts";
import type { JobFact, StepMemo } from "../src/checkin-steps.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";
import { trainAt as cacheAt } from "./train-at.ts";

/**
 * Crawler VP's real p18 (chat 01a115e2, 2026-10-13) under p71 and p43, with its waitFor and note from the chat's 20:55:47Z chat_board update,
 * and the service's step memo (recorded 21:06:40Z). p18 waits for "PROBE B r14 green and in land 35 (p82), then ...": land 35 had no run,
 * and the last land or promote run, promote 38375389358, had ended at 10:16:45Z, while the release owner's loop ran the land-34 critical set
 * on ci/ branches (ci/census-nullroot-20261013-r6 green at 21:44Z, ci/queue-cuts-t10 at 21:54Z). The check-ins at 22:36:41Z and 22:51:41Z
 * flagged p18 as blocked_on_others "on land" for 90 and 105 min, with its own job, lab compose additions, idle on purpose. The CI cache is
 * ~/.cache/virev/ci-runs.json read at 23:00:20Z, trimmed to its land and promote runs and the ci/ runs GitHub updated after 19:00Z.
 */
const CHAT = "01a115e2-9544-7204-b8db-8ce4d5319048";
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/crawler-vp-p18-release-path.json", import.meta.url), "utf8")) as {
  board: ChatBoard; steps: Record<string, StepMemo>; ciCache: { runs: Record<string, { run: Record<string, unknown> }> };
};
const MIN = 60_000;
const EVERY = 15 * MIN;
/** The chat's real check-in slots that flagged p18 (duties/01a115e2.runs.jsonl). */
const SLOTS = { "22:36": Date.parse("2026-10-13T22:36:41.312Z"), "22:51": Date.parse("2026-10-13T22:51:41.583Z") } as const;
/** p18's job: the subagent's session file last moved at 19:38:07Z, when it parked itself until the release owner's "released". */
const JOB: JobFact = { key: "01a12367-e296-71ea-8473-65ef32c4cbb9", name: "lab compose additions", state: "ended", activityAt: Date.parse("2026-10-13T19:38:07.206Z"),
  sessionId: "01a12367-e296-71ea-8473-65ef32c4cbb9" };
const trainAt = (now: number, shiftMs = 0): Train => cacheAt(FIXTURE.ciCache.runs, now, shiftMs);

/** The blocked_on_others and stale_steps flags on p18 at `now`, with `change` applied to p18 and its memo, so a new waitFor is no fresh change. */
function flagsAt(now: number, { train, change = {} }: { train?: Train; change?: Partial<PlanItem> } = {}): string[] {
  const swap = (item: PlanItem): PlanItem => ({ ...item, ...(item.id === "p18" ? change : {}), children: item.children.map(swap) });
  const board = { ...FIXTURE.board, updatedAt: new Date(now).toISOString(), plan: FIXTURE.board.plan.map(swap) };
  const memo = FIXTURE.steps.p18!;
  const was = JSON.stringify(JSON.parse(memo.wait!)[0]);
  const steps = change.waitFor ? { p18: { ...memo, sig: memo.sig.replace(was, JSON.stringify(change.waitFor)), wait: memo.wait!.replace(was, JSON.stringify(change.waitFor)) } }
    : FIXTURE.steps;
  const precheck = checkInPrecheck({ at: now - EVERY, since: now - 3 * 60 * MIN, steps }, [JOB], board, now,
    { self: [CHAT, "Crawler VP"], rows: [], everyMs: EVERY, ...(train ? { train } : {}) });
  const { flagged } = convergenceMisses(CHAT, precheck.steps, precheck, {}, EVERY, now);
  return flagged.filter(slice => slice.item === "p18" && ["blocked_on_others", "stale_steps"].includes(slice.kind)).map(slice => slice.kind).sort();
}

test("Crawler VP p18: a wait on a probe and a land with no run yet is parked while the release path moves, at the 22:36Z and 22:51Z check-ins", () => {
  for (const [slot, now] of Object.entries(SLOTS)) assert.deepEqual(flagsAt(now, { train: trainAt(now) }), [], `${slot}: the land-34 critical set moves on ci/ branches`);
});

test("Crawler VP p18 controls: no CI cache, an idle release path, a failed named run and a passed planned end still flag", () => {
  for (const [slot, now] of Object.entries(SLOTS)) {
    assert.deepEqual(flagsAt(now), ["blocked_on_others"], `${slot}, no CI cache: nothing shows the path moving`);
    assert.deepEqual(flagsAt(now, { train: trainAt(now, 3 * 60 * MIN) }), ["blocked_on_others"], `${slot}: every release run last moved over 110 min before`);
    assert.deepEqual(flagsAt(now, { train: trainAt(now), change: { waitFor: "PROBE B r14 (run 38436360274) green and in land 35 (p82), then a lane window" } }),
      ["blocked_on_others"], `${slot}: the run it names, ci/tts-tiktok-id-index-0145-r5e, failed at 21:31Z and nothing reruns it`);
  }
  const idle = (now: number) => trainAt(now, 3 * 60 * MIN);
  const eta = { note: "Fable's land-34 cut, ETA 23:30Z; then PROBE B r14 goes in land 35." };
  assert.deepEqual(flagsAt(SLOTS["22:51"], { train: idle(SLOTS["22:51"]), change: eta }), [], "an ETA 23:30Z still ahead parks it with the path idle");
  const late = Date.parse("2026-10-14T00:01:00Z");
  assert.deepEqual(flagsAt(late, { train: idle(late), change: eta }), ["blocked_on_others"], "past the ETA plus the grace, with the path idle, it flags");
  assert.deepEqual(flagsAt(SLOTS["22:51"], { train: trainAt(SLOTS["22:51"]), change: { waitFor: "the native host checks and a new R0 manifest" } }), ["blocked_on_others"],
    "a waitFor that names nothing on the release path is not parked by it (its note still names a land)");
});
