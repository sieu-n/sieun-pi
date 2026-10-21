// AI harness developer environment VP, check-in of 10-21 14:00Z (23:00 KST): its Jobs list called d9 residuals 10-21, digest cache integration,
// wiki behind code root cause and duties green push 10-18 "failed" on a 429, and stalled_steps flagged p773, p804, p818, p831, p850 and p795.
// Each sat in a provider quota park with an active quota-resume job in its scheduled-jobs.json (d9 residuals until 14:45:17Z, digest cache
// until 14:48:26Z), and from about 14:15Z duties green waited 62nd in pi-pool's queue. A job waiting for an account is moving, not failed.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkInPrecheck, checkInPrecheckText, convergenceMisses } from "../src/chat-checkin.ts";
import { parkFiles, quotaParks, readHeartbeats, withQuotaParks } from "../src/checkin-load.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import { withQueuePlaces } from "../src/chat-turn-queue.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const chat = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const d9 = "01a15d35-ad18-726c-8b7f-64ddb4dea411";
const digest = "01a15c17-f39c-7179-9f87-b1fdbacdb9f6";
const handoff = "01a153ef-8ff3-70e9-aae1-97df3eed1f47";
const greens = "01a14d72-63fa-776f-9d90-766b7ce76d30";
const now = Date.parse("2026-10-21T14:00:13.681Z");
const error = "Provider rate limit exceeded (rate_limit_error, 429): This request would exceed your account's rate limit. Please try again later.";
const resume = (session: string, id: string, createdAt: string, at: string, status = "active") => ({ id, status, source: "cron", runtimeKind: "top-level",
  sessionId: session, label: "quota-resume", schedule: { kind: "once", expression: `at ${at}` }, createdAt, updatedAt: createdAt, runCount: 0,
  ...status === "active" ? { nextRunAt: at } : {} });

const home = mkdtempSync(join(tmpdir(), "checkin-quota-park-"));
const schedules = (session: string, jobs: unknown[]) => {
  mkdirSync(join(home, ".prime", "agent", "session-artifacts", session), { recursive: true });
  writeFileSync(join(home, ".prime", "agent", "session-artifacts", session, "scheduled-jobs.json"), JSON.stringify({ jobs }));
};
schedules(d9, [resume(d9, "c0a9f299", "2026-10-21T11:40:29.246Z", "2026-10-21T13:21:47.043Z", "completed"),
  resume(d9, "5dd4428c", "2026-10-21T13:21:48.914Z", "2026-10-21T14:45:17.026Z")]);
schedules(digest, [resume(digest, "69d9045a", "2026-10-21T13:53:39.087Z", "2026-10-21T14:48:26.035Z")]);
schedules(greens, [resume(greens, "ad51d046", "2026-10-21T13:38:26.329Z", "2026-10-21T14:43:48.024Z")]);
// The detached handoff thread's last park was resumed at 12:21Z and its next turn failed again with nothing pending.
schedules(handoff, [resume(handoff, "e1", "2026-10-21T11:02:00.000Z", "2026-10-21T12:21:00.000Z", "completed")]);

const step = (id: string, text: string, job: string, sessionId: string, status: PlanItem["status"] = "doing"): PlanItem =>
  ({ id, text, status, job, sessionId, children: [] });
const board = { v: 2, rev: 1, updatedAt: "2026-10-21T07:00:00.000Z", todos: [], plan: [
  { id: "p624", text: "Every red duty in every chat gets its fix landed", status: "doing", children: [
    step("p773", "New open steps in every chat get a Done when line", "d9 residuals 10-21", d9, "todo"),
    step("p831", "Cache reads climb back above 94% and the skill checks pass", "digest cache integration", digest),
    step("p795", "Sort the duties red 15 runs or more by cause", "duties green push 10-18", greens),
    step("p823", "A Prime update attempt on us-metal02 does not refuse sessions", "detached handoff integration", handoff),
  ] },
] } as unknown as ChatBoard;
const thread = (id: string, name: string, item: PlanItem, activity: string): JobFact => ({ key: `thread:${id}`, name, state: "failed", error,
  activityAt: Date.parse(activity), item: { id: item.id, text: item.text, status: item.status } });
