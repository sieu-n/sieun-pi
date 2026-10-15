import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import type { DutyChat, DutyJobHost } from "../src/chat-duty-job.ts";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { Chats } from "../src/chats.ts";
import { CHECK_IN_MS } from "../src/checkin-settings.ts";
import { IdIndex } from "../src/id-index.ts";
import { type DutyJobRef, type DutyMetric, type DutyRunRecord, parseDutyInput } from "../src/shared/chat-duties.ts";
import { effectiveRun, metricStreaks } from "../src/shared/duty-streak.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";
import { fakeThreads, source } from "./chats-helpers.ts";

// A run's verdict was read before its own job's fixes: on 10-15 chat 01a1164b's 08:09Z check-in counted loose_goals on p447 as a miss after its
// job gave p447 a step. Each run now gets an after-job measure once its job ends. The check-in case below is the same chat's 05:03 KST run, which
// missed finished_open on p421, since the check-in is no longer judged on loose_goals.

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/duty-after-01a1164b.json", import.meta.url), "utf8")) as {
  checkInRun: DutyRunRecord; stepsAt0503: string[]; boardAfter: ChatBoard;
  d6: { id: string; name: string; ownerWords: string; goal: string; metrics: DutyMetric[]; onMiss: string }; d6Runs: [DutyRunRecord, DutyRunRecord];
};
const [P421, P453] = FIXTURE.boardAfter.plan as [PlanItem, PlanItem];
/**
 * p421 as the 05:03 run found it: doing, with every step it had then closed. That run flagged it for its closed steps; a check-in now reads an
 * item as done only on a fact, so here it fixes d6's usable_pct_1h, which d6's last run met.
 */
const lookingDone = (): PlanItem => ({ ...P421, status: "doing", duty: "d6/usable_pct_1h", children: P421.children.filter(step => FIXTURE.stepsAt0503.includes(step.id)) });
const d6Met: DutyRunRecord = { duty: "d6", at: FIXTURE.checkInRun.at - 60_000, trigger: "schedule", ms: 1, verdict: "met", summary: "",
  metrics: { usable_pct_1h: { value: 100, target: 100, op: ">=", met: true } } };

function fakeJobs() {
  const calls: string[] = [];
  const ended = new Set<string>();
  let next = 0;
  const host: DutyJobHost = {
    async chat(chatId): Promise<DutyChat> { return { id: chatId, name: "AI harness developer environment", cwd: "/repo", board: `/boards/${chatId}.json` }; },
    async working(job) { return !ended.has(job.id); },
    async start(_chat, name): Promise<DutyJobRef> { const id = `s${++next}`; calls.push(`start ${id}`); return { id, name }; },
    async retire(job) { calls.push(`retire ${job.id}`); },
    async ended(last, older = []) { return [...last, ...older].filter(job => ended.has(job.id)); },
    async stop(job) { calls.push(`stop ${job.id}`); },
  };
  return { host, calls, ended };
}

async function checkInChat(now: { at: number }) {
  const dir = await mkdtemp(join(tmpdir(), "duty-after-"));
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  const board: ChatBoard = { ...FIXTURE.boardAfter, plan: [lookingDone()] };
  const jobs = fakeJobs();
  const store = new DutyStore(dir);
  let chats: Chats | undefined;
  const duties = new Duties(store, { isChat: async id => id === "c1", jobs: jobs.host, now: () => now.at, tickMs: 0,
    checkIn: { view: async () => null, run: async () => {}, set: async () => null, measure: id => chats!.measureCheckIn(id) } });
  chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, { c1: board }, () => now.at), duty: duties, dutyRuns: async () => [d6Met] });
  await chats.adopt();
  threads.fire().live("c1", []);
  await chats.settled();
  calls.length = 0;
  return { dir, calls, board, jobs, store, duties, chats };
}

test("after-job measure: 01a1164b's 05:03 check-in missed finished_open on p421; once its job closed p421 and ended, the run reads met", async () => {
  const now = { at: FIXTURE.checkInRun.at };
  const { dir, calls, board, jobs, store, duties, chats } = await checkInChat(now);
  await chats.checkIn("c1");
  const [run] = await store.runs("c1");
  assert.equal(run!.verdict, "missed");
  assert.deepEqual(run!.metrics.finished_open, { value: 1, target: 0, op: "<=", met: false });
  assert.deepEqual(run!.flagged!.filter(slice => slice.kind === "finished_open").map(slice => slice.item), [P421.id], "the item the live run flagged");
  const memory = await readFile(join(dir, "check-ins.json"), "utf8");

  board.plan = [P421];
  now.at += 25 * 60_000;
  await duties.tick();
  assert.equal((await store.runs("c1"))[0]!.after, undefined, "a job still at work is not measured");
  jobs.ended.add("s1");
  now.at += 60_000;
  await duties.tick();
  const [after] = await store.runs("c1");
  assert.equal(after!.verdict, "missed", "the run's own measure is kept");
  assert.equal(after!.after?.at, now.at);
  assert.equal(after!.after?.verdict, "met");
  assert.deepEqual(after!.after?.metrics.finished_open, { value: 0, target: 0, op: "<=", met: true });
  assert.equal(effectiveRun(after!).verdict, "met");
  assert.deepEqual(metricStreaks([after!]), [], "no miss streak");
  assert.deepEqual(jobs.calls, ["start s1", "stop s1"], "measured, then archived");
  assert.equal(await readFile(join(dir, "check-ins.json"), "utf8"), memory, "the measure writes no check-in memory");
  assert.deepEqual(calls, [], "the measure sends the chat nothing");

  const at = now.at;
  now.at += 60_000;
  await duties.tick();
  assert.equal((await store.runs("c1"))[0]!.after?.at, at, "each run is measured once");
  chats.close();
  duties.close();
});

