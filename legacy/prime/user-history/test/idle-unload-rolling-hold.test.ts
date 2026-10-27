// At 16:18Z on 10-19 us-metal02 OOM-killed 11 processes, one inside prime-agent-daemon.service. 13 sessions sat 15 to 26 min in Prime's
// provider retry, each on a worker of its own (4.9 GB in all), while `pi-pool who` named a slot that kept moving to about now: 6 accounts
// served with 12 to 81 trees waiting on each. The unload stopped a retry only for a slot past its 15 min, so a rolling slot kept every one.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { type PoolPart, threadKey } from "../src/chat-pool.ts";
import { poolHoldsPast, providerWaits } from "../src/idle-unload.ts";

const MIN = 60_000;
const QUIET = 15 * MIN;
const at = Date.parse("2026-10-19T16:18:45Z");
const part = (body: unknown): PoolPart => ({ code: 0, out: JSON.stringify(body), err: "" });
const HOOK = '{"type":"message","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"Failed to resolve API key for provider \\"anthropic\\" from shell command: pi-pool-token pi-pool: this session waits for its slot at 2026-10-19T16:19:00.000Z. Try again in 1 minute."}}';

/** 'meta ads' at 16:18:45Z: a top-level job 26 min into its retry, its tree's slot 15 s ahead. */
const row = (waitedMin: number): SessionSummary => ({ sessionId: "01a154aa-0000-7000-8000-00000000meta", activeSessionId: "a1", sessionName: "meta ads", lifecycle: "live",
  activity: "working", isSessionActive: true, workerPid: 207603, sessionFile: "/s/meta.jsonl", model: { provider: "anthropic", id: "claude-opus-5-5" },
  lastActivityAt: new Date(at - waitedMin * MIN).toISOString() }) as unknown as SessionSummary;
const reads = (slotAt: number | null, rows: readonly SessionSummary[]) => ({
  all: rows, local: () => true, tail: async () => HOOK,
  read: async (threads: readonly { session: string | null; model: string | null }[]) => ({ threads: new Map(threads.map(thread => [threadKey(thread), { at,
    who: part({ providers: { anthropic: { selection: { mode: "auto" }, account: slotAt === null ? "claude7" : null, wait: slotAt === null ? null : { account: "claude11", slot_at: slotAt / 1000 } } } }),
    ls: { anthropic: part({ provider: "anthropic", rows: [{ id: "claude7", email: "claude7@slack.green", usage: "", reason: null, usable: slotAt === null, current: false, pinned: false }] }),
      "openai-codex": part({ provider: "openai-codex", rows: [] }) } }] as const)) }),
});

test("a session that already waited the quiet window stops on a rolling slot, and one that just began waiting does not", async () => {
  const held = async (waitedMin: number, slotAt: number | null) => (await providerWaits([row(waitedMin)], at, QUIET, reads(slotAt, [row(waitedMin)]))).size === 1;
  assert.equal(await held(26, at + 15_000), true, "26 min into its wait with the slot 15 s ahead, as at 16:18Z");
  assert.equal(await held(5, at + 15_000), false, "5 min into its wait: Prime's retry may still get it the slot");
  assert.equal(await held(26, null), false, "the pool serves the tree now: Prime's retry and the job sweep continue it in place");
  assert.equal(poolHoldsPast(at + 30 * 60 * MIN, at, QUIET, 26 * MIN), true, "a hold a day away stops it too: the resume pass looks back with no limit");
  assert.equal(poolHoldsPast(null, at, QUIET, 26 * MIN), true, "a session 26 min into a wait with no time named is a hold too");
});
