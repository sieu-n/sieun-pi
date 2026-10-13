import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkInPrecheck, convergenceMisses } from "../src/chat-checkin.ts";
import { parseTrain, type Train } from "../src/checkin-load.ts";
import type { StepMemo } from "../src/checkin-steps.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

/**
 * Crawler VP's real board (chat 01a115e2, rev 3030, 2026-10-13 05:20Z), the service's real step memos of its 05:18Z check-in, and the land and
 * promote runs of the CI cache (~/.cache/virev/ci-runs.json) read at 05:21Z. p40, p46, p47 and p85 wait for "... then land 34" while land 33's
 * run 38348869500 (created 04:56Z) is in progress and the release owner holds every push until its go push. The 05:03Z check-in flagged p40, p46
 * and p85 as blocked_on_others, and the 05:18Z one all four. p46's note at 05:03Z is its 10-12 23:41Z note, and at 05:18Z its 05:04Z note.
 */
const CHAT = "01a115e2-9544-7204-b8db-8ce4d5319048";
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/crawler-vp-train-board.json", import.meta.url), "utf8")) as
  { board: ChatBoard; steps: Record<string, StepMemo>; ciCache: { fetchedAt: string; runs: Record<string, { run: Record<string, unknown> }> } };
const P46_NOTES: Record<string, string> = {
  "05:03": "Land 32b is on prod since promote 8. A1 v5 5ca1fef0a0 waits on its own run (38302099800) and PROBE A, rerunning under the same id in land 34. Release owner's schedule at 23:38Z: land 33 on r9 dispatches about 01:00Z, and promote 9 reaches prod about 05:30Z (06:30Z if r9 slips past 01:30Z).",
  "05:18": "Land 32b is on prod since promote 8. A1 v5 rides land 34 in PROBE A. Land 33 (run 38348869500) is in progress; the freeze lifts at its metal step (about 05:45Z), then the go push and land 34.",
};
const SLOTS = { "05:03": "2026-10-13T05:03:13.408Z", "05:18": "2026-10-13T05:18:13.445Z" } as const;

/** The CI cache as read at `readAt`, with `change` applied to land 33's run 38348869500. */
function trainAt(readAt: string, change: Record<string, unknown> = {}): Train {
  const runs = { ...FIXTURE.ciCache.runs, "38348869500": { run: { ...FIXTURE.ciCache.runs["38348869500"]!.run, ...change } } };
  return parseTrain({ fetchedAt: readAt, runs })!;
}
/** The steps that wait on land 34; past 06:00Z other steps of the board go stale on their own, so only these are read there. */
const TRAIN_STEPS = ["p40", "p46", "p47", "p85"];
/** The ids flagged blocked_on_others at `now` with p46's note `note`, the real memos as the last check-in's memory. */
function blockedAt(now: number, note: string, train?: Train, p40WaitFor?: string): string[] {
  const swap = (item: PlanItem): PlanItem => ({ ...item, ...(item.id === "p46" ? { note } : {}), ...(item.id === "p40" && p40WaitFor ? { waitFor: p40WaitFor } : {}),
    children: item.children.map(swap) });
  const board = { ...FIXTURE.board, updatedAt: new Date(now).toISOString(), plan: FIXTURE.board.plan.map(swap) };
  const memo = FIXTURE.steps.p40!;
  const was = JSON.stringify(memo.wait ? JSON.parse(memo.wait)[0] : "");
  const steps = p40WaitFor ? { ...FIXTURE.steps, p40: { ...memo, sig: memo.sig.replace(was, JSON.stringify(p40WaitFor)), wait: memo.wait!.replace(was, JSON.stringify(p40WaitFor)) } } : FIXTURE.steps;
  const memory = { at: now - 15 * 60_000, since: now - 15 * 60_000, steps };
  const precheck = checkInPrecheck(memory, [], board, now, { self: [CHAT, "Crawler VP"], rows: [], ...(train ? { train } : {}) });
  const { flagged } = convergenceMisses(CHAT, precheck.steps, precheck, {}, 15 * 60_000, now);
  return flagged.filter(slice => slice.kind === "blocked_on_others" && (now < Date.parse("2026-10-13T06:00:00Z") || TRAIN_STEPS.includes(slice.item ?? "")))
    .map(slice => slice.item ?? "").sort();
}

test("Crawler VP p40, p46, p47 and p85: a wait on land 34 while land 33's run is in progress is not blocked_on_others", () => {
  for (const [slot, at] of Object.entries(SLOTS)) {
    const now = Date.parse(at);
    assert.deepEqual(blockedAt(now, P46_NOTES[slot]!, trainAt(at)), [], `${slot}: run 38348869500 is in progress, so the train moves`);
  }
  assert.deepEqual(blockedAt(Date.parse(SLOTS["05:03"]), P46_NOTES["05:03"]!), ["p40", "p46", "p85"], "with no CI cache, 05:03Z flags as the real check-in did");
  assert.deepEqual(blockedAt(Date.parse(SLOTS["05:18"]), P46_NOTES["05:18"]!), ["p40", "p46", "p47", "p85"], "with no CI cache, 05:18Z flags as the real check-in did");
});

test("Crawler VP p46: a wait that names a land whose newest run failed flags", () => {
  const now = Date.parse(SLOTS["05:18"]);
  const failed = trainAt(SLOTS["05:18"], { status: "completed", conclusion: "failure", updated_at: "2026-10-13T05:10:00Z" });
  assert.deepEqual(blockedAt(now, P46_NOTES["05:18"]!, failed), ["p46", "p47"],
    "p46's note names land 33's run 38348869500, now failed, and p47's says \"Land 33 doesn't carry A1\"; p40 and p85 name only land 34, which has no run yet");
  const older = trainAt(SLOTS["05:18"]);
  assert.deepEqual(blockedAt(now, P46_NOTES["05:03"]!, older), [], "land 33's failed run 38344244507 is not its newest, so naming land 33 does not flag");
});

test("Crawler VP p40, p46, p47 and p85: a train with no run in progress and none ended within TRAIN_IDLE_MS flags", () => {
  const passed = trainAt("2026-10-13T08:00:00Z", { status: "completed", conclusion: "success", updated_at: "2026-10-13T05:50:00Z" });
  assert.deepEqual(blockedAt(Date.parse("2026-10-13T07:39:00Z"), P46_NOTES["05:18"]!, passed), [], "109 min after land 33 ended, inside the 110 min limit");
  assert.deepEqual(blockedAt(Date.parse("2026-10-13T07:41:00Z"), P46_NOTES["05:18"]!, passed), ["p40", "p46", "p47", "p85"], "111 min after, past the limit");
  const stale = trainAt("2026-10-13T05:20:00Z");
  assert.deepEqual(blockedAt(Date.parse("2026-10-13T07:11:00Z"), P46_NOTES["05:18"]!, stale), ["p40", "p46", "p47", "p85"],
    "a run the cache last read in progress at 05:20Z counts as moving only until 07:10Z");
});

test("Crawler VP p40: a waitFor that names no land stays blocked_on_others though its note mentions one (VP of CI p120's shape)", () => {
  const now = Date.parse(SLOTS["05:03"]);
  assert.deepEqual(blockedAt(now, P46_NOTES["05:03"]!, trainAt(SLOTS["05:03"]), "the media serving check on the release owner's CI pass"), ["p40"],
    "p40's note says \"The media change rides PROBE A r5. After the land, ...\", and its waitFor names CI but no land or train run");
});
