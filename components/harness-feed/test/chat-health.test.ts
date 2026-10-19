import assert from "node:assert/strict";
import { cp, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { d7Cuts, judgeMinutes, read, readNew, runningRows } from "../readers/chat-health.ts";
import type { Context, Sample } from "../otlp.ts";

// The fixture home holds the files the live chat service writes on its box, with every time in 11:00Z to 12:00Z on 10-19:
// a watch line each minute but 11:40Z, us-metal02 CPU-unusable at 11:45Z (with a 1.5 s read and a missed worker poll) and 11:50Z (fast),
// a wake held 11:31Z to 11:44Z, a pi-pool refusal with room from 11:33Z to its 11:50Z slot and a cell wait to 11:58Z, a send timeout at
// 11:52Z, a supervisor send_message timeout at 11:55Z, and d7's 11:35Z run naming a cut job held 11:20Z to 11:32Z and resumed since.
const FIXTURE = join(import.meta.dirname, "fixtures/chat-health/home");
const NOW = Date.parse("2026-10-19T12:00:20Z");
const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";

async function fixtureHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "chat-health-"));
  await cp(FIXTURE, home, { recursive: true });
  // The repo ignores *.log, so the log fixtures carry a .fixture suffix and take their real names here.
  for (const log of [".config/pi-pool/pi-pool.log", ".prime/agent/browser-chat/service.log", ".prime/agent/logs/daemon.sock.fixture01.log"])
    await rename(join(home, `${log}.fixture`), join(home, log));
  const duties = join(home, ".prime/agent/browser-chat/duties");
  await writeFile(join(duties, `${CHAT}.runs.jsonl`), [
    { duty: "d7", at: Date.parse("2026-10-19T11:05:00Z"), detail: join(duties, CHAT, "missing.json") },
    { duty: "d7", at: Date.parse("2026-10-19T11:35:00Z"), detail: join(duties, CHAT, "d7-261019-2035.json") },
    { duty: "d4", at: Date.parse("2026-10-19T11:40:00Z"), detail: join(duties, CHAT, "d4.json") },
  ].map(line => JSON.stringify(line)).join("\n") + "\n");
  return home;
}

const value = (samples: readonly Sample[], name: string, labels: Record<string, string> = {}): number | undefined =>
  samples.find(sample => sample.name === name && Object.entries(labels).every(([key, want]) => sample.labels?.[key] === want))?.value;

