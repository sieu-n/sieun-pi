import assert from "node:assert/strict";
import { test } from "node:test";
import { LIVE_WINDOW_MS, sessionRates } from "../src/usage/rates.ts";

const NOW = 1_800_000_000_000;

test("sessionRates: a live rate from the last minute's calls, else the last call's rate, nothing without a start time", () => {
  const rates = sessionRates([
    { sessionId: "live", startedAt: NOW - 50_000, endedAt: NOW - 40_000, output: 500 },
    { sessionId: "live", startedAt: NOW - 30_000, endedAt: NOW - 10_000, output: 1000 },
    { sessionId: "live", startedAt: NOW - 3_600_000, endedAt: NOW - 3_000_000, output: 99_999 },
    { sessionId: "idle", startedAt: NOW - 7_200_000, endedAt: NOW - 7_190_000, output: 200 },
    { sessionId: "idle", startedAt: NOW - 3_600_000, endedAt: NOW - 3_596_000, output: 100 },
    { sessionId: "untimed", startedAt: null, endedAt: NOW - 1000, output: 100 },
    { sessionId: "zero", startedAt: NOW - 1000, endedAt: NOW - 1000, output: 100 },
  ], NOW);
  assert.deepEqual(rates, { live: { tps: 50, live: true }, idle: { tps: 25, live: false } });
  assert.equal(LIVE_WINDOW_MS, 60_000);
  assert.deepEqual(sessionRates([], NOW), {});
  assert.deepEqual(sessionRates([{ sessionId: "s", startedAt: NOW - 3000, endedAt: NOW, output: 10 }], NOW), { s: { tps: 3.3, live: true } });
});
