import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type DutyChat, type DutyJobHost } from "../src/chat-duty-job.ts";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { applyBoardOp, nextIds, parseBoardOp } from "../src/shared/chat-board.ts";
import { type DutyJobRef, type DutyMetric, type DutyRunRecord, parseDutyInput } from "../src/shared/chat-duties.ts";
import { closedFixes, dutyFixes, fixJobLive } from "../src/shared/duty-fixes.ts";
import type { ChatAgent, ChatBoard, PlanItem, SessionRow } from "../src/shared/types.ts";

// The AI harness chat's Mac stays usable duty (d6) on 10-15: its 17:22 run missed usable_pct_1h (93.2%) and usable_pct_24h (96.7%), and
// usable_pct_24h had missed 11 hourly runs in a row, from 99.1% down to 96.7%, while the runs only reported it. The board slice is p445 (done,
// hung cell interrupt), p449 (doing, spawn burst admission) and p452 (doing, yesterday work and tokens); the duty links are the test's.
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/duty-fixes-ai-harness-1015.json"), "utf8")) as {
  chat: string; duty: { id: string; name: string; ownerWords: string; goal: string; metrics: DutyMetric[]; onMiss: string }; runs: DutyRunRecord[]; board: ChatBoard };
const CHAT = fixture.chat;
const newest = fixture.runs[0]!;

/** The fixture board with duty links set on its steps, and `status` changes. */
function board(links: Record<string, string>, status: Record<string, PlanItem["status"]> = {}, rev = fixture.board.rev): ChatBoard {
  return { ...fixture.board, rev, plan: fixture.board.plan.map(item => ({ ...item, ...(links[item.id] ? { duty: links[item.id] } : {}), ...(status[item.id] ? { status: status[item.id]! } : {}) })) };
}

const output = (metrics: Record<string, number>) => `require("fs").writeFileSync(process.env.OUTPUT_FILE, ${JSON.stringify(JSON.stringify({ metrics, flagged: [] }))})`;

function fakeJobs() {
  const briefs: string[] = [];
  const steers: { job: string; text: string }[] = [];
  const stops: string[] = [];
  const ended = new Set<string>();
  let next = 0;
  const host: DutyJobHost = {
    async chat(chatId): Promise<DutyChat> { return { id: chatId, name: "AI harness developer environment", cwd: "/repo", board: `/boards/${chatId}.json` }; },
    async working(job) { return /^s\d+$/.test(job.id) && !ended.has(job.id); },
    async start(_chat, name, brief): Promise<DutyJobRef> { briefs.push(brief); return { id: `s${++next}`, name }; },
    async retire() {},
    async ended(last, older = []) { return [...last, ...older].filter(job => ended.has(job.id)); },
    async stop(job) { stops.push(job.id); },
    async steer(job, text) { steers.push({ job: job.id, text }); ended.delete(job.id); },
  };
  return { host, briefs, steers, stops, ended };
}

/** A Duties runner over a store seeded with the d6 runs before 17:22, whose precheck measures the 17:22 run's values, so its run stands for that one. */
async function runner(input: { board: () => ChatBoard; live?: ReadonlySet<string>; checkIn?: (trigger: string | undefined) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "duty-persistence-"));
  const store = new DutyStore(dir);
  for (const run of fixture.runs.slice(1).reverse()) await store.appendRun(CHAT, run);
  const values = Object.fromEntries(Object.entries(newest.metrics).map(([key, result]) => [key, result.value]));
  const now = { at: newest.at };
  await store.update(CHAT, duties => {
    // The stored d6 predates the shape rule (6 metrics), so it goes in as stored rather than through add.ts's parse.
    duties.push({ ...parseDutyInput({ ...fixture.duty, metrics: fixture.duty.metrics.slice(0, 4), schedule: { kind: "every", minutes: 60 },
      precheck: { command: ["node", "-e", output(values)], cwd: tmpdir() } }, "d6", newest.at), metrics: fixture.duty.metrics, lastRunAt: now.at });
  });
  const jobs = fakeJobs();
  const lines: string[] = [];
  const duties = new Duties(store, { isChat: async id => id === CHAT, jobs: jobs.host, now: () => now.at, tickMs: 0, log: line => lines.push(line),
    board: async () => input.board(), fixLive: async (_chat, item) => input.live?.has(item.job ?? "") ?? false,
    ...(input.checkIn ? { checkIn: { view: async () => null, set: async () => null, run: async (_chat: string, trigger?: string) => { input.checkIn!(trigger); } } } : {}) });
  return { store, duties, jobs, lines, now };
}

