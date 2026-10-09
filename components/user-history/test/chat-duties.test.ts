import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { dailySlot, dutyDue, dutyLine, errorStreak, judge, nextDutyId, nextRunAt, parseDutyInput, parseSchedule, repeatMisses, type Duty, type DutyRunRecord } from "../src/shared/chat-duties.ts";

const run = promisify(execFile);
const at = (day: number, hours: number, minutes = 0): number => new Date(2026, 9, day, hours, minutes).getTime();
const input = (command: string[] = ["node", "-e", "0"]) => ({
  name: "Chat health", ownerWords: "keep it healthy", goal: "Chats never sit stopped.", onMiss: "Start a job that reads the details and proposes fixes.", boardGoal: "p87",
  metrics: [{ key: "stalls_2h", label: "Stalls over 2 h", op: "<=", target: 0 }, { key: "long_replies", label: "Long replies", op: "<=", target: 10, unit: "%" }],
  schedule: { kind: "daily", at: "23:07" }, precheck: { command, cwd: tmpdir() },
});
const duty = (now: number, changes: Partial<Duty> = {}): Duty => ({ ...parseDutyInput(input(), "d1", now), ...changes });

test("dutyDue: a daily duty runs at its slot, catches up once within 6 h, skips a slot missed by more, and never runs a slot from before it existed", () => {
  const created = at(8, 17);
  assert.equal(dailySlot("23:07", at(8, 23, 10)), at(8, 23, 7));
  assert.equal(dailySlot("23:07", at(9, 1)), at(8, 23, 7));
  assert.deepEqual(dutyDue(duty(created), at(8, 23, 0)), { kind: "no" }, "yesterday's slot predates the duty");
  assert.deepEqual(dutyDue(duty(created), at(8, 23, 7)), { kind: "run", trigger: "schedule", slot: at(8, 23, 7) });
  assert.deepEqual(dutyDue(duty(created), at(9, 3)), { kind: "run", trigger: "catch-up", slot: at(8, 23, 7) });
  assert.deepEqual(dutyDue(duty(created), at(9, 6)), { kind: "skip", slot: at(8, 23, 7) });
  assert.deepEqual(dutyDue(duty(created, { lastSlotAt: at(8, 23, 7) }), at(9, 3)), { kind: "no" }, "a covered slot does not run again");
  assert.deepEqual(dutyDue(duty(created, { status: "paused" }), at(8, 23, 7)), { kind: "no" });
  assert.equal(nextRunAt(duty(created), at(8, 18)), at(8, 23, 7));
  assert.equal(nextRunAt(duty(created, { lastSlotAt: at(8, 23, 7) }), at(9, 1)), at(9, 23, 7));
  assert.equal(nextRunAt(duty(created, { status: "paused" }), at(8, 18)), null);
  const every = duty(created, { schedule: { kind: "every", minutes: 30 }, lastRunAt: at(8, 18) });
  assert.deepEqual(dutyDue(every, at(8, 18, 29)), { kind: "no" });
  assert.equal(dutyDue(every, at(8, 18, 30)).kind, "run");
  assert.equal(nextRunAt(every, at(8, 18, 10)), at(8, 18, 30));
});

test("judge: met when every metric is on target, missed names each miss with its target, error when a metric is absent", () => {
  const { metrics } = duty(0);
  assert.deepEqual(judge(metrics, { metrics: { stalls_2h: 0, long_replies: 8 } }).verdict, "met");
  const missed = judge(metrics, { metrics: { stalls_2h: 4, long_replies: 31.25 } });
  assert.equal(missed.verdict, "missed");
  assert.equal(missed.summary, "stalls_2h 4 (target at most 0), long_replies 31.3% (target at most 10%)");
  assert.deepEqual(missed.metrics.stalls_2h, { value: 4, target: 0, op: "<=", met: false });
  assert.deepEqual(judge(metrics, { metrics: { stalls_2h: 0 } }), { verdict: "error", metrics: {}, summary: "the precheck gave no value for long_replies" });
});

