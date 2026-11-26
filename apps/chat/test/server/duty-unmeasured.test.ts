/**
 * A run that measured no miss but left a counted metric unmeasured reads error, never met. When an `outside_wait` item names the wait, the
 * run keeps waitsOn and starts no job. On 11-26 VP of GTM's d1 read met on mailboxes_over_stop_line alone while its headline reply_rate_7d_pct
 * waited on the owner's For you todos, and agent factory's d7 counted it met on n = 0.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/duty-unmeasured.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { measure } from "../../server/duty-run.ts";
import { judge, type Duty, type DutyMetric } from "../../web/src/lib/api/shared/chat-duties.ts";

delete process.env.INVOCATION_ID;

const metrics: DutyMetric[] = [
  { key: "reply_rate_7d_pct", label: "Reply rate", op: ">=", target: 0.5, unit: "%", headline: true },
  { key: "mailboxes_over_stop_line", label: "Mailboxes over the line", op: "<=", target: 0 },
];
const wait = { kind: "outside_wait", excerpt: "No campaign is sending yet: batch 1 waits on the owner's For you todos t2, t3 and t4." };

test("judge reads a run with an unmeasured metric and no miss as error, and a measured miss as missed", () => {
  const partial = judge(metrics, { metrics: { mailboxes_over_stop_line: 0 }, flagged: [wait] });
  assert.equal(partial.verdict, "error");
  assert.deepEqual(Object.keys(partial.metrics), ["mailboxes_over_stop_line"], "the measured metric keeps its result");
  assert.match(partial.summary, /not measured: the precheck gave no value for reply_rate_7d_pct/);
  assert.equal(judge(metrics, { metrics: { mailboxes_over_stop_line: 2 } }).verdict, "missed");
  assert.equal(judge(metrics, { metrics: { mailboxes_over_stop_line: 0, reply_rate_7d_pct: 1 } }).verdict, "met");
});

test("a run whose headline waits outside the precheck records error with waitsOn and starts no job; without the wait it starts one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "duty-unmeasured-"));
  try {
    const duty = (flagged: unknown[]) => ({
      id: "d1", name: "Outreach campaigns", ownerWords: "w", goal: "g", onMiss: "m", metrics, schedule: { kind: "daily", at: "07:18" },
      precheck: { command: ["node", "-e", `require("fs").writeFileSync(process.env.OUTPUT_FILE, ${JSON.stringify(JSON.stringify({ metrics: { mailboxes_over_stop_line: 0 }, n: 0, flagged }))})`], cwd: dir, timeoutMs: 30_000 },
    }) as unknown as Duty;
    let at = Date.now();
    const run = (d: Duty) => measure({ duty: d, chat: { id: "ag_x", name: "X" }, dir, trigger: "schedule", previous: [], board: null, liveJob: () => false, boardApi: "http://x", now: at++ });
    const waiting = await run(duty([wait]));
    assert.equal(waiting.record.verdict, "error");
    assert.equal(waiting.record.waitsOn, wait.excerpt);
    assert.equal(waiting.brief, null, "a wait on the owner gives a job nothing to do");
    const broken = await run(duty([]));
    assert.equal(broken.record.verdict, "error");
    assert.equal(broken.record.waitsOn, undefined);
    assert.notEqual(broken.brief, null, "an unexplained gap starts a job");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
