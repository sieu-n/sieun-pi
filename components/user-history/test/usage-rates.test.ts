import assert from "node:assert/strict";
import { test } from "node:test";
import { LIVE_WINDOW_MS, MIN_RATE_MS, sessionRates } from "../src/usage/rates.ts";

const NOW = 1_800_000_000_000;

test("sessionRates: a live rate from the last minute's calls, else the average over every call, nothing without a start time", () => {
  const rates = sessionRates([
    { sessionId: "live", startedAt: NOW - 50_000, endedAt: NOW - 40_000, output: 500 },
    { sessionId: "live", startedAt: NOW - 30_000, endedAt: NOW - 10_000, output: 1000 },
    { sessionId: "live", startedAt: NOW - 3_600_000, endedAt: NOW - 3_000_000, output: 99_999 },
    { sessionId: "idle", startedAt: NOW - 7_200_000, endedAt: NOW - 7_190_000, output: 200 },
    { sessionId: "idle", startedAt: NOW - 3_600_000, endedAt: NOW - 3_596_000, output: 100 },
    { sessionId: "untimed", startedAt: null, endedAt: NOW - 1000, output: 100 },
    { sessionId: "zero", startedAt: NOW - 1000, endedAt: NOW - 1000, output: 100 },
  ], NOW);
  assert.deepEqual(rates, { live: { tps: 50, live: true }, idle: { tps: 21.4, live: false } });
  assert.equal(LIVE_WINDOW_MS, 60_000);
  assert.deepEqual(sessionRates([], NOW), {});
});

test("sessionRates: a finished session's short last call makes no spike, and under MIN_RATE_MS of generation makes no rate", () => {
  const job = [5284, 4375, 7510, 16794, 2800].map((ms, index) => ({ sessionId: "job", startedAt: NOW - 3_600_000 + index * 60_000, endedAt: NOW - 3_600_000 + index * 60_000 + ms,
    output: [506, 487, 410, 1807, 240][index]! }));
  const rates = sessionRates([...job, { sessionId: "job", startedAt: NOW - 3_000_000, endedAt: NOW - 2_999_996, output: 779 },
    { sessionId: "short", startedAt: NOW - 600_000, endedAt: NOW - 597_000, output: 16 }, { sessionId: "blip", startedAt: NOW - 10_003, endedAt: NOW - 10_000, output: 16 }], NOW);
  assert.deepEqual(rates, { job: { tps: 115, live: false } }, "4229 tokens over 36.8 s; a 3 s session and a 3 ms live call make no rate");
  assert.equal(MIN_RATE_MS, 5_000);
});
