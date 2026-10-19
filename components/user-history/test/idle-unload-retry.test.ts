// Guards the 10-19 01:11Z state on us-metal02 under c92: 176 sessions asleep in Prime's provider retry after a 429 (91) or pi-pool's token hook
// refusal (85) read as working, so the idle unload left their 148 workers and 176 kernels (31.2 GB) alone (~/scratch/idle-ram/attribution.md).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mock, test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { type PoolPart, poolFreeAt, type ThreadParts, threadKey } from "../src/chat-pool.ts";
import { type DaemonAnswer, HOLD_REACH_MS, IdleUnloader, poolHoldsPast, providerWaits, retryCandidates, STOP_BOUND_MS, unloadPlan } from "../src/idle-unload.ts";

type Fixture = { takenAt: string; chats: string[]; rows: SessionSummary[]; tails: Record<string, string> };
const day = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "daemon-rows-1019-0111.json"), "utf8")) as Fixture;
const at = Date.parse(day.takenAt);
const MIN = 60_000;
const TEN_MIN = 10 * MIN;
const chats = new Set(day.chats);
const attached = new Set([...chats].filter(id => day.rows.find(row => row.sessionId === id)?.attachedClients));
const input = { attached, pool: new Set<string>(), now: at, idleMs: TEN_MIN, chats };
const part = (body: unknown): PoolPart => ({ code: 0, out: JSON.stringify(body), err: "" });
const SLOT = / this session waits for its slot at (\S+Z)/;
const slotOf = (sessionId: string): number | null => { const found = SLOT.exec(day.tails[sessionId] ?? ""); return found ? Date.parse(found[1]!) : null; };

/** `pi-pool who` and `ls` for a tree held until `slotAt` (epoch ms), or served now by claude7 with null. */
const parts = (slotAt: number | null): ThreadParts => ({
  who: part({ providers: { anthropic: { account: slotAt ? null : "claude7", wait: slotAt ? { account: "claude11", slot_at: slotAt / 1000 } : null } } }),
  ls: { anthropic: part({ provider: "anthropic", rows: [{ id: "claude7", email: "claude7@slack.green", usage: "", reason: null, usable: slotAt === null, current: false, pinned: false }] }),
    "openai-codex": part({ provider: "openai-codex", rows: [] }) },
});
const byId = new Map(day.rows.map(row => [row.sessionId, row] as const));
const rootOf = (row: SessionSummary): string => { let top = row; for (let up = byId.get(top.parentSessionId ?? ""); up; up = byId.get(up.parentSessionId ?? "")) top = up; return top.sessionId; };
/** The pool as each tree's waiting sessions name it in their errors, the slot pi-pool gave them; a tree with no such error is served now. */
const treeSlots = new Map<string, number>();
for (const sessionId of Object.keys(day.tails)) {
  const slot = slotOf(sessionId), root = rootOf(byId.get(sessionId)!);
  if (slot !== null) treeSlots.set(root, Math.max(treeSlots.get(root) ?? 0, slot));
}
const reads = (slots: ReadonlyMap<string, number | null> = treeSlots) => ({
  all: day.rows, local: () => true, tail: async (file: string) => day.tails[file.slice("/sessions/".length, -".jsonl".length)] ?? "",
  read: async (threads: readonly { session: string | null; model: string | null }[]) =>
    ({ threads: new Map(threads.map(thread => [threadKey(thread), { ...parts(slots.get(thread.session ?? "") ?? null), at }] as const)) }),
});

