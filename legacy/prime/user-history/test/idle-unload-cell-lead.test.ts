// From 03:31Z to 03:48Z on 11-04 d7 read 5.1 GB of quiet trees on us-metal02 against its 5 GB target. Every tree it named sat in a pi-pool
// account wait whose cell pi-pool kept 2 to 12 min ahead (pi-pool.log): Prospect feature bro's chat parked at 03:34:12Z for 03:38:00Z, again
// at 03:38:00Z for 03:46:00Z, at 03:46:26Z for 03:48:00Z and at 03:48:21Z for 04:00:00Z, and metal-management's chat at 03:40:22Z for
// 03:50:00Z. The idle unload kept each one for a cell under its 15 min, though the lead resume of a stopped tree (POOL_LEAD_MS) starts it
// again 2 min before that cell.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { type PoolPart, threadKey } from "../src/chat-pool.ts";
import { providerWaits, retryCandidates, unloadPlan } from "../src/idle-unload.ts";

const MIN = 60_000;
const QUIET = 15 * MIN;
const at = (clock: string): number => Date.parse(`2026-11-04T${clock}Z`);
const iso = (ms: number): string => new Date(ms).toISOString();
const PROSPECT = "01a11bd7-072f-7591-ad1d-f123c276cde5";
const METAL = "01a14d31-6ec0-7005-bbe8-c38b7ae73cfb";
/** Each chat's parks from pi-pool.log: when it asked, and the cell pi-pool gave it. */
const PARKS: Record<string, [string, string][]> = {
  [PROSPECT]: [["03:34:12", "03:38:00"], ["03:38:00", "03:46:00"], ["03:46:26", "03:48:00"], ["03:48:21", "04:00:00"]],
  [METAL]: [["03:40:22", "03:50:00"]],
};
const failure = (asked: number, cell: number): string => JSON.stringify({ type: "message", timestamp: iso(asked), message: { role: "assistant", content: [],
  stopReason: "error", errorMessage: `pi-pool: this session waits for its slot at ${iso(cell)}. pi-pool wakes it sooner when a cell opens for it.` } });
/** The chat's parks by `now`: its transcript's run of failed replies, its last ask and the cell it waits for. */
const parked = (id: string, now: number) => {
  const seen = PARKS[id]!.map(([asked, cell]) => [at(asked), at(cell)] as const).filter(([asked]) => asked <= now);
  return { tail: seen.map(([asked, cell]) => failure(asked, cell)).join("\n"), last: seen.at(-1)![0], cell: seen.at(-1)![1] };
};
const row = (id: string, now: number): SessionSummary => ({ sessionId: id, activeSessionId: id, sessionName: id, lifecycle: "live", runtimeKind: "top-level",
  activity: "working", isSessionActive: true, workerState: "ready", workerPid: id === PROSPECT ? 1175967 : 1106615, attachedClients: 1,
  sessionFile: `/s/${id}.jsonl`, model: { provider: "anthropic", id: "claude-opus-5-5" }, lastActivityAt: iso(parked(id, now).last) }) as unknown as SessionSummary;
const part = (body: unknown): PoolPart => ({ code: 0, out: JSON.stringify(body), err: "" });
const reads = (rows: readonly SessionSummary[], now: number) => ({ all: rows, local: () => true,
  tail: async (file: string) => parked(file.slice("/s/".length, -".jsonl".length), now).tail,
  read: async (threads: readonly { session: string | null; model: string | null }[]) => ({ threads: new Map(threads.map(thread => [threadKey(thread), { at: now,
    who: part({ providers: { anthropic: { selection: { mode: "auto" }, account: null,
      wait: { account: "claude-virev9", slot_at: parked(thread.session!, now).cell / 1000, reserved: true } } } }),
    ls: { anthropic: part({ provider: "anthropic", rows: [{ id: "claude-virev9", email: "claude-virev9@slack.green", usage: "", reason: null, usable: false, current: false, pinned: false }] }),
      "openai-codex": part({ provider: "openai-codex", rows: [] }) } }] as const)) }) });

/** Whether the sweep at `now` stops the chat: the service holds it attached, and pi-pool parks it on its cell. */
async function stops(id: string, now: number): Promise<boolean> {
  const rows = [row(id, now)];
  const input = { attached: new Set([id]), pool: new Set<string>(), now, idleMs: QUIET, chats: new Set([id]) };
  const held = await providerWaits(retryCandidates(rows, input), now, QUIET, reads(rows, now));
  return unloadPlan(rows, { ...input, held }).some(planned => planned.sessionId === id);
}

test("a chat parked on a pi-pool cell further out than the lead stops, though the cell comes within the quiet window", async () => {
  assert.equal(await stops(PROSPECT, at("03:40:30")), true, "Prospect feature bro at 03:40:30Z, its 03:46:00Z cell 5.5 min ahead");
  assert.equal(await stops(PROSPECT, at("03:51:00")), true, "Prospect feature bro at 03:51:00Z, its 04:00:00Z cell 9 min ahead");
  assert.equal(await stops(METAL, at("03:42:30")), true, "metal-management at 03:42:30Z, its first cell 03:50:00Z 7.5 min ahead");
});

test("a chat whose cell comes within the lead keeps its worker, so it asks by its cell", async () => {
  assert.equal(await stops(PROSPECT, at("03:36:30")), false, "Prospect feature bro at 03:36:30Z, its 03:38:00Z cell 90 s ahead");
  assert.equal(await stops(PROSPECT, at("03:58:30")), false, "Prospect feature bro at 03:58:30Z, its 04:00:00Z cell 90 s ahead");
  assert.equal(await stops(METAL, at("03:48:30")), false, "metal-management at 03:48:30Z, its 03:50:00Z cell 90 s ahead");
});

const CUTS = "01a15eeb-592f-71db-a938-8fd43588213b";
const STAMP = "01a1a46e-26ad-734a-aad4-73b0078131fd";
PARKS[CUTS] = [["03:31:09", "03:38:00"], ["03:38:00", "03:46:00"]];
PARKS[STAMP] = PARKS[CUTS];

test("a subagent parked on a cell past the lead stops, so it no longer holds its idle chat attached", async () => {
  // metal01 cpu cuts sat attached and idle from 02:56Z until 03:48Z, held by its job stamp-match, asleep in the tree's pi-pool wait from
  // 03:31:09Z, which the unload stopped only at 03:46:59Z (service.log); d7 read the chat as a lingering session, idle 52 min.
  const now = at("03:40:30");
  const chat = { ...row(CUTS, now), activity: "idle", isSessionActive: false, lastActivityAt: iso(at("02:56:08")), workerPid: 3820082 } as SessionSummary;
  const stamp = { ...row(STAMP, now), runtimeKind: "subagent", parentSessionId: CUTS, attachedClients: 0, workerPid: 3820082 } as unknown as SessionSummary;
  const rows = [chat, stamp];
  const input = { attached: new Set([CUTS]), pool: new Set<string>(), now, idleMs: QUIET, chats: new Set([CUTS]) };
  const held = await providerWaits(retryCandidates(rows, input), now, QUIET, reads(rows, now));
  assert.deepEqual(unloadPlan(rows, { ...input, held }).map(planned => planned.sessionId), [STAMP], "its 03:46:00Z cell is 5.5 min ahead");
});
