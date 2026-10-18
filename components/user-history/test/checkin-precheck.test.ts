import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chatChildren, type DaemonSession, sessionRows } from "../scripts/duties/board-classes.ts";
import { checkInRecord } from "../src/chat-checkin.ts";
import { checkInSettings } from "../src/checkin-settings.ts";
import { CorrectionLedger } from "../src/chat-corrections.ts";
import type { CheckInRun } from "../src/chat-duty-run.ts";
import { Chats } from "../src/chats.ts";
import { type ChatThreads, type CheckInSource } from "../src/chat-sources.ts";
import { loadRecord } from "../src/chat-brief.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatBoard, ChildAgent } from "../src/shared/types.ts";

/**
 * The check-in precheck on a synthetic set of four chats (`test/fixtures/checkin-replay/`: boards, the daemon's sessions, the check-in memory,
 * settings and a corrections ledger with a handoff, at `capturedAt`). One scheduled tick hands each chat's precheck to the duty runner as
 * context for one check-in job; the server steers no chat, nudges no thread and writes no board note.
 */
process.env.TZ = "Asia/Seoul";
const FIXTURES = join(import.meta.dirname, "fixtures", "checkin-replay");
const A = "00000000-0000-7000-8000-00000000000a";
const D = "00000000-0000-7000-8000-00000000000d";
const MIN = 60_000;
type Observer = Parameters<ChatThreads["observe"]>[0];

test("check-in precheck: one tick gives each chat's classes, misses and findings to the duty runner, and the server sends no line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "checkin-precheck-"));
  const read = async (name: string) => JSON.parse(await readFile(join(FIXTURES, name), "utf8")) as unknown;
  const { capturedAt, sessions } = await read("sessions.json") as { capturedAt: number; sessions: DaemonSession[] };
  const boards = await read("boards.json") as Record<string, ChatBoard>;
  for (const name of ["check-ins.json", "check-in-settings.json", "corrections.json"]) await writeFile(join(dir, name), JSON.stringify(await read(name)));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  for (const id of Object.keys(boards).reverse()) await index.add(id);
  const sent: string[] = [];
  let observer: Observer | undefined;
  const threads = {
    state: () => ({ messages: [] }), async view() { return null; }, busy: () => false, running: () => false, setWait() {},
    async restart(id: string) { sent.push(`restart ${id}`); }, async prompt(id: string, input: { message: string }) { sent.push(`prompt ${id} ${input.message}`); },
    async notice(id: string) { sent.push(`notice ${id}`); }, async deleteSubagent() {}, pin: () => true, unpin() {}, async setSteeringMode() {},
    async heartbeat() { return undefined; }, async clearHeartbeat() {}, async reload() {},
    observe(next: Observer) { observer = next; return () => { observer = undefined; }; },
  } as unknown as ChatThreads;
  const runs = new Map<string, CheckInRun[]>();
  const source: CheckInSource = {
    board: async id => boards[id] ?? null, rows: async () => sessionRows(sessions), memory: checkInRecord(join(dir, "check-ins.json")),
    settings: checkInSettings(join(dir, "check-in-settings.json")), tickMs: 0, now: () => capturedAt + 16 * MIN, noReportGraceMs: 0,
    corrections: () => new CorrectionLedger(dir).read(),
    duty: { async checkIn(id, run) { runs.set(id, [...runs.get(id) ?? [], run]); }, async lastCheckIn(id) { return runs.get(id)?.at(-1)?.at; } },
  };
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source);
  await chats.adopt();
  for (const id of Object.keys(boards)) observer!.live(id, chatChildren(sessions, id) as ChildAgent[]);
  await chats.settled();
  const due = await chats.tick();
  await chats.settled();
  assert.deepEqual(due.sort(), Object.keys(boards).sort());
  assert.deepEqual(sent, [], "no steer, nudge, notice or restart");
  for (const id of Object.keys(boards)) {
    const [run, ...more] = runs.get(id) ?? [];
    assert.ok(run, `one run for ${id}`);
    assert.equal(more.length, 0);
    assert.equal(run.trigger, "schedule");
    const open = Object.values(run.classes).reduce((sum, count) => sum + count, 0);
    const listed = run.findings.split("### Every open step, oldest change first\n")[1]!.split("\n").filter(line => line.startsWith("- "));
    assert.equal(listed.length, open, `every open step of ${id} is listed`);
    for (const slice of run.output.flagged) if (slice.kind === "scope_misses" || slice.kind === "idle_goals") assert.ok(run.findings.includes(slice.excerpt), slice.excerpt);
  }
  assert.match(runs.get(A)![0]!.findings, /### Owned by another thread by an owner ruling\n- p6 "Fix: the build machine is out of disk space" belongs to chat B/);
  assert.match(runs.get(D)![0]!.findings, /### Look done[^\n]*\n- p31 "Goal: demo apps" doing, looks done: every step under it is closed\n- p36 "Ship: the landing page" doing, looks done: its note says "Merged"/);
  assert.doesNotMatch(runs.get(D)![0]!.findings, /Goals nobody works on/, "a goal whose open steps look done needs a check, not a job");
  assert.equal(runs.get(A)![0]!.output.metrics.scope_misses, 1);
  // A second tick in the same slot starts nothing.
  assert.deepEqual(await chats.tick(), []);
  chats.close();
});
