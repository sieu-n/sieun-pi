import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { changeCheckIn, checkInSettings, nextCheckIn } from "../src/checkin-settings.ts";
import { DaemonGate, type DaemonGateInput, type DaemonRequest, rosterList } from "../src/chat-daemon-gate.ts";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";

const MIN = 60_000;

async function setup(initial: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "daemon-gate-"));
  const path = join(dir, "check-in-settings.json");
  await writeFile(path, JSON.stringify(initial));
  const settings = checkInSettings(path);
  const clock = { at: new Date(2026, 9, 9, 18, 0).getTime() };
  const daemon = { ms: 200, fail: false, lists: 0 };
  const told: string[] = [];
  const log: string[] = [];
  // The old gate took a `tell` chat and a `steer` path and posted each pause and resume into that chat; both stay here so a gate that posts
  // into a chat again fails these tests.
  const input = { settings, chats: async () => ["vp", "c1", "c2", "c3", "c4"], keep: new Set(["vp"]), tell: "vp", now: () => clock.at, lastCheckIn: async () => null,
    log: (line: string) => { log.push(line); }, steer: async (id: string, message: string) => { told.push(`${id}: ${message}`); },
    list: async () => { daemon.lists++; clock.at += daemon.ms; if (daemon.fail) throw new Error("Timed out after 30000ms waiting for the Prime Agent daemon response to \"list\""); } };
  const gate = new DaemonGate(input as DaemonGateInput);
  const probe = async (ms: number, fail = false) => { daemon.ms = ms; daemon.fail = fail; clock.at += MIN; await gate.tick(); };
  return { settings, clock, daemon, told, log, gate, probe, dir };
}

test("daemon gate: the first list the daemon did not answer pauses the check-in of every chat but the kept one and the ones already paused; the first answered list resumes only those, staggered; nothing is posted into a chat (c43: no sample counts of ours)", async () => {
  const { settings, clock, told, log, gate, probe } = await setup({ vp: { everyMs: 15 * MIN }, c1: { everyMs: 15 * MIN }, c2: { everyMs: 15 * MIN, pausedUntil: "forever", pausedBy: "owner" },
    c3: { everyMs: 60 * MIN }, c4: { everyMs: 15 * MIN, pausedUntil: new Date(2026, 9, 9, 18, 30).getTime(), pausedBy: "chat" } });
  await probe(200);
  assert.equal(gate.state, "healthy");
  await probe(30_000, true);
  assert.equal(gate.state, "unhealthy", "one list past prime-agent's 30 s request timeout is the outage");
  const paused = await settings.all();
  assert.deepEqual(paused.c1, { everyMs: 15 * MIN, pausedUntil: "forever", pausedBy: "daemon", setter: "gate" });
  assert.deepEqual(paused.c3, { everyMs: 60 * MIN, pausedUntil: "forever", pausedBy: "daemon", setter: "gate" });
  assert.deepEqual(paused.vp, { everyMs: 15 * MIN }, "the developer environment VP chat keeps its check-in");
  assert.equal(paused.c2?.pausedBy, "owner", "the owner's pause stays the owner's");
  assert.equal(paused.c4?.pausedBy, "agent", "the chat's own pause, an older file's \"chat\", stays an agent's");
  assert.deepEqual(told, [], "no pause line goes into any chat");
  assert.match(log.join("\n"), /daemon gate: unhealthy \(list failed after 30\.0 s: Timed out after 30000ms [^)]*"list"\); paused the check-in of 2 chats: c1, c3/);
  assert.deepEqual(changeCheckIn(paused.c1!, { pause: null }, clock.at, { by: "agent", setter: "c1" }), { refused: "the server paused check-ins while the daemon is slow; they resume on their own" },
    "the gate holds its pause while the daemon is slow, so the chat cannot clear it");
  assert.deepEqual(changeCheckIn(paused.c1!, { pause: "1h" }, clock.at, { by: "agent", setter: "01a00000" }), { refused: "the server paused check-ins while the daemon is slow; they resume on their own" });
  await probe(30_000, true);
  assert.equal(gate.state, "unhealthy");
  await probe(1_000);
  assert.equal(gate.state, "healthy", "the first answered list ends the outage");
  const now = clock.at;
  const resumed = await settings.all();
  assert.deepEqual(resumed.c1, { everyMs: 15 * MIN, startAt: now }, "chat 0 of 2 runs at once");
  assert.deepEqual(resumed.c3, { everyMs: 60 * MIN, startAt: now + 30 * MIN }, "chat 1 of 2 runs half its interval later");
  assert.equal(resumed.c2?.pausedBy, "owner", "a pause the gate did not make is not resumed");
  assert.equal(resumed.c4?.pausedBy, "agent");
  assert.equal(nextCheckIn(resumed.c3!, now - 3 * 60 * MIN, now), now + 30 * MIN, "the first check-in after the resume waits for its turn");
  assert.equal(nextCheckIn(resumed.c3!, now + 30 * MIN, now + 30 * MIN), now + 90 * MIN, "then it runs at its interval");
  assert.match(log.at(-1)!, /daemon gate: healthy \(a list answered\); resumed the check-in of 2 chats, longest wait first, staggered over their interval: c1, c3/);
  assert.deepEqual(told, [], "daemon health is server state: the gate posts no pause or resume line into any chat (off_brief, 10-12: 33 such lines)");
});

