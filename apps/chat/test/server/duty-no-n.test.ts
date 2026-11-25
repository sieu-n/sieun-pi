/**
 * A duty whose precheck output has no top-level n gets one line in its job's brief that tells the job to add n, and that fix goes to one
 * job a day, as a hand-off sig does. On 11-26 agent factory's d7 read 47 duties in 13 agents with no n, so a met run on no input looked green.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/duty-no-n.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { measure, NO_N_LINE } from "../../server/duty-run.ts";
import type { Duty, DutyRunRecord } from "../../web/src/lib/api/shared/chat-duties.ts";

delete process.env.INVOCATION_ID;

test("a met run with no n starts one job a day whose brief says to add n; a run that names n starts none", async () => {
  const dir = mkdtempSync(join(tmpdir(), "duty-no-n-"));
  try {
    const duty = (extra: string) => ({
      id: "d2", name: "Deploys stay green", ownerWords: "w", goal: "g", onMiss: "m", metrics: [{ key: "red", label: "Red deploys", op: "<=", target: 0, headline: true }],
      schedule: { kind: "daily", at: "05:39" },
      precheck: { command: ["node", "-e", `require("fs").writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { red: 0 }${extra} }))`], cwd: dir, timeoutMs: 30_000 },
    }) as unknown as Duty;
    let at = Date.now();
    const run = (d: Duty, previous: DutyRunRecord[]) => measure({ duty: d, chat: { id: "ag_x", name: "X" }, dir, trigger: "schedule", previous, board: null, liveJob: () => false, boardApi: "http://x", now: at++ });
    const bare = await run(duty(""), []);
    assert.equal(bare.record.verdict, "met");
    assert.ok(bare.brief?.includes(NO_N_LINE), "a met run with no n starts a job told to add n");
    const withJob = { ...bare.record, job: { id: "j1", name: "Deploys stay green duty 261126-054934" } };
    assert.equal((await run(duty(""), [withJob])).brief, null, "a rerun the same day starts no second job for it");
    assert.equal((await run(duty(", n: 4"), [])).brief, null, "a met run that names n starts no job");
    assert.equal((await run(duty(", n: { deploys: 4 }"), [])).brief, null, "n as one count per metric counts");
    const missed = await run({ ...duty(", n: 4"), metrics: [{ key: "red", label: "Red deploys", op: "<=", target: -1, headline: true }] } as Duty, []);
    assert.notEqual(missed.brief, null);
    assert.ok(!missed.brief?.includes(NO_N_LINE), "a run that names n carries no n line");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
