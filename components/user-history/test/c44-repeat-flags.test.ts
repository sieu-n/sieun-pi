import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chatChildren, type DaemonSession, sessionRows } from "../scripts/duties/board-classes.ts";
import { checkInRecord, looksDone } from "../src/chat-checkin.ts";
import { checkInSettings } from "../src/checkin-settings.ts";
import { CorrectionLedger } from "../src/chat-corrections.ts";
import type { CheckInRun } from "../src/chat-duty-run.ts";
import { CHAT_SYSTEM_THREAD, flagStreaks, repeatLines } from "../src/checkin-repeats.ts";
import { Chats } from "../src/chats.ts";
import { type ChatThreads, type CheckInSource, replyCheckRecord } from "../src/chat-sources.ts";
import { loadRecord } from "../src/chat-brief.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatBoard, ChildAgent, PlanItem } from "../src/shared/types.ts";

/*
 * c44 repeated (owner 10-12 11:41 in the AI harness thread: "when i told you to organize plan ... that's a failure mode that would have been
 * the check-in's duty"). On 10-12 the long finished_open streaks were false matches each check-in judged and kept: frontend bro p93 (5 runs)
 * and p96 (4), launch main bro p27 (4), VP of CI p19 (3). The notes and waits below are the boards' own at the time of those flags.
 */
const item = (id: string, text: string, extra: Partial<PlanItem> = {}): PlanItem => ({ id, text, status: "doing", children: [], ...extra });

test("looks done: shipped in a path, a job name, a name or an adjective claims nothing (frontend bro 10-12: p93, p96, p92, p84)", () => {
  const p93 = item("p93", "Email from the current Staging screen: polish 5 parts one at a time", { job: "email from shipped",
    note: "Part 1, the template list, is built and checked in the browser. Clicking a count opens a compact popup of those creators with Sent, " +
      "Replied and No reply tabs, and columns can be resized. It scores 44 pass and 1 fail on the checklist, and that fail is fixed in the A/B part. " +
      "Next is part 2, creating a template. Shots: sessions/2026/10/12/2030-email-from-shipped/assets/" });
  assert.equal(looksDone(p93), null, "the path 2030-email-from-shipped");
  assert.equal(looksDone({ ...p93, note: "The email from shipped job builds part 3." }), null, "the job's own name");
  assert.equal(looksDone({ ...p93, note: "Shots in 2030-email-from-shipped.md" }), null, "a hyphenated file name");
  const p96 = item("p96", "A From scratch scenario on 5180", { job: "fresh start scenario",
    note: "The plan is done. The shipped app has had no onboarding since 2026-09-02, so this is a new design: one column where each step folds " +
      "forward in place. Part 2, the seed, clock and configure entry, is building now. Plan: sessions/2026/10/12/2117-fresh-start-scenario/fresh-start-plan.md" });
  assert.equal(looksDone(p96), null, "the shipped app");
  assert.equal(looksDone(item("p92", "Connections from the shipped screen", { note: "Still building from the shipped screen. list-flat is building now." })), null);
  assert.equal(looksDone(item("p84", "Creators from shipped", { note: "All four Creators versions are built from Shipped: swipe, wall, campaign and lens." })), null,
    "Shipped as the name of the live screen");
  assert.equal(looksDone({ ...p93, note: "Part 5 shipped to staging at 4f1c2a." }), 'its note says "shipped"', "a real ship claim still counts");
  assert.equal(looksDone({ ...p96, note: "The onboarding is shipped and checked on staging." }), 'its note says "shipped"');
});

test("looks done: closed steps under an item that still waits are its first part; a denial is no ship (VP of CI p19, launch main bro p27, Crawler VP p46, p115)", () => {
  const p27 = item("p27", "Build: 5-arm rate test (50 to 800 pages per account a day, 5 days)", { job: "engage rate test",
    waitFor: "Crawler VP's GO line at 15:00Z after step C (metal OK'd v2)", children: [item("p46", "Build: per-arm daily and hourly caps", { status: "done" })] });
  assert.equal(looksDone(p27), null, "its own test waits for the GO line");
  const p19 = item("p19", "Secrets scan on the diff, tiny Python lanes on light runners", { job: "ship command build",
    note: "Rides the land 33 chain, which ship command build pushes right after land 32b reaches staging.",
    waitFor: "land 32b's third try reaches staging, about 14:15Z, then the land 33 chain push",
    children: [item("p37", "Fix: the daily CI health check", { status: "done" }), item("p56", "Always-on CI dashboard", { status: "done" })] });
  assert.equal(looksDone(p19), null, "its push waits on the land");
  const { waitFor: _wait, ...p27Free } = p27;
  assert.equal(looksDone(p27Free), "every step under it is closed", "with no wait, closed steps still mean done");
  const p46 = item("p46", "Build: new snapshot tables and writers", { waitFor: "Fable's 32b-on-staging announcement (about 14:15Z), then media serving build pushes PROBE A",
    note: "Land 32b attempt 2 failed at 13:05Z on the CI signed-in e2e test, not 32b code; nothing deployed. Re-dispatch on 4555d6526b after about 13:23Z." });
  assert.equal(looksDone(p46), null, "nothing deployed");
  assert.equal(looksDone({ ...p46, note: "PROBE A deployed to staging at 14:20Z." }), 'its note says "deployed"', "a land wait with a ship claim may be over");
  const p115 = item("p115", "Fix: stop and ramp rules judge job outcomes", { waitFor: "census-cut-lines' ci ref from job outcome stop rules",
    note: "Watch v8 (metal-acked) is live on prod. The code change in census-cut-lines still moves ramp.py's HOLD rule to job outcomes." });
  assert.equal(looksDone(p115), null, "a wait on its own next work: another thing being live is no claim");
});

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
  const source: CheckInSource = {
    board: async id => boards[id] ?? null, rows: async () => sessionRows(sessions), memory, replyChecks: replyCheckRecord(join(dir, "reply-checks.json")),
    settings: checkInSettings(join(dir, "check-in-settings.json")), tickMs: 0, now: () => now, noReportGraceMs: 0,
    corrections: () => new CorrectionLedger(dir).read(),
    duty: { async checkIn(id, run) { runs.set(id, [...runs.get(id) ?? [], run]); } },
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
  assert.ok(second.startsWith("### Flagged again ("), "the repeats head the brief");
  const section = second.split("\n\n")[0]!;
  assert.match(section, /\n- finished_open: p31 "Goal: demo apps" doing, looks done: every step under it is closed \(flagged in 2 check-ins in a row\)/);
  assert.ok(section.includes(`send the ${CHAT_SYSTEM_THREAD} thread one message`), "a wrong finding goes to the thread that owns the checks");
  assert.equal((await memory.get(D))?.flags?.["finished_open p31"], 2, "the streak is kept in the check-in memory");
  chats.close();
});
