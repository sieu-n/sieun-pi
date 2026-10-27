// Prime to pi-host cutover, step 2 (cutover.md): the :5183 canary chat runs on pi-host, which keeps every session's schedules in one file,
// <agent dir>/pi-host/scheduled-jobs.json. The check-in read only Prime's per-session session-artifacts/<id>/scheduled-jobs.json, so on the
// canary it saw none of a chat's heartbeats.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import type { CheckInRun } from "../src/chat-duty-run.ts";
import { Chats } from "../src/chats.ts";
import { piHostJobsFile } from "../src/checkin-load.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatBoard, SessionRow } from "../src/shared/types.ts";
import { fakeThreads, row, source } from "./chats-helpers.ts";

const CHAT = "01a17e50-0000-7000-8000-000000000001";
const OTHER = "01a17e50-0000-7000-8000-000000000002";
const board: ChatBoard = { v: 2, rev: 1, updatedAt: "2026-10-27T17:00:00Z", todos: [], plan: [
  { id: "p1", text: "Ship the canary chat", status: "doing", children: [] }] };
const beat = (id: string, sessionId: string, label: string) => ({ id, status: "active", source: "rlm_heartbeat", runtimeKind: "top-level", deliveryMode: "steer",
  activeSessionId: sessionId, sessionId, sessionFile: `/x/${sessionId}.jsonl`, cwd: "/x", label, prompt: "Read the board and nudge stalled steps.",
  schedule: { kind: "interval", expression: "every 30m", intervalMs: 1_800_000 }, createdAt: "2026-10-27T16:00:00Z", updatedAt: "2026-10-27T16:00:00Z",
  nextRunAt: "2026-10-27T17:30:00Z", runCount: 1 });

test("on pi-host the check-in reads the chat's heartbeats from pi-host's one schedules file", async () => {
  const home = await mkdtemp(join(tmpdir(), "checkin-pi-host-schedules-"));
  try {
    const agentDir = join(home, ".prime", "agent");
    mkdirSync(join(agentDir, "pi-host"), { recursive: true });
    writeFileSync(piHostJobsFile(agentDir), JSON.stringify({ jobs: [beat("hb-chat", CHAT, "board watch"), beat("hb-other", OTHER, "other status")] }));
    const now = Date.parse("2026-10-27T17:05:00Z");
    const runs: CheckInRun[] = [];
    const index = new IdIndex(join(home, "chats.json"), "Chat index");
    await index.add(CHAT);
    const rows = (): SessionRow[] => [row(CHAT, "2026-10-27T17:00:00Z", { chat: true, name: "canary" })];
    const chats = new Chats(index, fakeThreads([]), async () => ({ lifecycle: "live" }), "b1", loadRecord(join(home, "extension-loads.json")),
      { ...source(home, { [CHAT]: board }, () => now, rows), home, piHostJobs: piHostJobsFile(agentDir),
        duty: { async checkIn(_id: string, run: CheckInRun) { runs.push(run); return "started"; }, async lastCheckIn() { return undefined; } } });
    await chats.adopt();
    await chats.roster(new Map());
    await chats.checkIn(CHAT);
    const run = runs.at(-1)!;
    assert.match(run.findings, /heartbeat "board watch"/, "the chat's heartbeat in pi-host's file is read");
    assert.doesNotMatch(run.findings, /other status/, "another session's heartbeat is not the chat's");
    chats.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
