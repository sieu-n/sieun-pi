import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { changeCheckIn, checkInSettings, nextCheckIn } from "../src/chat-checkin.ts";
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
  const input = { settings, chats: async () => ["vp", "c1", "c2", "c3", "c4"], keep: new Set(["vp"]), tell: "vp", now: () => clock.at,
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
  assert.match(log.at(-1)!, /daemon gate: healthy \(a list answered\); resumed the check-in of 2 chats, staggered over their interval: c1, c3/);
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
  const slow = new DaemonGate({ settings, chats: async () => [], keep: new Set(), list: () => { calls++; return new Promise<void>(resolve => { finish = resolve; }); } });
  const first = slow.tick();
  await slow.tick();
  assert.equal(calls, 1, "a wake while a probe still waits on the daemon sends no second list");
  finish();
  await first;
  duties.close();
});