test("dutyLine: quiet on met, a miss names the fixes' board goal, a repeat miss and an error pause ask for one tell_owner", () => {
  const d = duty(0);
  const record = (verdict: DutyRunRecord["verdict"], metrics: DutyRunRecord["metrics"] = {}): DutyRunRecord => ({ duty: "d1", at: 1, trigger: "schedule", ms: 1, verdict, metrics, summary: "stalls_2h 4 (target at most 0)", detail: "/x.json", told: false });
  assert.equal(dutyLine(d, record("met"), [], false), null);
  const miss = record("missed", { stalls_2h: { value: 4, target: 0, op: "<=", met: false }, long_replies: { value: 1, target: 10, op: "<=", met: true } });
  assert.equal(dutyLine(d, miss, [], false), 'duty d1 "Chat health" missed: stalls_2h 4 (target at most 0). Details: /x.json. Start a job that reads the details and proposes fixes. File each fix as a step under p87.');
  assert.deepEqual(repeatMisses(miss, miss), ["stalls_2h"]);
  assert.deepEqual(repeatMisses(miss, record("met")), []);
  assert.match(dutyLine(d, miss, ["stalls_2h"], false)!, /stalls_2h missed two runs in a row: call tell_owner once\.$/);
  assert.match(dutyLine(d, { ...record("error"), error: "exit 1" }, [], true)!, /precheck failed: exit 1\. It failed 3 runs in a row and is paused/);
  assert.equal(errorStreak([record("error"), record("skipped"), record("error"), record("met"), record("error")]), 2);
});

test("parseDutyInput: refuses a bad schedule, metric or board goal; nextDutyId never reuses an id", () => {
  assert.throws(() => parseDutyInput({ ...input(), schedule: { kind: "daily", at: "25:00" } }, "d1", 0), /schedule/);
  assert.throws(() => parseDutyInput({ ...input(), metrics: [{ key: "Bad Key", label: "x", op: "<=", target: 0 }] }, "d1", 0), /metrics\[0\]/);
  assert.throws(() => parseDutyInput({ ...input(), boardGoal: "goal" }, "d1", 0), /boardGoal/);
  assert.equal(parseDutyInput({ ...input(), precheck: { command: ["x"], cwd: "/", timeoutMs: 999_999 } }, "d1", 0).precheck.timeoutMs, 120_000);
  assert.equal(nextDutyId([duty(0, { id: "d1" }), duty(0, { id: "d4" })]), "d5");
  assert.equal(nextDutyId([]), "d1");
});

const script = (body: string) => ["node", "-e", body];
const writeOutput = (metrics: Record<string, number>) => `require("fs").writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: ${JSON.stringify(metrics)}, flagged: [] }))`;

async function setup(command: string[], now: { at: number }) {
  const dir = await mkdtemp(join(tmpdir(), "duties-"));
  const store = new DutyStore(dir);
  const told: string[] = [];
  await store.update("chat1", duties => { duties.push({ ...parseDutyInput(input(command), "d1", at(8, 17)) }); });
  const duties = new Duties(store, { isChat: async id => id === "chat1", notify: async (_id, text) => { told.push(text); }, now: () => now.at, tickMs: 0 });
  return { dir, store, told, duties };
}

test("Duties: a due met run records the metrics and tells nobody; a covered slot does not run twice", async () => {
  const now = { at: at(8, 23, 7) };
  const { store, told, duties } = await setup(script(writeOutput({ stalls_2h: 0, long_replies: 5 })), now);
  await duties.tick();
  await duties.settled();
  const [run] = await store.runs("chat1");
  assert.equal(run?.verdict, "met", JSON.stringify(run));
  assert.equal(run.summary, "all 2 on target");
  assert.deepEqual(told, []);
  const [d1] = await store.list("chat1");
  assert.deepEqual([d1!.runCount, d1!.lastRunAt, d1!.lastSlotAt], [1, at(8, 23, 7), at(8, 23, 7)]);
  now.at = at(8, 23, 30);
  await duties.tick();
  await duties.settled();
  assert.equal((await store.runs("chat1")).length, 1);
  const [view] = await duties.view("chat1");
  assert.deepEqual([view!.nextAt, view!.running, view!.runs.length], [at(9, 23, 7), false, 1]);
});