test("the fixture's 30 minutes read as d7's Whole system rule reads them", async () => {
  const home = await fixtureHome();
  process.env.PI_POOL_DIR = join(home, ".config/pi-pool");
  try {
    const ctx: Context = { home, host: "us-metal02", platform: "linux", now: NOW, chatHost: true, state: new Map() };
    const samples = await read(ctx);
    const minutes = (kind: string) => value(samples, "harness.chat.minutes_30", { kind });
    // Dirty: 11:30 to 11:32 (cut job), 11:41 to 11:44 (wake), 11:45 (slow CPU), 11:43 to 11:50 (free slot), 11:52 and 11:55 (faults).
    assert.equal(minutes("clean"), 14);
    assert.equal(minutes("held"), 7, "a hold counts from 10 min after its first line, 11:41:05Z");
    assert.equal(minutes("free_slot"), 8);
    assert.equal(minutes("cell_wait"), 16, "11:43Z to 11:58Z, never dirty");
    assert.equal(minutes("daemon_fail"), 2);
    assert.equal(minutes("cpu_busy"), 1, "11:50Z's CPU miss stayed fast");
    assert.equal(minutes("harness_unusable"), 1);
    assert.equal(minutes("unwatched"), 1);
    assert.equal(minutes("unknown"), 1, "11:40Z had no line and nothing dirty");
    assert.equal(value(samples, "harness.chat.box_minutes_30", { host: "us-metal02", state: "unusable" }), 1);
    assert.equal(value(samples, "harness.chat.box_minutes_30", { host: "mac", state: "usable" }), 29);
    assert.equal(value(samples, "harness.chat.queue_holds_30"), 3, "the wake, the cut job and the refusal with room");
    assert.equal(value(samples, "harness.chat.cell_holds_30"), 1);
    assert.equal(value(samples, "harness.chat.cut_jobs_held"), 0);
    assert.equal(value(samples, "harness.chat.daemon_faults_30"), 2);
    assert.equal(value(samples, "harness.chat.worker_poll_misses_30"), 1);
    // The Mac sat with nobody working from 11:00:30Z, so all its 29 lines in the window are past the 15 min quiet window; 11:50Z held 6.5 GB.
    assert.equal(value(samples, "harness.chat.quiet_minutes_30", { host: "mac" }), 29);
    assert.equal(value(samples, "harness.chat.quiet_agent_memory", { host: "mac" }), 6.5 * 1024 ** 3);
    assert.equal(value(samples, "harness.chat.quiet_agent_memory", { host: "us-metal02" }), undefined);
    assert.equal(value(samples, "harness.chat.hung_calls"), 1);
    assert.equal(value(samples, "harness.chat.agents", { host: "us-metal02", state: "working" }), 5);
    assert.equal(value(samples, "harness.chat.agents", { host: "us-metal02", state: "hung" }), 1);
    assert.equal(value(samples, "harness.chat.agent_memory", { host: "us-metal02" }), 8.5 * 1024 ** 3);
    assert.equal(value(samples, "harness.chat.box_usable", { host: "us-metal02" }), 1);
    assert.equal(value(samples, "harness.chat.slow_minutes_30", { kind: "read" }), 1);
    assert.equal(value(samples, "harness.chat.active_agents", { host: "us-metal02", kind: "thread" }), 1, "the archived running row is left out");
    assert.equal(value(samples, "harness.chat.active_agents", { host: "us-metal02", kind: "subagent" }), 2);
    assert.equal(value(samples, "harness.chat.active_agents", { host: "mac", kind: "thread" }), 1);
    assert.equal(value(samples, "harness.chat.unloaded_30"), 2);
    assert.equal(value(samples, "harness.chat.resume_pending", { reason: "cut_off" }), 2);
    assert.equal(value(samples, "harness.chat.opens_5m"), 2);
    assert.equal(value(samples, "harness.chat.open_slowest"), 2.5);
    assert.equal(value(samples, "harness.chat.worker_start_slowest", { kind: "resume" }), 3.5);
    assert.equal(value(samples, "harness.chat.d7_metric", { key: "clean_min_30" }), 12);
    assert.equal(value(samples, "harness.chat.d7_age"), (NOW - Date.parse("2026-10-19T11:35:00Z")) / 1000);
    assert.equal(value(samples, "harness.chat.tree_memory", { rank: "2", chat: "Crawler VP" }), 1.25 * 1024 ** 3);

    // A second round reads only what was appended: one more watch line moves the window and is the newest line.
    await writeFile(join(home, ".prime/agent/browser-chat/mac-usable/2026-10-19.jsonl"),
      JSON.stringify({ host: "us-metal02", at: "2026-10-19T12:00:30.000Z", workers: 0, workerGb: 0, top: [], live: 1, working: 0, queue: null, mac: { swapGb: null, pressureLevel: null }, cpuMs: 1 }) + "\n", { flag: "a" });
    const next = await read({ ...ctx, now: NOW + 60_000 });
    assert.equal(value(next, "harness.chat.sessions", { host: "us-metal02", kind: "live" }), 1);
    assert.equal(value(next, "harness.chat.minutes_30", { kind: "held" }), 6, "the cut job's 11:30Z minute left the window");
  } finally {
    delete process.env.PI_POOL_DIR;
    await rm(home, { recursive: true, force: true });
  }
});

