// 10-27 us-metal02: with 39 late spawn records, each pass of the brief keeper and of every chat's check-in read the whole recovery journal of
// each late session's worker again, 78 MB in 5,000 reads in a copy of one pass, on the chat's thread pool. primeWorkers now reads only the
// bytes a journal gained since its last read.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { primeWorkers } from "../src/brief-keeper.ts";

const ROOT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const SESSION = "01a17b35-0690-722e-9c0d-23975eecc700";
const op = (session: string, operation: string, recordedAt: string) => JSON.stringify({ version: 1, sessionId: session, busy: true, operation, recordedAt }) + "\n";

async function worker(): Promise<{ dir: string; journal: string }> {
  const dir = await mkdtemp(join(tmpdir(), "brief-journal-"));
  await mkdir(join(dir, "ee92e1d8c39e"));
  const journal = join(dir, "ee92e1d8c39e", "a4329299578b.recovery.jsonl");
  await writeFile(join(dir, "ee92e1d8c39e", "a4329299578b.json"), JSON.stringify({ version: 2, workerId: "a4329299578b", pid: process.pid,
    recoveryJournalPath: journal, rootSessionId: ROOT, createdAt: "2026-10-27T02:00:00.000Z", lifecycle: "ready" }));
  return { dir, journal };
}
const rchar = (): number | null => existsSync("/proc/self/io") ? Number(/rchar: (\d+)/.exec(readFileSync("/proc/self/io", "utf8"))![1]) : null;

test("an agent start the journal gains after a read counts, and a journal written again from the start is read again", async () => {
  const { dir, journal } = await worker();
  await writeFile(journal, op(SESSION, "ready", "2026-10-27T02:33:54.000Z"));
  const read = primeWorkers(dir);
  assert.deepEqual(await read(ROOT, SESSION), { id: "a4329299578b", ran: false });
  await appendFile(journal, op(SESSION, "agent_start", "2026-10-27T02:33:55.000Z").slice(0, 40));
  assert.deepEqual(await read(ROOT, SESSION), { id: "a4329299578b", ran: false }, "half a line is no agent start yet");
  await appendFile(journal, op(SESSION, "agent_start", "2026-10-27T02:33:55.000Z").slice(40));
  assert.deepEqual(await read(ROOT, SESSION), { id: "a4329299578b", ran: true });
  await writeFile(journal, op(SESSION, "agent_start", "2026-10-27T01:00:00.000Z"));
  assert.deepEqual(await read(ROOT, SESSION), { id: "a4329299578b", ran: false }, "the new file's only agent start is from before this worker began");
});

test("a journal read again reads only what it gained, not the whole file", { skip: rchar() === null && "no /proc/self/io" }, async () => {
  const { dir, journal } = await worker();
  await writeFile(journal, op("01a17b00-0000-7000-8000-000000000000", "message_update", "2026-10-27T02:10:00.000Z").repeat(40_000));
  const read = primeWorkers(dir);
  await read(ROOT, SESSION);
  await appendFile(journal, op(SESSION, "agent_start", "2026-10-27T02:33:55.000Z"));
  const before = rchar()!;
  assert.deepEqual(await read(ROOT, SESSION), { id: "a4329299578b", ran: true });
  const bytes = rchar()! - before;
  assert.ok(bytes < 100_000, `the second read took ${bytes} bytes of a ${(40_000 * 160 / 1e6).toFixed(0)} MB journal`);
});
