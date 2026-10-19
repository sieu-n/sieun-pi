// Replays cut duty runs from 10-19. Every check-in of "Twitch gaps" (01a151ca) from 02:33Z to 05:34Z got pi-pool's "this session waits for its
// slot" as its job's first reply: check-in 01a1521d got its task at 03:04:04Z, failed 80 ms later with its slot at 03:42Z, the idle unload
// stopped it at 03:06:30Z, and the runner logged "after its job, missed" at 03:07:00Z. The wiki dream duty d4 of chat 01a1164b had the same
// cut at 11:19:50Z (job 01a153e3-7133, slot 11:49:30Z).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dutyJobHost } from "../src/chat-duty-job.ts";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { dailySlot, type Duty, type DutyRunRecord } from "../src/shared/chat-duties.ts";
import type { CheckInView, SessionRow } from "../src/shared/types.ts";

const TWITCH = "01a151ca-2bab-71ee-a334-bfae1773e0a0";
const HARNESS = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const MIN = 60_000;
const slotError = (slot: string, minutes: number) => `Failed to resolve API key for provider "anthropic" from shell command: /home/sieun/.config/pi-pool/bin/pi-pool-token ` +
  `pi-pool: this session waits for its slot at ${slot}. Try again in ${minutes} minutes.`;
const CHECK_IN_MISS = { goal_gaps: { value: 1, target: 0, op: "<=" as const, met: false }, stuck_steps: { value: 0, target: 0, op: "<=" as const, met: true },
  no_done_line: { value: 0, target: 0, op: "<=" as const, met: true }, plan_risks: { value: 0, target: 0, op: "<=" as const, met: true } };

function transcript(id: string, briefAt: string, failedAt: string, error: string, unloadedAt: string): string {
  return [
    { type: "session", version: 3, id, timestamp: briefAt, cwd: "/home/sieun/Documents/Github/auto-sns-agent" },
    { type: "custom_message", customType: "harness_digest", timestamp: briefAt, content: "[harness-digest]" },
    { type: "message", timestamp: briefAt, message: { role: "user", content: [{ type: "text", text: "# the duty brief" }] } },
    { type: "custom", customType: "chat_correction_checkpoint", timestamp: briefAt },
    { type: "message", timestamp: failedAt, message: { role: "assistant", content: [{ type: "text", text: "" }], api: "anthropic-messages", provider: "anthropic",
      model: "claude-opus-5-5", stopReason: "error", errorMessage: error } },
    { type: "session_state", timestamp: unloadedAt, state: { status: "archived" } },
    { type: "session_state", timestamp: unloadedAt, state: { status: "active" } },
  ].map(line => JSON.stringify(line)).join("\n") + "\n";
}

function jobHostOverRows(dir: string) {
  const rows = new Map<string, SessionRow>();
  const row = (id: string, name: string): SessionRow => ({ id, name, cwd: dir, kind: "root", status: "idle", archived: false, messageCount: 2, working: false,
    subagentsRunning: 0, unread: false, tags: [], priority: 0 } as unknown as SessionRow);
  const created: string[] = [];
  for (const [id, name] of [[TWITCH, "Twitch gaps"], [HARNESS, "AI harness developer environment"]] as const) rows.set(id, row(id, name));
  const jobs = dutyJobHost({
    threads: { create: async ({ name }) => { const id = `rerun-job-${created.length + 1}`; created.push(name); rows.set(id, { ...row(id, name), working: true }); return { id }; },
      prompt: async () => {} },
    archives: { add: async job => { const found = rows.get(job.id); if (found) found.archived = true; } },
    rows: async () => [...rows.values()],
    registry: { add: async () => {}, chatOf: async () => undefined, chatIdOf: async () => undefined, rootsOf: async () => [], remove: async () => {} },
    board: id => join(dir, "boards", `${id}.json`),
    sessionFile: async id => { const file = join(dir, "sessions", `${id}.jsonl`); return existsSync(file) ? file : null; },
  });
  const addJob = async (id: string, name: string, lines: string) => {
    rows.set(id, row(id, name));
    await mkdir(join(dir, "sessions"), { recursive: true });
    await writeFile(join(dir, "sessions", `${id}.jsonl`), lines);
  };
  return { jobs, rows, created, addJob };
}