const items = board.plan[0]!.children;
const read: JobFact[] = [thread(d9, "d9 residuals 10-21", items[0]!, "2026-10-21T13:21:48.890Z"),
  thread(digest, "digest cache integration", items[1]!, "2026-10-21T13:53:38.900Z"),
  thread(greens, "duties green push 10-18", items[2]!, "2026-10-21T13:38:26.300Z"),
  thread(handoff, "detached handoff integration", items[3]!, "2026-10-21T12:21:30.000Z")];
const rows = read.map(fact => ({ id: fact.key.slice("thread:".length), name: fact.name, archived: false }));
const roots = rows.map(row => row.id);

const precheck = (facts: JobFact[], at = now) => checkInPrecheck(undefined, facts, board, at, { self: [chat, "AI harness developer environment VP"], rows });

test("a job in a quota park reads waiting for an account until its resume, and its steps leave stalled_steps", () => {
  const parks = quotaParks(parkFiles(chat, roots, home).flatMap(readHeartbeats), now);
  assert.deepEqual([...parks.keys()].sort(), [digest, d9, greens].sort());
  const facts = withQuotaParks(read, parks, () => undefined);
  const found = precheck(facts);
  assert.deepEqual(found.stalled.map(stall => stall.view.item.id), ["p823"], "only the failed job with no pending park stalls");
  const text = checkInPrecheckText(found, facts, [], now);
  const jobs = text.slice(text.indexOf("### Jobs"));
  assert.match(jobs, /d9 residuals 10-21 thread: waiting for an account until 10-21 \d\d:45,/);
  assert.match(jobs, /digest cache integration thread: waiting for an account until 10-21 \d\d:48,/);
  assert.doesNotMatch(jobs.split("\n").find(line => line.includes("d9 residuals"))!, /failed|429/);
  assert.match(jobs, /detached handoff integration thread: failed, .*error: Provider rate limit exceeded/);
  const { metrics } = convergenceMisses(chat, found.steps, found, {}, 60 * 60_000, now);
  assert.equal(metrics.stalled_steps, 1);
  assert.deepEqual(found.end.filter(entry => entry.state === "moving").map(entry => entry.reason).filter(reason => reason.includes("account")).length, 3);
});

test("a park whose resume time passed with nothing pending reads failed again", () => {
  const later = Date.parse("2026-10-21T14:50:00Z");
  const facts = withQuotaParks(read, quotaParks(parkFiles(chat, roots, home).flatMap(readHeartbeats), later), () => undefined);
  assert.deepEqual(facts.filter(fact => fact.state === "failed").map(fact => fact.name).sort(),
    ["d9 residuals 10-21", "digest cache integration", "detached handoff integration", "duties green push 10-18"].sort());
});

test("a job queued in pi-pool after its park resumed reads queued Nth for an account, and its step is not stalled", () => {
  const at = Date.parse("2026-10-21T14:20:00Z");
  const parks = quotaParks(parkFiles(chat, roots, home).flatMap(readHeartbeats), at);
  const queued = new Map([[greens, { position: 62, total: 114, since: Date.parse("2026-10-21T14:12:37Z") }]]);
  const facts = withQueuePlaces(withQuotaParks(read, parks, () => undefined), { queued, working: new Set() }, []);
  const greensFact = facts.find(fact => fact.name === "duties green push 10-18")!;
  assert.equal(greensFact.parkedUntil, undefined, "the queue place is newer than the park");
  const found = precheck(facts, at);
  assert.ok(!found.stalled.some(stall => stall.view.item.id === "p795"));
  const text = checkInPrecheckText(found, facts, [], at);
  assert.match(text, /duties green push 10-18 thread: queued 62nd of 114 for an account, in the queue for 7 min,/);
});
