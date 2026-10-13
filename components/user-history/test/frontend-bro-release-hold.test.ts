import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkInPrecheck } from "../src/chat-checkin.ts";
import { plannedEnd } from "../src/checkin-findings.ts";
import type { Train } from "../src/checkin-load.ts";
import type { StepMemo } from "../src/checkin-steps.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";
import { trainAt as cacheAt } from "./train-at.ts";

/**
 * frontend bro's real board (chat 01a11ba8, rev 1448) with p86 and p101 as its 18:51Z, 19:06Z and 19:21Z check-ins on 10-13 read them: blocked,
 * waiting for "Fable's 'released' for the land-34 critical loop, then one fresh push", unchanged since 17:50:32Z, their jobs idle. Each of
 * those check-ins flagged both as blocked_on_others "on land". The fixture holds the service's step memos of p86 and p101, and the CI cache
 * (~/.cache/virev/ci-runs.json, read 20:09:49Z) trimmed to its land and promote runs and the runs on ci/ branches that GitHub updated after
 * 16:00Z. The cache as it read at an earlier time is rebuilt from each run's times: a run not yet ended then was in progress, last updated
 * when it started. The notes are the chat's chat_board updates, verbatim from its session file.
 */
const CHAT = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/frontend-bro-release-hold-board.json", import.meta.url), "utf8")) as {
  board: ChatBoard; steps: Record<string, StepMemo>; ciCache: { runs: Record<string, { run: Record<string, unknown> }> };
};
const MIN = 60_000;
const WAIT = "Fable's 'released' for the land-34 critical loop, then one fresh push";
/** p86's and p101's notes: set at 17:41:05Z and 17:45:01Z, and with Fable's ETA at 19:07:57Z. */
const NOTES: [string, Record<"p86" | "p101", string>][] = [
  ["2026-10-13T17:41:05.717Z", {
    p86: "The fix holds on 5180. The land-34 critical loop cancelled run 38435261959 at 17:40:52Z while lint was still running, with nothing red. The job pushes fresh once right after 'released' and lands on a real green.",
    p101: "The land-34 critical loop cancelled r10's run at 17:44:22Z, with nothing red. Only probe family had run. The job pushes fresh once right after 'released' and lands on a real green.",
  }],
  ["2026-10-13T19:07:57.844Z", {
    p86: "The fix holds on 5180. The land-34 loop cancelled run 38435261959 at 17:40:52Z, with nothing red. After Fable's 'released' (ETA 23:30Z to 00:30Z), the job pushes fresh once and lands on a real green.",
    p101: "The land-34 loop cancelled r10's run at 17:44:22Z, with nothing red. After Fable's 'released' (ETA 23:30Z to 00:30Z), the job pushes fresh once and lands on a real green.",
  }],
];
/** The chat's real check-in slots (service.log "duty 01a11ba8/checkin"). */
const SLOTS = { "18:51": Date.parse("2026-10-13T18:51:09.397Z"), "19:06": Date.parse("2026-10-13T19:06:03.800Z"), "19:21": Date.parse("2026-10-13T19:21:13.476Z") } as const;

/** The CI cache as it read at `now`, its runs shifted `shiftMs` earlier, plus `extra` runs. */
const trainAt = (now: number, shiftMs = 0, extra: Record<string, unknown>[] = []): Train => cacheAt(FIXTURE.ciCache.runs, now, shiftMs, extra);

/** The blocked_on_others steps among p86 and p101 at `now`, with `waitFor` in place of the real one when given. */
function blockedAt(now: number, { train, waitFor = WAIT }: { train?: Train; waitFor?: string } = {}): string[] {
  const notes = NOTES.filter(([at]) => Date.parse(at) <= now).at(-1)![1];
  const swap = (item: PlanItem): PlanItem => {
    const children = item.children.map(swap);
    return item.id === "p86" || item.id === "p101" ? { ...item, waitFor, note: notes[item.id], children } : { ...item, children };
  };
  const board = { ...FIXTURE.board, updatedAt: new Date(now).toISOString(), plan: FIXTURE.board.plan.map(swap) };
  const steps = Object.fromEntries(Object.entries(FIXTURE.steps).map(([id, memo]) => [id, { ...memo, sig: memo.sig.replace(JSON.stringify(WAIT), JSON.stringify(waitFor)),
    wait: memo.wait!.replace(JSON.stringify(WAIT), JSON.stringify(waitFor)) }]));
  const precheck = checkInPrecheck({ at: now - 15 * MIN, since: now - 15 * MIN, steps }, [], board, now, { self: [CHAT, "frontend bro"], rows: [], ...(train ? { train } : {}) });
  return precheck.blocked.map(block => block.view.item.id).filter(id => id === "p86" || id === "p101").sort();
}

