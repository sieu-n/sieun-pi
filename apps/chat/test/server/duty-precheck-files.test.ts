/**
 * Each precheck launch keeps its own state copy, so a cleanup of one run that lands late leaves the STATE_FILE of the next run. Until 11-23
 * every run of a duty shared `<duty>.state.next.json`, and fixture.test's second duty run read "error" once during a release at box load 240.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/duty-precheck-files.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clearPrecheck, launchPrecheck, waitPrecheck } from "../../server/duty-run.ts";
import type { Duty } from "../../web/src/lib/api/shared/chat-duties.ts";

delete process.env.INVOCATION_ID;

test("a late cleanup of one run's precheck leaves the next run's STATE_FILE", async () => {
  const dir = mkdtempSync(join(tmpdir(), "duty-precheck-files-"));
  try {
    // The precheck waits 300 ms before it reads its STATE_FILE, the gap in which the last run's cleanup lands.
    const script = `const fs = require("fs"); setTimeout(() => { const seen = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8")); ` +
      `fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ runs: (seen.runs ?? 0) + 1 })); ` +
      `fs.writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { runs: (seen.runs ?? 0) + 1 } })); }, 300);`;
    const duty = { id: "d1", name: "Files", schedule: { kind: "every", minutes: 60 }, precheck: { command: ["node", "-e", script], cwd: dir, timeoutMs: 30_000 } } as unknown as Duty;
    const first = await launchPrecheck(duty, dir, join(dir, "d1-261123-050000.json"), [], "run", "files-1");
    assert.deepEqual((await waitPrecheck(duty, first)).metrics, { runs: 1 });
    const second = await launchPrecheck(duty, dir, join(dir, "d1-261123-050001.json"), [], "run", "files-2");
    await clearPrecheck(first);
    assert.deepEqual((await waitPrecheck(duty, second)).metrics, { runs: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