test("Duties: a miss steers the chat with one [check-in] line and keeps the output; the precheck's state advances only on success", async () => {
  const now = { at: at(8, 23, 7) };
  const body = `const fs = require("fs"); const s = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8")); fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ n: (s.n ?? 0) + 1 })); ${writeOutput({ stalls_2h: 3, long_replies: 5 })}`;
  const { dir, store, told, duties } = await setup(script(body), now);
  assert.equal(await duties.runNow("chat1", "d1"), true);
  assert.equal(await duties.runNow("chat1", "d1"), false, "a run going now is not started twice");
  await duties.settled();
  assert.equal(told.length, 1);
  assert.match(told[0]!, /^\[check-in\] duty d1 "Chat health" missed: stalls_2h 3 \(target at most 0\)\. Details: .*d1-261008-2307\.json\./);
  const [run] = await store.runs("chat1");
  assert.deepEqual([run!.verdict, run!.trigger, run!.told], ["missed", "owner", true]);
  assert.deepEqual(JSON.parse(await readFile(run!.detail!, "utf8")).metrics, { stalls_2h: 3, long_replies: 5 });
  assert.deepEqual(JSON.parse(await readFile(join(dir, "duties", "chat1", "d1.state.json"), "utf8")), { n: 1 });
  now.at = at(9, 23, 7);
  await duties.runNow("chat1", "d1");
  await duties.settled();
  assert.match(told[1]!, /stalls_2h missed two runs in a row: call tell_owner once\./);
});

test("Duties: three precheck errors in a row pause the duty and say so once; resume skips the slots missed while paused", async () => {
  const now = { at: at(8, 23, 7) };
  const { store, told, duties } = await setup(script("process.stderr.write('boom'); process.exit(2)"), now);
  for (let day = 8; day <= 10; day++) {
    now.at = at(day, 23, 7);
    await duties.tick();
    await duties.settled();
  }
  const runs = await store.runs("chat1");
  assert.deepEqual(runs.map(run => [run.verdict, run.error]), [["error", "exit 2: boom"], ["error", "exit 2: boom"], ["error", "exit 2: boom"]]);
  assert.equal((await store.list("chat1"))[0]!.status, "paused");
  assert.match(told[2]!, /paused until resumed/);
  assert.doesNotMatch(told[1]!, /paused/);
  now.at = at(11, 23, 7);
  await duties.tick();
  await duties.settled();
  assert.equal((await store.runs("chat1")).length, 3, "a paused duty does not run on schedule");
  now.at = at(12, 9);
  assert.equal(await duties.setStatus("chat1", "d1", "active"), true);
  await duties.tick();
  await duties.settled();
  assert.equal((await store.runs("chat1")).length, 3, "resume does not run the slot missed while paused");
});

test("Duties: a timeout and bad output are error runs; a slot missed by more than 6 h is recorded as skipped", async () => {
  const now = { at: at(9, 6) };
  const { store, duties } = await setup(script("setTimeout(() => {}, 10000)"), now);
  await duties.tick();
  await duties.settled();
  assert.deepEqual((await store.runs("chat1")).map(run => run.verdict), ["skipped"]);
  await store.update("chat1", list => { list[0]!.precheck.timeoutMs = 300; });
  await duties.runNow("chat1", "d1");
  await duties.settled();
  assert.equal((await store.runs("chat1"))[0]!.error, "timed out after 0 s");
  await store.update("chat1", list => { list[0]!.precheck.command = script("require('fs').writeFileSync(process.env.OUTPUT_FILE, 'nope')"); list[0]!.precheck.timeoutMs = 5000; });
  await duties.runNow("chat1", "d1");
  await duties.settled();
  assert.equal((await store.runs("chat1"))[0]!.error, "no valid JSON in OUTPUT_FILE");
});

