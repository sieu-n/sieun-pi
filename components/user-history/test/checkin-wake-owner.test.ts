import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import type { CheckInRun } from "../src/chat-duty-run.ts";
import type { StepMemo } from "../src/checkin-steps.ts";
import { Chats } from "../src/chats.ts";
import { silentJobs } from "../src/status-ask.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatBoard, ChildAgent, PlanItem, SessionRow } from "../src/shared/types.ts";
import { pendingWakes, TICKED, type Wake } from "../src/wakes.ts";
import { dutySink, fakeThreads, row, source } from "./chats-helpers.ts";

/**
 * launch main bro's real p53, p75 and p56 (chat 01a11bd7, 2026-10-14): the board as it stood at 14:13Z with the two goals cut to these steps,
 * their memos from check-ins.json (unchanged since 04:23Z), and the release driver's wake file verbatim. The release driver (session 01a1389b, a
 * create_session root of the chat) owns all three, checks land 35 and promote 10 every hour, and at 13:40Z ended its turn on a board.wake for
 * 14:40Z. The 22:50 KST (13:50Z) check-in and every one after it flagged all three as stuck_steps and two of them as blocked_on_others
 * with "release driver thread is idle" (the 14:05Z one: p53 and p75).
 */
const CHAT = "01a11bd7-072f-7591-ad1d-f123c276cde5";
const DRIVER = "01a1389b-63c7-75c9-8397-33705fb9d3d2";
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/launch-main-bro-wake-owner.json", import.meta.url), "utf8")) as
  { board: ChatBoard; memo: Record<string, StepMemo>; wake: Wake };
const IDS = ["p53", "p75", "p56"];
const WAKE_AT = Date.parse("2026-10-14T14:40:00Z");
const READ_AT = Date.parse("2026-10-14T14:15:00Z");
const DRIVER_ROW = row(DRIVER, "2026-10-14T13:40:30Z", { name: "release driver" });

interface Setup { now: number; tickedAt?: number; wake?: boolean; board?: ChatBoard; memo?: Record<string, StepMemo>; children?: ChildAgent[]; wakes?: Wake[] }
/** One check-in of the chat at `now` against a wakes folder holding the release driver's wake (unless `wake` is false) and a TICKED stamp. */
async function checkIn({ now, tickedAt = now - 20_000, wake = true, board = FIXTURE.board, memo = FIXTURE.memo, children, wakes = [] }: Setup): Promise<CheckInRun> {
  const dir = await mkdtemp(join(tmpdir(), "wake-owner-"));
  const wakeDir = join(dir, "wakes");
  await mkdir(wakeDir);
  for (const each of [...wake ? [FIXTURE.wake] : [], ...wakes]) {
    const key = each.on.kind === "time" ? `time-${each.on.at / 1000}` : `run-${each.on.run}`;
    await writeFile(join(wakeDir, `${each.session}-${key}.json`), JSON.stringify(each));
  }
  await writeFile(join(wakeDir, TICKED), new Date(tickedAt).toISOString());
  await writeFile(join(dir, "check-ins.json"), JSON.stringify({ chats: { [CHAT]: { at: now - 15 * 60_000, since: now - 15 * 60_000, steps: memo } }, ends: {} }));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add(CHAT);
  const threads = fakeThreads([]);
  const sink = dutySink();
  const rows: SessionRow[] = [row(CHAT, new Date(now).toISOString(), { name: "***launch main bro***" }), DRIVER_ROW];
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, { [CHAT]: board }, () => now, () => rows), duty: sink.duty, wakes: at => pendingWakes(wakeDir, at) });
  await chats.adopt();
  threads.fire().live(CHAT, children ?? []);
  await chats.settled();
  await chats.checkIn(CHAT);
  await chats.settled();
  chats.close();
  await rm(dir, { recursive: true, force: true });
  assert.equal(sink.runs.length, 1, "one check-in ran");
  return sink.runs[0]!.run;
}
/** The stuck and blocked flags on the three steps, as "kind:id". */
const flags = (run: CheckInRun): string[] => run.output.flagged
  .filter(slice => (slice.kind === "stuck_steps" || slice.kind === "blocked_on_others") && IDS.includes(slice.item ?? "")).map(slice => `${slice.kind}:${slice.item}`).sort();
/** What the 14:13Z board gives with no live owner; p53's "14:3xZ" note holds it off blocked_on_others. */
const STUCK = ["blocked_on_others:p56", "blocked_on_others:p75", "stuck_steps:p53", "stuck_steps:p56", "stuck_steps:p75"];

test("launch main bro 10-14: the release driver asleep on its 14:40Z board.wake is a live owner, so p53, p75 and p56 are moving, not stuck or blocked on others", async () => {
  const run = await checkIn({ now: READ_AT });
  assert.deepEqual(flags(run), []);
  assert.equal(run.output.metrics.stuck_steps, 0);
  for (const id of IDS) assert.match(run.findings, new RegExp(`- ${id} \\(live\\) "[^"]+" doing, owner release driver thread \\(asleep on a board\\.wake at 14:40Z\\)`));
  assert.match(run.findings, /release driver thread: asleep on a board\.wake at 14:40Z, last activity 35 min ago, on p53/);
});