function checkInDuties(dir: string, store: DutyStore, clock: { now: number }, slots: Record<string, number>) {
  const { jobs, rows, created, addJob } = jobHostOverRows(dir);
  const logs: string[] = [];
  const reruns: [string, string | undefined, number | undefined][] = [];
  const asked: string[] = [];
  let measures = 0;
  const host = {
    isChat: async () => true, now: () => clock.now, tickMs: 0, log: (line: string) => { logs.push(line); }, jobs,
    checkIn: { view: async () => ({ everyMs: 30 * MIN, paused: false }) as CheckInView, set: async () => null,
      run: async (chat: string, trigger?: DutyRunRecord["trigger"], rerunOf?: number) => { reruns.push([chat, trigger, rerunOf]); },
      measure: async () => { measures++; return { metrics: { goal_gaps: 1, stuck_steps: 0, no_done_line: 0, plan_risks: 0 }, flagged: [] }; } },
    poolAdmits: async (tree: string, provider: string) => { asked.push(`${tree} ${provider}`); return clock.now >= (slots[tree] ?? 0); },
  };
  return { duties: new Duties(store, host), rows, created, addJob, logs, reruns, asked, measures: () => measures };
}

test("check-in 01a1521d, cut by a pool wait at its first reply, records the cut instead of a measure and reruns once pi-pool admits its tree (Twitch gaps 10-19 03:04Z)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-cut-checkin-"));
  try {
    const store = new DutyStore(dir);
    await store.updateFile(TWITCH, file => { file.checkIn = { createdAt: Date.parse("2026-10-19T01:00:00Z"), runCount: 3 }; });
    const job = { id: "01a1521d-aa86-71cd-a00a-642777f60259", name: "check-in Twitch gaps 12:03" };
    const at = 1792379036725;
    await store.appendRun(TWITCH, { duty: "checkin", at, slot: at, trigger: "schedule", ms: 8000, verdict: "missed", metrics: CHECK_IN_MISS, summary: "goal_gaps 1 (target at most 0)", job });
    const error = slotError("2026-10-19T03:42:00.000Z", 38);
    const clock = { now: Date.parse("2026-10-19T03:07:00.809Z") };
    const run = checkInDuties(dir, store, clock, { [job.id]: Date.parse("2026-10-19T03:42:00.000Z") });
    await run.addJob(job.id, job.name, transcript(job.id, "2026-10-19T03:04:04.015Z", "2026-10-19T03:04:04.082Z", error, "2026-10-19T03:06:30.178Z"));

    await run.duties.tick();
    const [cut] = await store.runs(TWITCH);
    assert.deepEqual(cut!.cut, { error, at: Date.parse("2026-10-19T03:04:04.082Z"), provider: "anthropic", slotAt: Date.parse("2026-10-19T03:42:00.000Z") },
      "the run whose job got only a pool wait is recorded as cut");
    assert.equal(cut!.after, undefined, "a cut run gets no after-job measure");
    assert.equal(run.measures(), 0);
    assert.deepEqual(run.logs.filter(line => line.includes("after its job")), []);
    assert.ok(run.logs.some(line => line.startsWith("duty 01a151ca/checkin: cut, its job check-in Twitch gaps 12:03 ended on a failed model call at 2026-10-19T03:04:04.082Z, pi-pool slot 2026-10-19T03:42:00.000Z")),
      run.logs.join("\n"));
    assert.equal(run.rows.get(job.id)!.archived, true, "the cut job is archived as an ended job is");
    await run.duties.tick();
    assert.deepEqual(run.reruns, [], "no rerun before pi-pool admits the tree");
    assert.deepEqual(run.asked, [`${job.id} anthropic`]);

    clock.now = Date.parse("2026-10-19T03:42:10.000Z");
    await run.duties.tick();
    assert.deepEqual(run.reruns, [[TWITCH, "rerun", at]], "the cut run reruns at the first tick pi-pool admits its tree");
    await run.duties.tick();
    assert.deepEqual(run.reruns, [[TWITCH, "rerun", at]], "one rerun per cut run");

    await run.duties.checkIn(TWITCH, { at: clock.now, trigger: "rerun", rerunOf: at, everyMs: 30 * MIN, output: { metrics: { goal_gaps: 1, stuck_steps: 0, no_done_line: 0, plan_risks: 0 }, flagged: [] },
      classes: {}, findings: "" });
    const [rerun] = await store.runs(TWITCH);
    assert.equal(rerun!.trigger, "rerun");
    assert.equal(rerun!.rerunOf, at, "the rerun names the cut run");
    assert.equal(rerun!.job?.id, "rerun-job-1");
    run.duties.close();

    const restarted = checkInDuties(dir, store, clock, {});
    await restarted.duties.tick();
    assert.deepEqual(restarted.reruns, [], "after a restart the rerun link in the runs file keeps the cut run from a second rerun");
    restarted.duties.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a cut check-in whose next check-in started first gets no rerun, and that next one reruns at its own slot (Twitch gaps 10-19 03:34Z)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-cut-newer-"));
  try {
    const store = new DutyStore(dir);
    await store.updateFile(TWITCH, file => { file.checkIn = { createdAt: Date.parse("2026-10-19T01:00:00Z"), runCount: 3 }; });
    const first = { id: "01a1521d-aa86-71cd-a00a-642777f60259", name: "check-in Twitch gaps 12:03" };
    const next = { id: "01a15239-82a8-77f1-abee-efda6a6d9be3", name: "check-in Twitch gaps 12:34" };
    const firstAt = 1792379036725;
    const nextAt = 1792380861735;
    const after = { verdict: "missed" as const, metrics: CHECK_IN_MISS, summary: "goal_gaps 1 (target at most 0)" };
    await store.appendRun(TWITCH, { duty: "checkin", at: firstAt, slot: firstAt, trigger: "schedule", ms: 8000, ...after, job: first, after: { at: 1792379220809, ...after } });
    await store.appendRun(TWITCH, { duty: "checkin", at: nextAt, slot: nextAt, trigger: "schedule", ms: 8000, ...after, job: next, after: { at: 1792381130807, ...after } });
    const clock = { now: Date.parse("2026-10-19T03:42:10.000Z") };
    const run = checkInDuties(dir, store, clock, { [first.id]: Date.parse("2026-10-19T03:42:00.000Z"), [next.id]: Date.parse("2026-10-19T05:31:57.000Z") });
    await run.addJob(first.id, first.name, transcript(first.id, "2026-10-19T03:04:04.015Z", "2026-10-19T03:04:04.082Z", slotError("2026-10-19T03:42:00.000Z", 38), "2026-10-19T03:06:30.178Z"));
    await run.addJob(next.id, next.name, transcript(next.id, "2026-10-19T03:34:29.950Z", "2026-10-19T03:34:30.014Z", slotError("2026-10-19T05:31:57.000Z", 117), "2026-10-19T03:38:51.000Z"));
    for (const id of [first.id, next.id]) run.rows.get(id)!.archived = true;

    await run.duties.tick();
    assert.deepEqual(run.reruns, [], "03:04's run has a newer run with a job, and 03:34's slot is still ahead");
    const runs = await store.runs(TWITCH);
    assert.equal(runs.find(entry => entry.at === nextAt)!.cut?.slotAt, Date.parse("2026-10-19T05:31:57.000Z"), "a run the old code measured after its cut job is recorded as cut");
    assert.equal(runs.find(entry => entry.at === firstAt)!.cut, undefined, "only each duty's newest started run is read");

    clock.now = Date.parse("2026-10-19T05:32:00.000Z");
    await run.duties.tick();
    assert.deepEqual(run.reruns, [[TWITCH, "rerun", nextAt]]);
    run.duties.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a wiki dream job cut by a pool wait at its first reply reruns as its own run once pi-pool admits its tree (d4 of 01a1164b, 10-19 11:19Z)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-cut-d4-"));
  try {
    const count = join(dir, "prechecks");
    const precheck = join(dir, "precheck.mjs");
    await writeFile(precheck, `import { appendFileSync, writeFileSync } from "node:fs";
appendFileSync(${JSON.stringify(count)}, "x");
writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { wiki_problems: 46 } }));`);
    const store = new DutyStore(dir);
    const now = Date.parse("2026-10-19T11:24:41.198Z");
    const lastSlotAt = dailySlot("01:30", now);
    const duty: Duty = { id: "d4", name: "Wiki dream", ownerWords: "keep the wiki healthy", goal: "no wiki problems",
      metrics: [{ key: "wiki_problems", label: "Wiki problems", op: "<=", target: 0, headline: true }], schedule: { kind: "daily", at: "01:30" },
      precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 }, onMiss: "fix the wiki", status: "active", createdAt: now - 7 * 24 * 60 * MIN,
      updatedAt: now - 7 * 24 * 60 * MIN, runCount: 65, lastSlotAt, lastRunAt: lastSlotAt };
    await store.update(HARNESS, duties => { duties.push(duty); });
    const job = { id: "01a153e3-7133-747b-b1ae-1c4fdbf4fe62", name: "wiki dream AI harness developer environment 20:19" };
    const at = 1792408752057;
    await store.appendRun(HARNESS, { duty: "d4", at, slot: 1792408751960, trigger: "push", ms: 37_000, verdict: "missed",
      metrics: { wiki_problems: { value: 46, target: 0, op: "<=", met: false } }, summary: "wiki_problems 46 (target at most 0)", job });
    const clock = { now };
    const { jobs, rows, created, addJob } = jobHostOverRows(dir);
    await addJob(job.id, job.name, transcript(job.id, "2026-10-19T11:19:49.913Z", "2026-10-19T11:19:50.131Z", slotError("2026-10-19T11:49:30.000Z", 30), "2026-10-19T11:24:09.286Z"));
    const logs: string[] = [];
    const duties = new Duties(store, { isChat: async () => true, now: () => clock.now, tickMs: 0, node: process.execPath, log: line => { logs.push(line); }, jobs,
      checkIn: { view: async () => ({ everyMs: 120 * MIN, paused: false }) as CheckInView, set: async () => null, run: async () => {} },
      poolAdmits: async () => clock.now >= Date.parse("2026-10-19T11:49:30.000Z") });

    await duties.tick();
    await duties.settled();
    const [cut] = await store.runs(HARNESS);
    assert.equal(cut!.cut?.slotAt, Date.parse("2026-10-19T11:49:30.000Z"), "the d4 run is recorded as cut");
    assert.equal(cut!.after, undefined);
    assert.equal(existsSync(count), false, "a cut run is not measured after its job");
    assert.deepEqual(logs.filter(line => line.includes("after its job")), []);
    assert.equal(rows.get(job.id)!.archived, true);

    clock.now = Date.parse("2026-10-19T11:49:31.000Z");
    await duties.tick();
    await duties.settled();
    const [rerun, before] = await store.runs(HARNESS);
    assert.equal(before!.at, at);
    assert.equal(rerun!.trigger, "rerun");
    assert.equal(rerun!.rerunOf, at);
    assert.equal(rerun!.verdict, "missed");
    assert.equal(rerun!.job?.id, "rerun-job-1", "the rerun starts its own job");
    assert.deepEqual(created.map(name => name.startsWith("wiki dream AI harness developer environment ")), [true]);
    assert.equal((await readFile(count, "utf8")).length, 1, "the rerun measures once");
    assert.equal((await store.list(HARNESS))[0]!.lastRunAt, lastSlotAt, "a rerun leaves the schedule alone");

    await duties.tick();
    await duties.settled();
    assert.equal((await store.runs(HARNESS)).length, 2, "one rerun per cut run");
    duties.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a rerun whose own job is cut is recorded as cut and not rerun again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-cut-rerun-cut-"));
  try {
    const store = new DutyStore(dir);
    await store.updateFile(TWITCH, file => { file.checkIn = { createdAt: Date.parse("2026-10-19T01:00:00Z"), runCount: 4 }; });
    const first = { id: "01a1521d-aa86-71cd-a00a-642777f60259", name: "check-in Twitch gaps 12:03" };
    const second = { id: "01a15250-0000-7000-8000-000000000001", name: "check-in Twitch gaps 12:42" };
    const firstAt = 1792379036725;
    const secondAt = Date.parse("2026-10-19T03:42:10.000Z");
    const miss = { verdict: "missed" as const, metrics: CHECK_IN_MISS, summary: "goal_gaps 1 (target at most 0)" };
    await store.appendRun(TWITCH, { duty: "checkin", at: firstAt, slot: firstAt, trigger: "schedule", ms: 8000, ...miss, job: first,
      cut: { error: slotError("2026-10-19T03:42:00.000Z", 38), at: Date.parse("2026-10-19T03:04:04.082Z"), provider: "anthropic", slotAt: Date.parse("2026-10-19T03:42:00.000Z") } });
    await store.appendRun(TWITCH, { duty: "checkin", at: secondAt, slot: secondAt, trigger: "rerun", rerunOf: firstAt, ms: 8000, ...miss, job: second });
    const clock = { now: Date.parse("2026-10-19T04:20:00.000Z") };
    const run = checkInDuties(dir, store, clock, {});
    await run.addJob(first.id, first.name, transcript(first.id, "2026-10-19T03:04:04.015Z", "2026-10-19T03:04:04.082Z", slotError("2026-10-19T03:42:00.000Z", 38), "2026-10-19T03:06:30.178Z"));
    run.rows.get(first.id)!.archived = true;
    await run.addJob(second.id, second.name, transcript(second.id, "2026-10-19T03:42:12.000Z", "2026-10-19T03:42:12.100Z", slotError("2026-10-19T04:10:00.000Z", 28), "2026-10-19T03:45:00.000Z"));

    await run.duties.tick();
    const [rerun] = await store.runs(TWITCH);
    assert.equal(rerun!.cut?.slotAt, Date.parse("2026-10-19T04:10:00.000Z"), "the rerun's own cut is recorded");
    assert.ok(run.logs.some(line => line.includes("cut, its job check-in Twitch gaps 12:42") && line.endsWith("a rerun is not run again")), run.logs.join("\n"));
    await run.duties.tick();
    assert.deepEqual(run.reruns, [], "neither the cut rerun nor the cut run it reran runs again");
    run.duties.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