test("the 01:11Z rows: each session asleep in its provider retry on a pool hold past the unload's minutes is planned, where none was before", async () => {
  const candidates = retryCandidates(day.rows, input);
  const waiting = Object.keys(day.tails);
  assert.equal(waiting.length, 176);
  assert.ok(candidates.length >= 160, `${candidates.length} candidates`);
  assert.ok(candidates.every(row => !chats.has(row.sessionId) && row.attachedClients === 0 && !row.isStreaming && !row.isRunningTools), "never a chat, a client or a turn at work");
  const held = await providerWaits(candidates, at, TEN_MIN, reads());
  for (const [id, until] of held) assert.ok(until > at + TEN_MIN && until <= at + HOLD_REACH_MS, id);
  assert.ok(held.size >= 140, `${held.size} held`);
  const before = unloadPlan(day.rows, input);
  const after = unloadPlan(day.rows, { ...input, held });
  assert.ok(!before.some(row => held.has(row.sessionId)), "the unload stopped none of them before");
  assert.equal(after.length, before.length + held.size);
  const workers = new Map<number, SessionSummary[]>();
  for (const row of day.rows) if (row.activeSessionId && row.lifecycle === "live" && row.workerPid) workers.set(row.workerPid, [...workers.get(row.workerPid) ?? [], row]);
  const planned = new Set(after.map(row => row.sessionId));
  const freed = [...workers.values()].filter(on => on.every(row => planned.has(row.sessionId))).length;
  const freedBefore = [...workers.values()].filter(on => on.every(row => before.some(other => other.sessionId === row.sessionId))).length;
  assert.ok(freed >= freedBefore + 100, `workers whose every session stops: ${freedBefore} before, ${freed} now`);
});

test("a tree the pool serves within the unload's minutes, or now, or past HOLD_REACH_MS, keeps its session in Prime's retry", async () => {
  const row = retryCandidates(day.rows, input).find(candidate => slotOf(candidate.sessionId) !== null)!;
  const tree = rootOf(row);
  const heldWith = async (slot: number | null) => (await providerWaits([row], at, TEN_MIN, reads(new Map([[tree, slot]])))).has(row.sessionId);
  assert.equal(await heldWith(at + TEN_MIN + MIN), true);
  assert.equal(await heldWith(at + TEN_MIN - MIN), false, "the slot comes before the unload's minutes are out");
  assert.equal(await heldWith(null), false, "the pool serves the tree now: the job sweep's abort continues it in place");
  assert.equal(await heldWith(at + HOLD_REACH_MS + MIN), false, "the resume pass would not look back that far");
  const failing = { ...reads(), read: async () => { throw new Error("pi-pool failed"); } };
  await assert.rejects(providerWaits([row], at, TEN_MIN, failing), "a pool that does not answer stops none (the sweep logs it)");
  assert.equal((await providerWaits([row], at, TEN_MIN, { ...reads(), local: () => false })).size, 0, "another box's session is that box's pool to judge");
  assert.equal((await providerWaits([row], at, TEN_MIN, { ...reads(), tail: async () => '{"type":"message","message":{"role":"assistant","stopReason":"stop"}}' })).size, 0,
    "a transcript that does not end on a failed reply is no retry wait");
  assert.equal(poolHoldsPast(null, at, TEN_MIN), false, "a pool that names no time stops none");
});

test("poolFreeAt reads the wait's slot, the named account's limit, or now", () => {
  assert.equal(poolFreeAt(parts(at + 30 * MIN), "anthropic", at), at + 30 * MIN);
  assert.equal(poolFreeAt(parts(null), "anthropic", at), at);
  const limited: ThreadParts = { ...parts(null), ls: { ...parts(null).ls, anthropic: part({ provider: "anthropic", rows: [{ id: "claude7", email: "c7", usage: "", reason: "limited",
    usable: false, current: true, pinned: false, limited_until: (at + 2 * 60 * MIN) / 1000 }] }) } };
  assert.equal(poolFreeAt(limited, "anthropic", at), at + 2 * 60 * MIN);
  assert.equal(poolFreeAt({ ...parts(null), who: { code: 1, out: "", err: "boom" } }, "anthropic", at), null);
  assert.equal(poolFreeAt(parts(null), "faux", at), null, "a provider the pool does not vend for");
});

