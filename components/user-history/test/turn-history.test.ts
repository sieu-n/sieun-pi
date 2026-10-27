// pi-pool.log's `ts` is UTC since 10-27 (components/pi-pool/pool/base.py `log`); until then it was the writer's local time, and the
// Agent queue chart read it as local time, which on the owner's Mac (KST) would put each UTC line 9 hours early.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hourOf, turnHistory } from "../src/turn-history.ts";

const inZone = async (zone: string, run: () => Promise<void> | void): Promise<void> => {
  const was = process.env.TZ;
  process.env.TZ = zone;
  try { await run(); } finally { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; }
};

test("hourOf reads ts as UTC on a KST clock", () => inZone("Asia/Seoul", () => {
  assert.equal(hourOf("2026-10-27T01:20:00"), Date.parse("2026-10-27T01:00:00Z"));
  assert.equal(hourOf("2026-10-27T01:20:00Z"), null, "pi-pool writes no offset");
}));

test("the chart's hours on a KST clock hold the UTC lines of their hour", () => inZone("Asia/Seoul", async () => {
  const dir = mkdtempSync(join(tmpdir(), "turn-history-"));
  try {
    const log = join(dir, "pi-pool.log");
    writeFileSync(log, [
      { ts: "2026-10-27T00:10:00", event: "turn_admitted", kind: "slot", waited_s: 30 },
      { ts: "2026-10-27T00:50:00", event: "turn_released" },
      { ts: "2026-10-27T01:05:00", event: "turn_admitted", kind: "slot", waited_s: 10 },
      { ts: "2026-10-27T01:06:00", event: "turn_released" },
      { ts: "2026-10-27T01:07:00", event: "turn_released" },
    ].map(line => JSON.stringify(line)).join("\n") + "\n");
    const hours = await turnHistory(log)(Date.parse("2026-10-27T01:30:00Z"));
    assert.deepEqual(hours, [
      { at: Date.parse("2026-10-27T00:00:00Z"), finished: 1, medianWaitS: 30 },
      { at: Date.parse("2026-10-27T01:00:00Z"), finished: 2, medianWaitS: 10 },
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}));
