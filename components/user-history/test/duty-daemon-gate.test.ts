import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { changeCheckIn, checkInSettings, nextCheckIn } from "../src/chat-checkin.ts";
import { DaemonGate } from "../src/chat-daemon-gate.ts";
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
  const gate = new DaemonGate({ settings, chats: async () => ["vp", "c1", "c2", "c3", "c4"], keep: new Set(["vp"]), tell: "vp", now: () => clock.at,
    log: line => { log.push(line); }, steer: async (id, message) => { told.push(`${id}: ${message}`); },
    list: async () => { daemon.lists++; clock.at += daemon.ms; if (daemon.fail) throw new Error("daemon client closed"); } });
  const probe = async (ms: number) => { daemon.ms = ms; clock.at += MIN; await gate.tick(); };
  return { settings, clock, daemon, told, log, gate, probe, dir };
}

test("daemon gate: two slow lists pause the check-in of every chat but the kept one and the ones already paused; three fast lists resume only those, staggered, with one line each way", async () => {
  const { settings, clock, told, log, gate, probe } = await setup({ vp: { everyMs: 15 * MIN }, c1: { everyMs: 15 * MIN }, c2: { everyMs: 15 * MIN, pausedUntil: "forever", pausedBy: "owner" },
    c3: { everyMs: 60 * MIN }, c4: { everyMs: 15 * MIN, pausedUntil: new Date(2026, 9, 9, 18, 30).getTime(), pausedBy: "chat" } });
  await probe(200);
  assert.equal(gate.state, "healthy");
  await probe(12_000);
  assert.equal(gate.state, "healthy", "one slow list is not enough");
  await probe(6_000);
  assert.equal(gate.state, "unhealthy");
  const paused = await settings.all();
  assert.deepEqual(paused.c1, { everyMs: 15 * MIN, pausedUntil: "forever", pausedBy: "daemon", setter: "gate" });
  assert.deepEqual(paused.c3, { everyMs: 60 * MIN, pausedUntil: "forever", pausedBy: "daemon", setter: "gate" });
  assert.deepEqual(paused.vp, { everyMs: 15 * MIN }, "the developer environment VP chat keeps its check-in");
  assert.equal(paused.c2?.pausedBy, "owner", "the owner's pause stays the owner's");
  assert.equal(paused.c4?.pausedBy, "agent", "the chat's own pause, an older file's \"chat\", stays an agent's");
  assert.deepEqual(told, ["vp: [check-in] The daemon is slow (list took 6.0 s), so the server paused the check-in of 2 chats; they resume on their own after 3 lists in a row within 5 s."]);
  assert.match(log.join("\n"), /daemon gate: unhealthy \(list took 6\.0 s, 2 bad samples in a row\); paused the check-in of 2 chats: c1, c3/);
  assert.deepEqual(changeCheckIn(paused.c1!, { pause: null }, clock.at, { by: "agent", setter: "c1" }), { refused: "the server paused check-ins while the daemon is slow; they resume on their own" },
    "the gate holds its pause while the daemon is slow, so the chat cannot clear it");
  assert.deepEqual(changeCheckIn(paused.c1!, { pause: "1h" }, clock.at, { by: "agent", setter: "01a00000" }), { refused: "the server paused check-ins while the daemon is slow; they resume on their own" });
  await probe(30_000);
  await probe(1_000);
  await probe(1_000);
  assert.equal(gate.state, "unhealthy", "two fast lists are not enough");
  assert.equal(told.length, 1, "no second pause line");
  await probe(1_000);
  assert.equal(gate.state, "healthy");
  const now = clock.at;
  const resumed = await settings.all();
  assert.deepEqual(resumed.c1, { everyMs: 15 * MIN, startAt: now }, "chat 0 of 2 runs at once");
  assert.deepEqual(resumed.c3, { everyMs: 60 * MIN, startAt: now + 30 * MIN }, "chat 1 of 2 runs half its interval later");
  assert.equal(resumed.c2?.pausedBy, "owner", "a pause the gate did not make is not resumed");
  assert.equal(resumed.c4?.pausedBy, "agent");
  assert.equal(nextCheckIn(resumed.c3!, now - 3 * 60 * MIN, now), now + 30 * MIN, "the first check-in after the resume waits for its turn");
  assert.equal(nextCheckIn(resumed.c3!, now + 30 * MIN, now + 30 * MIN), now + 90 * MIN, "then it runs at its interval");
  assert.deepEqual(told.slice(1), ["vp: [check-in] The daemon answers again, so the server resumed the check-in of 2 chats, spread over their interval."]);
  assert.match(log.at(-1)!, /daemon gate: healthy \(3 lists in a row within 5 s\); resumed the check-in of 2 chats, staggered over their interval: c1, c3/);
  await probe(200);
  assert.equal(told.length, 2, "no second resume line");
});

test("daemon gate: a restart during an outage starts unhealthy and resumes the chats the daemon paused; failed lists and failed or slow archives are bad samples; the duty runner probes at most once a minute", async () => {
  const { settings, clock, daemon, told, gate, probe, dir } = await setup({ c1: { everyMs: 15 * MIN, pausedUntil: "forever", pausedBy: "daemon" }, c2: { everyMs: 15 * MIN } });
  await probe(100);
  assert.equal(gate.state, "unhealthy", "adopted from the settings file");
  await probe(100);
  await probe(100);
  assert.equal(gate.state, "healthy");
  assert.deepEqual((await settings.all()).c1, { everyMs: 15 * MIN, startAt: clock.at });
  assert.equal(told.length, 1, "only the resume line: this gate never paused");
  await gate.kill(2_000, true);
  await gate.kill(20_000, true);
  assert.equal(gate.state, "healthy");
  daemon.fail = true;
  await probe(10);
  assert.equal(gate.state, "unhealthy", "a slow archive then a failed list");
  assert.equal((await settings.all()).c2?.pausedBy, "daemon");
  daemon.fail = false;
  await probe(10);
  await gate.kill(0, false);
  await probe(10);
  await probe(10);
  assert.equal(gate.state, "unhealthy", "a failed archive starts the count again");
  await probe(10);
  assert.equal(gate.state, "healthy");
  const lists = daemon.lists;
  const duties = new Duties(new DutyStore(dir), { isChat: async () => false, jobs: { chat: async () => null, working: async () => false,
    start: async () => { throw new Error("no"); }, retire: async () => {} }, daemon: gate, tickMs: 0, now: () => clock.at });
  clock.at += MIN;
  await duties.tick();
  await duties.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(daemon.lists, lists + 1, "two wakes in the same minute probe once");
  duties.close();
});
