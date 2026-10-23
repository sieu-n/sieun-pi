// sep launch!!'s check-ins sent the chat the same one_session_load line for goal p2 and the data model on metal thread 21 runs in a row on 10-23
// and 10-24, with the same steps and the same working count each time. A finding goes out once per unchanged situation now.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import type { CheckInRun } from "../src/chat-duty-run.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatBoard, SessionRow } from "../src/shared/types.ts";
import { fakeThreads, row, source } from "./chats-helpers.ts";

const CHAT = "01a15427-145f-751d-ba15-d27b6c30f65f";
const DATA = "01a1692c-9f57-7562-b7e7-f57c0252fcbc";
const STEPS = ["p70", "p71", "p72", "p73", "p74", "p75", "p76", "p77"];
const board = (steps: readonly string[]): ChatBoard => ({ v: 2, rev: 1, updatedAt: "2026-10-23T19:00:00Z", todos: [], plan: [{
  id: "p2", text: "The 5180 app works for real on local and staging", status: "doing", children: [
    ...steps.map(id => ({ id, text: `schema part ${id}`, status: "doing", job: DATA, sessionId: DATA, children: [] })),
    { id: "p58", text: "chat part", status: "doing", children: [] }] }] } as unknown as ChatBoard);

test("a check-in sends a load finding to its job once, and again when the thread's steps change", async () => {
  const home = await mkdtemp(join(tmpdir(), "finding-once-"));
  try {
    let now = Date.parse("2026-10-23T19:55:00Z");
    const boards: Record<string, ChatBoard> = { [CHAT]: board(STEPS) };
    const runs: CheckInRun[] = [];
    let start: "started" | "done" = "started";
    const index = new IdIndex(join(home, "chats.json"), "Chat index");
    await index.add(CHAT);
    const rows = (): SessionRow[] => [row(CHAT, new Date(now).toISOString(), { chat: true }), row(DATA, new Date(now).toISOString(), { name: "data model on metal" })];
    const chats = new Chats(index, fakeThreads([]), async () => ({ lifecycle: "live" }), "b1", loadRecord(join(home, "extension-loads.json")),
      { ...source(home, boards, () => now, rows), home, duty: { async checkIn(_id: string, run: CheckInRun) { runs.push(run); return start; }, async lastCheckIn() { return undefined; } } });
    await chats.adopt();
    const load = async () => {
      await chats.checkIn(CHAT);
      now += 15 * 60_000;
      const run = runs.at(-1)!;
      return { flagged: run.output.flagged.filter(slice => slice.kind === "one_session_load").length, text: /One session carries too much/.test(run.findings),
        metric: run.output.metrics.one_session_load };
    };
    assert.deepEqual(await load(), { flagged: 1, text: true, metric: 1 }, "19:55Z sends it");
    assert.deepEqual(await load(), { flagged: 0, text: false, metric: 1 }, "20:10Z leaves it out and still counts it");
    boards[CHAT] = board(STEPS.slice(0, 7));
    start = "done";
    assert.deepEqual(await load(), { flagged: 1, text: true, metric: 1 }, "p77 left the thread, so it goes out again");
    start = "started";
    assert.deepEqual(await load(), { flagged: 1, text: true, metric: 1 }, "the last run started no job, so this one sends it");
    assert.deepEqual(await load(), { flagged: 0, text: false, metric: 1 });
    chats.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
