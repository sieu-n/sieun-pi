import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chatChildren, type DaemonSession, sessionRows } from "../scripts/duties/duty-fleet.ts";
import { checkInRecord } from "../src/chat-checkin.ts";
import { checkInSettings } from "../src/checkin-settings.ts";
import { CorrectionLedger } from "../src/chat-corrections.ts";
import type { CheckInRun } from "../src/chat-duty-run.ts";
import { CHAT_SYSTEM_THREAD, flagStreaks, repeatLines } from "../src/checkin-repeats.ts";
import { Chats } from "../src/chats.ts";
import { type ChatThreads, type CheckInSource } from "../src/chat-sources.ts";
import { loadRecord } from "../src/chat-brief.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatBoard, ChildAgent, PlanItem } from "../src/shared/types.ts";

/*
 * c44 repeated (owner 10-12 11:41 in the AI harness thread: "when i told you to organize plan ... that's a failure mode that would have been
 * the check-in's duty"). A finding flagged in check-ins in a row is listed first, with its streak.
 */
test("flag streaks: a finding flagged again counts up, a new one starts at 1, one not flagged now drops; Flagged again lists 2 or more", () => {
  const first = flagStreaks(undefined, [{ kind: "finished_open", item: "p93" }, { kind: "orphan_steps", item: "p88" }]);
  assert.deepEqual(first, { "finished_open p93": 1, "orphan_steps p88": 1 });
  const second = flagStreaks(first, [{ kind: "finished_open", item: "p93" }, { kind: "wait_met", item: "p50" }]);
  assert.deepEqual(second, { "finished_open p93": 2, "wait_met p50": 1 });
  const lines = repeatLines(flagStreaks(second, [{ kind: "finished_open", item: "p93" }, { kind: "wait_met", item: "p50" }]), [
    { chat: "c", at: 0, kind: "wait_met", item: "p50", excerpt: "p50 waits for t6, and t6 is answered" },
    { chat: "c", at: 0, kind: "finished_open", item: "p93", excerpt: 'p93 "Email" doing, looks done' }]);
  assert.deepEqual(lines, ['finished_open: p93 "Email" doing, looks done (flagged in 3 check-ins in a row)', "wait_met: p50 waits for t6, and t6 is answered (flagged in 2 check-ins in a row)"]);
});

process.env.TZ = "Asia/Seoul";
const FIXTURES = join(import.meta.dirname, "fixtures", "checkin-replay");
const D = "00000000-0000-7000-8000-00000000000d";
const MIN = 60_000;
type Observer = Parameters<ChatThreads["observe"]>[0];

test("check-in: a finding the last check-in flagged and the board did not fix heads the next brief, with the Chat system thread for a wrong one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "c44-repeat-"));
  const read = async (name: string) => JSON.parse(await readFile(join(FIXTURES, name), "utf8")) as unknown;
  const { capturedAt, sessions } = await read("sessions.json") as { capturedAt: number; sessions: DaemonSession[] };
  const boards = await read("boards.json") as Record<string, ChatBoard>;
  for (const name of ["check-ins.json", "check-in-settings.json", "corrections.json"]) await writeFile(join(dir, name), JSON.stringify(await read(name)));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  for (const id of Object.keys(boards).reverse()) await index.add(id);
  let observer: Observer | undefined;
  const threads = {
    state: () => ({ messages: [] }), async view() { return null; }, busy: () => false, running: () => false, setWait() {},
    async restart() {}, async prompt() {}, async notice() {}, async deleteSubagent() {}, pin: () => true, unpin() {}, async setSteeringMode() {},
    async heartbeat() { return undefined; }, async clearHeartbeat() {}, async reload() {},
    observe(next: Observer) { observer = next; return () => { observer = undefined; }; },
  } as unknown as ChatThreads;
  const runs = new Map<string, CheckInRun[]>();
  let now = capturedAt + 16 * MIN;
  const memory = checkInRecord(join(dir, "check-ins.json"));
  // The chat ran its check-in every 15 min then, under today's 120 min default.
  await writeFile(join(dir, "check-in-settings.json"), JSON.stringify(Object.fromEntries(Object.keys(boards).map(id => [id, { everyMs: 15 * MIN }]))));
  const source: CheckInSource = {
    board: async id => boards[id] ?? null, rows: async () => sessionRows(sessions), memory, settings: checkInSettings(join(dir, "check-in-settings.json")), tickMs: 0, now: () => now, noReportGraceMs: 0,
    corrections: () => new CorrectionLedger(dir).read(),
    duty: { async checkIn(id, run) { runs.set(id, [...runs.get(id) ?? [], run]); }, async lastCheckIn(id) { return runs.get(id)?.at(-1)?.at; } },
  };
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source);
  await chats.adopt();
  for (const id of Object.keys(boards)) observer!.live(id, chatChildren(sessions, id) as ChildAgent[]);
  await chats.settled();
  await chats.tick();
  await chats.settled();
  assert.doesNotMatch(runs.get(D)![0]!.findings, /### Flagged again/, "a first flag is not a repeat");
  now += 16 * MIN;
  await chats.tick();
  await chats.settled();
  const second = runs.get(D)![1]!.findings;
  const heads = second.split("\n\n").filter(part => part.startsWith("### "));
  const repeats = heads[heads[0]!.startsWith("### Stuck steps (") ? 1 : 0]!;
  assert.ok(repeats.startsWith("### Flagged again ("), "the repeats head the brief, after the stuck steps");
  assert.match(repeats, /\n- orphan_steps: p31 "Goal: demo apps" has no live owner: .* \(flagged in 2 check-ins in a row\)/);
  assert.ok(repeats.includes(`send the ${CHAT_SYSTEM_THREAD} thread one message`), "a wrong finding goes to the thread that owns the checks");
  assert.equal((await memory.get(D))?.flags?.["orphan_steps p31"], 2, "the streak is kept in the check-in memory");
  chats.close();
});
