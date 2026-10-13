import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { blockedLine } from "../src/checkin-findings.ts";
import { checkInPrecheck, convergenceMisses } from "../src/chat-checkin.ts";
import { liveThreads, parseTrain, type ScheduledJob, type Train } from "../src/checkin-load.ts";
import type { JobFact, StepMemo } from "../src/checkin-steps.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

/**
 * Crawler VP's real goal p71 (chat 01a115e2, board rev 3164) with p147 as its 08:39Z and 09:09Z check-ins read it: blocked, owned by the meta
 * ads thread (01a10db4), waiting for "ci/meta-ads-l34-r2 ee5b6b4974 (38357752199) green, land 34, then ...", unchanged since 06:48:38Z. Both
 * check-ins flagged it as "blocked on the meta ads thread", its owner. The fixture holds the service's step memos of the 09:09Z check-in, the
 * land, promote and verify-dev runs of the CI cache (~/.cache/virev/ci-runs.json, read 09:16:57Z), the thread's three active heartbeats, the
 * times each one ran and the times the thread answered, both from its session file. The cache as it read at an earlier time is rebuilt from
 * each run's created_at and updated_at: a run not yet ended then was in progress.
 */
const CHAT = "01a115e2-9544-7204-b8db-8ce4d5319048";
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/crawler-vp-p147-owner-board.json", import.meta.url), "utf8")) as {
  board: ChatBoard; steps: Record<string, StepMemo>; ciCache: { runs: Record<string, { run: Record<string, unknown> }> };
  thread: { id: string; name: string; assistantAt: string[] }; heartbeats: ScheduledJob[]; heartbeatRuns: Record<string, string[]>;
};
const SLOTS = { "08:39": Date.parse("2026-10-13T08:39:51.015Z"), "09:09": Date.parse("2026-10-13T09:09:46.488Z") } as const;
const MIN = 60_000;
const last = (times: readonly string[], now: number): string | undefined => times.filter(at => Date.parse(at) <= now).at(-1);

/** The CI cache as it read at `now`, its runs shifted `shiftMs` earlier. */
function trainAt(now: number, shiftMs = 0): Train {
  const runs = Object.fromEntries(Object.entries(FIXTURE.ciCache.runs).flatMap(([id, { run }]) => {
    const created = Date.parse(String(run.created_at)) - shiftMs;
    const updated = Date.parse(String(run.updated_at)) - shiftMs;
    if (created > now) return [];
    const ended = run.status === "completed" && updated <= now;
    return [[id, { run: { ...run, created_at: new Date(created).toISOString(), updated_at: new Date(Math.min(updated, now)).toISOString(),
      status: ended ? "completed" : "in_progress", conclusion: ended ? run.conclusion : null } }]];
  }));
  return parseTrain({ fetchedAt: new Date(now).toISOString(), runs })!;
}
/** The meta ads thread's heartbeats as its schedule file read at `now`, each with the last run its session shows before then. */
const heartbeatsAt = (now: number, status = "active"): ScheduledJob[] => FIXTURE.heartbeats.map(job => {
  const ran = last(FIXTURE.heartbeatRuns[job.id] ?? [], now);
  return { ...job, status, ...(ran ? { lastRunAt: ran } : {}) };
});
/** The daemon's fact for the meta ads thread at `now`: idle between its turns, last active at its last answer before `now`, or `activityAt`. */
const threadFact = (now: number, activityAt?: number): JobFact => ({ key: `thread:${FIXTURE.thread.id}`, name: FIXTURE.thread.name, state: "ended",
  activityAt: activityAt ?? Date.parse(last(FIXTURE.thread.assistantAt, now)!), item: { id: "p147", text: "Fix: Meta Ads splits an advertiser", status: "blocked" } });

