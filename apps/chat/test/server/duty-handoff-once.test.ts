/**
 * A duty's hand-off item (`handOff` with a sig, such as the Area review's `<agent>:<day>`) goes to one job: a later run of the same duty
 * that hands off the same sig starts no job for it when nothing else is due. On 11-26 VP of GTM's d3 started three jobs for
 * ag_vp-of-gtm:2026-11-25, and each rerun that day repeated the review.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/duty-handoff-once.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { measure } from "../../server/duty-run.ts";
import type { Duty, DutyRunRecord } from "../../web/src/lib/api/shared/chat-duties.ts";

delete process.env.INVOCATION_ID;

test("a hand-off sig an earlier run gave a job starts no second job; a new sig or a missed metric still does", async () => {
  const dir = mkdtempSync(join(tmpdir(), "duty-handoff-"));
  try {
    const duty = (sig: string, unsaved = 0) => ({
      id: "d3", name: "Area review", ownerWords: "w", goal: "g", onMiss: "m", metrics: [{ key: "corrections_unsaved", label: "Unsaved", op: "<=", target: 0, headline: true }],
      schedule: { kind: "daily", at: "05:39" },
      precheck: { command: ["node", "-e", `require("fs").writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ n: 1, metrics: { corrections_unsaved: ${unsaved} }, ` +
        `flagged: [{ kind: "area_review", sig: ${JSON.stringify(sig)}, handOff: true, excerpt: "review" }] }))`], cwd: dir, timeoutMs: 30_000 },
    }) as unknown as Duty;
    let at = Date.now();
    const run = (d: Duty, previous: DutyRunRecord[]) => measure({ duty: d, chat: { id: "ag_vp-of-gtm", name: "VP of GTM" }, dir, trigger: "schedule", previous, board: null, liveJob: () => false, boardApi: "http://x", now: at++ });
    const first = await run(duty("ag_vp-of-gtm:2026-11-25"), []);
    assert.notEqual(first.brief, null, "the day's first run hands the review to a job");
    assert.deepEqual(first.record.flagged?.map(slice => slice.sig), ["ag_vp-of-gtm:2026-11-25"]);
    const withJob = { ...first.record, job: { id: "j1", name: "Area review duty 261126-054934" } };
    const again = await run(duty("ag_vp-of-gtm:2026-11-25"), [withJob]);
    assert.equal(again.brief, null, "a rerun the same day starts no job for the same sig");
    // A run whose earlier job never started (no job on the record) still hands off.
    assert.notEqual((await run(duty("ag_vp-of-gtm:2026-11-25"), [first.record])).brief, null);
    assert.notEqual((await run(duty("ag_vp-of-gtm:2026-11-26"), [withJob])).brief, null, "the next day's sig is new");
    // A finding whose job ran over a day ago, such as a page still off shape, goes out again.
    assert.notEqual((await run(duty("ag_vp-of-gtm:2026-11-25"), [{ ...withJob, at: at - 25 * 3_600_000 }])).brief, null);
    assert.notEqual((await run(duty("ag_vp-of-gtm:2026-11-25", 2), [withJob])).brief, null, "a missed metric still starts a job");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