test("launch main bro 10-14 control: a due wake with no tick for over 2 min, or no wake, leaves p53, p75 and p56 stuck; a late tick or a late send does not", async () => {
  assert.deepEqual(flags(await checkIn({ now: WAKE_AT + 2 * 60_000 })), [], "at 14:42Z the wake is still within one delivery gap");
  assert.deepEqual(flags(await checkIn({ now: WAKE_AT + 40 * 60_000 })), [], "a ticking service still owes a wake it sends late (AI harness 10-18 03:27Z: sends up to 41 min late)");
  const overdue = await checkIn({ now: WAKE_AT + 3 * 60_000, tickedAt: WAKE_AT });
  assert.deepEqual(flags(overdue), STUCK, "at 14:43Z the wake is due and no tick ran for 3 min, so nobody sends it");
  assert.match(overdue.findings, /owner release driver thread \(idle\)/);
  assert.deepEqual(flags(await checkIn({ now: READ_AT, tickedAt: READ_AT - 3 * 60_000 })), [], "a last tick 3 min old does not erase a wake still ahead (AI harness 10-18 01:32Z)");
  assert.deepEqual(flags(await checkIn({ now: READ_AT, wake: false })), STUCK, "the release driver with no wake is idle");
});

test("wakes: a subagent asleep on a board.wake for a CI run is a working owner and gets no status ask, even while the service's tick is late", async () => {
  const fact = { key: "k7", name: "train lander", state: "working" as const, item: { id: "p200", text: "Land train 1", status: "doing" as const } };
  assert.equal(silentJobs([fact], () => READ_AT - 2 * 60 * 60_000, READ_AT).length, 1, "a working job silent for 2 h gets an ask");
  assert.deepEqual(silentJobs([{ ...fact, wake: "a board.wake on run 38576851186" }], () => READ_AT - 2 * 60 * 60_000, READ_AT), [], "an ask would wake it");
  const session = "01a13a70-b2fc-7191-a914-3d3058bea249";
  const step: PlanItem = { id: "p200", text: "Land train 1", status: "doing", job: "train lander", waitFor: "train 1 run 38576851186 green, then land", children: [] };
  const board: ChatBoard = { ...FIXTURE.board, plan: [{ id: "p199", text: "Ship the trains", status: "doing", children: [step] }] };
  const memo = { p200: { sig: JSON.stringify(["doing", step.text, "train lander"]), at: READ_AT - 3 * 60 * 60_000, wait: JSON.stringify(["waits", "train lander"]), waitAt: READ_AT - 3 * 60 * 60_000 } };
  const child: ChildAgent = { id: "k7", label: "train lander", sessionName: "train lander", sessionId: session, status: "done", lastActivityAt: READ_AT - 2 * 60 * 60_000, repliedSinceTask: true };
  const wake: Wake = { session, on: { kind: "run", run: 38576851186 }, note: "train 1 run finished: read jobs, land on green or find the red commit", since: READ_AT - 2 * 60 * 60_000 };
  const asleep = await checkIn({ now: READ_AT, wake: false, board, memo, children: [child], wakes: [wake] });
  assert.deepEqual(asleep.output.flagged.filter(slice => slice.item === "p200").map(slice => slice.kind), []);
  assert.match(asleep.findings, /- p200 \(live\) "Land train 1" doing, owner job train lander \(asleep on a board\.wake on run 38576851186\)/);
  const stale = await checkIn({ now: READ_AT, tickedAt: READ_AT - 3 * 60_000, wake: false, board, memo, children: [child], wakes: [wake] });
  assert.deepEqual(stale.output.flagged.filter(slice => slice.item === "p200").map(slice => slice.kind), [], "a tick 3 min late still owes the run wake");
});

test("launch main bro 10-14: a step that waits on the release driver thread is not blocked on others while the driver sleeps on its wake", async () => {
  const step: PlanItem = { id: "p300", text: "Turn on the 2,000 page canary", status: "blocked", waitFor: "the release driver's promote 10 read-back", children: [] };
  const board: ChatBoard = { ...FIXTURE.board, plan: [{ id: "p299", text: "Canary", status: "doing", children: [step] }] };
  const memo = { p300: { sig: JSON.stringify(["blocked", step.text, ""]), at: READ_AT - 3 * 60 * 60_000, wait: JSON.stringify(["waits", ""]), waitAt: READ_AT - 3 * 60 * 60_000 } };
  const blocked = (run: CheckInRun) => run.output.flagged.filter(slice => slice.kind === "blocked_on_others" && slice.item === "p300").map(slice => slice.excerpt);
  assert.deepEqual(blocked(await checkIn({ now: READ_AT, board, memo })), []);
  assert.match(blocked(await checkIn({ now: WAKE_AT + 3 * 60_000, tickedAt: WAKE_AT, board, memo }))[0] ?? "", /p300 "Turn on the 2,000 page canary" is blocked on the release driver thread/);
});
