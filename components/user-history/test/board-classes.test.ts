import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { classesReport, boardClasses, parseLooseJson, type DaemonSession } from "../scripts/duties/board-classes.ts";
import { checkInRecord } from "../src/chat-checkin.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { parseDutyInput } from "../src/shared/chat-duties.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const run = promisify(execFile);
const HOUR = 60 * 60_000;
const NOW = Date.parse("2026-10-09T12:00:00Z");
const step = (id: string, text: string, status: PlanItem["status"], extra: Partial<PlanItem> = {}): PlanItem => ({ id, text, status, children: [], ...extra });

/** A data dir with one chat c1 whose board has one step per class, the check-in memory dating each step, and the daemon's sessions. */
async function fixture(): Promise<{ dir: string; sessions: string }> {
  const dir = await mkdtemp(join(tmpdir(), "board-classes-"));
  await mkdir(join(dir, "boards"), { recursive: true });
  const board: ChatBoard = { v: 2, rev: 3, updatedAt: new Date(NOW - 40 * HOUR).toISOString(), plan: [step("p1", "Goal", "doing", { requirements: [{ text: "\"a bridge\"", status: "met", evidence: "design doc" }], children: [
    step("p2", "Write the docs", "todo"),
    step("p3", "Check the load", "doing", { job: "c1", waitUntil: new Date(NOW - HOUR).toISOString() }),
    step("p4", "Revoke the old app", "blocked", { job: "c1", waitFor: "Promote 5 green" }),
    step("p5", "Fix the dates", "doing", { job: "dates fix" }),
    step("p6", "Pick the price", "blocked", { job: "c1" }),
    step("p7", "Build the bridge", "doing", { job: "builder" }),
    step("p8", "Old", "done")] })],
    todos: [{ id: "t1", text: "p6: which price?", done: false, from: "agent", at: "", choices: ["$9", "$19"] }] };
  await writeFile(join(dir, "boards", "c1.json"), JSON.stringify(board));
  await writeFile(join(dir, "chats.json"), JSON.stringify({ ids: ["c1"] }));
  const at = (hours: number) => ({ sig: "kept", at: NOW - hours * HOUR });
  await writeFile(join(dir, "check-ins.json"), JSON.stringify({ chats: { c1: { at: NOW - 15 * 60_000, jobs: {}, answered: [], ready: [],
    steps: { p2: at(3), p3: at(5), p4: at(30), p5: at(2), p6: at(10), p7: at(1) } } } }));
  const sessions: DaemonSession[] = [
    { sessionId: "c1", sessionName: "dev VP\u0007", lifecycle: "live", activity: "idle", lastActivityAt: new Date(NOW).toISOString() },
    { sessionId: "s-dates", sessionName: "dates fix", parentSessionId: "c1", rlmChildId: "sub-1", lifecycle: "live", activity: "idle", lastActivityAt: new Date(NOW - HOUR).toISOString() },
    { sessionId: "s-build", sessionName: "builder", parentSessionId: "c1", rlmChildId: "sub-2", lifecycle: "live", activity: "working", lastActivityAt: new Date(NOW - 60_000).toISOString() },
  ];
  const file = join(dir, "sessions.json");
  await writeFile(file, JSON.stringify({ sessions }).replace("\\u0007", "\u0007"));
  return { dir, sessions: file };
}

