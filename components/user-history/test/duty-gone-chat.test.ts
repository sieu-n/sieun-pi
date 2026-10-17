import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type DutyChat, type DutyJobHost } from "../src/chat-duty-job.ts";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { type DutyRef, goalsToFold, markUnmeasured } from "../src/checkin-findings.ts";
import type { DutyJobRef, DutyRunRecord } from "../src/shared/chat-duties.ts";
import type { ChatBoard } from "../src/shared/types.ts";

/**
 * The chat "TikTok listing drops" (01a143d5) on 10-17, as its check-in job 01a14b71 found it. Its goals_to_fold finding said to fold p1 into
 * the duty d1, whose only run was an error (d1.last-runs.json empty), while the job "tiktok drops reread and land" still built d1's precheck.
 * The chat was archived at about 19:58Z, a minute after that check-in job started, and the job kept working on it: job-steer answered 404
 * "This thread is not a chat", and it started a new job for the archived chat.
 */
const CHAT = "01a143d5-3709-737f-b8a4-54bcb895bd53";
const NOW = Date.parse("2026-10-17T19:59:00.000Z");
const MIN = 60_000;
const BOARD: ChatBoard = { v: 2, rev: 15, updatedAt: "2026-10-17T19:59:53.095Z", todos: [], plan: [
  { id: "p1", text: "Top 10 TikTok Shop listings that lost the most views this week", status: "todo",
    target: { metric: "listings measured", target: 10, unit: "of 10", current: 0, measuredAt: "2026-10-16T08:43:00.000Z", source: "scripts/duties/crawler/tiktok-shop-listings.mjs" },
    children: [
      { id: "p2", text: "Find which listings and which view numbers to use", status: "done", job: "tiktok shop view drops", sessionId: "01a143d7-2c14-74cc-b251-71b59e28ffdf", children: [] },
      { id: "p3", text: "Measure the 10 biggest drops and check each one", status: "doing", job: "tiktok drops reread and land", sessionId: "01a14b72-c977-76e8-b198-c8a5fabd5532", children: [] },
      { id: "p5", text: "Refresh the page every day", status: "doing", job: "tiktok drops reread and land", sessionId: "01a14b72-c977-76e8-b198-c8a5fabd5532", children: [] },
    ] },
] } as ChatBoard;
const D1: DutyRef = { id: "d1", name: "TikTok Shop listings", status: "active", boardGoal: "p1",
  goal: "The TikTok Shop listings page shows the 10 listings that lost the most product page video views this week against last week." };
const run = (duty: string, verdict: DutyRunRecord["verdict"]): Pick<DutyRunRecord, "duty" | "verdict"> => ({ duty, verdict });

test("TikTok listing drops 10-17: no goal folds into a duty with no met or missed run on record", () => {
  const folds = (runs: Pick<DutyRunRecord, "duty" | "verdict">[]) => goalsToFold(BOARD, [], new Set([CHAT]), markUnmeasured([D1], runs)).map(fold => `${fold.goal.id}>${fold.duty?.id}`);
  assert.deepEqual(folds([]), [], "d1 never ran");
  assert.deepEqual(folds([run("d1", "error"), run("d1", "skipped"), run("checkin", "missed")]), [], "d1's only runs are an error and a skip");
  assert.deepEqual(folds([run("d1", "missed")]), ["p1>d1"], "a measured miss is a run on record");
  assert.deepEqual(folds([run("d1", "met")]), ["p1>d1"]);
  assert.deepEqual(markUnmeasured([D1], [run("d1", "met")]), [D1], "a measured duty is passed through as it is");
});

function fakeJobs(working: ReadonlySet<string>) {
  const calls: string[] = [];
  const host: DutyJobHost = {
    async chat(chatId): Promise<DutyChat> { return { id: chatId, name: "chat", cwd: "/repo", board: `/boards/${chatId}.json` }; },
    async working(job) { calls.push(`working? ${job.id}`); return working.has(job.id); },
    async start(_chat, name): Promise<DutyJobRef> { calls.push(`start ${name}`); return { id: "new", name }; },
    async retire(job) { calls.push(`retire ${job.id}`); },
  };
  return { host, calls };
}

test("TikTok listing drops 10-17: a chat that left the chat list has its working duty jobs retired once, and no old run costs a daemon call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-gone-"));
  const store = new DutyStore(dir);
  await store.update(CHAT, () => undefined);
  const job = (id: string, name: string): DutyJobRef => ({ id, name });
  const record = (duty: string, at: number, ref: DutyJobRef): DutyRunRecord => ({ duty, at, slot: at, trigger: "schedule", ms: 100, verdict: "missed", metrics: {}, summary: "", job: ref });
  await store.appendRun(CHAT, record("checkin", NOW - 13 * 60 * MIN, job("old", "check-in TikTok listing drops 06:59")));
  await store.appendRun(CHAT, record("d1", NOW - 30 * MIN, job("ended", "tiktok shop listings TikTok listing drops 19:29")));
  await store.appendRun(CHAT, record("checkin", NOW - 40 * MIN, job("earlier", "check-in TikTok listing drops 19:19")));
  await store.appendRun(CHAT, record("checkin", NOW - 2 * MIN, job("01a14b71-2852-761c-bd31-0a6e2bdec488", "check-in TikTok listing drops 19:57")));
  const jobs = fakeJobs(new Set(["01a14b71-2852-761c-bd31-0a6e2bdec488", "earlier", "old"]));
  const lines: string[] = [];
  const duties = new Duties(store, { isChat: async () => false, jobs: jobs.host, now: () => NOW, tickMs: 0, log: line => lines.push(line) });
  await duties.tick();
  assert.deepEqual(jobs.calls, ["working? 01a14b71-2852-761c-bd31-0a6e2bdec488", "retire 01a14b71-2852-761c-bd31-0a6e2bdec488", "working? ended"],
    "each duty's newest job is checked; the check-in job at work is retired, the ended d1 job is left, and the 13 h old run is never read");
  assert.ok(lines.includes("duty job check-in TikTok listing drops 19:57: its chat left the chat list; retired it"), lines.join("\n"));
  await duties.tick();
  assert.deepEqual(jobs.calls.slice(3), ["working? ended"], "a retired job is not retired again");
});
