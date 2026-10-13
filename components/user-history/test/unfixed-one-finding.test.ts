import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkInPrecheck, convergenceMisses } from "../src/chat-checkin.ts";
import { parseTrain, type Train } from "../src/checkin-load.ts";
import type { JobFact, StepMemo } from "../src/checkin-steps.ts";
import type { ChatBoard } from "../src/shared/types.ts";

/**
 * unfixed_flags 10-13: Crawler VP's p42, p84 and p92 and VP of CI's p86 stayed flagged 5 to 20 check-ins in a row. Each check-in chased the
 * holder (Fable's land queue, VP of CI's CI backlog) and got two lines for one step: stalled_steps "act on it in this run" and
 * blocked_on_others "start a job that fixes the blocker". From 10-13 09:15 to 23:59 KST 34 steps got both in one run; Crawler VP's p47, which
 * waits for "land 34 on staging ..." while the train moves, got "act on it" alone at 19:38, 20:12 and 20:59 though blocked_on_others parks it.
 * This replays Crawler VP's real board (rev 3164), step memos and CI cache of its 09:09Z check-in (the p147 fixture): p18 waits for
 * "PROBE B r8 ... green and in land 34", p32 for "... lands on prod in land 34", p147 for "ci/meta-ads-l34-r2 ... (38357752199) green, land 34".
 */
const CHAT = "01a115e2-9544-7204-b8db-8ce4d5319048";
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/crawler-vp-p147-owner-board.json", import.meta.url), "utf8")) as {
  board: ChatBoard; steps: Record<string, StepMemo>; ciCache: { runs: Record<string, { run: Record<string, unknown> }> }; thread: { id: string; name: string };
};
const NOW = Date.parse("2026-10-13T09:09:46.488Z");
const MIN = 60_000;
/** The CI cache as it read at NOW, its runs shifted `shiftMs` earlier: a run not yet ended then was in progress. */
function trainAt(shiftMs = 0): Train {
  const runs = Object.fromEntries(Object.entries(FIXTURE.ciCache.runs).flatMap(([id, { run }]) => {
    const created = Date.parse(String(run.created_at)) - shiftMs;
    const updated = Date.parse(String(run.updated_at)) - shiftMs;
    if (created > NOW) return [];
    const ended = run.status === "completed" && updated <= NOW;
    return [[id, { run: { ...run, created_at: new Date(created).toISOString(), updated_at: new Date(Math.min(updated, NOW)).toISOString(),
      status: ended ? "completed" : "in_progress", conclusion: ended ? run.conclusion : null } }]];
  }));
  return parseTrain({ fetchedAt: new Date(NOW).toISOString(), runs })!;
}
/** The meta ads thread with no turn for 3 h and no heartbeat: p147's owner is idle. */
const idleThread: JobFact = { key: `thread:${FIXTURE.thread.id}`, name: FIXTURE.thread.name, state: "ended", activityAt: NOW - 180 * MIN,
  item: { id: "p147", text: "Fix: Meta Ads splits an advertiser", status: "blocked" } };
/** Each flagged p18, p32 and p147 line's kind at the 09:09Z check-in. */
function kinds(train?: Train): string[] {
  const memory = { at: NOW - 15 * MIN, since: NOW - 15 * MIN, steps: FIXTURE.steps };
  const rows = [{ id: FIXTURE.thread.id, name: FIXTURE.thread.name, archived: false }];
  const board = { ...FIXTURE.board, updatedAt: new Date(NOW).toISOString() };
  const precheck = checkInPrecheck(memory, [idleThread], board, NOW, { self: [CHAT, "Crawler VP"], rows, ...(train ? { train } : {}) });
  const { flagged } = convergenceMisses(CHAT, precheck.steps, precheck, {}, 15 * MIN, NOW);
  return flagged.filter(slice => ["p18", "p32", "p147"].includes(slice.item ?? "") && ["stalled_steps", "blocked_on_others"].includes(slice.kind))
    .map(slice => `${slice.item} ${slice.kind}`).sort();
}

test("unfixed_flags 10-13: a step blocked on CI, a land or a thread gets the blocked_on_others line only, not stalled_steps too", () => {
  assert.deepEqual(kinds(), ["p147 blocked_on_others", "p18 blocked_on_others", "p32 blocked_on_others"],
    "with no train read, each step waits on land 34 or a CI run past an hour and gets one line that names the blocker");
});

test("unfixed_flags 10-13: a step on a moving release train is neither stalled nor blocked, as blocked_on_others already parks it (b1ea3ca)", () => {
  assert.deepEqual(kinds(trainAt()), [], "land 33 and promote 9 ran within 110 min of 09:09Z, so land 34's waits are on schedule");
  assert.deepEqual(kinds(trainAt(4 * 60 * MIN)), ["p147 blocked_on_others", "p18 blocked_on_others", "p32 blocked_on_others"],
    "control: with the train's last run 4 h old, the train does not move and each step is blocked on it, still once");
});