test("a run with 2 missed metrics lists both with their streaks in the brief, and each needs a fix step", async () => {
  const { store, duties, jobs } = await runner({ board: () => board({ p445: "d6/usable_pct_24h" }) });
  assert.equal(await duties.runNow(CHAT, "d6"), true);
  await duties.settled();
  const brief = jobs.briefs[0]!;
  assert.match(brief, /## Missed metrics: each one needs a fix step with a live job/);
  assert.match(brief, /- usable_pct_1h \(Share of the last hour's minutes the Mac was usable\) is 93\.2%, target >= 100%, missed 1 run in a row\. No plan step fixes it\. Start a fix job with rlm\.create_session/);
  assert.match(brief, /add a plan step with duty "d6\/usable_pct_1h" and that job\./);
  assert.match(brief, /- usable_pct_24h \(.*\) is 96\.7%, target >= 100%, missed 11 runs in a row, not moving toward the target\./);
  assert.match(brief, /sends you back with its name, so the run cannot end on an unowned miss/);
  const record = (await store.runs(CHAT))[0]!;
  assert.equal(record.trigger, "owner");
  assert.deepEqual(record.fixes, { usable_pct_24h: { step: "p445", job: "hung cell interrupt", live: false } });
});

test("a stuck metric's brief requires a new root-cause job and names the old fix and its job", async () => {
  const { duties, jobs } = await runner({ board: () => board({ p445: "d6/usable_pct_24h" }) });
  await duties.runNow(CHAT, "d6");
  await duties.settled();
  const brief = jobs.briefs[0]!;
  assert.match(brief, /usable_pct_24h .* Change approach: the fix p445 \(job hung cell interrupt\) did not move it\. Start a new root-cause job with rlm\.create_session that finds why the last fix did not move the number/);
  assert.match(brief, /Do not run the same fix again\. Add its own plan step with duty "d6\/usable_pct_24h" and the new job, and close or drop p445/);
  assert.match(brief, /### Change approach\n- usable_pct_24h missed 11 runs in a row and did not move toward its target; the fix p445 by hung cell interrupt did not move it\./);
  assert.doesNotMatch(brief, /usable_pct_1h[^\n]*Change approach/, "a first miss is not stuck");
});

test("fixes fill from a board with linked steps: an open step with a live job first, an open one with a dead job next, a closed one last", async () => {
  const linked = board({ p445: "d6/usable_pct_24h", p449: "d6/usable_pct_1h", p452: "d6/usable_pct_24h" });
  const live = new Set(["spawn burst admission"]);
  const fixes = await dutyFixes(linked, "d6", ["usable_pct_1h", "usable_pct_24h", "kernel_waiters_1h"], async item => live.has(item.job ?? ""));
  assert.deepEqual(fixes, {
    usable_pct_1h: { step: "p449", job: "spawn burst admission", live: true },
    usable_pct_24h: { step: "p452", job: "yesterday work and tokens", live: false },
  });
  const closed = await dutyFixes(board({ p445: "d6/usable_pct_24h" }), "d6", ["usable_pct_24h"], async () => true);
  assert.deepEqual(closed, { usable_pct_24h: { step: "p445", job: "hung cell interrupt", live: false } }, "a closed fix step never counts as live");
  assert.deepEqual(await dutyFixes(linked, "d1", ["usable_pct_1h"], async () => true), {}, "a link to another duty does not count");
});

test("fixJobLive reads the chat's agent that owns the step, its session row, and a pending board.wake", () => {
  const row = (id: string, extra: Partial<SessionRow> = {}): SessionRow => ({ id, name: id, cwd: "/repo", kind: "live", status: "idle", archived: false,
    messageCount: 4, working: false, subagentsRunning: 0, unread: false, tags: [], priority: 0, progress: "none", ...extra });
  const agent = (name: string, sessionId: string, state: ChatAgent["state"], steps: string[]): ChatAgent =>
    ({ key: "thread:" + sessionId, sessionId, name, job: "session:" + sessionId, sender: name, link: "step", state, steps });
  const [p445, p449, p452] = fixture.board.plan as [PlanItem, PlanItem, PlanItem];
  const rows = [row(CHAT, { agents: [agent("spawn burst admission", p449.sessionId!, "working", ["p449"]), agent("yesterday work and tokens", p452.sessionId!, "done", ["p452"])] }),
    row(p449.sessionId!, { name: "spawn burst admission", working: true }), row(p452.sessionId!, { name: "yesterday work and tokens" }), row(p445.sessionId!, { name: "hung cell interrupt" })];
  assert.equal(fixJobLive(p449, CHAT, rows, new Set()), true);
  assert.equal(fixJobLive(p452, CHAT, rows, new Set()), false, "a job whose turn ended and waits for nothing is not live");
  assert.equal(fixJobLive(p452, CHAT, rows, new Set([p452.sessionId!])), true, "a job asleep on a board.wake is live");
  assert.equal(fixJobLive(p445, CHAT, rows, new Set()), false);
});

test("a duty job whose turn ends with an unowned miss is sent back with a message naming each metric, and stopped once it ends again with no board change", async () => {
  const current = { board: board({}) };
  const { duties, jobs, lines, now } = await runner({ board: () => current.board, live: new Set(["spawn burst admission", "mac usable root cause"]) });
  await duties.runNow(CHAT, "d6");
  await duties.settled();
  jobs.ended.add("s1");
  now.at += 60_000;
  await duties.tick();
  assert.equal(jobs.steers.length, 1);
  const text = jobs.steers[0]!.text;
  assert.match(text, /^\[duty\] Your Mac stays usable run is not done: 2 missed metrics have no fix step with a live job\./);
  assert.match(text, /- usable_pct_1h: no plan step fixes it\. Start a fix job with rlm\.create_session and add a plan step for it with duty "d6\/usable_pct_1h" and that job\./);
  assert.match(text, /- usable_pct_24h: missed 3 or more runs with no move\. Start a new root-cause job/);
  assert.deepEqual(jobs.stops, [], "a job sent back is not archived");
  jobs.ended.add("s1");
  now.at += 60_000;
  await duties.tick();
  assert.deepEqual(jobs.stops, ["s1"], "a job that ends again with the board unchanged is stopped");
  assert.equal(jobs.steers.length, 1);
  assert.ok(lines.some(line => line.includes("ended again with usable_pct_1h, usable_pct_24h unowned and no board change")), lines.join("\n"));
});

test("a duty job that links a fix step with a live job for every miss ends its run normally", async () => {
  const current = { board: board({}) };
  const { duties, jobs, now } = await runner({ board: () => current.board, live: new Set(["spawn burst admission", "yesterday work and tokens"]) });
  await duties.runNow(CHAT, "d6");
  await duties.settled();
  jobs.ended.add("s1");
  now.at += 60_000;
  await duties.tick();
  assert.equal(jobs.steers.length, 1);
  current.board = board({ p449: "d6/usable_pct_1h", p452: "d6/usable_pct_24h" }, {}, fixture.board.rev + 2);
  jobs.ended.add("s1");
  now.at += 60_000;
  await duties.tick();
  assert.equal(jobs.steers.length, 1, "no second message");
  assert.deepEqual(jobs.stops, ["s1"]);
});

test("closing a linked fix step starts one verify run of its duty; a check-in link runs the check-in with trigger verify", async () => {
  const checkIns: (string | undefined)[] = [];
  const { store, duties, lines } = await runner({ board: () => board({}), checkIn: trigger => checkIns.push(trigger) });
  const open = board({ p449: "d6/usable_pct_1h", p452: "checkin/stuck_steps" });
  await duties.boardChanged(CHAT, open);
  await duties.settled();
  assert.equal((await store.runs(CHAT)).length, (fixture.runs.length - 1), "the first board seen only sets the base");
  const closed = board({ p449: "d6/usable_pct_1h", p452: "checkin/stuck_steps" }, { p449: "done", p452: "done" }, fixture.board.rev + 1);
  await duties.boardChanged(CHAT, closed);
  await duties.settled();
  await duties.boardChanged(CHAT, { ...closed, rev: closed.rev + 1 });
  await duties.settled();
  const runs = await store.runs(CHAT);
  assert.equal(runs.length, (fixture.runs.length - 1) + 1, "one verify run per close");
  assert.equal(runs[0]!.trigger, "verify");
  assert.deepEqual(checkIns, ["verify"]);
  assert.ok(lines.some(line => line.endsWith("d6: fix p449 closed; a verify run starts")), lines.join("\n"));
  assert.deepEqual(closedFixes(open, closed).map(fix => `${fix.step} ${fix.duty}/${fix.metric}`), ["p449 d6/usable_pct_1h", "p452 checkin/stuck_steps"]);
});

test("chat_board: plan_add and plan_update set, change and clear a step's duty link, plan_set keeps it, and a bad link is refused", () => {
  const now = "2026-10-15T09:20:00.000Z";
  const apply = (state: ChatBoard, op: unknown) => applyBoardOp(state, parseBoardOp(op), "agent", now, nextIds(state));
  const added = apply(fixture.board, { op: "plan_add", parent: "p449", text: "Find why the Mac usable share stays under target", job: "mac usable root cause", duty: "d6/usable_pct_24h" });
  assert.match(added.summary, /^Added p453 "Find why the Mac usable share stays under target", fixing duty metric d6\/usable_pct_24h under p449/);
  const step = added.board.plan[1]!.children[0]!;
  assert.equal(step.duty, "d6/usable_pct_24h");
  const moved = apply(added.board, { op: "plan_update", id: step.id, duty: "checkin/stuck_steps" });
  assert.match(moved.summary, /linked duty metric checkin\/stuck_steps/);
  const kept = apply(moved.board, { op: "plan_set", items: moved.board.plan.map(item => ({ id: item.id, text: item.text, status: item.status,
    children: item.children.map(child => ({ id: child.id, text: child.text, status: child.status })) })) });
  assert.equal(kept.board.plan[1]!.children[0]!.duty, "checkin/stuck_steps");
  const cleared = apply(moved.board, { op: "plan_update", id: step.id, duty: null });
  assert.equal(cleared.board.plan[1]!.children[0]!.duty, undefined);
  assert.match(cleared.summary, /unlinked its duty metric/);
  assert.throws(() => parseBoardOp({ op: "plan_update", id: "p449", duty: "Mac stays usable" }), /duty must be "<dutyId>\/<metricKey>"/);
});
