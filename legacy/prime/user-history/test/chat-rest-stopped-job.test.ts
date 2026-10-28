// Guards d7's lingering finding of 05:57Z on 10-28: frontend bro (Mac) and Crawler VP sat attached and loaded alone on their workers, idle 18
// to 48 min, while pi-pool held jobs of theirs that the daemon had stopped mid-turn, and only the jobs' resume at 06:00Z and 06:01:30Z ended it.
// A job the daemon stopped reads running in the chat's roster with no activity time, and it must not hold the chat attached.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHILD_SILENT_MS, holding } from "../src/chat-dormancy.ts";
import { isThreadBusy } from "../src/shared/thread-state.ts";
import type { ChildAgent, ThreadState } from "../src/shared/types.ts";

const now = Date.parse("2026-10-28T05:57:00Z");
const idle = { info: { isStreaming: false, isCompacting: false, isBashRunning: false, retryAttempt: 0, sessionAction: null, queuedActions: 0 },
  queue: { steering: [], followUp: [] }, tools: [] } as unknown as Pick<ThreadState, "info" | "queue" | "tools">;
const busy = (children: ChildAgent[]) => isThreadBusy({ ...idle, children: holding(children, now) });

test("a running job the daemon stopped holds its chat no longer, and a loaded running or queued job still does", () => {
  const stopped: ChildAgent = { id: "sub-180ab", label: "brand collab counts off api loop", sessionName: "brand collab counts off api loop", status: "running" };
  assert.equal(busy([stopped]), false);
  assert.equal(busy([stopped, { id: "sub-done", label: "done", status: "done" }]), false);
  assert.equal(busy([{ ...stopped, lastActivityAt: now - 60_000 }]), true);
  assert.equal(busy([{ ...stopped, status: "queued", lastActivityAt: now }]), true);
  assert.equal(busy([{ ...stopped, lastActivityAt: now - CHILD_SILENT_MS }]), false);
});
