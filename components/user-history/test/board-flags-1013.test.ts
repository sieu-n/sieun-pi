import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type CheckInMemory, checkInPrecheck, convergenceMisses } from "../src/chat-checkin.ts";
import { blockedLine, deadRunWaits, noProgress, waitMetLine } from "../src/checkin-findings.ts";
import { heartbeatLine, parseTrain, redundantHeartbeats, type HeartbeatDuty, type ScheduledJob, type Train } from "../src/checkin-load.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

/*
 * Board findings the 10-13 23:07 KST Chat system run counted that pointed the chats at the wrong action: steps waiting on a cancelled run read as
 * blocked_on_others, steps waiting on their own queued verify-dev run read as no_progress, two SEO heartbeats read as check-in work for the words
 * "board" and "status" in their prompts, and AI harness p1 read as an orphan step next to its finished_open line.
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
/** The 10-13 23:07 KST Chat system run. */
const RUN_AT = Date.parse("2026-10-13T14:07:22.618Z");

/** Three verify-dev runs as ~/.cache/virev/ci-runs.json read them at 17:21Z on 10-13. */
const RUNS: Record<string, { created_at: string; updated_at: string; conclusion: string; head_branch: string }> = {
  "38408618643": { created_at: "2026-10-13T13:52:58Z", updated_at: "2026-10-13T13:55:56Z", conclusion: "cancelled", head_branch: "ci/batch-config-r10" },
  "38378436903": { created_at: "2026-10-13T09:44:10Z", updated_at: "2026-10-13T14:04:08Z", conclusion: "cancelled", head_branch: "ci/engage-operator-cause-r7" },
  "38378422183": { created_at: "2026-10-13T09:44:03Z", updated_at: "2026-10-13T14:04:10Z", conclusion: "cancelled", head_branch: "ci/engage-canary-arm-r8" },
};
/** The cache as it read at `now`: a run not yet ended then was in progress. */
function cacheAt(now: number): Train {
  const runs = Object.fromEntries(Object.entries(RUNS).flatMap(([id, run]) => {
    if (Date.parse(run.created_at) > now) return [];
    const ended = Date.parse(run.updated_at) <= now;
    return [[id, { run: { id: Number(id), name: "verify-dev", path: ".github/workflows/verify-dev.yml", head_branch: run.head_branch, created_at: run.created_at,
      updated_at: ended ? run.updated_at : new Date(now).toISOString(), status: ended ? "completed" : "in_progress", conclusion: ended ? run.conclusion : null } }]];
  }));
  return parseTrain({ fetchedAt: new Date(now).toISOString(), runs })!;
}
const item = (id: string, text: string, rest: Partial<PlanItem> = {}): PlanItem => ({ id, text, status: "todo", children: [], ...rest });
const boardOf = (plan: PlanItem[], updatedAt: number): ChatBoard => ({ v: 2, rev: 1, plan, scratch: [], todos: [], updatedAt: new Date(updatedAt).toISOString() });

/** api portal vp p9 as it stood at 23:07 KST: blocked on its batch run, which Fable's land-34 loop cancelled at 13:55:56Z, unchanged for 4 h. */
const API_PORTAL = ["01a1301d-18de-7129-a559-cfb92f9b5fb1", "api portal vp"];
const p9 = (waitFor = "run 38408618643 (ci/batch-config-r10) fully green, then land-object onto the tip") => item("p9", "Batch API works", { status: "blocked",
  job: "portal batch setup", note: "Pushed fresh on ca3898c320. Prod still answers batch_unavailable.", waitFor });
const BATCH_JOB: JobFact = { key: "sub-batch", name: "portal batch setup", state: "ended", activityAt: Date.parse("2026-10-13T13:57:00Z") };
function apiPortalAt(now: number, train: Train | undefined, waitFor?: string) {
  const board = boardOf([item("p2", "The public API sells what it documents", { children: [p9(waitFor)] })], RUN_AT - 4 * HOUR);
  const precheck = checkInPrecheck(undefined, [BATCH_JOB], board, now, { self: API_PORTAL, ...(train ? { train } : {}) });
  return { precheck, misses: convergenceMisses(API_PORTAL[0]!, precheck.steps, precheck, {}, 15 * MIN, now).metrics };
}