test("daemon gate: a list that answers late is not an outage, so 10-12's slow lists and slow archives pause nothing and post nothing (off_brief, c43)", async () => {
  const { settings, told, gate, probe } = await setup({ vp: { everyMs: 15 * MIN }, c1: { everyMs: 15 * MIN } });
  // The answer times of 10-12's pauses, in the order the old gate logged them, then a slow archive that worked.
  for (const ms of [5_100, 7_200, 9_300, 6_000, 10_400, 11_600, 9_000, 6_600, 10_600, 5_700, 29_000]) await probe(ms);
  await gate.kill(17_700, true);
  await gate.kill(44_700, true);
  assert.equal(gate.state, "healthy");
  assert.deepEqual((await settings.all()).c1, { everyMs: 15 * MIN }, "no chat's check-in was paused");
  assert.deepEqual(told, []);
});

test("daemon gate: the probe lists the daemon's roster only, with prime-agent's own request timeout", async () => {
  const calls: unknown[][] = [];
  const request: DaemonRequest = async (...args) => { calls.push(args); return { success: true }; };
  await rosterList(request);
  assert.deepEqual(calls, [[{ type: "list" }, undefined, { recoverable: false }]], "no `all`: the disk scan of every saved session is not a health signal; no timeout of ours");
  await assert.rejects(rosterList(async () => ({ success: false, error: "daemon closed" })), /daemon closed/);
});

test("daemon gate: a restart during an outage starts unhealthy and the first answered list resumes the chats the daemon paused; a failed archive pauses; every duty wake probes, one probe at a time", async () => {
  const { settings, clock, daemon, told, gate, probe, dir } = await setup({ c1: { everyMs: 15 * MIN, pausedUntil: "forever", pausedBy: "daemon" }, c2: { everyMs: 15 * MIN } });
  await gate.kill(100, true);
  assert.equal(gate.state, undefined, "an archive that worked is no sample");
  await probe(100);
  assert.equal(gate.state, "healthy", "adopted as unhealthy from the settings file, then the first answered list resumes");
  assert.deepEqual((await settings.all()).c1, { everyMs: 15 * MIN, startAt: clock.at });
  await gate.kill(30_800, false);
  assert.equal(gate.state, "unhealthy", "a failed archive is the daemon not answering");
  assert.equal((await settings.all()).c2?.pausedBy, "daemon");
  await gate.kill(2_000, true);
  assert.equal(gate.state, "unhealthy", "an archive that worked does not end the outage; a list does");
  await probe(10);
  assert.equal(gate.state, "healthy");
  assert.deepEqual(told, []);
  const lists = daemon.lists;
  const duties = new Duties(new DutyStore(dir), { isChat: async () => false, jobs: { chat: async () => null, working: async () => false,
    start: async () => { throw new Error("no"); }, retire: async () => {} }, daemon: gate, tickMs: 0, now: () => clock.at });
  await duties.tick();
  await new Promise(resolve => setImmediate(resolve));
  await duties.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(daemon.lists, lists + 2, "each wake probes: no interval of ours on top of the duty runner's");
  let finish!: () => void;
  let calls = 0;
  const slow = new DaemonGate({ settings, chats: async () => [], keep: new Set(), lastCheckIn: async () => null, list: () => { calls++; return new Promise<void>(resolve => { finish = resolve; }); } });
  const first = slow.tick();
  await slow.tick();
  assert.equal(calls, 1, "a wake while a probe still waits on the daemon sends no second list");
  finish();
  await first;
  duties.close();
});

