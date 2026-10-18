import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkInRecord } from "../src/chat-checkin.ts";
import { checkInSettings, OWNER_UI } from "../src/checkin-settings.ts";
import type { CheckInRun } from "../src/chat-duty-run.ts";
import { Chats } from "../src/chats.ts";
import { type ChatThreads, type CheckInSource } from "../src/chat-sources.ts";
import { loadRecord } from "../src/chat-brief.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatBoard, SessionRow, ThreadMessage } from "../src/shared/types.ts";

// The failed-turn restart (`revive`) of a chat must not wait on its check-in or on a pause the owner did not set.
// 10-11 19:08Z: a Prime update aborted the turns of 4 chats. From 20:35Z to 10-12 01:42Z the service ran no revive and no check-in for any
// chat while it attached sessions in under 0.3 s, and the 4 chats sat 0.5 to 7.7 h (chat-health unretried_errors 4, dead_hours 11.8).
// 10-12 13:35Z on: a check-in pause of 7 chats also skipped their revive.

process.env.TZ = "Asia/Seoul";

const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", todos: [], plan: [{ id: "p1", text: "Goal", status: "doing", children: [] }] };
const aborted = (at: number): ThreadMessage[] => [
  { role: "user", content: "continue", timestamp: at - 1000 },
  { role: "assistant", content: [], provider: "anthropic", model: "m", stopReason: "aborted", errorMessage: "Request was aborted", timestamp: at } as ThreadMessage,
];

async function setup(duty: CheckInSource["duty"], hung?: { start: number; running: { on: boolean; lastEventAt: number }; endsOnRestart: boolean }) {
  const dir = await mkdtemp(join(tmpdir(), "chat-revive-"));
  const calls: string[] = [];
  const transcripts = new Map<string, ThreadMessage[]>();
  const known: Partial<ChatThreads> = {
    state: (id: string) => { const messages = transcripts.get(id); return messages ? { messages } : undefined; },
    running: () => hung?.running.on ?? false,
    quietSince: () => hung?.running.on ? hung.running.lastEventAt : null,
    busy: () => false,
    setWait: () => {},
    observe: () => () => {},
    pin: () => true,
    restart: async (id: string, message: string, abort?: boolean) => {
      calls.push(`restart ${id} ${message}${abort ? " (abort)" : ""}`);
      if (hung?.endsOnRestart) { hung.running.on = false; hung.running.lastEventAt = now; }
    },
  };
  // Every other thread call this test does not reach answers with nothing.
  const threads = new Proxy(known, { get: (target, key) => (target as Record<PropertyKey, unknown>)[key] ?? (async () => undefined) }) as unknown as ChatThreads;
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  let now = hung?.start ?? 1_000_000_000;
  const settingsFile = join(dir, "check-in-settings.json");
  // `home: dir`: the check-in reads heartbeats and the release train under the home folder; the owner's real ~/.cache/virev/ci-runs.json made
  // the check-in slower than the ticks of the test below, so it failed at random (0 check-ins started).
  const source: CheckInSource = { board: async () => board, rows: async () => [{ id: "c1", name: "c1" } as SessionRow], home: dir, memory: checkInRecord(join(dir, "check-ins.json")),
    settings: checkInSettings(settingsFile), tickMs: 0, now: () => now, noReportGraceMs: 0,
    ...(duty ? { duty } : {}) };
  const logs: string[] = [];
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source, line => { logs.push(line); });
  await chats.adopt();
  transcripts.set("c1", hung ? [{ role: "user", content: "continue", timestamp: now }] : aborted(now));
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
  /** The Mac sleeps: the clock moves with no wake. */
  const sleep = (ms: number) => { now += ms; };
  return { chats, run, sleep, settingsFile, calls, logs };
}

