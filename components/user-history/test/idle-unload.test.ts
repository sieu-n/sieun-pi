import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { UNLOAD_IDLE_MS, unloadPlan } from "../src/idle-unload.ts";

// `prime-agent sessions --json` at 21:22Z on 10-15: 136 loaded sessions, 25 workers holding 20.77 GB, and the hour at 71.7% usable with 15
// harness minutes. Prime's idle sweep had not stopped idle roots: each sweep ends at the first worker that "did not stop".
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/daemon-rows-1015-2122.json"), "utf8")) as
  { takenAt: string; chats: string[]; pool: string[]; rows: SessionSummary[] };
const now = Date.parse(fixture.takenAt);
const plan = unloadPlan(fixture.rows, { chats: new Set(fixture.chats), pool: new Set(fixture.pool), now });

test("the 21:22Z rows unload the idle top-level jobs with nothing running, queued or scheduled", () => {
  assert.deepEqual(plan.map(row => row.sessionId).sort(), ["01a10810-34b5-710f-88fe-3d369f89a8c9", "01a13f51-8e0d-70a3-b3bd-f35c39c94b2c", "01a13fff-aed5-71ab-a420-e32514dea6f1", "01a14068-faa2-7369-a7d0-0389df1d4632"]);
  for (const row of plan) {
    assert.equal(row.rlmDepth ?? 0, 0);
    assert.ok(!fixture.chats.includes(row.sessionId), "never a chat");
    assert.ok(!fixture.pool.includes(row.sessionId), "never one with a turn working or queued in pi-pool");
    assert.ok(now - Date.parse(row.lastActivityAt!) >= UNLOAD_IDLE_MS);
  }
});

test("a session with a heartbeat, a client attached, a running child, a queued input or a minute of quiet missing keeps its worker", () => {
  const base = plan[0]!;
  for (const change of [{ hasRegisteredHeartbeat: true }, { hasRegisteredCronJob: true }, { attachedClients: 1 }, { hasRunningRlmChildren: true },
    { sessionActions: { queuedCount: 1, steering: [], followUps: [] } }, { activity: "working" }, { lastActivityAt: new Date(now - 30_000).toISOString() },
    { rlmDepth: 1 }] as Partial<SessionSummary>[]) {
    assert.deepEqual(unloadPlan([{ ...base, ...change } as SessionSummary], { chats: new Set(), pool: new Set(), now }), [], JSON.stringify(change));
  }
  assert.deepEqual(unloadPlan([base], { chats: new Set([base.sessionId]), pool: new Set(), now }), []);
});
