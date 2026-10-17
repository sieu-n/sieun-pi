import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { UNLOAD_IDLE_MS, unloadPlan } from "../src/idle-unload.ts";

type Fixture = { takenAt: string; chats: string[]; pool: string[]; rows: SessionSummary[] };
const load = (name: string): Fixture => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")) as Fixture;
const TEN_MIN = 10 * 60_000;

// `prime-agent sessions --json` at 21:22Z on 10-15: 136 loaded sessions, 25 workers holding 20.77 GB, and the hour at 71.7% usable with 15
// harness minutes. Prime's idle sweep had not stopped idle roots: each sweep ends at the first worker that "did not stop".
const fixture = load("daemon-rows-1015-2122.json");
const now = Date.parse(fixture.takenAt);
const roots = (plan: SessionSummary[]) => plan.filter(row => (row.rlmDepth ?? 0) === 0 && row.runtimeKind !== "subagent");
const plan = unloadPlan(fixture.rows, { chats: new Set(fixture.chats), pool: new Set(fixture.pool), now, childIdleMs: null });

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
    { sessionActions: { queuedCount: 1, steering: [], followUps: [] } }, { activity: "working" }, { lastActivityAt: new Date(now - 30_000).toISOString() }] as Partial<SessionSummary>[]) {
    assert.deepEqual(unloadPlan([{ ...base, ...change } as SessionSummary], { chats: new Set(), pool: new Set(), now, childIdleMs: TEN_MIN }), [], JSON.stringify(change));
  }
  assert.deepEqual(unloadPlan([base], { chats: new Set([base.sessionId]), pool: new Set(), now, childIdleMs: TEN_MIN }), []);
});

// The same list at 21:33Z on 10-17: 106 resident sessions with a Python kernel each, swap at 15.3 of 16 GB, and Prime's child passivation
// sweep timing out. 57 idle subagents stayed resident inside trees that still ran, because the unload stopped only roots.
const day17 = load("daemon-rows-1017-2133.json");
const at17 = Date.parse(day17.takenAt);
const plan17 = unloadPlan(day17.rows, { chats: new Set(day17.chats), pool: new Set(day17.pool), now: at17, childIdleMs: TEN_MIN });
const children17 = plan17.filter(row => !roots([row]).length);

test("the 10-17 rows stop each subagent idle for idleEvictionMinutes with nothing at work below it", () => {
  const names = new Set(children17.map(row => row.sessionName));
  for (const name of ["gap-niche-missing", "gap-secuid-missing", "grafana-c-checks", "test results in ci", "query mcp build"]) assert.ok(names.has(name), name);
  assert.ok(children17.length >= 15, `${children17.length} subagents`);
  const byId = new Map(day17.rows.map(row => [row.sessionId, row] as const));
  for (const row of children17) {
    assert.ok(at17 - Date.parse(row.lastActivityAt!) >= TEN_MIN, row.sessionName);
    const below = day17.rows.filter(other => { for (let up = other.parentSessionId; up; up = byId.get(up)?.parentSessionId) if (up === row.sessionId) return true; return false; });
    assert.ok(below.every(other => other.activity === "idle"), `${row.sessionName} has a session at work below it`);
  }
});

test("a subagent with a session at work below it, quiet for less than idleEvictionMinutes, or with idle eviction off keeps its worker", () => {
  const child = children17[0]!;
  const quiet = { chats: new Set<string>(), pool: new Set<string>(), now: at17 };
  assert.deepEqual(unloadPlan([child], { ...quiet, childIdleMs: TEN_MIN }).length, 1);
  assert.deepEqual(unloadPlan([child], { ...quiet, childIdleMs: null }), []);
  assert.deepEqual(unloadPlan([{ ...child, lastActivityAt: new Date(at17 - TEN_MIN + 60_000).toISOString() }], { ...quiet, childIdleMs: TEN_MIN }), []);
  const grandchild = { ...child, sessionId: "below-1", activeSessionId: "below-1", parentSessionId: "below-0", activity: "working" } as SessionSummary;
  const middle = { ...child, sessionId: "below-0", activeSessionId: "below-0", parentSessionId: child.sessionId } as SessionSummary;
  assert.deepEqual(unloadPlan([child, middle, grandchild], { ...quiet, childIdleMs: TEN_MIN }), []);
});
