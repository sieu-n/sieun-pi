// The owner on 10-28 (msg mvqzy9rn): "check in system working normally?". A reading of the duties files alone counted two daily check-ins 9.6
// and 15.6 days late: the clean-room chat 01a14d38, archived by its teardown on 10-18, and chat 01a12dfd, which the daemon no longer lists.
// Neither is in chats.json, so the scheduler rightly runs neither, and nothing said so. An empty plan's daily check-in also moved no lastRunAt.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Duties } from "../src/chat-duty-run.ts";
import type { DutyJobHost } from "../src/chat-duty-job.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { checkInStandingLine, checkInStandings } from "../src/checkin-schedule.ts";

const CHAT = "01a11b0b-7c15-73da-9481-8de15903eab4";
const CLEAN_ROOM = "01a14d38-3fa3-72cd-a10b-dc0b2fb2e976";
const GONE = "01a12dfd-74cc-743d-acf2-80203e204b68";
const ARCHIVED = "01a17bf3-a180-710c-8edd-ad4cd2be19eb";
const now = Date.parse("2026-10-27T18:06:00Z");
const minutes = (count: number) => count * 60_000;

test("a check-in with nothing to check moves its duties file's lastRunAt, so an empty plan's daily check-in reads as run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "checkin-schedule-"));
  try {
    const store = new DutyStore(dir);
    const duties = new Duties(store, { isChat: async () => true, jobs: {} as DutyJobHost, tickMs: 0, log: () => {} });
    await duties.checkInClean(CHAT, now, "schedule");
    assert.equal((await store.read(CHAT)).checkIn?.lastRunAt, now);
    assert.deepEqual(await store.runs(CHAT), [], "a chat never measured still gets no run record");
    await duties.checkInClean(CHAT, now + minutes(24 * 60), "schedule");
    assert.equal((await store.read(CHAT)).checkIn?.lastRunAt, now + minutes(24 * 60));
    duties.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("only a chat in the chat list is scheduled; a thread that left it reads stopped with why, and an archived one is left out", () => {
  const standings = checkInStandings({
    now, chats: new Set([CHAT]), archived: new Set([ARCHIVED]), cleanRoom: new Set([CLEAN_ROOM]),
    recorded: new Map([[CHAT, now - minutes(10)], [CLEAN_ROOM, now - minutes(13_740)], [GONE, now - minutes(22_401)], [ARCHIVED, now - minutes(50_000)]]),
    settings: { [CHAT]: { everyMs: minutes(120) }, [GONE]: { everyMs: minutes(120) } }, planOpen: new Map([[CHAT, true]]) });
  assert.deepEqual(standings.map(standing => [standing.chat, standing.state]), [[CHAT, "on_time"], [CLEAN_ROOM, "stopped"], [GONE, "stopped"]]);
  const line = (chat: string) => checkInStandingLine(standings.find(standing => standing.chat === chat)!, chat.slice(0, 8), now);
  assert.match(line(CLEAN_ROOM), /stopped on purpose, last check-in 2026-10-18T05:06Z, 13740 min ago, since it is a clean-room test chat/);
  assert.match(line(GONE), /since it is no longer in the chat list/);
});

test("a chat past 1.5 intervals reads late at the daily interval of an empty plan, and a paused one names who paused it", () => {
  const read = (lastMin: number, planOpen: boolean, setting = { everyMs: minutes(60) }) => checkInStandings({ now, chats: new Set([CHAT]), archived: new Set(),
    cleanRoom: new Set(), recorded: new Map([[CHAT, now - minutes(lastMin)]]), settings: { [CHAT]: setting }, planOpen: new Map([[CHAT, planOpen]]) })[0]!;
  assert.equal(read(89, true).state, "on_time");
  assert.equal(read(91, true).state, "late");
  assert.equal(read(91, false).state, "on_time", "an empty plan checks in daily");
  assert.equal(read(36 * 60 + 1, false).state, "late");
  const paused = read(50_000, true, { everyMs: minutes(60), pausedUntil: "forever", pausedBy: "owner" } as never);
  assert.equal(paused.state, "paused");
  assert.match(checkInStandingLine(paused, "ops guy", now), /^ops guy: paused by the owner until resumed/);
  assert.equal(checkInStandings({ now, chats: new Set([CHAT]), archived: new Set(), cleanRoom: new Set(), recorded: new Map(), settings: {}, planOpen: new Map() })[0]!.state, "late",
    "a chat with no check-in on record is late");
});
