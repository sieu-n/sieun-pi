import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkInRecord, checkInSettings, OWNER_UI } from "../src/chat-checkin.ts";
import type { CheckInRun } from "../src/chat-duty-run.ts";
import { Chats, type ChatThreads, type CheckInSource, loadRecord, replyCheckRecord } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatBoard, ThreadMessage } from "../src/shared/types.ts";

// The failed-turn restart (`revive`) of a chat must not wait on its check-in or on a pause the owner did not set.
// 10-11 19:08Z: a Prime update aborted the turns of 4 chats. From 20:35Z to 10-12 01:42Z the service ran no revive and no check-in for any
// chat while it attached sessions in under 0.3 s, and the 4 chats sat 0.5 to 7.7 h (chat-health unretried_errors 4, dead_hours 11.8).
// 10-12 13:35Z on: the daemon gate paused the check-in of 7 chats, and that pause also skipped their revive.

process.env.TZ = "Asia/Seoul";

const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", scratch: [], todos: [], plan: [{ id: "p1", text: "Goal", status: "doing", children: [] }] };
const aborted = (at: number): ThreadMessage[] => [
  { role: "user", content: "continue", timestamp: at - 1000 },
  { role: "assistant", content: [], provider: "anthropic", model: "m", stopReason: "aborted", errorMessage: "Request was aborted", timestamp: at } as ThreadMessage,
];

async function setup(duty: CheckInSource["duty"]) {
  const dir = await mkdtemp(join(tmpdir(), "chat-revive-"));
  const calls: string[] = [];
  const transcripts = new Map<string, ThreadMessage[]>();
  const known: Partial<ChatThreads> = {
    state: (id: string) => { const messages = transcripts.get(id); return messages ? { messages } : undefined; },
    running: () => false,
    busy: () => false,
    setWait: () => {},
    observe: () => () => {},
    pin: () => true,
    restart: async (id: string, message: string) => { calls.push(`restart ${id} ${message}`); },
  };
  // Every other thread call this test does not reach answers with nothing.
  const threads = new Proxy(known, { get: (target, key) => (target as Record<PropertyKey, unknown>)[key] ?? (async () => undefined) }) as unknown as ChatThreads;
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  let now = 1_000_000_000;
  const settingsFile = join(dir, "check-in-settings.json");
  const source: CheckInSource = { board: async () => board, rows: async () => [], memory: checkInRecord(join(dir, "check-ins.json")),
    replyChecks: replyCheckRecord(join(dir, "reply-checks.json")), settings: checkInSettings(settingsFile), tickMs: 0, now: () => now, noReportGraceMs: 0,
    ...(duty ? { duty } : {}) };
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source);
  await chats.adopt();
  transcripts.set("c1", aborted(now));
  const start = now;
  /** Ticks every 30 s for `minutes`; the minutes after the failure at which c1 got its restart. */
  const run = async (minutes: number, settle = true): Promise<number[]> => {
    const restarted: number[] = [];
    for (let half = 0; half < minutes * 2; half++) {
      now += 30_000;
      const before = calls.length;
      await chats.tick();
      if (settle) await chats.settled();
      else for (let spin = 0; spin < 20; spin++) await new Promise(resolve => setImmediate(resolve));
      if (calls.slice(before).some(call => call.startsWith("restart c1"))) restarted.push(Math.round((now - start) / 60_000));
    }
    return restarted;
  };
  return { chats, run, settingsFile, calls };
}

test("chat revive: a check-in whose duty job start never ends does not hold the chat's failed-turn restart", async () => {
  const runs: string[] = [];
  const hung = { checkIn: (id: string, _run: CheckInRun) => { runs.push(id); return new Promise<never>(() => {}); } };
  const { chats, run, calls } = await setup(hung);
  assert.deepEqual(await run(6, false), [5], "the restart comes 5 min after the abort, beside the check-in that still waits on its job start");
  assert.equal(runs.length, 1, "the check-in started once and still waits");
  assert.equal(calls.find(call => call.startsWith("restart")), "restart c1 [check-in] Your last turn failed at 22:46 (Request was aborted). Re-check the board and continue.");
  chats.close();
});

test("chat revive: a daemon gate pause or the chat's own pause stops the check-in, not the failed-turn restart; the owner's pause stops both", async () => {
  const runs: string[] = [];
  const sink = { async checkIn(id: string, _run: CheckInRun) { runs.push(id); } };
  const gated = await setup(sink);
  await writeFile(gated.settingsFile, JSON.stringify({ c1: { everyMs: 900_000, pausedUntil: "forever", pausedBy: "daemon", setter: "gate" } }));
  assert.deepEqual(await gated.run(6), [5], "the gate paused the check-in of the chat; its failed turn still restarts at 5 min");
  assert.deepEqual(runs, [], "no check-in while the gate holds it");
  gated.chats.close();

  const own = await setup(sink);
  await writeFile(own.settingsFile, JSON.stringify({ c1: { everyMs: 900_000, pausedUntil: "forever", pausedBy: "agent", setter: "s1" } }));
  assert.deepEqual(await own.run(6), [5], "the chat paused its own check-in");
  own.chats.close();

  const owner = await setup(sink);
  await owner.chats.setCheckIn("c1", { pause: "forever" }, OWNER_UI);
  assert.deepEqual(await owner.run(30), [], "the owner paused the chat");
  owner.chats.close();
});
