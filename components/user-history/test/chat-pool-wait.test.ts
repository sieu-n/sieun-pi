// From 03:42:20Z to 03:47:50Z on 10-26 us-metal02's chat answered reads in 2.3 to 10.7 s with its event loop stalled at most 273 ms, and its
// latency line could not say whether file reads were waiting for libuv's thread pool.
import assert from "node:assert/strict";
import { pbkdf2 } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { takeLatency, timeRead } from "../src/chat-latency.ts";
import { harnessSlow } from "../src/harness-slow.ts";

test("the latency line times how long a file read waited for the thread pool, a probe still out included", async () => {
  timeRead({ method: "POST" } as IncomingMessage, {} as ServerResponse, "/");
  await sleep(1200);
  assert.ok((takeLatency()?.poolMs ?? Infinity) < 500, "an idle pool answers a stat at once");
  // Each pbkdf2 holds one of the 4 threads for about 4 s on us-metal02, so the probes queue behind them.
  const held = Array.from({ length: 4 }, () => new Promise(resolve => { pbkdf2("a", "b", 4_000_000, 32, "sha256", resolve); }));
  await sleep(2500);
  const busy = takeLatency()?.poolMs ?? 0;
  assert.ok(busy >= 1000, `the probe waited ${busy} ms behind the held threads`);
  await Promise.all(held);
});

test("a thread-pool wait over 1 s is named beside the slow read it explains", () => {
  assert.deepEqual(harnessSlow({ box: "us-metal02", own: true, latency: { readMs: 2263, read: "api/accounts", loopMs: 144, poolMs: 2100 }, from: 0, to: 1, misses: [], faults: [] }),
    ["the chat answered api/accounts in 2.3 s", "the chat's file reads waited 2.1 s for a thread-pool thread"]);
  assert.deepEqual(harnessSlow({ box: "us-metal02", own: true, latency: { readMs: 40, loopMs: 144, poolMs: 30 }, from: 0, to: 1, misses: [], faults: [] }), []);
});
