// Guards 10-19 15:46Z to 15:52Z: after 5279cb39 the watchdog told ops guy "polling again" every 30 s, because a null alerting state (recovered)
// read like "not restored yet" to `??=`, so the main thread and the poll worker both read the old alert_since back from the status file.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BridgeWatch, PollHealth } from "../src/alert-bridge-health.ts";

test("the watchdog tells ops guy once that the bridge polls again, and not on every tick after", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-watch-once-"));
  const statusFile = join(dir, "alert-bridge-status.json");
  const now = Date.parse("2026-10-19T15:46:44Z");
  await writeFile(statusFile, JSON.stringify({ v: 1, alert_since: "2026-10-19T15:20:05.016Z", alert_sent_at: "2026-10-19T15:27:14.165Z" }));
  const health = new PollHealth(() => now);
  health.record = { configuredAt: now - 3_600_000, lastOk: now - 1000, lastError: null, firing: 47 };
  const sent: string[] = [];
  const handed: unknown[] = [];
  const watch = new BridgeWatch({ health, statusFile, configFile: join(dir, "grafana-alerts.json"), now: () => now, wokeAt: async () => null,
    deliver: async (_session, text) => { sent.push(text); }, alerting: alerting => { handed.push(alerting); }, log: () => {} });
  for (let tick = 0; tick < 4; tick++) await watch.tick();
  assert.equal(sent.length, 1);
  assert.deepEqual(handed.slice(-1), [null]);
});