test("a step whose CI run was cancelled is not blocked on others; after 30 min it is a wait_met that says rerun or push fresh (api portal vp p9, 10-13)", () => {
  const old = apiPortalAt(RUN_AT, undefined).precheck.blocked.map(block => blockedLine(block, RUN_AT));
  assert.match(old[0]!, /^p9 "Batch API works" is blocked on CI run 38408618643 for 4 h/, "with no CI cache the step reads as the 23:07 run counted it");
  const at23 = apiPortalAt(RUN_AT, cacheAt(RUN_AT));
  assert.deepEqual(at23.precheck.blocked, [], "run 38408618643 was cancelled at 13:55:56Z: nobody else holds the step");
  assert.deepEqual(at23.precheck.waitsMet, [], "11 min after the cancel the chat may still repoint the wait");
  assert.equal(at23.misses.blocked_on_others, 0);
  const later = Date.parse("2026-10-13T14:30:00Z");
  const late = apiPortalAt(later, cacheAt(later));
  assert.equal(late.misses.wait_met, 1);
  assert.equal(late.misses.blocked_on_others, 0);
  assert.equal(waitMetLine(late.precheck.waitsMet[0]!), 'p9 "Batch API works" waits for "run 38408618643 (ci/batch-config-r10) fully green, then lan…", ' +
    "and run 38408618643 was cancelled 34 min ago and nothing reruns it: the wait is over, act on it now (a cancelled run never turns green: rerun it, " +
    "or push fresh and put the new run in waitFor, or wait on the hold that cancelled it)");
  const running = Date.parse("2026-10-13T13:54:00Z");
  assert.equal(apiPortalAt(running, cacheAt(running)).precheck.waitsMet.length, 0, "a running run is no dead wait");
  assert.deepEqual(apiPortalAt(RUN_AT, cacheAt(running)).precheck.blocked, [], "a step on a run that moved 13 min before is parked on the release path");
  const stuck = running + 111 * MIN;
  assert.match(blockedLine(apiPortalAt(stuck, cacheAt(running)).precheck.blocked[0]!, stuck), /is blocked on CI run 38408618643/,
    "a run the cache last saw move over 110 min before no longer parks it");
  const replaced = apiPortalAt(later, cacheAt(later), "run 38414020573 (ci/batch-config-r11, sup 38408618643) fully green, then land-object");
  assert.deepEqual(deadRunWaits(replaced.precheck.steps, cacheAt(later), later), [], "a run named only as the one a newer run replaced is no wait");
});

/** Launch main bro's goal p82 at the 10:50Z check-in: p84 and p75 each waited on its own verify-dev run, queued while the M1 Air runners slept. */
const LAUNCH = ["01a11bd7-072f-7591-ad1d-f123c276cde5", "launch main bro"];
const LAUNCH_AT = Date.parse("2026-10-13T10:50:00Z");
const launchBoard = (): ChatBoard => boardOf([item("p82", "Engage accounts run at the best proven rate", { status: "doing", children: [
  item("p84", "Build: deliberate freezes by us get their own label, so the staging freeze alert counts only real proxy errors", { status: "doing",
    job: "engage monitoring alerts", kind: "build", waitFor: "operator-cause r7 run 38378436903; green; CAS; land 34" }),
  item("p75", "Standing duty: about 10% of engage accounts always run as a canary arm testing the next limit", { status: "doing", job: "instagram access canary",
    waitFor: "canary r8 run 38378422183; green; CAS; arm back to 2000 once on prod" }),
] })], LAUNCH_AT - 3 * HOUR);
const LAUNCH_JOBS: JobFact[] = [{ key: "sub-alerts", name: "engage monitoring alerts", state: "working" }, { key: "sub-canary", name: "instagram access canary", state: "working" }];
function launchNoProgress(now: number, train: Train | undefined): number {
  const memory: CheckInMemory = { at: now - 15 * MIN, since: now - 2 * HOUR, steps: {} };
  const precheck = checkInPrecheck(memory, LAUNCH_JOBS, launchBoard(), now, { self: LAUNCH, ...(train ? { train } : {}) });
  return convergenceMisses(LAUNCH[0]!, precheck.steps, precheck, {}, 15 * MIN, now).metrics.no_progress;
}