test("frontend bro p86 and p101: a wait on the release owner's hold is not blocked_on_others at the 18:51Z, 19:06Z and 19:21Z check-ins", () => {
  for (const [slot, now] of Object.entries(SLOTS)) {
    assert.deepEqual(blockedAt(now, { train: trainAt(now) }), [], `${slot}: the land-34 critical set moves on ci/ branches while no land or promote run is in progress`);
  }
});

test("launch main bro's wording of the same hold, \"Fable's release of the land 34 loop\", is a wait on the hold too", () => {
  const now = SLOTS["18:51"];
  assert.deepEqual(blockedAt(now, { train: trainAt(now), waitFor: "Fable's release of the land 34 loop; then r10 pushed fresh on the tip; green; CAS; land 35" }), [],
    "launch main bro p84's waitFor at 20:15Z");
});

test("frontend bro p86 and p101: an \"ETA HH:MMZ to HH:MMZ\" in the note is a planned end, the later clock", () => {
  assert.deepEqual(blockedAt(SLOTS["19:21"]), [], "19:21Z, no CI cache: the 19:07:57Z note's ETA 00:30Z plus the grace is ahead");
  const item = { id: "p86", text: "", status: "blocked", children: [], waitFor: WAIT, note: NOTES[1]![1].p86 } as unknown as PlanItem;
  assert.equal(new Date(plannedEnd(item, Date.parse("2026-10-13T17:50:32.745Z"))!).toISOString(), "2026-10-14T00:30:00.000Z");
  assert.equal(new Date(plannedEnd({ ...item, note: "Fable's ETA is ~22:00Z." }, SLOTS["19:21"])!).toISOString(), "2026-10-13T22:00:00.000Z");
  assert.equal(plannedEnd({ ...item, note: "At 23:00Z, 7 of 10 jobs were green." }, SLOTS["19:21"]), undefined, "a clock with no ETA is still no end");
});

test("frontend bro p86 and p101 controls: a stalled hold, a passed ETA and a land wait with no hold still flag", () => {
  const both = ["p101", "p86"];
  assert.deepEqual(blockedAt(SLOTS["18:51"]), both, "18:51Z, no CI cache: the 17:41Z and 17:45Z notes name no end");
  assert.deepEqual(blockedAt(SLOTS["18:51"], { train: trainAt(SLOTS["18:51"], 3 * 60 * MIN) }), both,
    "a hold whose runs last moved over TRAIN_IDLE_MS before does not move");
  const late = Date.parse("2026-10-14T01:01:00Z");
  assert.deepEqual(blockedAt(late, { train: trainAt(late, 6 * 60 * MIN) }), both, "past the ETA 00:30Z plus the grace, with the hold idle, both flag again");
  assert.deepEqual(blockedAt(SLOTS["18:51"], { train: trainAt(SLOTS["18:51"]), waitFor: "land 34, then one fresh push" }), both,
    "a wait on land 34 that names no hold rides only land and promote runs, and none ran since 10:16:45Z");
});

test("a run in progress on a land branch moves the train for a wait on that land", () => {
  const now = SLOTS["18:51"];
  const run = { id: 1, name: "verify-dev", head_branch: "ci/land-34-r2", path: ".github/workflows/verify-dev.yml", status: "in_progress", conclusion: null,
    created_at: "2026-10-13T18:40:00Z", updated_at: "2026-10-13T18:40:00Z" };
  const train = trainAt(now, 0, [run]);
  assert.deepEqual(train.runs.filter(entry => entry.id === "1").map(entry => entry.key), ["34"]);
  assert.deepEqual(blockedAt(now, { train, waitFor: "land 34, then one fresh push" }), []);
  assert.deepEqual(trainAt(now, 0, [{ ...run, head_branch: "ci/landing-copy-r2" }]).runs.filter(entry => entry.id === "1"), [], "ci/landing-copy is no land branch");
});
