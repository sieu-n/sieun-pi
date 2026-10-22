// Owner, 10-22 about 09:50Z: "also for Check in, make it Default to daily if plan list is empty". A chat with no open plan step ran its
// check-in at its own interval (2 h by default) all day.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { Chats } from "../src/chats.ts";
import { checkInLine, IDLE_CHECK_IN_MS, planCheckIn } from "../src/checkin-settings.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatBoard } from "../src/shared/types.ts";
import { fakeThreads, row, source } from "./chats-helpers.ts";

const CHAT = "01a16302-0000-7000-8000-00000000c4e1";
const MIN = 60_000;
const start = Date.parse("2026-10-22T10:00:00Z");
const board = (status: "todo" | "done"): ChatBoard => ({ v: 2, rev: 1, updatedAt: "", todos: [], plan: [{ id: "p1", text: "Ship the daily check-in", status, children: [] }] } as unknown as ChatBoard);

test("a chat with no open plan step checks in daily, and its own interval comes back with the next open step", async () => {
  const home = await mkdtemp(join(tmpdir(), "checkin-idle-daily-"));
  try {
    const boards: Record<string, ChatBoard> = { [CHAT]: board("done") };
    const index = new IdIndex(join(home, "chats.json"), "Chat index");
    await index.add(CHAT);
    let now = start;
    const chats = new Chats(index, fakeThreads([]), async () => ({ lifecycle: "live" }), "b1", loadRecord(join(home, "extension-loads.json")),
      { ...source(home, boards, () => now, () => [row(CHAT, new Date(now).toISOString(), { chat: true })]), home });
    const tick = async (minutes: number) => { now = start + minutes * MIN; const due = await chats.tick(); await chats.settled(); return due; };

    assert.deepEqual(await tick(0), [CHAT], "a chat with no check-in on record is due at once");
    assert.deepEqual(await tick(180), [], "3 h later the empty plan still waits for its daily check-in");
    const idle = (await chats.checkIns()).get(CHAT)!;
    assert.equal(idle.everyMs, 1440 * MIN, "the header shows a daily check-in");
    assert.equal(idle.planEveryMs, 120 * MIN, "and the interval the next open step brings back");
    assert.equal(idle.nextAt, start + 1440 * MIN);

    boards[CHAT] = board("todo");
    assert.deepEqual(await tick(181), [CHAT], "an open step brings the 2 h interval back, and 2 h have passed");
    const busy = (await chats.checkIns()).get(CHAT)!;
    assert.equal(busy.everyMs, 120 * MIN);
    assert.equal(busy.planEveryMs, undefined);

    await chats.setCheckIn(CHAT, { everyMs: 30 * MIN }, { by: "owner", setter: "ui" });
    assert.deepEqual(await tick(211), [CHAT], "the owner's 30 min stays while the plan has an open step");
    boards[CHAT] = board("done");
    assert.deepEqual(await tick(241), [], "with the plan empty again the 30 min waits for the next open step");
    assert.equal((await chats.checkIns()).get(CHAT)!.planEveryMs, 30 * MIN);
    chats.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("the daily interval applies only to a shorter one, and the chat_board line names it", () => {
  const two = { everyMs: 120 * MIN };
  assert.equal(planCheckIn(two, false).everyMs, IDLE_CHECK_IN_MS);
  assert.equal(planCheckIn(two, true), two);
  const week = { everyMs: 7 * 1440 * MIN };
  assert.equal(planCheckIn(week, false), week, "an interval longer than a day stays");
  assert.equal(checkInLine(two, start, false), "Check-in: daily while the plan has no open step, then every 120 min");
  assert.equal(checkInLine(two, start, true), "Check-in: every 120 min");
});