test("cadence: a standing duty takes every N minutes or a daily time (a moved daily slot already past waits for tomorrow); the check-in duty's cadence and pause are the chat's check-in setting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duties-cadence-"));
  const store = new DutyStore(dir);
  let now = at(9, 18);
  await store.update("chat1", duties => { duties.push(parseDutyInput(input(), "d1", at(8, 12))); });
  const setting = { everyMs: 15 * 60_000, pausedUntil: null as number | "forever" | null };
  const changes: unknown[] = [];
  const view = async () => ({ everyMs: setting.everyMs, paused: setting.pausedUntil !== null, pausedUntil: setting.pausedUntil, nextAt: setting.pausedUntil !== null ? null : now + setting.everyMs, lastAt: now });
  const duties = new Duties(store, { isChat: async () => true, notify: async () => {}, tickMs: 0, now: () => now,
    checkIn: { view: async id => id === "chat1" ? view() : null, run: async () => {}, measure: async () => null,
      set: async (_id, change) => { changes.push(change); if (change.everyMs !== undefined) setting.everyMs = change.everyMs; if (change.pause !== undefined) setting.pausedUntil = change.pause === null ? null : "forever"; return view(); } } });

  let views = await duties.view("chat1");
  assert.deepEqual(views.map(entry => [entry.duty.id, entry.builtin ?? "", entry.schedule, entry.paused]),
    [["checkin", "checkin", { kind: "every", minutes: 15 }, false], ["d1", "", { kind: "daily", at: "23:07" }, false]], "the check-in comes first, built in, on the chat's setting");
  assert.equal(views[0]!.duty.name, "Check-in");

  assert.equal(await duties.setSchedule("chat1", "checkin", { kind: "every", minutes: 30 }), true);
  assert.deepEqual(changes.at(-1), { everyMs: 30 * 60_000 }, "the card's cadence writes the check-in setting the header's control writes");
  await assert.rejects(duties.setSchedule("chat1", "checkin", { kind: "daily", at: "09:00" }), /every 1 to 240 minutes/);
  await assert.rejects(duties.setSchedule("chat1", "checkin", { kind: "every", minutes: 241 }), /every 1 to 240 minutes/);
  assert.equal(await duties.setStatus("chat1", "checkin", "paused"), true);
  assert.deepEqual(changes.at(-1), { pause: "forever" });
  views = await duties.view("chat1");
  assert.deepEqual([views[0]!.paused, views[0]!.duty.status, views[0]!.nextAt], [true, "paused", null]);
  assert.equal(await duties.setStatus("chat1", "checkin", "active"), true);
  assert.deepEqual(changes.at(-1), { pause: null });

  assert.equal(await duties.setSchedule("chat1", "d1", { kind: "daily", at: "07:30" }), true);
  let [d1] = await store.list("chat1");
  assert.deepEqual([d1!.schedule, d1!.lastSlotAt], [{ kind: "daily", at: "07:30" }, at(9, 7, 30)], "today's 07:30 already passed: no catch-up run for a cadence change");
  assert.equal(dutyDue(d1!, now).kind, "no");
  assert.equal(nextRunAt(d1!, now), at(10, 7, 30));
  assert.equal(await duties.setSchedule("chat1", "d1", { kind: "every", minutes: 45 }), true);
  [d1] = await store.list("chat1");
  assert.deepEqual(d1!.schedule, { kind: "every", minutes: 45 });
  assert.throws(() => parseSchedule({ kind: "every", minutes: 4 }), /5 to 10080/);
  await assert.rejects(duties.setSchedule("chat1", "d1", { kind: "daily", at: "25:00" }), /schedule/);
  assert.equal(await duties.setSchedule("chat1", "d9", { kind: "every", minutes: 45 }), false);
  now = at(9, 19);
  duties.close();
});

test("check-in duty record: a told run, a job event and a changed metric are kept; a quiet run with the same metrics at most hourly; the run count sits beside the list", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duties-checkin-"));
  const store = new DutyStore(dir);
  const now = at(9, 18);
  const duties = new Duties(store, { isChat: async () => true, notify: async () => {}, tickMs: 0, now: () => now });
  const quiet = { orphan_steps: 0, due_late: 0, stale_chase_24h: 0, job_end_unrecorded: 0, job_end_silent: 0, scope_misses: 0 };
  const run = (minutes: number, metrics = quiet, told = false) => duties.recordCheckIn("chat1", { at: now + minutes * 60_000, trigger: "schedule", summary: "s", told,
    output: { metrics, flagged: [] }, classes: { live: 2 } });
  await run(0);
  await run(15);
  await run(30, { ...quiet, orphan_steps: 1 });
  await run(45, { ...quiet, orphan_steps: 1 }, true);
  await duties.recordCheckIn("chat1", { at: now + 50 * 60_000, trigger: "job-ended", summary: "fixer ended with no report", told: true });
  await run(60, { ...quiet, orphan_steps: 1 });
  await run(110, { ...quiet, orphan_steps: 1 });
  const runs = (await store.runs("chat1")).reverse();
  assert.deepEqual(runs.map(entry => [(entry.at - now) / 60_000, entry.trigger, entry.verdict]),
    [[0, "schedule", "met"], [30, "schedule", "missed"], [45, "schedule", "missed"], [50, "job-ended", "missed"], [110, "schedule", "missed"]]);
  assert.deepEqual([(await store.read("chat1")).checkIn?.runCount, (await store.read("chat1")).duties], [5, []]);
  assert.deepEqual(runs[0]!.classes, { live: 2 });
  duties.close();
});

