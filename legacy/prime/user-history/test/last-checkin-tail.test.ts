// Guards the chat's start at 05:53:51Z on 10-26 on us-metal02: Chats.load read each chat's last check-in by parsing its whole duty runs file
// (134 files, 24 MB, 9,765 records), and the owner's api/threads/01a15427-145f-751d-ba15-d27b6c30f65f/duties read waited 1.9 s on it, so d7
// counted 05:54Z dirty. The last check-in now comes from the file's tail.
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import type { DutyRunRecord } from "../src/shared/chat-duties.ts";

const CHAT = "01a15427-145f-751d-ba15-d27b6c30f65f";
const START = Date.parse("2026-10-19T14:13:00Z");
const record = (duty: string, at: number): DutyRunRecord => ({ duty, at, slot: at, trigger: "schedule", ms: 0, verdict: "met", metrics: {}, summary: "x".repeat(900) });

async function runsFile(dir: string, records: readonly DutyRunRecord[]): Promise<void> {
  await mkdir(join(dir, "duties"), { recursive: true });
  await appendFile(join(dir, "duties", `${CHAT}.runs.jsonl`), records.map(entry => JSON.stringify(entry) + "\n").join(""));
}

test("the last check-in at a start reads the runs file's tail, not every record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "last-checkin-tail-"));
  try {
    const records = Array.from({ length: 2_000 }, (_, index) => record(index % 3 ? "d7" : "checkin", START + index * 60_000));
    records.push(record("checkin", START + 2_000 * 60_000), record("d7", START + 2_001 * 60_000));
    await runsFile(dir, records);
    const store = new DutyStore(dir);
    let parsed = 0;
    const runs = store.runs.bind(store);
    store.runs = async id => { parsed++; return await runs(id); };
    const duties = new Duties(store, {
      isChat: async () => true, now: () => START, tickMs: 0, node: process.execPath, tell: async () => {},
      jobs: { chat: async () => null, working: async () => false, retire: async () => {}, start: async () => ({ id: "j", name: "j" }), kept: async () => null, steer: async () => {} },
    });
    assert.equal(await duties.lastCheckIn(CHAT), START + 2_000 * 60_000);
    assert.equal(parsed, 0, "no parse of the whole runs file");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a check-in older than the tail and a file with none still read from the whole file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "last-checkin-old-"));
  try {
    await runsFile(dir, [record("checkin", START), ...Array.from({ length: 400 }, (_, index) => record("d7", START + (index + 1) * 60_000))]);
    const store = new DutyStore(dir);
    assert.equal((await store.newestRun(CHAT, "checkin"))?.at, START);
    assert.equal(await store.newestRun(CHAT, "d2"), undefined);
    assert.equal(await store.newestRun("01a17000-0000-7000-8000-000000000000", "checkin"), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