test("chat revive: a check-in whose duty job start never ends does not hold the chat's failed-turn restart", async () => {
  const runs: string[] = [];
  let started: () => void = () => {};
  const startedOnce = new Promise<void>(resolve => { started = resolve; });
  const hung = { checkIn: (id: string, _run: CheckInRun) => { runs.push(id); started(); return new Promise<never>(() => {}); }, lastCheckIn: async () => undefined };
  const { chats, run, calls } = await setup(hung);
  assert.deepEqual(await run(6, false), [5], "the restart comes 5 min after the abort, beside the check-in that still waits on its job start");
  await startedOnce;
  assert.equal(runs.length, 1, "the check-in started once and still waits");
  assert.equal(calls.find(call => call.startsWith("restart")), "restart c1 [check-in] Your last turn failed at 22:46 (Request was aborted). Re-check the board and continue.");
  chats.close();
});

test("chat revive: the chat's own pause stops the check-in, not the failed-turn restart; the owner's pause stops both", async () => {
  const runs: string[] = [];
  const sink = { async checkIn(id: string, _run: CheckInRun) { runs.push(id); }, async lastCheckIn() { return undefined; } };
  const own = await setup(sink);
  await writeFile(own.settingsFile, JSON.stringify({ c1: { everyMs: 900_000, pausedUntil: "forever", pausedBy: "agent", setter: "s1" } }));
  assert.deepEqual(await own.run(6), [5], "the chat paused its own check-in");
  own.chats.close();

  const owner = await setup(sink);
  await owner.chats.setCheckIn("c1", { pause: "forever" }, OWNER_UI);
  assert.deepEqual(await owner.run(30), [], "the owner paused the chat");
  owner.chats.close();
});

const at = (iso: string): number => Date.parse(iso);

test("chat revive: a turn that streams with no session event for HUNG_TURN_MS (45 min) is stopped and restarted; replay of 1180e 10-11 22:04Z, hung 252.7 min", async () => {
  // 1180e: the "continue" at 22:04:07Z started a turn that sent nothing until the owner's Resume aborted it at 02:16:49Z.
  const start = at("2026-10-11T22:04:07.773Z");
  const hung = { start, running: { on: true, lastEventAt: start }, endsOnRestart: true };
  const { chats, run, calls } = await setup(undefined, hung);
  assert.deepEqual(await run(252), [45], "stopped 45 min in, 207 min before the owner's Resume; the new turn ended, so once");
  assert.equal(calls[0], "restart c1 [check-in] Your turn showed no progress for 45 min (since 07:04), so the server stopped it. Re-check the board and continue. (abort)");
  chats.close();
});

test("chat revive: replay of 11bd7 10-11 03:22Z, hung 15.5 h: the restart comes 45 awake min in, a restart that changes nothing waits another 45 min, and a sleep starts the count over", async () => {
  // 11bd7: the watchdog message at 03:22:31Z started a turn that sent nothing until the Resume at 18:57:32Z. pmset: awake to 04:37:09Z,
  // then lid-closed sleep with short dark wakes until 18:39:35Z, then awake.
  const start = at("2026-10-11T03:22:31.301Z");
  const hung = { start, running: { on: true, lastEventAt: start }, endsOnRestart: false };
  const { chats, run, sleep } = await setup(undefined, hung);
  assert.deepEqual(await run(74), [45], "45 awake min in; the next try would be 90 min in, after the sleep began");
  sleep(at("2026-10-11T18:39:35Z") - (start + 74 * 60_000));
  assert.deepEqual(await run(18), [], "the wake at 18:39:35Z starts the count over: 18 min to the Resume is under 45");
  chats.close();
});

test("chat revive: a turn whose events come 43 min apart, the longest normal silence measured 10-08 to 10-12, is never stopped", async () => {
  const start = at("2026-10-12T04:27:44Z");
  const hung = { start, running: { on: true, lastEventAt: start }, endsOnRestart: true };
  const { chats, run } = await setup(undefined, hung);
  const restarted: number[] = [];
  for (let step = 0; step < 4; step++) { restarted.push(...await run(43)); hung.running.lastEventAt = start + (step + 1) * 43 * 60_000; }
  assert.deepEqual(restarted, []);
  chats.close();
});
