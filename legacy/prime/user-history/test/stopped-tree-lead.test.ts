// A tree the chat stopped while it waited on pi-pool came back only at or after its cell, and a tree that asks after its cell loses it. On 11-01
// the idle unload stopped SEO guy (01a11a24) at 09:09:30Z, 90 s before its 09:11:00Z cell on claude16. The resume pass asked for the tree at
// 09:11:32Z, 09:12:32Z, 09:13:42Z and 09:14:40Z, each after the cell it was given or too early for it, and pi-pool parked it again each time,
// last at 09:15:30Z. After that `who` read only dry run cells ahead of the clock, poolAdmitsNow never read an admit, and the tree asked next at
// 09:25:42Z, after the :5182 restart and a hand "continue" (pi-pool.log, unload-receipts.jsonl, ~/work/parked-miss-slot/).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { poolAdmits, poolAdmitsNow, type PoolPart, threadKey } from "../src/chat-pool.ts";
import { PoolHeldJobs } from "../src/chat-resume.ts";
import { providerWaits, retryCandidates, unloadPlan } from "../src/idle-unload.ts";
import type { PoolHeldRun } from "../src/shared/interrupted.ts";

const TREE = "01a11a24-a46e-77ff-adf7-671d01d462e2";
const CLAUDE16 = "claude16-id";
const at = (clock: string): number => Date.parse(`2026-11-01T${clock}Z`);
const iso = (ms: number): string => new Date(ms).toISOString();
const part = (body: unknown): PoolPart => ({ code: 0, out: JSON.stringify(body), err: "" });
/** `pi-pool who` and `ls` for the tree: claude16 usable, the tree held in a wait for `slot` (reserved or a dry run), or admitted with none. */
const parts = (slot: number | null, reserved = true) => ({
  at: 0,
  who: part({ providers: { anthropic: { selection: { mode: "auto" }, account: slot === null ? CLAUDE16 : null,
    wait: slot === null ? null : { account: CLAUDE16, slot_at: slot / 1000, reserved } } } }),
  ls: { anthropic: part({ provider: "anthropic", rows: [{ id: CLAUDE16, email: "claude16@slack.green", usage: "", reason: null, usable: true, current: false, pinned: false }] }),
    "openai-codex": part({ provider: "openai-codex", rows: [] }) },
});
const reader = (slot: number | null, reserved = true) => async (threads: readonly { session: string | null; model: string | null }[] = []) =>
  ({ threads: new Map(threads.map(thread => [threadKey(thread), parts(slot, reserved)] as const)), config: null }) as never;

test("a stopped tree is started again within the lead before its own cell, not after it", async () => {
  const cell = at("09:11:00");
  for (const [clock, resumes] of [["09:08:30", false], ["09:09:30", true], ["09:10:30", true], ["09:11:00", true]] as const) {
    assert.equal(await poolAdmits(TREE, "anthropic", reader(cell), () => at(clock)), resumes, `at ${clock}`);
  }
  assert.equal(poolAdmitsNow(parts(cell), "anthropic", at("09:09:30")), false, "the old rule waited for an admit now, at or after the cell");
});

test("a stopped tree whose cell passed with no ask is started again for the next cell pi-pool would give it", async () => {
  // At 09:16:00Z the 09:15:30Z cell had passed, and `who` read a dry run cell a minute ahead at every tick until the hand continue.
  for (const clock of ["09:16:00", "09:18:00", "09:22:00"]) {
    const now = at(clock);
    assert.equal(poolAdmitsNow(parts(now + 60_000, false), "anthropic", now), false, `the old rule held it at ${clock}`);
    assert.equal(await poolAdmits(TREE, "anthropic", reader(now + 60_000, false), () => now), true, `at ${clock}`);
  }
  assert.equal(await poolAdmits(TREE, "anthropic", reader(at("09:40:00"), false), () => at("09:16:00")), false, "a cell 24 min out still waits");
});

test("a held job gets its pass within the lead before its pool time", async () => {
  const job = "01a1963d-9f8f-7674-b82b-caf22b7c1c19";
  const run: PoolHeldRun = { id: job, name: "seo job", session_id: job, head: job, head_session_id: job, tree: TREE, provider: "anthropic",
    errored_at: "2026-11-01T09:07:33.183Z", held_by: "pi-pool gave this session a slot at 2026-11-01T09:11:00+00:00", pool_at: "2026-11-01T09:11:00+00:00" };
  const asked: string[] = [];
  const jobs = new PoolHeldJobs(async tree => { asked.push(tree); return true; });
  await jobs.set([run]);
  assert.deepEqual(await jobs.admitted(at("09:08:30")), [], "3.5 min before the cell it waits");
  assert.deepEqual((await jobs.admitted(at("09:09:30"))).map(held => held.session_id), [job], "90 s before the cell its pass goes");
  assert.deepEqual(asked, [TREE]);
});

const MIN = 60_000;
/** chat-pool.ts POOL_LEAD_MS, written out so this file also runs against the code before it. */
const POOL_LEAD_MS = 2 * MIN;
const failure = (writtenAt: number, slot: number): string => JSON.stringify({ type: "message", timestamp: iso(writtenAt), message: { role: "assistant",
  content: [], stopReason: "error", errorMessage: `pi-pool: this session waits for its slot at ${iso(slot)}. pi-pool wakes it sooner when a cell opens for it.` } });
/** SEO guy's tail at 09:09:30Z: a run of failed replies since 08:40Z, each slot parked again after it passed, the last for 09:11:00Z. */
const tail = [failure(at("08:40:00"), at("08:44:00")), failure(at("08:44:30"), at("08:52:00")), failure(at("08:52:30"), at("09:11:00"))].join("\n");
const row = (now: number): SessionSummary => ({ sessionId: TREE, activeSessionId: TREE, sessionName: "SEO guy", lifecycle: "live", runtimeKind: "top-level",
  activity: "working", isSessionActive: true, workerState: "ready", workerPid: 1, attachedClients: 0, sessionFile: `/s/${TREE}.jsonl`,
  model: { provider: "anthropic", id: "claude-opus-4-5" }, lastActivityAt: iso(now - 17 * MIN) }) as unknown as SessionSummary;

test("the idle unload keeps a tree whose own cell comes within the lead, though pi-pool parked it again before", async () => {
  const stops = async (now: number, slot: number): Promise<boolean> => {
    const reads = { all: [row(now)], local: () => true, tail: async () => tail, read: reader(slot) };
    const input = { attached: new Set<string>(), pool: new Set<string>(), now, idleMs: 15 * MIN };
    const held = await providerWaits(retryCandidates([row(now)], input), now, 15 * MIN, reads);
    return unloadPlan([row(now)], { ...input, held }).some(planned => planned.sessionId === TREE);
  };
  assert.equal(await stops(at("09:09:30"), at("09:11:00")), false, "on 11-01 the unload stopped it 90 s before its cell");
  assert.equal(await stops(at("09:09:30"), at("09:09:30") + POOL_LEAD_MS + MIN), true, "a re-parked tree with its cell past the lead still stops");
});