test("duty store remove: a duty's definition, runs and saved files go; the second run finds nothing; remove.ts by name is idempotent and leaves other duties", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duties-remove-"));
  const store = new DutyStore(dir);
  for (const chat of ["c1", "c2"]) {
    await store.update(chat, duties => {
      duties.push(parseDutyInput({ ...input(), name: "Board convergence" }, "d1", 0));
      if (chat === "c2") duties.push(parseDutyInput(input(), "d2", 0));
    });
    for (const id of ["d1", "d2"]) await store.appendRun(chat, { duty: id, at: 1, trigger: "schedule", ms: 0, verdict: "met", metrics: {}, summary: "", told: false });
    await mkdir(store.chatDir(chat), { recursive: true });
    for (const name of ["d1-261009-2307.json", "d1.state.json", "d1.last-runs.json", "d2.state.json", "d10.state.json"]) await writeFile(join(store.chatDir(chat), name), "{}");
  }
  const script = (...args: string[]) => run(process.execPath, ["--import", "tsx", "scripts/duties/remove.ts", "--name", "Board convergence", "--data-dir", dir, ...args],
    { cwd: join(import.meta.dirname, "..") });
  assert.equal((await script("--chat", "c1")).stdout, 'removed d1 "Board convergence" from c1\n1 removed\n');
  assert.equal((await script()).stdout, 'removed d1 "Board convergence" from c2\n1 removed\n');
  assert.equal((await script()).stdout, 'no duty named "Board convergence"\n', "a second run changes nothing");
  assert.equal(await store.remove("c1", "d1"), false);
  assert.deepEqual((await store.list("c2")).map(duty => duty.id), ["d2"]);
  assert.deepEqual((await store.runs("c2")).map(entry => entry.duty), ["d2"]);
  assert.deepEqual((await readdir(store.chatDir("c2"))).sort(), ["d10.state.json", "d2.state.json"]);
});

test("after-turn recheck for a standing duty: a flagged step the chat left unchanged comes back by name once; a step it changed counts as handled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duties-after-turn-"));
  const store = new DutyStore(dir);
  let now = at(9, 18);
  const flags = join(dir, "flags.json");
  await writeFile(flags, JSON.stringify([{ kind: "stalls_2h", excerpt: "p5 sat 3 h", item: "p5" }, { kind: "stalls_2h", excerpt: "p6 sat 4 h", item: "p6" }]));
  const command = ["node", "-e", `const fs = require("fs"); const flagged = JSON.parse(fs.readFileSync(${JSON.stringify(flags)}, "utf8"));
    fs.writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { stalls_2h: flagged.length, long_replies: 0 }, flagged }))`];
  await store.update("chat1", duties => { duties.push(parseDutyInput(input(command), "d1", at(8, 12))); });
  const step = (id: string, note: string) => ({ id, text: id, status: "doing" as const, note, children: [] });
  const board = { v: 2 as const, rev: 1, updatedAt: "", scratch: [], todos: [], plan: [step("p5", "a"), step("p6", "b")] };
  const sent: string[] = [];
  const duties = new Duties(store, { isChat: async () => true, notify: async (_id, message) => { sent.push(message); }, tickMs: 0, now: () => now, board: async () => board });
  assert.equal(await duties.runNow("chat1", "d1"), true);
  await duties.settled();
  assert.equal(sent.length, 1, "the miss told the chat");
  board.plan[1] = step("p6", "b, restarted the job");
  now += 60_000;
  await duties.afterTurn("chat1");
  assert.match(sent[1]!, /^\[check-in\] duty d1 "Chat health": after your turn the same check still flags this step and the board shows no change on it\. .*\n- p5 \(stalls_2h\): p5 sat 3 h$/s);
  const [after] = await store.runs("chat1");
  assert.deepEqual([after!.trigger, after!.handled, after!.unresolved?.map(slice => slice.item), after!.told], ["after-turn", ["p6"], ["p5"], true]);
  await duties.afterTurn("chat1");
  assert.equal(sent.length, 2, "one recheck per told run");
  duties.close();
});
