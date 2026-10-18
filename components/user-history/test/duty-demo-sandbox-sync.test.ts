// Guards the box drift count in d1 (10-18, job "demo sync watcher"): the walk runs on us-metal02's 5180, and the owner's uncommitted demo edits
// reach that tree only through the Mac watcher ai.virev.demo-box-sync, so a stopped watcher or lasting drift has to miss the duty.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readBoxSync, SYNC_STALE_MS } from "../scripts/duties/demo-sandbox.ts";

const NOW = Date.parse("2026-10-18T07:10:00Z");
const status = (fields: Record<string, unknown>) => JSON.stringify({ ok: true, checked_at: "2026-10-18T07:08:00Z", drift: 0, consecutive_drift_runs: 0, alert: false, ...fields });

test("a fresh clean check counts nothing", () => {
  assert.deepEqual(readBoxSync(status({}), NOW).problems, 0);
});

test("one check with drift does not count, two in a row count each file", () => {
  assert.equal(readBoxSync(status({ drift: 3, consecutive_drift_runs: 1 }), NOW).problems, 0);
  const lasting = readBoxSync(status({ drift: 3, consecutive_drift_runs: 2, alert: true, drift_files: ["missing apps/virev-demo/a.ts"] }), NOW);
  assert.equal(lasting.problems, 3);
  assert.equal(lasting.kind, "box_drift");
  assert.match(lasting.excerpt, /missing apps\/virev-demo\/a\.ts/);
});

test("two failed checks count 1", () => {
  assert.equal(readBoxSync(status({ ok: false, drift: null, consecutive_drift_runs: 2, alert: true, error: "ssh exited 255" }), NOW).problems, 1);
});

test("a missing, broken or stale status counts 1", () => {
  assert.equal(readBoxSync(Object.assign(new Error("ENOENT"), { code: "ENOENT" }), NOW).kind, "box_sync_missing");
  assert.equal(readBoxSync("{", NOW).problems, 1);
  const stale = readBoxSync(status({ checked_at: new Date(NOW - SYNC_STALE_MS - 1000).toISOString() }), NOW);
  assert.equal(stale.problems, 1);
  assert.equal(stale.kind, "box_sync_stale");
});
