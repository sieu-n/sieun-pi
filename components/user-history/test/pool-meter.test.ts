import assert from "node:assert/strict";
import { test } from "node:test";
import { poolCaps, poolSummary } from "../src/client/pool-meter.ts";
import type { PoolAccount, PoolProvider } from "../src/shared/types.ts";

const NOW = 1_791_300_000_000;
const account = (id: string, five: number | null, week: number, extra: Partial<PoolAccount> = {}): PoolAccount => ({
  id, email: id, label: id, usage: "", session_pct: five, weekly_pct: week, usable: true, reason: null, current: false, pinned: false, live: false, seat: false,
  score: null, tier: null, usageAt: NOW, cooldownUntil: null, cooldownReason: null, limitedUntil: null, disabled: false, sessions: 0,
  windows: [...(five === null ? [] : [{ kind: "session" as const, label: "5h", pct: five, resetsAt: NOW + 3_600_000 }]),
    { kind: "weekly" as const, label: "week", pct: week, resetsAt: NOW + 7 * 3_600_000 }], ...extra });
const pool = (rows: PoolAccount[], provider: PoolProvider["provider"] = "anthropic"): PoolProvider => ({ provider, rows, resolution: null });

test("pool meter: blocked and week-depleted accounts count as full, turned-off accounts are left out", () => {
  const summary = poolSummary(pool([
    account("ok", 20, 40),
    account("week-out", 0, 98, { usable: false, reason: "depleted" }),
    account("login", 0, 0, { usable: false, reason: "needs-reauth" }),
    account("refused", 0, 0, { usable: false, reason: "cooldown 21h", cooldownUntil: NOW + 3_600_000 }),
    account("off", 0, 0, { disabled: true }),
  ]), poolCaps(null), NOW);
  assert.deepEqual(summary.meters.map(meter => [meter.key, meter.pct]), [["5h", 80], ["week", 84.5]]);
  assert.equal(summary.usable, 1);
  assert.equal(summary.total, 4);
  assert.equal(summary.nextFree, NOW + 3_600_000);
});

test("pool meter: a 429-limited account counts as full and frees at its limit end", () => {
  const summary = poolSummary(pool([account("ok", 20, 40), account("limited", 10, 10, { usable: false, reason: "limited 30m", limitedUntil: NOW + 1_800_000 })]), poolCaps(null), NOW);
  assert.deepEqual(summary.meters.map(meter => [meter.key, meter.pct]), [["5h", 60], ["week", 70]]);
  assert.equal(summary.nextFree, NOW + 1_800_000);
});

test("pool meter: Codex has no 5h window, and the next free time is the depleted window's reset", () => {
  const summary = poolSummary(pool([account("pro", null, 98, { usable: false, reason: "depleted" }), account("plus", null, 10)], "openai-codex"), poolCaps(null), NOW);
  assert.deepEqual(summary.meters.map(meter => meter.key), ["week"]);
  assert.equal(summary.nextFree, NOW + 7 * 3_600_000);
});

test("pool meter: the caps are pi-pool's admit caps for the thread's priority, from this Mac's config, else pi-pool's defaults", () => {
  assert.deepEqual(poolCaps(null), { "5h": 70, week: 98 });
  assert.deepEqual(poolCaps(null, "high"), { "5h": 70, week: 98 });
  assert.deepEqual(poolCaps(null, "low"), { "5h": 50, week: 98 });
  assert.deepEqual(poolCaps({ admit_5h_max_pct: 60, low_admit_5h_max_pct: 40, refresh_skew_sec: 900 }), { "5h": 60, week: 98 });
  assert.deepEqual(poolCaps({ admit_5h_max_pct: 60, low_admit_5h_max_pct: 40 }, "low"), { "5h": 40, week: 98 });
  // An account at 65% of its 5h window takes no new thread under a 60% cap, so the next free time is that window's reset.
  const rows = [account("ok", 20, 40), account("spent", 65, 40, { usable: false, reason: "depleted" })];
  assert.equal(poolSummary(pool(rows), poolCaps({ admit_5h_max_pct: 60 }), NOW).nextFree, NOW + 3_600_000);
  assert.equal(poolSummary(pool(rows), poolCaps(null), NOW).nextFree, null);
});