test("after-job measure: a check-in job still working at the next slot is retired by that run, and the new run's measure is the old run's after", async () => {
  const now = { at: FIXTURE.checkInRun.at };
  const { board, jobs, store, duties, chats } = await checkInChat(now);
  board.plan = [lookingDone(), P453];
  await chats.checkIn("c1");
  board.plan = [P421, P453];
  now.at += CHECK_IN_MS + 60_000;
  await chats.checkIn("c1");
  const [second, first] = await store.runs("c1");
  assert.deepEqual(jobs.calls, ["start s1", "retire s1", "start s2"], "the stuck job is retired and replaced");
  assert.match(second!.summary, /replaced stuck job/);
  assert.equal(first!.metrics.finished_open?.met, false);
  assert.deepEqual(first!.after, { at: second!.at, verdict: second!.verdict, metrics: second!.metrics, summary: second!.summary.replace(/ \(replaced stuck job .*\)$/, "") });
  assert.equal(effectiveRun(first!).metrics.finished_open?.met, true);
  assert.equal(second!.after, undefined, "the new run waits for its own job");
  chats.close();
  duties.close();
});

test("after-job measure: a standing duty reruns its precheck once when its job ends, with the file contract, and keeps no precheck state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-after-standing-"));
  const store = new DutyStore(dir);
  const jobs = fakeJobs();
  const values = join(dir, "values.json");
  const calls = join(dir, "calls.txt");
  const script = join(dir, "precheck.mjs");
  await writeFile(script, `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const state = JSON.parse(readFileSync(process.env.STATE_FILE, "utf8"));
const lastRuns = JSON.parse(readFileSync(process.env.LAST_RUNS_FILE, "utf8"));
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ n: state.n ?? 0, lastRuns: lastRuns.length }) + "\\n");
writeFileSync(process.env.STATE_FILE, JSON.stringify({ n: (state.n ?? 0) + 1 }));
writeFileSync(process.env.OUTPUT_FILE, readFileSync(${JSON.stringify(values)}, "utf8"));
`);
  const output = (run: DutyRunRecord) => JSON.stringify({ metrics: Object.fromEntries(Object.entries(run.metrics).map(([key, result]) => [key, result.value])) });
  const kept = (run: DutyRunRecord) => Object.fromEntries(FIXTURE.d6.metrics.map(metric => [metric.key, run.metrics[metric.key]]));
  const [before, later] = FIXTURE.d6Runs;
  await writeFile(values, output(before));
  const now = { at: before.at };
  await store.update("c1", duties => {
    duties.push(parseDutyInput({ ...FIXTURE.d6, schedule: { kind: "every", minutes: 60 }, precheck: { command: ["node", script], cwd: dir } }, FIXTURE.d6.id, now.at - 60 * 60_000));
  });
  const duties = new Duties(store, { isChat: async id => id === "c1", jobs: jobs.host, now: () => now.at, tickMs: 0 });
  await duties.tick();
  await duties.settled();
  const [run] = await store.runs("c1");
  assert.deepEqual([run!.verdict, run!.metrics], [before.verdict, kept(before)], "the 16:22 run as it was recorded");

  await writeFile(values, output(later));
  jobs.ended.add("s1");
  now.at += 5 * 60_000;
  await duties.tick();
  const [measured] = await store.runs("c1");
  assert.deepEqual([measured!.after?.at, measured!.after?.verdict, measured!.after?.metrics], [now.at, later.verdict, kept(later)], "the after measure is the precheck's new output");
  assert.equal(effectiveRun(measured!).metrics.kernel_waiters_1h?.met, true, "kernel_waiters_1h met after the job");
  const lines = (await readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { n: number; lastRuns: number });
  assert.deepEqual(lines, [{ n: 0, lastRuns: 0 }, { n: 1, lastRuns: 1 }], "one rerun, reading the state the run kept and the run itself");
  assert.deepEqual(JSON.parse(await readFile(join(store.chatDir("c1"), `${FIXTURE.d6.id}.state.json`), "utf8")), { n: 1 }, "the rerun keeps no state");
  assert.deepEqual(jobs.calls, ["start s1", "stop s1"]);
  now.at += 60_000;
  await duties.tick();
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 2, "measured once");
  duties.close();
});

test("DutyStore.updateRun changes one record and keeps every record appended at the same time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-after-store-"));
  const store = new DutyStore(dir);
  const base = FIXTURE.checkInRun;
  await store.appendRun("c1", base);
  const after = { at: base.at + 60_000, verdict: "met" as const, metrics: {}, summary: "all 0 on target" };
  const results = await Promise.all([
    ...Array.from({ length: 20 }, (_, index) => store.appendRun("c1", { ...base, at: base.at + (index + 1) * 1000 })),
    store.updateRun("c1", base.duty, base.at, record => { record.after = after; }),
    ...Array.from({ length: 5 }, (_, index) => store.updateRun("c1", base.duty, base.at + (index + 1) * 1000, record => { record.ms = index; })),
  ]);
  const runs = await store.runs("c1");
  assert.equal(runs.length, 21, "no append is lost");
  assert.deepEqual(runs.find(run => run.at === base.at)?.after, after);
  assert.deepEqual({ ...runs.find(run => run.at === base.at), after: undefined }, { ...base, after: undefined }, "the rest of the record is as it was");
  assert.equal(results[20], true);
  assert.equal(await store.updateRun("c1", base.duty, 1, () => {}), false, "no record matches");
});
