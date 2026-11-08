// From 21:42Z to 23:00Z on 11-07 nobody worked on us-metal02 while its Agent sessions held 11.85 GB: 46 sessions sat in pi-pool account waits
// on krenerd77 and claude12, whose usage pi-pool had not read for 7.8 and 2.1 days, so `pi-pool ls` read both unsampled. pi-pool booked each
// tree a cell on them 180 s ahead at every ask (pi-pool.log), such as wiki dream AI harness developer environment 01:45 (01a1b6e6) at 22:51:03Z
// for 22:54:03Z, at 22:54:04Z for 22:57:30Z and at 22:57:30Z for 23:00:30Z. A sweep finds such a session quiet only ENDED_MS after its ask,
// when its cell is under POOL_LEAD_MS ahead, so the idle unload kept every one, and the lead resume would start a stopped one again at once.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { type PoolPart, poolResumesBy, threadKey, waitCellOpens } from "../src/chat-pool.ts";
import { providerWaits, retryCandidates, unloadPlan } from "../src/idle-unload.ts";

const MIN = 60_000;
const QUIET = 15 * MIN;
const at = (clock: string): number => Date.parse(`2026-11-07T${clock}Z`);
const iso = (ms: number): string => new Date(ms).toISOString();
const WIKI = "01a1b6e6-a5a7-7374-b8f6-41af8dff1635";
const ASKS: [string, string][] = [["21:44:00", "21:47:00"], ["22:51:03", "22:54:03"], ["22:54:04", "22:57:30"]];
const failure = (asked: number, cell: number): string => JSON.stringify({ type: "message", timestamp: iso(asked), message: { role: "assistant", content: [],
  stopReason: "error", errorMessage: `pi-pool: this session waits for its slot at ${iso(cell)}. pi-pool wakes it sooner when a cell opens for it.` } });
const tail = ASKS.map(([asked, cell]) => failure(at(asked), at(cell))).join("\n");
const now = at("22:56:30");
const row = { sessionId: WIKI, activeSessionId: WIKI, sessionName: "wiki dream AI harness developer environment 01:45", lifecycle: "live", runtimeKind: "top-level",
  activity: "working", isSessionActive: true, workerState: "ready", workerPid: 3126412, attachedClients: 0, sessionFile: `/s/${WIKI}.jsonl`,
  model: { provider: "anthropic", id: "claude-opus-5-5" }, lastActivityAt: iso(at("22:54:04")) } as unknown as SessionSummary;
const part = (body: unknown): PoolPart => ({ code: 0, out: JSON.stringify(body), err: "" });
/** `pi-pool ls` rows as us-metal02 read them at 23:47Z on 11-07, and the wait `who` gave the tree: its cell on claude12. */
const account = (id: string, fields: Record<string, unknown>) => ({ id, email: `${id}@slack.green`, usage: "0%/0%", current: false, pinned: false,
  reason: null, usable: true, ...fields });
const parts = (row: Record<string, unknown>, cell = at("22:57:30")) => ({ at: now,
  who: part({ providers: { anthropic: { selection: { mode: "auto" }, account: null, wait: { account: "claude12", slot_at: cell / 1000, reserved: true } } } }),
  ls: { anthropic: part({ provider: "anthropic", rows: [account("claude12", row)] }), "openai-codex": part({ provider: "openai-codex", rows: [] }) } });
const UNSAMPLED = { reason: "unsampled", usable: false };

async function stops(claude12: Record<string, unknown>): Promise<boolean> {
  const rows = [row];
  const input = { attached: new Set<string>(), pool: new Set<string>(), now, idleMs: QUIET, chats: new Set<string>() };
  const held = await providerWaits(retryCandidates(rows, input), now, QUIET, { all: rows, local: () => true, tail: async () => tail,
    read: async threads => ({ threads: new Map(threads.map(thread => [threadKey(thread), parts(claude12)] as const)) }) });
  return unloadPlan(rows, { ...input, held }).some(planned => planned.sessionId === WIKI);
}

test("a session parked on a cell of an account that opens no cell stops, though the cell comes within the lead", async () => {
  assert.equal(await stops(UNSAMPLED), true, "its 22:57:30Z cell on unsampled claude12 is 60 s ahead");
  assert.equal(await stops({ reason: null, usable: false }), false, "the same cell on an account that only waits for its R4 cell keeps it, as on 11-04");
});

test("a stopped tree comes back in the lead only for a cell whose account opens by then", () => {
  const lead = at("22:56:00");
  assert.equal(poolResumesBy(parts(UNSAMPLED), "anthropic", lead), false, "unsampled claude12 opens no cell at 22:57:30Z");
  assert.equal(poolResumesBy(parts({ reason: "needs-reauth", usable: false }), "anthropic", lead), false);
  assert.equal(poolResumesBy(parts({}), "anthropic", lead), true, "a usable claude12 opens its 22:57:30Z cell");
  const limited = (until: string) => ({ reason: "limited 1m", usable: false, limited_until: at(until) / 1000 });
  assert.equal(poolResumesBy(parts(limited("22:57:00")), "anthropic", lead), true, "a limit that ends 30 s before the cell");
  assert.equal(poolResumesBy(parts(limited("23:30:00")), "anthropic", lead), false, "a limit that ends after the cell");
  assert.equal(waitCellOpens(parts(UNSAMPLED), "anthropic", lead), false);
});