test("board classes: one class per open leaf step, and the convergence misses", async () => {
  const { dir, sessions } = await fixture();
  const parsed = parseLooseJson(await readFile(sessions, "utf8")) as { sessions: DaemonSession[] };
  assert.equal(parsed.sessions[0]!.sessionName, "dev VP\u0007", "a raw control character in a title parses");
  const [chat] = await boardClasses({ dataDir: dir, now: NOW, sessions: () => parsed.sessions });
  assert.deepEqual(chat!.steps.map(view => `${view.item.id} ${view.cls}`), ["p2 orphan", "p3 due", "p4 stale-chase", "p5 orphan", "p6 foryou", "p7 live"]);
  assert.deepEqual(chat!.misses, { orphan_steps: 2, due_late: 1, stale_chase_24h: 1, job_end_unrecorded: 1, job_end_silent: 0, scope_misses: 0, idle_goals: 0, stalled_steps: 2, go_missing: 0, requirements_missing: 0, goal_gaps: 0, blocked_on_others: 1,
    finished_open: 0, loose_goals: 0, extra_goals: 0, open_under_closed: 0,
    held_elsewhere: 0, wait_met: 0, no_progress: 0, stale_steps: 0, goals_to_fold: 0, merges_without_go: 0, one_session_load: 0, redundant_heartbeats: 0, goals_without_duty: 1, stuck_steps: 4 });
  assert.deepEqual(chat!.flagged.map(slice => `${slice.kind} ${slice.item}`), ["orphan_steps p2", "due_late p3", "stale_chase_24h p4", "orphan_steps p5", "job_end_unrecorded p5",
    "stalled_steps p3", "stalled_steps p4", "blocked_on_others p4", "goals_without_duty p1", "stuck_steps p2", "stuck_steps p3", "stuck_steps p4", "stuck_steps p5"],
    "each flagged slice names its step, for the after-turn recheck");
  assert.deepEqual(chat!.end.map(entry => `${entry.view.item.id} ${entry.state}`), ["p2 no_owner", "p3 time", "p4 release", "p5 job_ended", "p6 foryou", "p7 moving"]);
  assert.deepEqual([chat!.kpi.open, chat!.kpi.stuck, chat!.kpi.pct], [6, 4, 33.3]);
  const report = classesReport([chat!], NOW);
  assert.match(report, /c1 dev VP.: End state: 2 of 6 open steps \(33\.3%\) are moving, in For you or parked; 4 stuck \(release 1, time 1, job_ended 1, no_owner 1\)\.\n  classes: live 1, foryou 1, waiting 0, due 1, stale-chase 1, orphan 2, parked 0 \(open 6\); duty: orphan_steps 2, due_late 1, stale_chase_24h 1, job_end_unrecorded 1, job_end_silent 0, scope_misses 0/);
  assert.match(report, /\n  stuck: p4 "Revoke the old app" is stuck \(release\)/);
  assert.match(report, /  stale-chase: p4 "Revoke the old app" waits for "Promote 5 green" for 30 h: make it a For you todo or replan it now/);
  assert.match(report, /  blocked: p4 "Revoke the old app" is blocked on Promote for 30 h and no job works on it: find out why and start a job that fixes the blocker/);
  assert.match(report, /All chats: End state: 2 of 6 open steps \(33\.3%\)[^\n]*\nAll chats, classes: live 1, foryou 1, waiting 0, due 1, stale-chase 1, orphan 2, parked 0/);
});

test("board classes CLI: prints the classes report; it is no duty precheck and writes no OUTPUT_FILE", async () => {
  const { dir, sessions } = await fixture();
  const output = join(dir, "out.json");
  const { stdout } = await run(process.execPath, ["--import", "tsx", "scripts/duties/board-classes.ts", "--chat", "c1", "--data-dir", dir, "--sessions", sessions, "--now", String(NOW)],
    { cwd: join(import.meta.dirname, ".."), env: { ...process.env, OUTPUT_FILE: output } });
  assert.match(stdout, /duty: orphan_steps 2, due_late 1, stale_chase_24h 1, job_end_unrecorded 1, job_end_silent 0, scope_misses 0/);
  await assert.rejects(readFile(output, "utf8"), /ENOENT/, "the Board convergence precheck mode is gone");
});

test("board classes: a step whose job the server told as a bad end with no report counts as job_end_silent, not again as job_end_unrecorded", async () => {
  const { dir, sessions } = await fixture();
  const parsed = parseLooseJson(await readFile(sessions, "utf8")) as { sessions: DaemonSession[] };
  await checkInRecord(join(dir, "check-ins.json")).told("c1", "sub-1", { at: NOW - HOUR, cause: "error" });
  const [chat] = await boardClasses({ dataDir: dir, now: NOW, sessions: () => parsed.sessions });
  assert.deepEqual(chat!.misses, { orphan_steps: 2, due_late: 1, stale_chase_24h: 1, job_end_unrecorded: 0, job_end_silent: 1, scope_misses: 0, idle_goals: 0, stalled_steps: 2, go_missing: 0, requirements_missing: 0, goal_gaps: 0, blocked_on_others: 1,
    finished_open: 0, loose_goals: 0, extra_goals: 0, open_under_closed: 0,
    held_elsewhere: 0, wait_met: 0, no_progress: 0, stale_steps: 0, goals_to_fold: 0, merges_without_go: 0, one_session_load: 0, redundant_heartbeats: 0, goals_without_duty: 1, stuck_steps: 4 });
  assert.deepEqual(chat!.flagged.filter(slice => slice.kind.startsWith("job_end")).map(slice => `${slice.kind}: ${slice.excerpt}`),
    ['job_end_silent: p5 "Fix the dates": job dates fix stopped on a provider error 60 min ago with no report and the step has not changed since']);
  await checkInRecord(join(dir, "check-ins.json")).told("c1", "sub-1", { at: NOW - 3 * HOUR, cause: "aborted" });
  const [before] = await boardClasses({ dataDir: dir, now: NOW, sessions: () => parsed.sessions });
  assert.deepEqual([before!.misses.job_end_unrecorded, before!.misses.job_end_silent], [1, 0], "a told end before the step's last change is no silent end");
});