test("a box that does not run the chat service reads nothing", async () => {
  assert.deepEqual(await read({ home: FIXTURE, host: "mbp", platform: "darwin", now: NOW, chatHost: false, state: new Map() }), []);
});

test("d7's cut jobs hold on to now while its run still names them cut", () => {
  const at = Date.parse("2026-10-19T00:05:00Z");
  const cuts = d7Cuts({ flagged: [
    { kind: "queue_hold", item: "cut job a (01a154b8-78b9-705b-93a5-e1bf1902cee5)", excerpt: "cut job a (01a154b8-78b9-705b-93a5-e1bf1902cee5) waited 50 min, 23:15Z to 00:05Z." },
    { kind: "cut_job", item: "01a154b8-78b9-705b-93a5-e1bf1902cee5", excerpt: "a was cut" },
    { kind: "queue_hold", item: "wake of abcd1234", excerpt: "wake of abcd1234 waited 12 min, 23:40Z to 23:52Z." },
  ] }, at);
  assert.deepEqual(cuts, [{ hold: { what: "cut job a (01a154b8-78b9-705b-93a5-e1bf1902cee5)", from: Date.parse("2026-10-18T23:15:00Z"), to: at }, open: true }]);
});

test("a CPU miss is dirty only when the harness was slow in it, as harness-slow.ts reads it", () => {
  const line = (minute: number, runnablePerCore: number, readMs: number) => ({ host: "b", at: new Date(Date.parse("2026-10-19T11:30:30Z") + minute * 60_000).toISOString(),
    usable: { kind: "linux" as const, memSomeAvg10: 0, memFullAvg10: 0, cpuSomeAvg10: 0, swapoutsPerS: 0, runnablePerCore, allowedCpus: 8 },
    workers: 0, workerGb: 0, top: [], live: 0, working: 0, queue: null, mac: { swapGb: null, pressureLevel: null }, cpuMs: 0, chat: { readMs, loopMs: 0 } });
  const watch = Array.from({ length: 30 }, (_, minute) => line(minute, minute < 3 ? 2 : 0.5, minute === 0 ? 1200 : 100));
  const out = judgeMinutes({ now: NOW, watch, holds: [], pool: [], faults: [], misses: [] });
  assert.equal(out.clean, 29);
  assert.equal(out.cpuBusy, 2);
  assert.equal(out.unattributed, 1, "a Linux CPU miss with no cpuCores has no side read");
});

test("the catalog count streams the rows and reads each row's own status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-health-copy-"));
  const file = join(dir, "session-copy.json");
  try {
    await writeFile(file, JSON.stringify({ version: 1, rows: [
      { id: "aa00bb00cc00", lifecycle: "live", runtimeKind: "top-level", rlmDepth: 0, model: { id: "m" }, rosterStatus: "running" },
      { id: "aa00bb00cc01", lifecycle: "live", runtimeKind: "rlm-child", rlmDepth: 1, model: { id: "m" }, firstMessage: "{\"rosterStatus\":\"running\"} [", rosterStatus: "idle" },
      { id: "aa00bb00cc02", lifecycle: "live", runtimeKind: "rlm-child", rlmDepth: 2, model: { id: "m" }, rosterStatus: "running" }] }));
    assert.deepEqual(await runningRows(file), { thread: 1, subagent: 1 }, "a status quoted in a message is no running row");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("readNew keeps a line still being written for the next round and starts a first read on a whole line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-health-tail-"));
  const file = join(dir, "log");
  try {
    await writeFile(file, "one\ntwo\nthr");
    const first = await readNew(file, undefined, 8);
    assert.deepEqual(first?.lines, ["two"]);
    await writeFile(file, "ee\n", { flag: "a" });
    const second = await readNew(file, first!.tail, 8);
    assert.deepEqual(second?.lines, ["three"]);
    await writeFile(file, "new\n");
    assert.deepEqual((await readNew(file, second!.tail, 8))?.lines, ["new"], "a file that shrank is read from its start");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