// The daemon gate's pauses and resumes of 10-12 from 13:15Z to 17:55Z, from service.log ("-" unhealthy, "+" healthy). From 15:11Z it flapped:
// 44 resumes by 17:35Z, every healthy spell but the last under 17 minutes.
const FLIPS_1012 =
  "13:19:29- 13:22:07+ 13:35:14- 15:11:01+ 15:15:03- 15:19:08+ 15:22:29- 15:22:31+ 15:24:31- 15:24:59+ 15:37:10- 15:37:33+ " +
  "15:37:58- 15:38:04+ 15:38:28- 15:38:29+ 15:44:59- 15:45:04+ 15:45:33- 15:45:37+ 15:46:05- 15:46:28+ 15:48:29- 15:49:09+ " +
  "15:49:50- 15:50:05+ 15:50:20- 15:50:30+ 15:50:51- 15:51:03+ 15:51:24- 15:51:28+ 15:51:58- 15:52:00+ 15:52:28- 15:52:28+ " +
  "15:54:02- 15:54:35+ 15:55:06- 15:55:48+ 15:57:13- 15:57:37+ 15:59:59- 16:00:32+ 16:01:01- 16:01:41+ 16:02:03- 16:02:08+ " +
  "16:03:07- 16:03:36+ 16:03:39- 16:03:58+ 16:04:53- 16:04:59+ 16:09:57- 16:11:52+ 16:13:29- 16:13:59+ 16:28:15- 16:28:27+ " +
  "16:34:29- 16:35:12+ 16:51:48- 16:52:02+ 17:03:27- 17:03:58+ 17:04:26- 17:05:07+ 17:05:25- 17:05:27+ 17:06:26- 17:06:47+ " +
  "17:08:42- 17:09:16+ 17:09:39- 17:09:57+ 17:10:41- 17:10:57+ 17:17:42- 17:18:12+ 17:20:31- 17:21:15+ 17:32:15- 17:32:37+ " +
  "17:33:11- 17:33:13+ 17:33:43- 17:33:55+ 17:34:16- 17:34:54+ 17:53:05- 17:53:28+ ";

test("daemon gate: a flapping gate resumes the longest wait first, so no chat starves; replay of 10-12, where VP of CI had no check-in from 13:15Z to 17:52Z", async () => {
  const day = (time: string): number => Date.parse(`2026-10-12T${time}Z`);
  // The 7 chats the gate paused, in check-in-settings.json order, with their interval in minutes and their last check-in before 13:19:29Z.
  const chats: [string, number, string][] = [["slack green", 60, "13:04:42"], ["launch main bro", 15, "13:17:11"], ["frontend bro", 15, "13:04:11"],
    ["ops guy", 120, "05:46:59"], ["VP of CI", 30, "13:15:07"], ["Crawler VP", 15, "13:07:42"], ["api portal", 15, "13:18:22"]];
  const last = new Map(chats.map(([id, , time]) => [id, day(time)]));
  // Each gap counts from VP of CI's 13:15:07Z check-in at the earliest, so ops guy's wait from 05:46Z, before the window, does not count.
  const gaps = new Map(chats.map(([id]) => [id, 0]));
  const dir = await mkdtemp(join(tmpdir(), "daemon-gate-replay-"));
  const path = join(dir, "check-in-settings.json");
  await writeFile(path, JSON.stringify(Object.fromEntries(chats.map(([id, minutes]) => [id, { everyMs: minutes * MIN }]))));
  const settings = checkInSettings(path);
  const clock = { at: day("13:15:30") };
  const gate = new DaemonGate({ settings, chats: async () => chats.map(([id]) => id), keep: new Set(), now: () => clock.at, list: async () => {},
    lastCheckIn: async id => last.get(id) ?? null });
  const flips = FLIPS_1012.trim().split(/\s+/).map(flip => ({ at: day(flip.slice(0, -1)), healthy: flip.endsWith("+") }));
  // Chats.tick every CHECK_IN_TICK_MS (30 s): a chat runs when its pause has ended and nextCheckIn is due.
  for (let tick = day("13:15:30"); tick <= day("17:55:00"); tick += 30_000) {
    while (flips.length && flips[0]!.at <= tick) {
      const flip = flips.shift()!;
      clock.at = flip.at;
      if (flip.healthy) await gate.probe();
      else await gate.kill(30_000, false);
    }
    clock.at = tick;
    const all = await settings.all();
    for (const [id] of chats) {
      const next = nextCheckIn(all[id]!, last.get(id)!, tick);
      if (next === null || next > tick) continue;
      gaps.set(id, Math.max(gaps.get(id)!, tick - Math.max(last.get(id)!, day("13:15:07"))));
      last.set(id, tick);
    }
  }
  for (const [id] of chats) gaps.set(id, Math.max(gaps.get(id)!, day("17:55:00") - Math.max(last.get(id)!, day("13:15:07"))));
  const minutes = Object.fromEntries([...gaps].map(([id, ms]) => [id, Math.round(ms / MIN)]));
  // The fixed resume order gave VP of CI 277 min and the 7 chats up to 280 min. VP of CI's 124 min now is the 96-minute full pause from 13:35Z
  // to 15:11Z, from the old 5 s bar that 540af42 removed, and the first resume after it runs VP of CI's check-in at its next wake.
  assert.deepEqual(minutes, { "slack green": 130, "launch main bro": 109, "frontend bro": 109, "ops guy": 143, "VP of CI": 124, "Crawler VP": 109, "api portal": 110 });
});