test("no progress: a step whose named verify-dev run is queued or running waits on CI that moves (launch main bro p84 and p75, 10-13 10:50Z)", () => {
  assert.equal(launchNoProgress(LAUNCH_AT, undefined), 1, "with no CI cache both steps read as moving, as the 10:50Z check-in counted them");
  assert.equal(launchNoProgress(LAUNCH_AT, cacheAt(LAUNCH_AT)), 0, "both runs were queued at 10:50Z");
  const after = Date.parse("2026-10-13T14:40:00Z");
  assert.equal(launchNoProgress(after, cacheAt(after)), 1, "both runs were cancelled at 14:04Z: the chat must act");
  const views = checkInPrecheck(undefined, LAUNCH_JOBS, launchBoard(), LAUNCH_AT, { self: LAUNCH }).steps;
  assert.equal(noProgress(launchBoard(), views, {}, LAUNCH_AT - 2 * HOUR, [], new Set(LAUNCH), LAUNCH_AT, cacheAt(LAUNCH_AT)), null);
});

const SEO = JSON.parse(readFileSync(new URL("./fixtures/seo-heartbeats-1013.json", import.meta.url), "utf8")) as { jobs: ScheduledJob[]; duties: HeartbeatDuty[] };

test("redundant heartbeats: a heartbeat that spawns a job is no check-in work for its report words; a duty at the same time that runs the same files covers it (SEO guy, 10-13)", () => {
  assert.deepEqual(redundantHeartbeats(SEO.jobs), [], "both prompts spawn the daily SEO job; \"put the job on the board\" and \"the status\" are its report");
  const covered = redundantHeartbeats(SEO.jobs, SEO.duties);
  assert.deepEqual(covered.map(({ job, duty }) => `${job.label} ${duty?.id}`), ["virev-seo-daily d1", "virev-seo-recrawl d2"]);
  assert.match(heartbeatLine(covered[0]!), /^heartbeat "virev-seo-daily" \(0 9 \* \* \*\), ".*": the duty d1 "Search visits grow" runs this work at 09:00\. Ask the chat to delete it in its own REPL with `await rlm_heartbeat\.delete\("9c96cb18-c9cf-49e5-9fa6-fd55d1e81c97"\)`$/);
  const moved = SEO.duties.map(duty => ({ ...duty, schedule: { kind: "daily", at: "11:00" } }));
  assert.deepEqual(redundantHeartbeats(SEO.jobs, moved), [], "a duty at another time runs other work");
  const paused = SEO.duties.map(duty => ({ ...duty, status: "paused" }));
  assert.deepEqual(redundantHeartbeats(SEO.jobs, paused), [], "a paused duty covers nothing");
  const watcher = { ...SEO.jobs[0]!, id: "w1", label: "seo-board-watch" };
  assert.deepEqual(redundantHeartbeats([watcher], SEO.duties).map(({ job, duty }) => `${job.id} ${duty?.id}`), ["w1 undefined"], "a label that names check-in work stays the check-in's");
});

test("an open item that looks done gets finished_open only, not orphan_steps too (AI harness p1, 10-13 23:07 KST)", () => {
  const AH = ["01a1164b-4a2d-742d-b27a-82f086ed0200", "AI harness developer environment VP"];
  const board = boardOf([
    item("p1", "The chat app feels like messaging a VP", { children: [item("p86", "Chats get better every day", { status: "done" }), item("p342", "Prime's idle cleanup", { status: "dropped" })] }),
    item("p300", "A repo goal", { status: "doing", children: [item("p301", "Write the stale-file guard")] }),
  ], RUN_AT - 4 * HOUR);
  const precheck = checkInPrecheck(undefined, [], board, RUN_AT, { self: AH });
  const { metrics, flagged } = convergenceMisses(AH[0]!, precheck.steps, precheck, {}, 15 * MIN, RUN_AT);
  assert.equal(metrics.finished_open, 1);
  assert.deepEqual(flagged.filter(slice => slice.kind === "orphan_steps").map(slice => slice.item), ["p301"], "p301 has no owner and is not done, so it stays an orphan");
});
