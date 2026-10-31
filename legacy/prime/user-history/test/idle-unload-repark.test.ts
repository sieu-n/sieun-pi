// From 05:10Z to 06:00Z on 10-31 d7 read 10.4 to 10.5 GB in 17 quiet trees on us-metal02 while pi-pool gave only claude12 and krenerd77 out.
// pi-pool parked each waiting tree again at every slot, 3 to 4.5 min apart, and each retry Prime made wrote 2 failed replies. The unload read
// the wait from lastActivityAt, under 4.5 min old, and kept every session for its own slot under 15 min ahead, so it sent no pool-wait stop.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { type PoolPart, threadKey } from "../src/chat-pool.ts";
import { failedRun, lastTurnError } from "../src/held-turns.ts";
import { providerWaits, retryCandidates, unloadPlan } from "../src/idle-unload.ts";

const MIN = 60_000;
const QUIET = 15 * MIN;
const ID = "01a19034-0368-7215-8f44-cd3f70e128e2";
const start = Date.parse("2026-10-31T04:24:55.439Z");
/** The slots pi-pool named 01a19034 from 04:24:55Z, each one where the retry before it failed again. */
const SLOTS = ["04:27:56", "04:30:57", "04:34:00", "04:38:00", "04:42:30", "04:46:30", "04:50:30", "04:53:31", "04:56:32", "04:59:33", "05:02:34",
  "05:05:35", "05:08:36", "05:12:30", "05:16:30", "05:20:30", "05:24:30", "05:29:00", "05:32:30"].map(clock => Date.parse(`2026-10-31T${clock}.000Z`));

const iso = (ms: number): string => new Date(ms).toISOString();
const failure = (writtenAt: number, slot: number, hook: boolean): string => JSON.stringify({ type: "message", timestamp: iso(writtenAt), message: { role: "assistant",
  content: [], stopReason: "error", errorMessage: hook
    ? `API key for provider "anthropic" is temporarily unavailable until ${iso(slot)}: waiting for an account slot pi-pool: this session waits for its slot at ${iso(slot)}. pi-pool wakes it sooner when a cell opens for it.`
    : `pi-pool: this session waits for its slot at ${iso(slot)}. pi-pool wakes it sooner when a cell opens for it.` } });

/** 01a19034's transcript as it read at `now`: its task, then 2 failed replies at its start and at each slot that passed. */
function transcript(now: number): { tail: string; last: number; slot: number } {
  const lines = [JSON.stringify({ type: "message", timestamp: iso(start), message: { role: "user", content: [{ type: "text", text: "fix d7" }] } })];
  let asked = start + 87, last = asked;
  for (const slot of SLOTS) {
    lines.push(failure(asked, slot, true), failure(asked + 1_050, slot, false));
    last = asked + 1_050;
    if (slot > now) return { tail: lines.join("\n"), last, slot };
    asked = slot + 70;
  }
  throw new Error("past the replayed slots");
}

const row = (now: number): SessionSummary => ({ sessionId: ID, activeSessionId: ID, sessionName: "d7 fix", lifecycle: "live", runtimeKind: "top-level",
  activity: "working", isSessionActive: true, workerState: "ready", workerPid: 478613, attachedClients: 0, sessionFile: `/s/${ID}.jsonl`,
  model: { provider: "anthropic", id: "claude-opus-4-5" }, lastActivityAt: iso(transcript(now).last) }) as unknown as SessionSummary;
const part = (body: unknown): PoolPart => ({ code: 0, out: JSON.stringify(body), err: "" });
const reads = (now: number) => ({ all: [row(now)], local: () => true, tail: async () => transcript(now).tail,
  read: async (threads: readonly { session: string | null; model: string | null }[]) => ({ threads: new Map(threads.map(thread => [threadKey(thread), { at: now,
    who: part({ providers: { anthropic: { selection: { mode: "auto" }, account: null, wait: { account: "krenerd77", slot_at: transcript(now).slot / 1000 } } } }),
    ls: { anthropic: part({ provider: "anthropic", rows: [{ id: "krenerd77", email: "krenerd77@naver.com", usage: "", reason: null, usable: false, current: false, pinned: false }] }),
      "openai-codex": part({ provider: "openai-codex", rows: [] }) } }] as const)) }) });
const input = (now: number) => ({ attached: new Set<string>(), pool: new Set<string>(), now, idleMs: QUIET });
const stops = async (now: number): Promise<boolean> => {
  const rows = [row(now)];
  const candidates = retryCandidates(rows, input(now));
  const held = await providerWaits(candidates, now, QUIET, reads(now));
  return unloadPlan(rows, { ...input(now), held }).some(planned => planned.sessionId === ID);
};

test("the transcript's failed run names its first failed reply and the slot pi-pool parked it again at", () => {
  const at = Date.parse("2026-10-31T05:31:00Z");
  const run = failedRun(transcript(at).tail)!;
  assert.equal(run.since, start + 87);
  assert.equal(run.rolled, true);
  assert.match(lastTurnError(transcript(at).tail)!, /waits for its slot at 2026-10-31T05:32:30.000Z/);
  const first = failedRun(transcript(start + 2 * MIN).tail)!;
  assert.equal(first.rolled, false, "before its first slot passed, pi-pool has not parked it again");
  assert.equal(failedRun(`${transcript(at).tail}\n${JSON.stringify({ type: "message", message: { role: "toolResult" } })}`), undefined);
});

test("a tree pi-pool parks again every 3 to 4.5 min stops as a pool wait once its run is 15 min old, not before", async () => {
  // Each sweep minute that reads lastActivityAt 2 min or more old (ENDED_MS), as the minute-by-minute sweep did from 04:25Z to 05:32Z.
  const minutes = Array.from({ length: 67 }, (_, n) => Date.parse("2026-10-31T04:26:00Z") + n * MIN)
    .filter(now => now - transcript(now).last >= 2 * MIN);
  assert.ok(minutes.length > 20, `${minutes.length} sweep minutes`);
  const stopped = [];
  for (const now of minutes) if (await stops(now)) stopped.push(now);
  assert.ok(stopped.length, "no sweep stopped it");
  assert.ok(stopped[0]! - start >= QUIET, `stopped at ${iso(stopped[0]!)}, under 15 min into its wait`);
  assert.ok(stopped[0]! - start <= QUIET + 5 * MIN, `first stop at ${iso(stopped[0]!)}`);
  for (const now of minutes.filter(now => now >= stopped[0]!)) assert.equal(await stops(now), true, `kept at ${iso(now)}`);
});

test("a tree whose first slot has not passed keeps its worker for that slot, however long ago it first failed", async () => {
  const now = Date.parse("2026-10-31T04:46:00Z");
  const one = [failure(start, now + 91_000, true), failure(start + 1_050, now + 91_000, false)].join("\n");
  const single = { ...reads(now), tail: async () => one,
    read: async (threads: readonly { session: string | null; model: string | null }[]) => (await reads(now).read(threads)) };
  const wait = { ...single, read: async (threads: readonly { session: string | null; model: string | null }[]) => {
    const found = await single.read(threads);
    for (const parts of found.threads.values()) parts.who = part({ providers: { anthropic: { selection: { mode: "auto" }, account: null, wait: { account: "krenerd77", slot_at: (now + 91_000) / 1000 } } } });
    return found;
  } };
  assert.equal((await providerWaits([row(now)], now, QUIET, wait)).size, 0);
});
