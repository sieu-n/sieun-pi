import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ARCHIVE_GIVE_UP_MS, ArchiveQueue } from "../src/chat-archive-queue.ts";
import { dutyJobHost } from "../src/chat-duty-job.ts";
import { type CheckInRun, Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { jobRegistry } from "../src/chat-sources.ts";
import type { SessionRow } from "../src/shared/types.ts";

const row = (id: string, name: string, extra: Partial<SessionRow> = {}): SessionRow => ({ id, name, cwd: "/repo", kind: "live", status: "idle", archived: false,
  messageCount: 1, working: false, subagentsRunning: 0, unread: false, tags: [], priority: 0, progress: "none", ...extra });
const quiet = { orphan_steps: 0, due_late: 0, stale_chase_24h: 0, job_end_unrecorded: 0, job_end_silent: 0, scope_misses: 0, idle_goals: 0, stalled_steps: 0, go_missing: 0, requirements_missing: 0 };

test("duty archive queue: a hung archive does not delay the next duty job's start; a failed try retries after its wait and succeeds; a restart keeps the queue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "archive-queue-"));
  const path = join(dir, "duty-archive-queue.json");
  const clock = { at: new Date(2026, 9, 9, 18, 0).getTime() };
  const calls: string[] = [];
  let release: (() => void) | undefined;
  let outcome: "hang" | "fail" | "ok" = "hang";
  const queue = new ArchiveQueue({ path, tickMs: 0, now: () => clock.at, archive: async id => {
    calls.push(`archive ${id}`);
    if (outcome === "hang") await new Promise<void>(resolve => { release = resolve; });
    if (outcome === "fail" || outcome === "hang") throw new Error('Timed out after 30000ms waiting for the Prime Agent daemon response to "kill".');
  } });
  let next = 0;
  const host = dutyJobHost({ archives: queue, rows: async () => [row("chat1", "dev VP")], registry: jobRegistry(join(dir, "chat-jobs.json")), board: id => `/b/${id}.json`,
    threads: { async create(input) { calls.push(`create ${input.name}`); return { id: `s${++next}` }; }, async prompt() {} } });
  const store = new DutyStore(dir);
  const duties = new Duties(store, { isChat: async () => true, jobs: host, tickMs: 0, now: () => clock.at });
  const run = (minutes: number): CheckInRun => ({ at: clock.at + minutes * 60_000, trigger: "schedule", everyMs: 15 * 60_000, output: { metrics: quiet, flagged: [] }, classes: {}, findings: "" });
  await duties.checkIn("chat1", run(0));
  await duties.checkIn("chat1", run(15));
  assert.deepEqual(calls.sort(), ["archive s1", "create check-in dev VP 18:00", "create check-in dev VP 18:15"], "the second job started while s1's archive hangs");
  assert.deepEqual((await store.runs("chat1")).map(entry => entry.job?.id), ["s2", "s1"]);
  assert.deepEqual((await queue.pending()).map(entry => [entry.id, entry.tries]), [["s1", 0]], "the hung archive is still queued");
  release!();
  await queue.drain();
  const [failed] = await queue.pending();
  assert.deepEqual([failed?.id, failed?.tries, failed!.nextAt - clock.at], ["s1", 1, 60_000], "the failed try waits 1 min");
  outcome = "fail";
  clock.at += 30_000;
  await queue.drain();
  assert.equal(calls.filter(call => call === "archive s1").length, 1, "not tried before its wait ends");
  clock.at += 30_000;
  await queue.drain();
  assert.deepEqual((await queue.pending()).map(entry => [entry.tries, entry.nextAt - clock.at]), [[2, 120_000]], "the second failure waits 2 min");
  const restarted: string[] = [];
  const after = new ArchiveQueue({ path, tickMs: 0, now: () => clock.at, archive: async id => { restarted.push(id); } });
  clock.at += 120_000;
  await after.drain();
  assert.deepEqual(restarted, ["s1"], "a new queue on the same file (a restart) archives it");
  assert.deepEqual(await after.pending(), []);
  duties.close();
});

test("duty archive queue: the waits grow to 30 min and repeat, a try that never answers counts as failed, and an entry a day old is dropped with a log line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "archive-queue-"));
  const clock = { at: 0 };
  const log: string[] = [];
  const queue = new ArchiveQueue({ path: join(dir, "q.json"), tickMs: 0, tryTimeoutMs: 20, now: () => clock.at, log: line => { log.push(line); },
    archive: () => new Promise<void>(() => {}) });
  await queue.add({ id: "s1", name: "check-in dev VP 18:00" });
  await queue.add({ id: "s1", name: "check-in dev VP 18:00" });
  const waits: number[] = [];
  for (let tries = 0; tries < 7; tries++) {
    await queue.drain();
    const [entry] = await queue.pending();
    waits.push((entry!.nextAt - clock.at) / 60_000);
    clock.at = entry!.nextAt;
  }
  assert.deepEqual(waits, [1, 2, 5, 15, 30, 30, 30]);
  assert.match(log[0]!, /archive check-in dev VP 18:00 \(s1\) try 1 failed, retrying later: no answer after 0 s/);
  clock.at = ARCHIVE_GIVE_UP_MS;
  await queue.drain();
  assert.deepEqual(await queue.pending(), []);
  assert.match(log.at(-1)!, /gave up on check-in dev VP 18:00 \(s1\) after 8 tries in a day/);
});
