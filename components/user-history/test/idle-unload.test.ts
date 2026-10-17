import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { unloadPlan } from "../src/idle-unload.ts";

type Fixture = { takenAt: string; chats: string[]; pool: string[]; rows: SessionSummary[] };
const load = (name: string): Fixture => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")) as Fixture;
const TEN_MIN = 10 * 60_000;
const isRoot = (row: SessionSummary): boolean => (row.rlmDepth ?? 0) === 0 && row.runtimeKind !== "subagent";

// `prime-agent sessions --json` at 21:22Z on 10-15: 136 loaded sessions, 25 workers holding 20.77 GB, and the hour at 71.7% usable with 15
// harness minutes. Prime's idle sweep had not stopped idle roots: each sweep ends at the first worker that "did not stop".
const day15 = load("daemon-rows-1015-2122.json");
const at15 = Date.parse(day15.takenAt);
const plan15 = unloadPlan(day15.rows, { chats: new Set(day15.chats), pool: new Set(day15.pool), now: at15, idleMs: TEN_MIN });

test("the 10-15 rows unload the top-level jobs idle for idleEvictionMinutes with nothing running, queued or scheduled", () => {
  const roots = plan15.filter(isRoot);
  assert.ok(roots.length >= 1, `${roots.length} roots`);
  for (const row of roots) {
    assert.ok(!day15.chats.includes(row.sessionId), "never a chat");
    assert.ok(!day15.pool.includes(row.sessionId), "never one with a turn working or queued in pi-pool");
    assert.ok(at15 - Date.parse(row.lastActivityAt!) >= TEN_MIN);
  }
});

test("a session with a heartbeat, a client attached, a running child, a queued input or idleEvictionMinutes of quiet missing keeps its worker", () => {
  const base = plan15.find(isRoot)!;
  const input = { chats: new Set<string>(), pool: new Set<string>(), now: at15, idleMs: TEN_MIN };
  for (const change of [{ hasRegisteredHeartbeat: true }, { hasRegisteredCronJob: true }, { attachedClients: 1 }, { hasRunningRlmChildren: true },
    { sessionActions: { queuedCount: 1, steering: [], followUps: [] } }, { activity: "working" }, { lastActivityAt: new Date(at15 - TEN_MIN + 60_000).toISOString() }] as Partial<SessionSummary>[]) {
    assert.deepEqual(unloadPlan([{ ...base, ...change } as SessionSummary], input), [], JSON.stringify(change));
  }
  assert.deepEqual(unloadPlan([base], { ...input, chats: new Set([base.sessionId]) }), []);
  assert.deepEqual(unloadPlan([base], { ...input, idleMs: null }), [], "idle eviction off stops none");
});

// The same list at 21:33Z on 10-17: 106 resident sessions with a Python kernel each, swap at 15.3 of 16 GB, and Prime's child passivation
// sweep timing out. 57 idle subagents stayed resident inside trees that still ran, because the unload stopped only roots.
const day17 = load("daemon-rows-1017-2133.json");
const at17 = Date.parse(day17.takenAt);
const plan17 = unloadPlan(day17.rows, { chats: new Set(day17.chats), pool: new Set(day17.pool), now: at17, idleMs: TEN_MIN });
const children17 = plan17.filter(row => !isRoot(row));

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

test("a root reloaded by a message 1 to 2 minutes after it went quiet is not stopped in between", () => {
  const root = plan15.find(isRoot)!;
  for (const quietMs of [60_000, 2 * 60_000, 4 * 60_000]) {
    assert.deepEqual(unloadPlan([{ ...root, lastActivityAt: new Date(at15 - quietMs).toISOString() }], { chats: new Set(), pool: new Set(), now: at15, idleMs: TEN_MIN }), []);
  }
});

test("a subagent with a session at work below it keeps its worker", () => {
  const child = children17[0]!;
  const input = { chats: new Set<string>(), pool: new Set<string>(), now: at17, idleMs: TEN_MIN };
  assert.equal(unloadPlan([child], input).length, 1);
  const middle = { ...child, sessionId: "below-0", activeSessionId: "below-0", parentSessionId: child.sessionId } as SessionSummary;
  const grandchild = { ...child, sessionId: "below-1", activeSessionId: "below-1", parentSessionId: "below-0", activity: "working" } as SessionSummary;
  assert.deepEqual(unloadPlan([child, middle, grandchild], input), []);
});
