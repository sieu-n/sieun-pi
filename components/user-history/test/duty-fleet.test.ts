import assert from "node:assert/strict";
import { appendFile, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type DaemonSession, dutyFleet } from "../scripts/duties/duty-fleet.ts";
import type { DutyRunRecord } from "../src/shared/chat-duties.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

/**
 * A slice of the real duty data of 10-15 08:41Z: four chats' duty files and their last 12 runs per duty, their check-in settings (Search
 * visits paused its check-in) and chats.json. Hand count: 14 active duties, 4 green (two check-ins, Reviewers get trials, Slack green emails),
 * and 7 that missed 3 or more measured runs in a row with no fix step.
 */
const FIXTURE = join(import.meta.dirname, "fixtures", "duty-fleet-1015");
const NOW = Date.parse("2026-10-15T08:45:00Z");
const SLACK = "01a11b0b-7c15-73da-9481-8de15903eab4";
const SEO = "01a11a24-a46e-77ff-adf7-671d01d462e2";
const CRAWLER = "01a115e2-9544-7204-b8db-8ce4d5319048";
const FRONTEND = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";
const chat = (id: string, name: string): DaemonSession => ({ sessionId: id, sessionName: name, lifecycle: "live", activity: "idle", lastActivityAt: new Date(NOW).toISOString() });
const SESSIONS: DaemonSession[] = [chat(SLACK, "slack green guy"), chat(SEO, "seo guy"), chat(CRAWLER, "Crawler VP"), chat(FRONTEND, "frontend bro")];
const step = (id: string, extra: Partial<PlanItem> & { duty?: string }): PlanItem => ({ id, text: `Fix ${id}`, status: "doing", children: [], ...extra });

async function copy(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "duty-fleet-"));
  await cp(FIXTURE, dir, { recursive: true });
  return dir;
}
const stuckOf = (fleet: Awaited<ReturnType<typeof dutyFleet>>) => fleet.duties.filter(duty => duty.stuck).map(duty => `${duty.chat.slice(0, 8)}/${duty.duty}`);

test("duty fleet: the green share and the stuck duties of the real slice match the hand count", async () => {
  const fleet = await dutyFleet({ dataDir: FIXTURE, now: NOW, sessions: () => SESSIONS });
  assert.equal(fleet.duties.length, 14, "the paused check-in of the SEO chat is left out");
  assert.deepEqual(fleet.duties.filter(duty => duty.green).map(duty => `${duty.chat.slice(0, 8)}/${duty.duty}`), ["01a11b0b/checkin", "01a11b0b/d2", "01a11b0b/d3", "01a11ba8/checkin"]);
  assert.deepEqual(fleet.metrics, { duties_green_pct: 28.5, stuck_duties: 7 });
  assert.deepEqual(stuckOf(fleet), ["01a11b0b/d1", "01a11a24/d1", "01a115e2/d1", "01a115e2/d2", "01a115e2/d3", "01a11ba8/d1", "01a11ba8/d2"]);
  assert.ok(!fleet.duties.find(duty => duty.chat === SEO && duty.duty === "d2")!.stuck, "2 misses in a row is under CHANGE_APPROACH_MISSES");
  assert.equal(fleet.flagged.length, 7);
  assert.deepEqual(fleet.flagged.find(slice => slice.chat === CRAWLER && slice.item === "d2"),
    { chat: CRAWLER, kind: "stuck_duty", item: "d2", excerpt: "Crawler VP: GeoNode proxy use missed 4 runs, job_success_pct_worst_lane 3.4 against at least 99, no live fix job" });
});

test("duty fleet: a duty with a live linked fix step is not stuck, one whose fix job is idle is", async () => {
  const dir = await copy();
  await mkdir(join(dir, "boards"), { recursive: true });
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: new Date(NOW).toISOString(), todos: [], plan: [step("p1", { text: "Crawler", children: [
    step("p2", { job: "reads fix", duty: "d1/ig_reads_per_s" }),
    step("p3", { job: "proxy fix", duty: "d2/geonode_mbps_avg" }),
    step("p4", { job: "limits fix", duty: "d3/no_such_metric" })] })] };
  await writeFile(join(dir, "boards", `${CRAWLER}.json`), JSON.stringify(board));
  const job = (session: string, name: string, activity: string, ago: number): DaemonSession => ({ sessionId: session, sessionName: name, parentSessionId: CRAWLER,
    rlmChildId: `sub-${session}`, lifecycle: "live", activity, lastActivityAt: new Date(NOW - ago).toISOString() });
  const sessions = [...SESSIONS, job("s-reads", "reads fix", "working", 60_000), job("s-proxy", "proxy fix", "idle", 3 * 60 * 60_000), job("s-limits", "limits fix", "working", 60_000)];
  const fleet = await dutyFleet({ dataDir: dir, now: NOW, sessions: () => sessions });
  const crawler = fleet.duties.filter(duty => duty.chat === CRAWLER);
  assert.equal(crawler.find(duty => duty.duty === "d1")!.fix, "p2");
  assert.deepEqual(crawler.filter(duty => duty.stuck).map(duty => duty.duty), ["d2", "d3"], "an idle fix job is no fix, and a link to a metric that did not miss is none either");
  assert.equal(fleet.metrics.stuck_duties, 6);
});

