// Guards the 10-18 owner report on us-metal02 ("the web server sieu-pi keep crashing"): the service starts from 04:22Z to 06:15Z each opened 11
// to 49 sessions live in their first 3 min, up to 253 s of attach and snapshot in all and up to 49 s for one, and every pinned chat idle for
// less than idleEvictionMinutes (10) was among them. A pinned chat that is not at work now stays detached until its first need.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { Dormancy } from "../src/chat-dormancy.ts";

const now = Date.parse("2026-10-18T06:15:37Z");
const summary = (change: Partial<SessionSummary> = {}): SessionSummary =>
  ({ sessionId: "01a11bd7", cwd: "/x", lastActivityAt: new Date(now - 2 * 60_000).toISOString(), isSessionActive: false, activity: "idle", ...change }) as SessionSummary;

test("a pinned chat idle 2 min stays detached at a service start, and one at work or held by a duty attaches", async () => {
  const dormancy = new Dormancy({ minutes: () => 10, now: () => now, held: async id => id === "held" });
  assert.equal(await dormancy.restedOnDisk(summary(), () => []), 2 * 60_000);
  assert.equal(await dormancy.restedOnDisk(summary({ isSessionActive: true }), () => []), null);
  assert.equal(await dormancy.restedOnDisk(summary({ activity: "working" }), () => []), null);
  assert.equal(await dormancy.restedOnDisk(summary({ hasRunningRlmChildren: true }), () => [now - 60_000]), null);
  assert.equal(await dormancy.restedOnDisk(summary({ sessionId: "held" }), () => []), null);
});
