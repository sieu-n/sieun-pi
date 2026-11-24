// d9's brief of 2026-11-25 05:21 KST told its job both "This run starts a new root-cause job" (stuckFindings) and "Start no job" (missLine) for
// duties_green_pct, whose 11 reds all had owners (redOwners.none 0). A stuck metric whose reds are all owned, or whose fix waits on the owner,
// gets no "Change approach" line.
import assert from "node:assert/strict";
import { test } from "node:test";
import { stuckFindings } from "../src/chat-duty-run.ts";
import type { MetricStreak } from "../src/shared/duty-streak.ts";

const base: MetricStreak = { key: "duties_green_pct", misses: 552, moved: false, since: 0, value: 84.5, target: 100, op: ">=", stuck: true };

test("a stuck metric whose every red has an owner gets no change-approach line", () => {
  const owned = { ...base, fix: { step: "p1671", job: "d11 window last event", live: false },
    redOwners: { live: 5, owner: 1, aging: 1, swFactory: 4, ownRuns: 0, none: 0 } };
  assert.equal(stuckFindings([owned]), "");
});

test("a stuck metric whose fix waits on the owner's todo gets no change-approach line", () => {
  assert.equal(stuckFindings([{ ...base, key: "owner_fixes", fix: { step: "p1664", live: false, hold: "t44" } }]), "");
});

test("a stuck metric with an unowned red still gets its change-approach line", () => {
  const unowned = { ...base, redOwners: { live: 5, owner: 1, aging: 1, swFactory: 4, ownRuns: 0, none: 1 } };
  assert.match(stuckFindings([unowned]), /duties_green_pct missed 552 runs.*starts a new root-cause job/);
  assert.match(stuckFindings([{ ...base, key: "x" }]), /x missed 552 runs/);
});
