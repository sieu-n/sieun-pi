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
import { Duties } from "../src/chat-duty-run.ts";
import { CONVERGENCE_DUTY, convergenceDuty, parseDutyInput } from "../src/shared/chat-duties.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const run = promisify(execFile);
const HOUR = 60 * 60_000;
const NOW = Date.parse("2026-10-09T12:00:00Z");
const step = (id: string, text: string, status: PlanItem["status"], extra: Partial<PlanItem> = {}): PlanItem => ({ id, text, status, children: [], ...extra });

/** A data dir with one chat c1 whose board has one step per class, the check-in memory dating each step, and the daemon's sessions. */
async function fixture(): Promise<{ dir: string; sessions: string }> {
  const dir = await mkdtemp(join(tmpdir(), "board-classes-"));
  await mkdir(join(dir, "boards"), { recursive: true });
  const board: ChatBoard = { v: 2, rev: 3, updatedAt: new Date(NOW - 40 * HOUR).toISOString(), scratch: [], plan: [step("p1", "Goal", "doing", { children: [
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
  assert.deepEqual(chat!.misses, { orphan_steps: 2, due_late: 1, stale_chase_24h: 1, job_end_unrecorded: 1, job_end_silent: 0, scope_misses: 0 });
  const report = classesReport([chat!], NOW);
  assert.match(report, /c1 dev VP.: live 1, foryou 1, waiting 0, due 1, stale-chase 1, orphan 2 \(open 6\); duty: orphan_steps 2, due_late 1, stale_chase_24h 1, job_end_unrecorded 1, job_end_silent 0, scope_misses 0/);
  assert.match(report, /  stale-chase: p4 "Revoke the old app" waits for "Promote 5 green" for 30 h: make it a For you todo or replan it now/);
  assert.match(report, /All chats: live 1, foryou 1, waiting 0, due 1, stale-chase 1, orphan 2/);
});

test("board convergence duty: the precheck writes the misses for its chat; a run against the duty's targets misses; ensure is idempotent", async () => {
  const { dir, sessions } = await fixture();
  const output = join(dir, "out.json");
  await run(process.execPath, ["--import", "tsx", "scripts/duties/board-classes.ts", "--chat", "c1", "--data-dir", dir, "--sessions", sessions, "--now", String(NOW)],
    { cwd: join(import.meta.dirname, ".."), env: { ...process.env, OUTPUT_FILE: output } });
  const result = JSON.parse(await readFile(output, "utf8")) as { metrics: Record<string, number>; flagged: { kind: string; excerpt: string }[] };
  assert.deepEqual(result.metrics, { orphan_steps: 2, due_late: 1, stale_chase_24h: 1, job_end_unrecorded: 1, job_end_silent: 0, scope_misses: 0 });
  assert.deepEqual(result.flagged.map(slice => slice.kind), ["orphan_steps", "due_late", "stale_chase_24h", "orphan_steps", "job_end_unrecorded"]);

  const definition = convergenceDuty("c1", join(import.meta.dirname, ".."));
  const duty = parseDutyInput(definition, "d1", NOW);
  assert.equal(duty.name, CONVERGENCE_DUTY);
  assert.deepEqual(duty.metrics.map(metric => `${metric.key} ${metric.op} ${metric.target}`), ["orphan_steps <= 0", "due_late <= 0", "stale_chase_24h <= 0", "job_end_unrecorded <= 0", "job_end_silent <= 0", "scope_misses <= 0"]);
  assert.deepEqual(duty.precheck.command, ["node", "--import", "tsx", "scripts/duties/board-classes.ts", "--chat", "c1"]);
  const duties = new Duties(new DutyStore(dir), { isChat: async () => true, notify: async () => {}, tickMs: 0, now: () => NOW });
  assert.equal(await duties.ensure("c1", definition), "added d1");
  assert.equal(await duties.ensure("c1", definition), "unchanged d1", "a second adopt changes nothing");
  assert.equal(await duties.ensure("c1", convergenceDuty("c1", "/elsewhere")), "updated d1", "a moved checkout updates the definition, keeping its runs");
  duties.close();
});

test("board classes: a step whose job the server told as a bad end with no report counts as job_end_silent, not again as job_end_unrecorded", async () => {
  const { dir, sessions } = await fixture();
  const parsed = parseLooseJson(await readFile(sessions, "utf8")) as { sessions: DaemonSession[] };
  await checkInRecord(join(dir, "check-ins.json")).told("c1", "sub-1", { at: NOW - HOUR, cause: "error" });
  const [chat] = await boardClasses({ dataDir: dir, now: NOW, sessions: () => parsed.sessions });
  assert.deepEqual(chat!.misses, { orphan_steps: 2, due_late: 1, stale_chase_24h: 1, job_end_unrecorded: 0, job_end_silent: 1, scope_misses: 0 });
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
