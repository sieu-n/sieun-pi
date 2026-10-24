// 10-24 us-metal02: the chat's CPU profile pid626077 shows deletedFolders' pairwise nested-folder check holding the event loop 973 ms at
// 12:26:02Z, and d7 read that minute dirty ("the chat's event loop stalled 1 s"). The same check took 424 to 450 ms in three more sweeps of that
// profile. The nested-folder pass now looks each folder's parents up in a set.
import assert from "node:assert/strict";
import { test } from "node:test";
import { outermost } from "../src/job-leftovers.ts";
import { SLOW_READ_MS } from "../src/harness-slow.ts";

test("outermost keeps the folders inside no other one, and a sibling that only shares a name prefix stays", () => {
  assert.deepEqual(outermost(["/c/a/x", "/c/a", "/c/a-b", "/c/a/x/y", "/c/b/z"]), ["/c/a", "/c/a-b", "/c/b/z"]);
  assert.deepEqual(outermost([]), []);
});

test("outermost on 6,000 deleted job folders ends well under the watch's 1 s stall line", () => {
  const base = "/home/u/.prime/agent/session-artifacts/01a1164b-4a2d-742d-b27a-82f086ed0200";
  const dirs = Array.from({ length: 6000 }, (_, i) => `${base}/sub-${(i * 2654435761 >>> 0).toString(16).padStart(8, "0")}${i % 3 ? `/sub-${i.toString(16).padStart(8, "0")}` : ""}`);
  const started = performance.now();
  const kept = outermost(dirs);
  const ms = performance.now() - started;
  assert.equal(kept.length, 6000);
  assert.ok(ms < SLOW_READ_MS / 10, `outermost took ${ms.toFixed(0)} ms; the pairwise check took 9.1 s on this input on us-metal02 on 10-24`);
});
