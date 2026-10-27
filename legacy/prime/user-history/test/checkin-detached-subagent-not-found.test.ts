// disk space trend 10-24 13:50:33Z: the check-in read p2's owner "root disk sampler (not found)" while the chat's agents API at 13:50:22Z
// listed the same job working, queued 55th of 86 in pi-pool, with a board.wake at 15:30Z. The job is a subagent of the chat (sub-e7ac1ec7,
// session 01a16dda). The chat was detached, and from 13:23:53Z to 15:31:03Z the daemon listed no subagent under it, so the roster gave the
// check-in no children. The catalog rows hold top-level sessions only, so p2's stored session id named no row either. The agents API kept the
// job through p2's session id (`chatAgents`), and its wake and queue place made it working. The check-in had no fact to put them on.
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
import type { Wake } from "../src/wakes.ts";
import { fakeThreads, row, source } from "./chats-helpers.ts";

const CHAT = "01a16dd9-edb7-745d-9ccb-9acf74ee8609";
const SAMPLER = "01a16dda-a85d-75d8-b9d0-2a2b34b26eda";
const board: ChatBoard = { v: 2, rev: 1, updatedAt: "2026-10-24T13:10:00Z", todos: [], plan: [
  { id: "p1", text: "Track free space on us-metal02 root for 3 hours and write a short page", status: "doing", children: [
    { id: "p2", text: "Take 12 readings of free space on root, 15 minutes apart", status: "doing", job: "root disk sampler", sessionId: SAMPLER,
      waitUntil: "2026-10-24T15:30:00.000Z", children: [] }] }] };
const wake: Wake = { session: SAMPLER, on: { kind: "time", at: Date.parse("2026-10-24T15:30:00Z") }, note: "check the samples file", since: Date.parse("2026-10-24T13:10:30Z") };

test("a detached chat's subagent that the daemon no longer lists still owns its step through the step's session id, asleep and queued", async () => {
  const home = await mkdtemp(join(tmpdir(), "subagent-not-found-"));
  try {
    const now = Date.parse("2026-10-24T13:50:33Z");
    const runs: CheckInRun[] = [];
    const index = new IdIndex(join(home, "chats.json"), "Chat index");
    await index.add(CHAT);
    const rows = (): SessionRow[] => [row(CHAT, "2026-10-24T13:20:25Z", { chat: true, name: "disk space trend" })];
    const chats = new Chats(index, fakeThreads([]), async () => ({ lifecycle: "live" }), "b1", loadRecord(join(home, "extension-loads.json")),
      { ...source(home, { [CHAT]: board }, () => now, rows), home,
        wakes: async () => [wake],
        queue: async () => ({ queued: new Map([[SAMPLER, { position: 55, total: 86, since: Date.parse("2026-10-24T13:42:45Z") }]]), working: new Set<string>() }),
        duty: { async checkIn(_id: string, run: CheckInRun) { runs.push(run); return "started"; }, async lastCheckIn() { return undefined; } } });
    await chats.adopt();
    await chats.roster(new Map());
    await chats.checkIn(CHAT);
    const run = runs.at(-1)!;
    assert.doesNotMatch(run.findings, /root disk sampler \(?not found/, "p2's owner is found");
    assert.match(run.findings, /p2 \(live\)[^\n]*owner job root disk sampler \(queued 55th of 86 for an account, asleep on a board\.wake at 15:30Z\)/);
    assert.equal(run.classes.live, 1);
    chats.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