test("duty fleet: a live fix the run recorded keeps a duty off the stuck list", async () => {
  const dir = await copy();
  const file = join(dir, "duties", `${FRONTEND}.runs.jsonl`);
  const runs = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line) as DutyRunRecord);
  const newest = runs.filter(run => run.duty === "d2").at(-1)!;
  const missed = Object.entries(newest.metrics).find(([, result]) => !result.met)![0];
  await appendFile(file, JSON.stringify({ ...newest, at: NOW - 60_000, fixes: { [missed]: { step: "p40", job: "staging fix", live: true } } }) + "\n");
  const fleet = await dutyFleet({ dataDir: dir, now: NOW, sessions: () => SESSIONS });
  const duty = fleet.duties.find(entry => entry.chat === FRONTEND && entry.duty === "d2")!;
  assert.deepEqual([duty.stuck, duty.fix, duty.misses], [false, "p40", 4]);
});

test("duty fleet: a duty whose own run job is still at work is not stuck, and is once that job ended (ops guy check-in, 10-15 16:29Z)", async () => {
  const dir = await copy();
  const file = join(dir, "duties", `${FRONTEND}.runs.jsonl`);
  const runs = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line) as DutyRunRecord);
  const newest = runs.filter(run => run.duty === "d2").at(-1)!;
  const job = { id: "01a14053-87bc-7357-99c7-c0c95bd2641c", name: "apps reach staging frontend bro 01:08" };
  await appendFile(file, JSON.stringify({ ...newest, at: NOW - 60_000, job }) + "\n");
  const session = (activity: string): DaemonSession => ({ sessionId: job.id, sessionName: job.name, lifecycle: "live", activity, lastActivityAt: new Date(NOW).toISOString() });
  const read = async (activity: string) => (await dutyFleet({ dataDir: dir, now: NOW, sessions: () => [...SESSIONS, session(activity)] })).duties.find(entry => entry.chat === FRONTEND && entry.duty === "d2")!;
  const busy = await read("working");
  assert.deepEqual([busy.stuck, busy.working], [false, job.name]);
  const ended = await read("idle");
  assert.deepEqual([ended.stuck, ended.working], [true, undefined]);
});

test("duty fleet: a run whose after-measure is met counts green and ends the streak", async () => {
  const dir = await copy();
  const file = join(dir, "duties", `${SLACK}.runs.jsonl`);
  const runs = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line) as DutyRunRecord);
  const newest = runs.filter(run => run.duty === "d1").at(-1)!;
  const met = Object.fromEntries(Object.entries(newest.metrics).map(([key, result]) => [key, { ...result, value: result.target, met: true }]));
  await appendFile(file, JSON.stringify({ ...newest, at: NOW - 60_000, after: { at: NOW - 30_000, verdict: "met", metrics: met, summary: "all on target" } }) + "\n");
  const fleet = await dutyFleet({ dataDir: dir, now: NOW, sessions: () => SESSIONS });
  const duty = fleet.duties.find(entry => entry.chat === SLACK && entry.duty === "d1")!;
  assert.deepEqual([duty.green, duty.stuck, duty.misses], [true, false, 0]);
  assert.deepEqual(fleet.metrics, { duties_green_pct: 35.7, stuck_duties: 6 });
});

test("duty fleet: the daemon is not asked when no duty is red long enough", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-fleet-empty-"));
  await writeFile(join(dir, "chats.json"), JSON.stringify({ ids: ["c1"] }));
  const fleet = await dutyFleet({ dataDir: dir, now: NOW, sessions: () => { throw new Error("no daemon"); } });
  assert.deepEqual(fleet.metrics, { duties_green_pct: 100, stuck_duties: 0 }, "a chat's check-in with no measured run is pending, outside the share");
  assert.deepEqual(fleet.duties.map(duty => [duty.duty, duty.pending]), [["checkin", true]]);
});

