import assert from "node:assert/strict";
import { test } from "node:test";
import { dutyAdmitter } from "../src/chat-turn-queue.ts";
import type { AgentQueueReading } from "../src/shared/types.ts";

/**
 * A check-in starts at once (c89: no gate, hold or limit delays agent work over RAM). On 10-15 the check-in keys, asked as `checkin`, still
 * waited for a free slot under the working limit: "duty 01a141d2/checkin: the turn queue admitted its job after 1277 s" at 23:37Z, then 669 s
 * for it and Crawler VP at 23:54Z, and both waits were lost to server restarts. The runner now marks the check-in key as an owner turn first,
 * so pi-pool runs it at once (`mark_owner`, then `admit` pops the mark); any other duty asks as before.
 */
test("a check-in's queue key is marked to start at once before it asks the pool; another duty only asks", async () => {
  const calls: string[] = [];
  const pool = {
    mark: async (key: string) => { calls.push(`mark ${key}`); },
    admit: async (key: string, _tree: string, klass: string) => { calls.push(`admit ${key} ${klass}`); return "admitted" as const; },
    release: async (key: string) => { calls.push(`release ${key}`); },
    read: async () => ({ working: [], queued: [] }) as unknown as AgentQueueReading,
  };
  const admitter = dutyAdmitter({ log: () => {}, pool });
  await admitter.admit("01a141d2-0000", "checkin");
  await admitter.admit("01a141d2-0000", "d3");
  assert.deepEqual(calls, ["mark duty:01a141d2-0000:checkin", "admit duty:01a141d2-0000:checkin checkin", "admit duty:01a141d2-0000:d3 low"]);
});