type Call = { type: "get_state" | "kill"; session: string };
function harness(rows: SessionSummary[], held: ReadonlyMap<string, number>, state: (row: SessionSummary) => Promise<DaemonAnswer>) {
  const calls: Call[] = [], stopped: string[] = [], lines: string[] = [];
  const unloader = new IdleUnloader({
    rows: () => rows, localRows: () => [], idleMs: () => TEN_MIN, chats: async () => new Set(), dormant: () => false, pool: async () => new Set(),
    waking: async () => new Set(), held: async candidates => new Map([...held].filter(([id]) => candidates.some(row => row.sessionId === id))),
    own: async () => new Map(), restNow: async () => false, title: () => null,
    request: async (row, type) => { calls.push({ type, session: row.sessionId }); return type === "get_state" ? state(row) : { success: true }; },
    stopped: async row => { stopped.push(row.sessionId); }, log: line => { lines.push(line); }, now: () => at,
  });
  return { unloader, calls, stopped, lines };
}
const asleep = (id: string): SessionSummary => {
  const { parentSessionId: _parent, ...row } = retryCandidates(day.rows, input)[0]!;
  return { ...row, sessionId: id, activeSessionId: id, sessionName: id, lastActivityAt: new Date(at - 30 * MIN).toISOString() } as SessionSummary;
};
const retryState: DaemonAnswer = { success: true, data: { activity: "working", isSessionActive: true, isStreaming: false, isCompacting: false, isBashRunning: false, isRunningTools: false } };
const turn = () => new Promise(resolve => setImmediate(resolve));

test("a session asleep in its retry is killed although its turn is open, and one whose retry fired since the row was listed is kept", async () => {
  const until = at + 60 * MIN;
  const { unloader, calls, stopped, lines } = harness([asleep("sleeper"), asleep("woke")], new Map([["sleeper", until], ["woke", until]]),
    async row => row.sessionId === "woke" ? { success: true, data: { ...(retryState.success ? retryState.data as object : {}), isStreaming: true } } : retryState);
  await unloader.sweep();
  await unloader.settled();
  assert.deepEqual(stopped, ["sleeper"]);
  assert.deepEqual(calls.filter(call => call.type === "kill").map(call => call.session), ["sleeper"], "no kill lands on the retry that streams");
  assert.ok(lines.some(line => line.includes(`sleeper (waits on pi-pool until ${new Date(until).toISOString().slice(11, 16)}Z)`)), lines.join("\n"));
  const { unloader: plain, calls: none } = harness([asleep("unheld")], new Map(), async () => retryState);
  await plain.sweep();
  await plain.settled();
  assert.deepEqual(none, [], "a retry the pool does not hold past the unload's minutes is not asked");
});

// From 22Z on 10-18 to 01:03Z on 10-19 the hung worker 114947 left every get_state of 01a150e1 unanswered for 30 s, every minute.
test("a get_state that never answers holds up neither the sweep's other stops nor its line, and the next sweep asks again", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const rows = [asleep("hung"), asleep("quick")];
    const held = new Map([["hung", at + 60 * MIN], ["quick", at + 60 * MIN]]);
    const { unloader, calls, stopped, lines } = harness(rows, held, async row => row.sessionId === "hung" ? new Promise<DaemonAnswer>(() => {}) : retryState);
    await unloader.sweep();
    for (let i = 0; i < 5; i++) await turn();
    assert.deepEqual(stopped, ["quick"]);
    assert.deepEqual(lines, [], "the line waits for the bound, not for the hung stop forever");
    mock.timers.tick(STOP_BOUND_MS);
    for (let i = 0; i < 5; i++) await turn();
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /stopped 1 idle sessions: quick/);
    await unloader.sweep();
    assert.equal(calls.filter(call => call.session === "hung").length, 1, "the stop still out is not doubled");
  } finally { mock.timers.reset(); }
});
