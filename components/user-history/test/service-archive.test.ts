// 10-20 18:25Z (job "429 drought resume fixes"): the duty runner archived each cut duty job 0.4 to 3 s after "its turn ended; queued its
// archive" in service.log, and Prime wrote archive reason owner_archive on each. Prime takes no reason from a client (a bare kill reads
// owner_stop, archive_saved_session reads owner_archive), so every reader that tells the owner's intent apart from the system's read the
// service's archive as the owner's. The service now names its own archives in service-archives.json, and only the owner's routes write a cancel.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { archiveDutyJob } from "../src/chat-duty-job.ts";
import { ownerStopSinceActive } from "../src/chat-guard.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { jobCancelRecord } from "../src/job-cancels.ts";
import { serviceArchiveRecord } from "../src/service-archives.ts";
import { fakeThreads, row, source } from "./chats-helpers.ts";

const CHAT = "01a15903-32dc-722e-87d3-55af930292fe";
const DUTY_JOB = "01a15a8d-0000-7000-8000-0000000000d1";
const OWNER_JOB = "01a15a8d-0000-7000-8000-0000000000d2";
const SCRIPT_JOB = "01a15a8d-0000-7000-8000-0000000000d3";

test("the duty runner's archive and a script's teardown archive record no owner cancel; the owner's archive of a job still does", async t => {
  const root = mkdtempSync(join(tmpdir(), "service-archive-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, "browser-chat");
  mkdirSync(data, { recursive: true });
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(data, "chats.json"), "Chat index");
  await index.add(CHAT);
  const now = Date.parse("2026-10-20T18:20:00.000Z");
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(data, "extension-loads.json")),
    { ...source(data, {}, () => now, () => [row(CHAT, new Date(now).toISOString(), { chat: true })]), cancels: jobCancelRecord(join(data, "job-cancels.json")) },
    () => {});
  t.after(() => chats.close());
  await chats.adopt();

  await archiveDutyJob(threads, async () => [row(DUTY_JOB, new Date(now).toISOString())])(DUTY_JOB);
  await chats.archiveJob(SCRIPT_JOB, "service_cleanup");
  await chats.archiveJob(OWNER_JOB, "owner");

  const cancels = JSON.parse(readFileSync(join(data, "job-cancels.json"), "utf8")) as Record<string, { how: string; by: string }>;
  assert.deepEqual(Object.keys(cancels), [OWNER_JOB], "only the owner's archive is kept as his cancel");
  assert.equal(cancels[OWNER_JOB]!.how, "archive");
  assert.equal(threads.archivedBy.get(DUTY_JOB), "duty_job_end", "the duty runner's archive goes out as the service's");
  assert.equal(threads.archivedBy.get(SCRIPT_JOB), "service_cleanup");
  assert.equal(threads.archivedBy.get(OWNER_JOB), "owner");
});

test("a session file's owner_archive line that service-archives.json names is the service's archive, and an archive after a reopen is the owner's again", async t => {
  const root = mkdtempSync(join(tmpdir(), "service-archive-file-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const record = serviceArchiveRecord(join(root, "service-archives.json"));
  const file = join(root, `${DUTY_JOB}.jsonl`);
  const state = (at: string, status: string, reason?: string) =>
    appendFileSync(file, JSON.stringify({ type: "session_state", timestamp: at, state: { status, ...reason ? { reason } : {} } }) + "\n");
  writeFileSync(file, JSON.stringify({ type: "session", id: DUTY_JOB }) + "\n");
  state("2026-10-20T18:01:00.000Z", "active");
  const queued = Date.parse("2026-10-20T18:20:11.000Z");
  await record.add(DUTY_JOB, { at: queued, reason: "duty_job_end" });
  state("2026-10-20T18:20:11.400Z", "archived", "owner_archive");

  const entry = await record.of(DUTY_JOB);
  assert.deepEqual(entry, { at: queued, reason: "duty_job_end" });
  assert.equal(await ownerStopSinceActive(file, entry), null, "the service's archive is no owner stop");
  assert.equal(await ownerStopSinceActive(file), "owner_archive at 2026-10-20T18:20:11.400Z", "without the record Prime's line reads as the owner's");

  state("2026-10-20T18:30:00.000Z", "active");
  state("2026-10-20T18:31:00.000Z", "archived", "owner_archive");
  assert.equal(await ownerStopSinceActive(file, entry), "owner_archive at 2026-10-20T18:31:00.000Z", "an archive after a reopen is not the service's");

  await record.drop(DUTY_JOB);
  assert.equal(await record.of(DUTY_JOB), undefined, "the owner's own archive through the service takes the record back");
});