/** The p147 blocked_on_others lines at `now`, with the facts `liveThreads` gives for the thread's `heartbeats`. */
function p147At(now: number, { train, heartbeats = heartbeatsAt(now), activityAt, waitFor }: { train?: Train; heartbeats?: ScheduledJob[]; activityAt?: number; waitFor?: string } = {}): string[] {
  const swap = (item: PlanItem): PlanItem => ({ ...item, ...(item.id === "p147" && waitFor ? { waitFor } : {}), children: item.children.map(swap) });
  const board = { ...FIXTURE.board, updatedAt: new Date(now).toISOString(), plan: FIXTURE.board.plan.map(swap) };
  const steps = waitFor ? { ...FIXTURE.steps, p147: { ...FIXTURE.steps.p147!, sig: FIXTURE.steps.p147!.sig.replace(/"ci\/meta-ads[^"]*"/, JSON.stringify(waitFor)),
    wait: FIXTURE.steps.p147!.wait!.replace(/"ci\/meta-ads[^"]*"/, JSON.stringify(waitFor)) } } : FIXTURE.steps;
  const memory = { at: now - 15 * MIN, since: now - 15 * MIN, steps };
  const facts = liveThreads([threadFact(now, activityAt)], session => session === FIXTURE.thread.id ? heartbeats : [], now);
  const rows = [{ id: FIXTURE.thread.id, name: FIXTURE.thread.name, archived: false }];
  const precheck = checkInPrecheck(memory, facts, board, now, { self: [CHAT, "Crawler VP"], rows, ...(train ? { train } : {}) });
  convergenceMisses(CHAT, precheck.steps, precheck, {}, 15 * MIN, now);
  return precheck.blocked.filter(block => block.view.item.id === "p147").map(block => blockedLine(block, now));
}

test("Crawler VP p147: the meta ads thread between heartbeats is live, so p147 is not blocked_on_others at the 08:39Z and 09:09Z check-ins", () => {
  for (const [slot, now] of Object.entries(SLOTS)) assert.deepEqual(p147At(now, { train: trainAt(now) }), [], `${slot}: the owner thread is live`);
  assert.deepEqual(p147At(SLOTS["08:39"]), [], "08:39Z: every beat last ran 41 to 67 min before, but the thread answered at 08:39:06Z, inside its 30-min beat");
  assert.deepEqual(p147At(SLOTS["09:09"]), [], "09:09Z: the 30-min status beat ran at 09:02:42Z");
});

test("Crawler VP p147: the step's own owner thread is never its blocker, so a moving release train parks it (why b1ea3ca missed it)", () => {
  const dead = (now: number) => heartbeatsAt(now, "cancelled");
  const away = (now: number) => now - 3 * 60 * MIN;
  for (const [slot, now] of Object.entries(SLOTS)) {
    assert.deepEqual(p147At(now, { train: trainAt(now), heartbeats: dead(now), activityAt: away(now) }), [],
      `${slot}: p147 waits for land 34 while promote 38361345787 or 38372115577 runs or ended within TRAIN_IDLE_MS`);
  }
  const [line] = p147At(SLOTS["09:09"], { heartbeats: dead(SLOTS["09:09"]), activityAt: away(SLOTS["09:09"]) });
  assert.match(line!, /^p147 "Fix: Meta Ads splits an advertiser over the 50,001-ad count…" is blocked on CI run 38357752199 for 2 h and meta ads thread is idle: /,
    "with no CI cache, the blocker is the CI run its waitFor names, not the owner thread");
  assert.doesNotMatch(line!, /blocked on the meta ads thread/);
});

/** The cache with p147's run 38357752199 still in progress: it was cancelled at 08:55:22Z, and a step on a cancelled run waits on nobody (`deadRun`). */
const runLive = (train: Train): Train => ({ ...train, all: new Map([...train.all!].map(([id, run]) => [id, id === "38357752199" ? { ...run, running: true, conclusion: null } : run])) });
test("Crawler VP p147 control: a dead owner thread and a wait on no moving train still flag", () => {
  const now = SLOTS["09:09"];
  const dead = { heartbeats: heartbeatsAt(now, "cancelled"), activityAt: now - 3 * 60 * MIN };
  assert.equal(p147At(now, { ...dead, train: runLive(trainAt(now)), waitFor: "ci/meta-ads-l34-r2 ee5b6b4974 (38357752199) green, then the release owner's go push" }).length, 1,
    "a waitFor that names no land and no train run is not on the train");
  assert.equal(p147At(now, { ...dead, train: runLive(trainAt(now, 2 * 60 * MIN)) }).length, 1, "a train with no run in progress and none ended within 110 min does not move");
  const quiet = heartbeatsAt(now).map(job => ({ ...job, lastRunAt: new Date(now - 61 * MIN).toISOString() }));
  assert.equal(p147At(now, { heartbeats: quiet, activityAt: now - 61 * MIN }).length, 1,
    "active beats that last ran 61 min ago, past the 60-min CI watch, and a thread quiet as long are not live");
});
