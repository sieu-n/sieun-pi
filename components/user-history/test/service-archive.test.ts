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
import { parseServiceArchives, serviceArchiveRecord } from "../src/service-archives.ts";
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

test("only the exact line a confirmed service archive wrote is the service's; an owner stop before or after it, or after a reopen, stays his", async t => {
  const root = mkdtempSync(join(tmpdir(), "service-archive-file-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const record = serviceArchiveRecord(join(root, "service-archives.json"));
  const file = join(root, `${DUTY_JOB}.jsonl`);
  const state = (id: string, at: string, status: string, reason?: string) =>
    appendFileSync(file, JSON.stringify({ type: "session_state", id, timestamp: at, state: { status, ...reason ? { reason } : {} } }) + "\n");
  writeFileSync(file, JSON.stringify({ type: "session", id: DUTY_JOB }) + "\n");
  state("a1", "2026-10-20T18:01:00.000Z", "active");
  const queued = Date.parse("2026-10-20T18:20:11.000Z");
  await record.add(DUTY_JOB, { op: "op-1", at: queued, reason: "duty_job_end", after: "a1", line: null });
  state("s1", "2026-10-20T18:20:11.400Z", "archived", "owner_archive");
  assert.equal(await ownerStopSinceActive(file, await record.of(DUTY_JOB)), "owner_archive at 2026-10-20T18:20:11.400Z",
    "an operation the daemon has not confirmed covers no line");
  await record.land(DUTY_JOB, "op-1", "s1");
  assert.deepEqual(await record.of(DUTY_JOB), [{ op: "op-1", at: queued, reason: "duty_job_end", after: "a1", line: "s1" }]);
  assert.equal(await ownerStopSinceActive(file, await record.of(DUTY_JOB)), null, "the service's archive is no owner stop");
  assert.equal(await ownerStopSinceActive(file), "owner_archive at 2026-10-20T18:20:11.400Z", "without the record Prime's line reads as the owner's");

  state("o1", "2026-10-20T18:20:12.000Z", "archived", "owner_stop");
  assert.equal(await ownerStopSinceActive(file, await record.of(DUTY_JOB)), "owner_stop at 2026-10-20T18:20:12.000Z", "the owner's stop 0.6 s later is his");

  state("a2", "2026-10-20T18:30:00.000Z", "active");
  state("o2", "2026-10-20T18:31:00.000Z", "archived", "owner_archive");
  assert.equal(await ownerStopSinceActive(file, await record.of(DUTY_JOB)), "owner_archive at 2026-10-20T18:31:00.000Z", "an archive after a reopen is not the service's");

  await record.drop(DUTY_JOB);
  assert.deepEqual(await record.of(DUTY_JOB), [], "the owner's own archive through the service takes the record back");
});

test("an owner stop before a service archive still holds after the service's line", async t => {
  const root = mkdtempSync(join(tmpdir(), "service-archive-order-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, `${DUTY_JOB}.jsonl`);
  writeFileSync(file, [{ type: "session", id: DUTY_JOB }, { type: "session_state", id: "a1", timestamp: "2026-10-20T18:01:00.000Z", state: { status: "active" } },
    { type: "session_state", id: "o1", timestamp: "2026-10-20T18:10:00.000Z", state: { status: "archived", reason: "owner_stop" } },
    { type: "session_state", id: "s1", timestamp: "2026-10-20T18:20:00.000Z", state: { status: "archived", reason: "owner_archive" } }].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  assert.equal(await ownerStopSinceActive(file, [{ op: "op-1", at: Date.parse("2026-10-20T18:19:59.000Z"), reason: "duty_job_end", after: "o1", line: "s1" }]),
    "owner_stop at 2026-10-20T18:10:00.000Z");
});

test("4ec60673's { at, reason } entries name no line, so they cover nothing", () => {
  assert.deepEqual(parseServiceArchives({ [DUTY_JOB]: { at: 1, reason: "duty_job_end" } }), {});
  assert.deepEqual(parseServiceArchives({ [DUTY_JOB]: [{ op: "x", at: 1, reason: "duty_job_end", after: null, line: null }, { at: 1, reason: "duty_job_end" }] }),
    { [DUTY_JOB]: [{ op: "x", at: 1, reason: "duty_job_end", after: null, line: null }] });
});