test("duty fleet: a fix job that sleeps on a board.wake is live though the daemon no longer lists it, as the server reads it (SEO d1, 10-15 23:55 KST)", async () => {
  const dir = await copy();
  await mkdir(join(dir, "boards"), { recursive: true });
  await mkdir(join(dir, "wakes"), { recursive: true });
  const root = "01a13fd8-608f-7509-b85b-efe3cfe6b63e";
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: new Date(NOW).toISOString(), todos: [], plan: [step("p56", { text: "SEO duties green", children: [
    step("p61", { job: "fix search visits grow SEO guy 22:53", sessionId: root, duty: "d1/goal_visits_d7" })] })] };
  await writeFile(join(dir, "boards", `${SEO}.json`), JSON.stringify(board));
  // `prime-agent sessions --json` lists the loaded sessions only (128 of the catalog's 2,480 rows at 14:57Z), and the job had unloaded asleep.
  const sessions = SESSIONS;
  const before = await dutyFleet({ dataDir: dir, now: NOW, sessions: () => sessions });
  assert.ok(before.duties.find(duty => duty.chat === SEO && duty.duty === "d1")!.stuck, "an idle root job with no wake is no fix");
  await writeFile(join(dir, "wakes", ".ticked"), new Date(NOW - 10_000).toISOString());
  await writeFile(join(dir, "wakes", `${root}-time-${NOW / 1000 + 3600}.json`), JSON.stringify({ session: root, on: { kind: "time", at: NOW + 3_600_000 }, note: "remeasure", since: NOW - 60_000 }));
  const after = await dutyFleet({ dataDir: dir, now: NOW, sessions: () => sessions });
  const seo = after.duties.find(duty => duty.chat === SEO && duty.duty === "d1")!;
  assert.deepEqual([seo.stuck, seo.fix], [false, "p61"]);
  assert.equal(after.metrics.stuck_duties, before.metrics.stuck_duties - 1);
});

test("duty fleet: a red duty's fix is the open step at work on its lead metric, never a done one (AI harness d7, 10-18 00:46Z)", async () => {
  // The real slice: d7's last 4 measured runs, its duty, and the board's three d7 steps. The newest run recorded clean_min_30's fix as p528,
  // done since 00:09Z, and stuck_steps_all's as p529 with a live job; p559 "clean minutes 10-18 09:41" took clean_min_30 after that run.
  const fixture = join(import.meta.dirname, "fixtures", "duty-fleet-1018");
  const harness = "01a1164b-4a2d-742d-b27a-82f086ed0200";
  const now = Date.parse("2026-10-18T00:46:00Z");
  const root = (id: string, name: string, activity: string): DaemonSession => ({ sessionId: id, sessionName: name, lifecycle: "live", activity, lastActivityAt: new Date(now - 60_000).toISOString() });
  const read = async (clean: string) => (await dutyFleet({ dataDir: fixture, now, sessions: () => [root(harness, "AI harness developer environment VP", "idle"),
    root("01a14c52-3069-70e5-b828-b110eb04603d", "checkin pushes goals", "working"), root("01a14c77-0eca-7383-8f3e-2f37e7c22f80", "clean minutes 10-18 09:41", clean)] }))
    .duties.find(duty => duty.chat === harness && duty.duty === "d7")!;
  const working = await read("working");
  assert.deepEqual([working.stuck, working.fix, working.metric?.key, working.metric?.fix], [false, "p559", "clean_min_30", { step: "p559", job: "clean minutes 10-18 09:41", live: true }]);
  const ended = await read("idle");
  assert.deepEqual([ended.stuck, ended.fix, ended.metric?.fix], [false, "p529", undefined], "with p559's job ended the live fix of another missed metric holds, and done p528 is no fix");
});

test("duty fleet: archived and clean-room chats are not the owner's, and a duty with no measured run is pending, outside the share (10-18 01:00Z)", async () => {
  const dir = await copy();
  const before = await dutyFleet({ dataDir: dir, now: NOW, sessions: () => SESSIONS });
  // "skill references" was archived by its teardown and "LinkedIn index gaps" is a clean-room chat; here Slack and SEO play them.
  await writeFile(join(dir, "clean-room-chats.json"), JSON.stringify({ ids: [SLACK] }));
  await writeFile(join(dir, "archived-chats.json"), JSON.stringify({ ids: [SEO] }));
  const file = join(dir, "duties", `${FRONTEND}.json`);
  const duties = JSON.parse(await readFile(file, "utf8")) as { duties: { id: string; name: string }[] };
  duties.duties.push({ ...duties.duties[0]!, id: "d9", name: "A duty added a minute ago" });
  await writeFile(file, JSON.stringify(duties));
  const fleet = await dutyFleet({ dataDir: dir, now: NOW, sessions: () => SESSIONS });
  assert.ok(!fleet.duties.some(duty => duty.chat === SLACK || duty.chat === SEO));
  const added = fleet.duties.find(duty => duty.chat === FRONTEND && duty.duty === "d9")!;
  assert.deepEqual([added.pending, added.green, added.stuck], [true, false, false]);
  const judged = fleet.duties.filter(duty => !duty.pending);
  assert.equal(fleet.metrics.duties_green_pct, Math.floor(1000 * judged.filter(duty => duty.green).length / judged.length) / 10);
  assert.notEqual(fleet.metrics.duties_green_pct, before.metrics.duties_green_pct);
});