test("board classes: a job idle under a step that names its wait is holding, not ended unrecorded (Crawler VP 10-09: obs-p0 held a CI slot)", async () => {
  const { dir, sessions } = await fixture();
  const parsed = parseLooseJson(await readFile(sessions, "utf8")) as { sessions: DaemonSession[] };
  const file = join(dir, "boards", "c1.json");
  const board = JSON.parse(await readFile(file, "utf8")) as ChatBoard;
  const p5 = board.plan[0]!.children.find(item => item.id === "p5")!;
  p5.waitFor = "a free CI slot";
  await writeFile(file, JSON.stringify(board));
  const [chat] = await boardClasses({ dataDir: dir, now: NOW, sessions: () => parsed.sessions });
  assert.equal(chat!.misses.job_end_unrecorded, 0);
  delete p5.waitFor;
  p5.waitUntil = new Date(NOW + HOUR).toISOString();
  await writeFile(file, JSON.stringify(board));
  assert.equal((await boardClasses({ dataDir: dir, now: NOW, sessions: () => parsed.sessions }))[0]!.misses.job_end_unrecorded, 0, "a waitUntil still ahead holds too");
  p5.waitUntil = new Date(NOW - 2 * HOUR).toISOString();
  await writeFile(file, JSON.stringify(board));
  assert.equal((await boardClasses({ dataDir: dir, now: NOW, sessions: () => parsed.sessions }))[0]!.misses.job_end_unrecorded, 1, "a passed waitUntil holds nothing");
});

test("board classes: a job whose own turn ended while its subagent works is live, not an orphan (01a115e2 10-09: google serp waited on exp-http-final)", async () => {
  const { dir, sessions } = await fixture();
  const parsed = parseLooseJson(await readFile(sessions, "utf8")) as { sessions: DaemonSession[] };
  const grandchild: DaemonSession = { sessionId: "s-probe", sessionName: "probe run", parentSessionId: "s-dates", rlmChildId: "sub-3", lifecycle: "live", activity: "working",
    lastActivityAt: new Date(NOW - 60_000).toISOString() };
  const [chat] = await boardClasses({ dataDir: dir, now: NOW, sessions: () => [...parsed.sessions, grandchild] });
  assert.equal(chat!.steps.find(view => view.item.id === "p5")!.cls, "live");
  assert.equal(chat!.misses.orphan_steps, 1);
  const [archived] = await boardClasses({ dataDir: dir, now: NOW, sessions: () => [...parsed.sessions, { ...grandchild, lifecycle: "archived" }] });
  assert.equal(archived!.steps.find(view => view.item.id === "p5")!.cls, "orphan", "an archived subagent holds nothing");
});

test("board classes: a chat with an open goal and no active duty counts once in goals_without_duty; the built-in check-in is no duty (duty proposals 10-12)", async () => {
  const { dir, sessions } = await fixture();
  const parsed = parseLooseJson(await readFile(sessions, "utf8")) as { sessions: DaemonSession[] };
  const classes = async () => (await boardClasses({ dataDir: dir, now: NOW, sessions: () => parsed.sessions }))[0]!;
  const store = new DutyStore(dir);
  await store.updateFile("c1", state => { state.checkIn = { createdAt: NOW - HOUR, runCount: 4 }; });
  const none = await classes();
  assert.equal(none.misses.goals_without_duty, 1, "c1 has the open goal p1, and its check-in runs are no duty");
  assert.deepEqual(none.flagged.filter(slice => slice.kind === "goals_without_duty").map(slice => [slice.chat, slice.item, slice.excerpt]),
    [["c1", "p1", '1 open goal (p1 "Goal") and no active duty: when the owner\'s words ask for standing work, add a daily duty for it with ' +
      "scripts/duties/add.ts (the owner's words, a goal, metrics and a precheck) yourself"]]);
  assert.match(classesReport([none], NOW), /\n  no duty: 1 open goal \(p1 "Goal"\)/);
  const duty = parseDutyInput({ name: "Dev loop", ownerWords: "keep the dev loop green", goal: "The dev loop stays green.", onMiss: "Fix it.",
    metrics: [{ key: "red_runs", label: "Red runs", op: "<=", target: 0 }], schedule: { kind: "daily", at: "09:00" }, precheck: { command: ["true"], cwd: "/" } }, "d1", NOW);
  await store.update("c1", duties => { duties.push({ ...duty, status: "paused" }); });
  assert.equal((await classes()).misses.goals_without_duty, 1, "a paused duty runs nothing");
  await store.update("c1", duties => { duties[0]!.status = "active"; });
  const covered = await classes();
  assert.equal(covered.misses.goals_without_duty, 0, "an active duty clears it");
  assert.equal(covered.flagged.filter(slice => slice.kind === "goals_without_duty").length, 0);
  await store.update("c1", duties => { duties.length = 0; });
  const file = join(dir, "boards", "c1.json");
  const board = JSON.parse(await readFile(file, "utf8")) as ChatBoard;
  await writeFile(file, JSON.stringify({ ...board, plan: board.plan.map(goal => ({ ...goal, status: "done" })) }));
  assert.equal((await classes()).misses.goals_without_duty, 0, "no open goal, nothing to flag");
});
