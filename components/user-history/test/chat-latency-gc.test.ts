// Guards the GC field of the chat's latency line: d7 read 1.2 to 2.3 s loop stalls on us-metal02 on 10-20 with no word of their cause.
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { constants } from "node:perf_hooks";
import { test } from "node:test";
import { noteGc, takeLatency, timeRead } from "../src/chat-latency.ts";
import { chatLatency, harnessSlow } from "../src/harness-slow.ts";

test("the latency window keeps its longest GC and its kind, and the next window starts without one", () => {
  timeRead({ method: "POST" } as IncomingMessage, {} as ServerResponse, "/");
  takeLatency();
  noteGc(120, constants.NODE_PERFORMANCE_GC_MINOR);
  noteGc(1480.6, constants.NODE_PERFORMANCE_GC_MAJOR);
  noteGc(300, constants.NODE_PERFORMANCE_GC_INCREMENTAL);
  const taken = takeLatency();
  assert.equal(taken?.gcMs, 1481);
  assert.equal(taken?.gc, "major");
  assert.equal(takeLatency()?.gcMs, undefined);
});

test("a loop stall with a long GC beside it names the GC, and the minute stays dirty", () => {
  const latency = chatLatency({ readMs: 0, loopMs: 2100, gcMs: 1900, gc: "major" });
  assert.deepEqual(latency, { readMs: 0, loopMs: 2100, gcMs: 1900, gc: "major" });
  assert.deepEqual(harnessSlow({ box: "us-metal02", own: true, latency, from: 0, to: 1, misses: [], faults: [] }),
    ["the chat's event loop stalled 2.1 s (a major GC took 1.9 s)"]);
  assert.deepEqual(harnessSlow({ box: "us-metal02", own: true, latency: { readMs: 0, loopMs: 2100, gcMs: 40, gc: "minor" }, from: 0, to: 1, misses: [], faults: [] }),
    ["the chat's event loop stalled 2.1 s"]);
});
