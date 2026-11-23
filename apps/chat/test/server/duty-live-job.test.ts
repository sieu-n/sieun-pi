/**
 * A duty run reads a fix step's job as working when the job or any subagent under it works or has a pending wake: a job that is idle only
 * because it waits on its own working subagents, or on a wake set under it, is alive, and the duty brief must not call it "not working", or
 * the duty job starts a duplicate fix job.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/duty-live-job.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { DutyRunRecord } from "../../web/src/lib/api/shared/chat-duties.ts";
import { BOARD_DOC } from "../../server/boards.ts";
import { armWake } from "../../server/wakes.ts";
import { FIXTURE_AGENTS as agents, FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import type { FixtureHost } from "../../server/host/fixture.ts";
import { start, until, type Running } from "./helpers.ts";

const HOUR = 3_600_000;
const now = Date.now();
let s: Running;
let work: string;
const briefs: string[] = [];
const runsOf = (): DutyRunRecord[] => (JSON.parse(readFileSync(join(s.app.boards.dir(agents.vent), "duties.json"), "utf8")) as { runs: Record<string, DutyRunRecord[]> }).runs.d1 ?? [];

before(async () => {
  s = await start();
  work = mkdtempSync(join(tmpdir(), "duty-live-job-"));
  const host = s.host as FixtureHost;
  // In vent's work thread: "busy fix" is idle and waits on its working subagent "busy walk"; "quiet fix" is idle with nothing under it at work.
  const thread = host.threadsById.get(ids.vent)!;
  const busy = host.addChild(thread, 1, "busy fix", now, "idle");
  host.addChild(thread, busy.id, "busy walk", now, "running");
  const quiet = host.addChild(thread, 1, "quiet fix", now, "idle");
  host.addChild(thread, quiet.id, "quiet walk", now, "idle");
  // "waiting fix" is idle, and its idle subagent "waiting walk" sleeps on a check wake until its netem walk ends, as p155-fix did on 11-21.
  const waiting = host.addChild(thread, 1, "waiting fix", now, "idle");
  const waitingWalk = host.addChild(thread, waiting.id, "waiting walk", now, "idle");
  armWake(s.app.boards.wakeDir, ids.vent, { conversation: waitingWalk.id, on: { kind: "time", at: now + 10 * HOUR }, note: "walk done" });
  // pi-host bumps a thread's updatedAt when its tree changes, and the chat server reads the tree again only then.
  thread.row.updatedAt = now + 1;
  // The board goes in before the read: the read's events start the sidebar's timer, which reads and keeps each chat's board.
  const at = new Date().toISOString();
  await host.docPut(ids.vent, BOARD_DOC, { v: 2, rev: 1, updatedAt: at, todos: [], plan: [
    { id: "p1", text: "Fix up", status: "doing", duty: "d1/up", job: "busy fix", children: [] },
    { id: "p2", text: "Fix down", status: "doing", duty: "d1/down", job: "quiet fix", children: [] },
    { id: "p3", text: "Fix side", status: "doing", duty: "d1/side", job: "waiting fix", children: [] },
  ] });
  await s.app.threads.refresh();
  host.beforeSubmit = async (_id, input) => {
    if (input.requestId?.startsWith("duty:")) briefs.push(input.text ?? "");
  };
  const metric = (key: string, headline: boolean) => ({ key, label: key, op: ">=" as const, target: 99, headline });
  const duty = { id: "d1", name: "Snappy", ownerWords: "keep it snappy", goal: "it stays snappy", metrics: [metric("up", true), metric("down", false), metric("side", false)],
    schedule: { kind: "daily", at: "07:04" }, onMiss: "fix it", status: "active", createdAt: now - 10 * 24 * HOUR, updatedAt: now, lastRunAt: now - HOUR, runCount: 1,
    precheck: { command: ["node", "-e", `require("fs").writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { up: 90, down: 90, side: 90 } }))`], cwd: work, timeoutMs: 30_000 } };
  mkdirSync(s.app.boards.dir(agents.vent), { recursive: true });
  writeFileSync(join(s.app.boards.dir(agents.vent), "duties.json"), JSON.stringify({ duties: [duty], runs: {} }));
});
after(async () => {
  await s.close();
  rmSync(work, { recursive: true, force: true });
});

test("an idle fix job with a working subagent or a pending wake under it reads as working in the duty brief", async () => {
  await s.send("POST", `/api/threads/${ids.vent}/duties`, { duty: "d1", action: "run" });
  const [run] = await until(() => Promise.resolve(runsOf()), runs => runs.length === 1 && !!runs[0]!.job);
  assert.deepEqual(run!.fixes, {
    up: { step: "p1", job: "busy fix", live: true }, down: { step: "p2", job: "quiet fix", live: false }, side: { step: "p3", job: "waiting fix", live: true },
  });
  assert.equal(briefs.length, 1);
  assert.match(briefs[0]!, /- up: missed 1 run in a row, fix step p1 \(job busy fix, working\)\./);
  assert.match(briefs[0]!, /- down: missed 1 run in a row, fix step p2 \(job quiet fix, not working\)\./);
  assert.match(briefs[0]!, /- side: missed 1 run in a row, fix step p3 \(job waiting fix, working\)\./);
});
