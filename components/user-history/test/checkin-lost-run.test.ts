import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkInRecord } from "../src/chat-checkin.ts";
import { loadRecord } from "../src/chat-brief.ts";
import { Chats } from "../src/chats.ts";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatBoard } from "../src/shared/types.ts";
import { fakeThreads, source } from "./chats-helpers.ts";

/**
 * Chat 01a1164b (AI harness developer environment) on 10-15: its 2 h check-in measured at 10:09:38.724Z and wrote that time into the check-in
 * memory, then waited in the turn queue; the 10:12:28Z restart (release-81efbb1) cut it off before release-379933e wrote any run record. The
 * next server read its schedule from the memory, so the check-in counted as done and the next one was set for 12:09:38Z: at 11:34Z the chat had
 * no check-in since 08:09Z and service.log said nothing about it. The record below is the chat's newest check-in run, trimmed, from
 * duties/01a1164b-4a2d-742d-b27a-82f086ed0200.runs.jsonl.
 */
const ID = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const EVERY_MS = 7_200_000;
const LAST_RUN = { duty: "checkin", at: 1792051760924, slot: 1792051760924, trigger: "schedule", ms: 16530, verdict: "missed",
  summary: "stuck_steps 0 (on target), loose_goals 1 (target at most 0)", job: { id: "01a13e9b-f72c-746a-bae4-1e7b827d27ca", name: "check-in AI harness developer environment 17:09" },
  metrics: { loose_goals: { value: 1, target: 0, op: "<=", met: false } },
  after: { at: 1792058978724, verdict: "missed", summary: "stuck_steps 2 (target at most 0)", metrics: {} } };
const MEASURED_AT = 1792058978724;
const BOARD: ChatBoard = { v: 2, rev: 1, updatedAt: "", scratch: [], todos: [], plan: [{ id: "p447", text: "Every duty green", status: "doing", children: [] }] };

async function liveState() {
  const dir = await mkdtemp(join(tmpdir(), "checkin-lost-run-"));
  await mkdir(join(dir, "duties"), { recursive: true });
  await writeFile(join(dir, "duties", `${ID}.runs.jsonl`), JSON.stringify(LAST_RUN) + "\n");
  await writeFile(join(dir, "check-in-settings.json"), JSON.stringify({ [ID]: { everyMs: EVERY_MS } }));
  await checkInRecord(join(dir, "check-ins.json")).set(ID, { at: MEASURED_AT, steps: {} });
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add(ID);
  return { dir, index };
}

function serve(dir: string, index: IdIndex, now: () => number, lines: string[], started: string[]) {
  const duties = new Duties(new DutyStore(dir), { isChat: async () => true, tickMs: 0, now, log: line => lines.push(line),
    jobs: { chat: async id => ({ id, name: "AI harness developer environment", cwd: "/repo", board: "/b.json" }), working: async () => false, retire: async () => {},
      start: async (_chat, name) => { started.push(name); return { id: `job-${started.length}`, name }; } } });
  const chats = new Chats(index, fakeThreads([]), async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, { [ID]: BOARD }, now), duty: duties }, line => lines.push(line));
  return { chats, duties };
}

test("a check-in measured but never recorded before a restart is due at the next server's first wake, and a recorded one keeps its schedule (01a1164b 10-15)", async () => {
  const { dir, index } = await liveState();
  let now = Date.parse("2026-10-15T11:34:00Z");
  const lines: string[] = [];
  const started: string[] = [];
  const first = serve(dir, index, () => now, lines, started);
  await first.chats.adopt();
  assert.deepEqual(await first.chats.tick(), [ID], "the last recorded check-in ran at 08:09Z, so the 2 h check-in is due; the memory's 10:09Z measure started no job");
  await first.chats.settled();
  await first.duties.settled();
  assert.equal(started.length, 1, "one check-in job starts");
  assert.match(lines.join("\n"), new RegExp(`duty ${ID.slice(0, 8)}/checkin: missed, .*started check-in`));
  first.chats.close();
  first.duties.close();

  now += 60_000;
  const second = serve(dir, index, () => now, lines, started);
  await second.chats.adopt();
  assert.deepEqual(await second.chats.tick(), [], "the run recorded a minute ago keeps the schedule across this restart");
  second.chats.close();
  second.duties.close();
});

test("a check-in that runs nothing says why in the log: nothing open to check, or a run of the chat still starting its job", async () => {
  const { dir, index } = await liveState();
  const now = Date.parse("2026-10-15T11:34:00Z");
  const lines: string[] = [];
  const idle = new Chats(index, fakeThreads([]), async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, { [ID]: { ...BOARD, plan: [] } }, () => now) }, line => lines.push(line));
  await idle.adopt();
  await idle.checkIn(ID);
  assert.match(lines.join("\n"), /chat 01a1164b: check-in: nothing to check \(no job at work, no open plan step, no board error\)/);
  idle.close();

  let admit!: () => void;
  const admitted = new Promise<void>(resolve => { admit = resolve; });
  const started: string[] = [];
  const duties = new Duties(new DutyStore(dir), { isChat: async () => true, tickMs: 0, now: () => now, log: line => lines.push(line),
    admit: async () => { await admitted; return null; },
    jobs: { chat: async id => ({ id, name: "AI harness developer environment", cwd: "/repo", board: "/b.json" }), working: async () => false, retire: async () => {},
      start: async (_chat, name) => { started.push(name); return { id: "job-1", name }; } } });
  const run = { at: now, trigger: "schedule" as const, everyMs: EVERY_MS, output: { metrics: {}, flagged: [] }, classes: {}, findings: "" };
  const going = duties.checkIn(ID, run);
  const shared = duties.checkIn(ID, { ...run, at: now + 1000 });
  assert.match(lines.join("\n"), /duty 01a1164b\/checkin: a check-in run is still starting its job, so this check-in waits for it/);
  admit();
  await Promise.all([going, shared]);
  assert.equal(started.length, 1);
  duties.close();
});
