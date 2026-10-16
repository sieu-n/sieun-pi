import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { chatAgents } from "../src/chat-agents.ts";
import { archiveDutyJob, type DutyChat, dutyJobBrief, type DutyJobHost, dutyJobHost, dutyJobName } from "../src/chat-duty-job.ts";
import { OWNER_UI } from "../src/checkin-settings.ts";
import { jobRegistry } from "../src/chat-sources.ts";
import type { SessionRow } from "../src/shared/types.ts";
import { CHECK_IN_FOCUS, type CheckInRun, Duties, STILL_GOING, STILL_WORKING, stuckAfterMs } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { CHECK_IN_DUTY, dailySlot, dutyDue, type DutyJobRef, errorStreak, judge, nextDutyId, nextRunAt, parseDutyInput, parseSchedule, repeatMisses, type Duty,
  type DutyMetric, type DutyRunRecord, metricSizeProblem } from "../src/shared/chat-duties.ts";

const run = promisify(execFile);
const at = (day: number, hours: number, minutes = 0): number => new Date(2026, 9, day, hours, minutes).getTime();
const input = (command: string[] = ["node", "-e", "0"]) => ({
  name: "Chat system", ownerWords: "keep it healthy", goal: "Chats never sit stopped.", onMiss: "Start a job that reads the details and proposes fixes.", boardGoal: "p87",
  metrics: [{ key: "orphans", label: "Orphan steps", op: "<=", target: 0, headline: true }, { key: "long_replies", label: "Long replies", op: "<=", target: 10, unit: "%" }],
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
  assert.deepEqual(judge(metrics, { metrics: { orphans: 0, long_replies: 8 } }).verdict, "met");
  const missed = judge(metrics, { metrics: { orphans: 4, long_replies: 31.25 } });
  assert.equal(missed.verdict, "missed");
  assert.equal(missed.summary, "orphans 4 (target at most 0), long_replies 31.3% (target at most 10%)");
  assert.deepEqual(missed.metrics.orphans, { value: 4, target: 0, op: "<=", met: false });
  assert.deepEqual(judge(metrics, { metrics: { orphans: 0 } }), { verdict: "error", metrics: {}, summary: "the precheck gave no value for long_replies" });
});

test("duty job brief: the duty in the owner's words, the measure as information, the findings, and how a chat job works; no fixed list and no verdict", () => {
  process.env.TZ = "Asia/Seoul";
  const d = duty(0);
  const start = Date.UTC(2026, 9, 9, 5, 0);
  assert.equal(dutyJobName("Check-in", "frontend bro", start), "check-in frontend bro 14:00");
  assert.equal(dutyJobName("Chat system", "AI harness developer environment VP", start), "chat system AI harness developer environment 14:00");
  assert.equal(dutyJobName("Check-in", "***launch main bro***", start), "check-in launch main bro 14:00", "markdown marks are dropped");
  assert.notEqual(dutyJobName("Check-in", "frontend bro", start), dutyJobName("Check-in", "VP of CI", start), "two chats at the same slot get two names (10-09 collision)");
  const brief = dutyJobBrief({ duty: d, chat: { id: "c1", name: "dev VP", board: "/data/boards/c1.json" }, job: "chat system dev VP 14:00", at: start,
    measure: "all 2 on target", findings: "### Flagged\n- orphans p5: p5 sat 3 h", focus: ["Look for open goals with no live job."] });
  assert.equal(brief, `# chat system dev VP 14:00: the Chat system duty of the chat "dev VP"

You are the duty job "chat system dev VP 14:00" of the chat "dev VP" (session id c1), started 2026-10-09 14:00. The server starts one duty job on each scheduled run of this duty, with the precheck below as context. Act as the chat's VP for this duty.

## The duty

Goal: Chats never sit stopped.

Owner's words (verbatim):

> keep it healthy

What to do about a miss: Start a job that reads the details and proposes fixes. Fixes go under the plan item p87.

## Headline KPI
This run is judged on moving one number: Orphan steps (orphans <= 0). Spend the run on the work that moves it most; the other targets and the number of checks you run are detail.

Targets: orphans <= 0 (Orphan steps); long_replies <= 10% (Long replies).

## What the precheck found

Measured against the targets: all 2 on target. This is information, not a verdict: a met target does not mean nothing needs work, and code cannot see everything. Check the real state.

### Flagged
- orphans p5: p5 sat 3 h

## How to work

- The chat's board is the JSON file /data/boards/c1.json: the plan with its step notes and the For you todos with the owner's answers. Read it, then check the real state behind it: the jobs (\`await agent_observe.list_agents()\`, \`await agent_observe.recent_messages(name)\`), the commits, the live pages, and other threads' last messages.
- Fix the issues you find and check what the duty specifies. You decide what to check and what to start from what you find: control flow is decided by agents, not by loops in code.
- Look for open goals with no live job.
- Split work by the job rules: one goal per job, one subagent per unit of output, and work of 1 to 3 tool calls stays inline. Start subagents with \`await rlm.spawn(brief, name=...)\`, all at once, each brief ending with \`await agent_message.send(report, receiver_role="parent")\`; end your turn, read each reply as it comes, and delete each subagent after its report. Work for another repository goes to \`await rlm.create_session(brief, name=..., cwd=...)\`.
- Map the chat's work as a graph: one job or subagent per part, never steps piled on one old long-running session; when the findings list a session that carries too much, move its steps to new jobs per part. Heartbeats the check-in covers go: name each for the chat to delete.
- You can message another thread yourself to chase it: \`await agent_message.send(text, receiver_role="sibling", receiver_name=<thread name>)\`.
- Apply each board change to the chat's board yourself in this run, with \`import json, shlex\` and \`await bash("cd ${join(import.meta.dirname, "..")} && node --import tsx scripts/board-apply.ts c1 " + shlex.quote(json.dumps(ops)) + " --data-dir /data")\`, where ops is a list of chat_board ops like \`[{"op":"plan_update","id":"p4","status":"done","note":"live on production at 4f1c2a, checked on the live page"}]\`. It refuses what chat_board refuses and prints each op's summary. Close a step only on evidence you name in its note. A step whose run, probe, land or push has not finished green and landed stays open with its job, which is a live owner.
- Every stuck step needs a live owner, a For you todo, or a close in this run. Give a step an owner that outlives this run with \`await rlm.create_session(brief, name=..., cwd=...)\`, which registers the session as a job of the chat, and set the step's job to that name in the same board change. A subagent you spawn is archived when the next run retires you, so spawn only for work that ends inside this run.
- Two hard gates hold for every chat. A step marked as needing the owner's go moves only after the owner answers its For you todo with a go (a step whose only target is staging never needs one): never start, steer or report work on it as approved before that, and stop a job that started without it. A Build step starts only after its goal's requirements check: a plan or design job's report quotes the original owner request and checks each line of it against the design before build.
- Never ask the owner to confirm a staging land, merge or deploy: do it on your own (owner 10-12). Owner rule c74 (2026-10-15): Until the proper launch, the owner pre-approves every prod promote, merge or push to main. Never put a promote, merge or push go on For you and never wait for one; the release owner promotes as soon as staging checks out. The board gate and the global-rules merge guard pass a merge, a push to main or master and a promote with no For you todo and no OWNER_OK. An outside send (an email, a ticket or support reply, a customer message, a post) still needs the owner's ok on a For you todo first (c37).
- A goal can carry a target: when you measure it, apply plan_update with its whole target, like \`{"op":"plan_update","id":"p1","target":{"metric":"proxy bandwidth used","target":200,"unit":"Mbps","current":8,"measuredAt":"2026-10-09T21:00:00+09:00","source":"proxy dashboard, 24 h average"}}\`. Close the largest gap first: start or steer the job that moves the number.
- Never push a ci/ branch or use --push-ci: build the commit object for auto-sns-agent (\`node scripts/repo/agent/commit.mjs --object-only -m "<type>(<scope>): <what>" <files>\`) and send it to the chat, which asks Fable for a probe slot; code reaches the shared tip only after its own green probe. Every file you touch stays under its light-guard line limit (1,000 lines for most source files); split a file before it would cross it.
- Never cancel or rerun an auto-sns-agent CI run (\`gh run cancel\`, \`gh run rerun\` or their API calls), yours included; a superseded run is cancelled by Fable's loop or its own probe family, so send Fable its id through the chat, and push a fresh run for a new attempt.
- Do what you can reach yourself: Convex data is read or written with \`npx convex run\` or a query using the deploy key and an identity; never ask the owner for his browser or to act as him, and turn such a For you todo into a job.
- Never send anything outside on your own: an email, a vendor or support ticket reply, a customer message or a public post is drafted and put in For you with the draft and choices; it goes out only after the owner approves it there.
- Act directly and ship: do not invent waiting rules, extra review rounds or safety gates of your own; keep only the gates the owner asked for.
- No cap, throttle, timeout, rate or caution line without a measurement, a vendor limit or an incident cited next to the number; remove unbacked ones.
- When nothing needs work, end in one short turn and send nothing; the server keeps this run's record.
- Otherwise send the chat one short report when your work is done, with only what it and the owner need: the headline number, the board ops you applied, at most 3 items in plain words the owner should hear (like "p412 waits on land 37 with no job moving it", never a kind label or a list of step ids) or "nothing for the owner", and the detail file path the findings name. Never paste the full flagged list. Send it with \`await agent_message.send(report, receiver_role="sibling", receiver_name="dev VP")\`.
`);
  assert.doesNotMatch(brief, /verifier per goal|start at least these subagents/i, "no fixed split");
  const record = (verdict: DutyRunRecord["verdict"], metrics: DutyRunRecord["metrics"] = {}): DutyRunRecord => ({ duty: "d1", at: 1, trigger: "schedule", ms: 1, verdict, metrics, summary: "" });
  const miss = record("missed", { orphans: { value: 4, target: 0, op: "<=", met: false }, long_replies: { value: 1, target: 10, op: "<=", met: true } });
  assert.deepEqual(repeatMisses(miss, miss), ["orphans"]);
  assert.deepEqual(repeatMisses(miss, record("met")), []);
  assert.equal(errorStreak([record("error"), record("skipped"), record("error"), record("met"), record("error")]), 2);
  assert.ok(CHECK_IN_FOCUS[0]!.startsWith("Your number is goal_gaps"), "owner 10-15: the check-in job is judged on the goals first");
  assert.ok(CHECK_IN_FOCUS[1]!.includes("add one push step") && CHECK_IN_FOCUS[1]!.includes("never start a second"), "one owner job per goal, steered when alive");
  assert.ok(CHECK_IN_FOCUS[2]!.startsWith("Then the steps") && CHECK_IN_FOCUS[2]!.includes("plan_update parent"), "the stuck steps and c44's plan upkeep come second");
  assert.ok(CHECK_IN_FOCUS[3]!.startsWith("A goal held only by other threads") && CHECK_IN_FOCUS[3]!.includes("send the holding thread the leftover in one message"),
    "c45: the check-in job closes or hands off a goal that only waits on another thread");
});

test("parseDutyInput: refuses a bad schedule, metric or board goal; nextDutyId never reuses an id", () => {
  assert.throws(() => parseDutyInput({ ...input(), schedule: { kind: "daily", at: "25:00" } }, "d1", 0), /schedule/);
  assert.throws(() => parseDutyInput({ ...input(), metrics: [{ key: "Bad Key", label: "x", op: "<=", target: 0 }] }, "d1", 0), /metrics\[0\]/);
  assert.throws(() => parseDutyInput({ ...input(), boardGoal: "goal" }, "d1", 0), /boardGoal/);
  assert.equal(parseDutyInput({ ...input(), precheck: { command: ["x"], cwd: "/", timeoutMs: 999_999 } }, "d1", 0).precheck.timeoutMs, 120_000);
  assert.equal(nextDutyId([duty(0, { id: "d1" }), duty(0, { id: "d4" })]), "d5");
  assert.equal(nextDutyId([]), "d1");
});

test("metricSizeProblem: a duty refuses size counts of text and takes outcomes, time and process memory (owner 10-10, c39)", () => {
  const refused = [
    { key: "biggest_skill_words", label: "Words in the biggest skill" },
    { key: "skill_md_over_500_lines", label: "SKILL.md files over 500 lines" },
    { key: "skills_over_budget", label: "Skills over 5000 words" },
    { key: "prompt_size", label: "Prompt tokens in the brief" },
    { key: "doc_bytes", label: "Docs on disk" },
    { key: "brief_chars", label: "Brief length" },
    { key: "memory_text", label: "Characters in harness memories" },
    { key: "skill_files", label: "Total file size of skills" },
    { key: "brief_length", label: "Length of the brief", unit: " lines" },
    { key: "code_size", label: "Lines of code in the server" },
    { key: "long_replies", label: "Owner replies over 60 words", unit: "%" },
  ];
  for (const metric of refused) {
    assert.match(metricSizeProblem(metric) ?? "", /counts the size of text \(.+\); a duty measures outcomes \(a thing works, a mistake stops repeating\), never the size of text\.$/, metric.key);
    assert.throws(() => parseDutyInput({ ...input(), metrics: [{ ...metric, op: "<=", target: 0 }] }, "d1", 0), /^Error: metrics\[0\]: ".*" counts the size of text/, metric.key);
  }
  const allowed = [
    { key: "wiki_ms", label: "Time for the wiki (localhost:5176) to answer", unit: " ms" },
    { key: "dead_hours", label: "Hours a chat sat on a failed turn", unit: " h" },
    { key: "wiki_footprint_mb", label: "Real memory of the wiki's pm2 process tree", unit: " MB" },
    { key: "skill_smoke_failures", label: "Skills that fail their smoke check" },
    { key: "repeat_corrections_7d", label: "Owner corrections given again in 7 days (ledger repeats)" },
    { key: "unread_14d", label: "Tracked skills no agent read in 14 days" },
    { key: "orphan_steps", label: "Open steps with no live owner, todo or wait" },
    { key: "pipeline_failures", label: "Failed pipeline runs before the deadline" },
    { key: "slop_replies", label: "Owner replies with labels, dashes, jargon or abstract words" },
    { key: "unlinked_job_mentions", label: "Messages to the owner naming a job with no job: link" },
  ];
  for (const metric of allowed) {
    assert.equal(metricSizeProblem(metric), null, metric.key);
    assert.doesNotThrow(() => parseDutyInput({ ...input(), metrics: [{ ...metric, op: "<=", target: 0 }] }, "d1", 0), metric.key);
  }
});

test("every shipped duty file passes the size check", async () => {
  const dir = join(import.meta.dirname, "..", "scripts", "duties");
  for (const file of (await readdir(dir)).filter(name => name.endsWith(".duty.json"))) {
    const { metrics } = JSON.parse(await readFile(join(dir, file), "utf8")) as { metrics: DutyMetric[] };
    for (const metric of metrics) assert.equal(metricSizeProblem(metric), null, `${file} ${metric.key}`);
  }
});

const script = (body: string) => ["node", "-e", body];
const writeOutput = (metrics: Record<string, number>) => `require("fs").writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: ${JSON.stringify(metrics)}, flagged: [] }))`;

/** A fake duty job host: every start and retire in order, the briefs, and the jobs that still work. */
function fakeJobs() {
  const calls: string[] = [];
  const briefs: string[] = [];
  const working = new Set<string>();
  let next = 0;
  const host: DutyJobHost = {
    async chat(chatId): Promise<DutyChat> { return { id: chatId, name: "dev VP", cwd: "/repo", board: `/boards/${chatId}.json` }; },
    async working(job) { return working.has(job.id); },
    async start(chat, name, brief): Promise<DutyJobRef> { const id = `s${++next}`; calls.push(`start ${chat.id} ${name} ${id}`); briefs.push(brief); return { id, name }; },
    async retire(job) { calls.push(`retire ${job.id}`); },
  };
  return { host, calls, briefs, working };
}

async function setup(command: string[], now: { at: number }) {
  const dir = await mkdtemp(join(tmpdir(), "duties-"));
  const store = new DutyStore(dir);
  const jobs = fakeJobs();
  await store.update("chat1", duties => { duties.push({ ...parseDutyInput(input(command), "d1", at(8, 17)) }); });
  const duties = new Duties(store, { isChat: async id => id === "chat1", jobs: jobs.host, now: () => now.at, tickMs: 0 });
  return { dir, store, jobs, duties };
}

test("Duties: a met run still starts one duty job with the precheck in its brief; a covered slot does not run twice", async () => {
  const now = { at: at(8, 23, 7) };
  const { dir, store, jobs, duties } = await setup(script(writeOutput({ orphans: 0, long_replies: 5 })), now);
  await duties.tick();
  await duties.settled();
  const [run] = await store.runs("chat1");
  assert.equal(run?.verdict, "met", JSON.stringify(run));
  assert.equal(run.summary, "orphans 0 (on target); all 2 on target");
  assert.deepEqual(run.job, { id: "s1", name: "chat system dev VP 23:07" });
  assert.equal(run.slot, at(8, 23, 7));
  assert.deepEqual(jobs.calls, ["start chat1 chat system dev VP 23:07 s1"], "met is no reason to stay quiet: the job judges");
  assert.match(jobs.briefs[0]!, /Measured against the targets: orphans 0 \(on target\); all 2 on target\. This is information, not a verdict/);
  assert.match(jobs.briefs[0]!, /The headline number this run is orphans at 0, target at most 0 \(Orphan steps\)\.\n\nNo flagged items\./);
  assert.match(jobs.briefs[0]!, /Every flagged item and the full precheck are in .*d1-261008-2307\.flagged\.md\./);
  assert.match(await readFile(join(dir, "duties", "chat1", "d1-261008-2307.flagged.md"), "utf8"), /The full precheck output is .*d1-261008-2307\.json\./);
  const [d1] = await store.list("chat1");
  assert.deepEqual([d1!.runCount, d1!.lastRunAt, d1!.lastSlotAt], [1, at(8, 23, 7), at(8, 23, 7)]);
  now.at = at(8, 23, 30);
  await duties.tick();
  await duties.settled();
  assert.equal((await store.runs("chat1")).length, 1);
  assert.equal(jobs.calls.length, 1);
  const [view] = await duties.view("chat1");
  assert.deepEqual([view!.nextAt, view!.running, view!.runs.length], [at(9, 23, 7), false, 1]);
});

test("Duties: a miss starts the job with the flagged items and the repeat; the precheck's state advances only on success; the next run archives the last job", async () => {
  const now = { at: at(8, 23, 7) };
  const body = `const fs = require("fs"); const s = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8")); fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ n: (s.n ?? 0) + 1 })); ` +
    `fs.writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { orphans: 3, long_replies: 5 }, flagged: [{ kind: "orphans", item: "p5", excerpt: "p5 sat 3 h" }] }))`;
  const { dir, store, jobs, duties } = await setup(script(body), now);
  assert.equal(await duties.runNow("chat1", "d1"), true);
  assert.equal(await duties.runNow("chat1", "d1"), false, "a run going now is not started twice");
  await duties.settled();
  assert.equal(jobs.briefs.length, 1);
  assert.match(jobs.briefs[0]!, /Measured against the targets: orphans 3 \(target at most 0\)\./);
  assert.match(jobs.briefs[0]!, /1 flagged item; the first 1:\n- p5 sat 3 h\n/);
  assert.match(await readFile(join(dir, "duties", "chat1", "d1-261008-2307.flagged.md"), "utf8"), /### Flagged \(1\)\n- orphans p5: p5 sat 3 h/);
  const [run] = await store.runs("chat1");
  assert.deepEqual([run!.verdict, run!.trigger, run!.job?.name], ["missed", "owner", "chat system dev VP 23:07"]);
  assert.deepEqual(JSON.parse(await readFile(run!.detail!, "utf8")).metrics, { orphans: 3, long_replies: 5 });
  assert.deepEqual(JSON.parse(await readFile(join(dir, "duties", "chat1", "d1.state.json"), "utf8")), { n: 1 });
  now.at = at(9, 23, 7);
  await duties.runNow("chat1", "d1");
  await duties.settled();
  assert.match(jobs.briefs[1]!, /- orphans \(.*\) is 3, target <= 0, missed 2 runs in a row, not moving toward the target\. No plan step fixes it\./);
  assert.deepEqual(jobs.calls, ["start chat1 chat system dev VP 23:07 s1", "retire s1", "start chat1 chat system dev VP 23:07 s2"], "the last job is archived when the next starts");
});

test("Duties: while the last duty job still works a run still measures but starts no job; the run after it ends starts one", async () => {
  const now = { at: at(8, 23, 7) };
  const { store, jobs, duties } = await setup(script(writeOutput({ orphans: 0, long_replies: 5 })), now);
  await store.update("chat1", list => { list[0]!.schedule = { kind: "every", minutes: 15 }; list[0]!.createdAt = now.at - 15 * 60_000; });
  await duties.tick();
  await duties.settled();
  jobs.working.add("s1");
  now.at += 15 * 60_000;
  await duties.tick();
  await duties.settled();
  const [waited] = await store.runs("chat1");
  assert.deepEqual([waited!.verdict, waited!.summary, waited!.job, waited!.metrics.orphans?.value],
    ["met", `orphans 0 (on target); all 2 on target; ${STILL_WORKING} (job chat system dev VP 23:07)`, undefined, 0], "the precheck ran while the job worked (ops guy 10-12: 220 of 293 runs had none)");
  assert.equal((await store.list("chat1"))[0]!.lastRunAt, now.at, "the run covers the slot: the next tick does not retry it");
  await duties.tick();
  await duties.settled();
  assert.equal((await store.runs("chat1")).length, 2);
  jobs.working.delete("s1");
  now.at += 15 * 60_000;
  await duties.tick();
  await duties.settled();
  assert.deepEqual(jobs.calls, ["start chat1 chat system dev VP 23:07 s1", "retire s1", "start chat1 chat system dev VP 23:37 s2"]);
});

test("Duties: three precheck errors in a row pause the duty and its job is told to fix the precheck; resume skips the slots missed while paused", async () => {
  const now = { at: at(8, 23, 7) };
  const { store, jobs, duties } = await setup(script("process.stderr.write('boom'); process.exit(2)"), now);
  for (let day = 8; day <= 10; day++) {
    now.at = at(day, 23, 7);
    await duties.tick();
    await duties.settled();
  }
  const runs = await store.runs("chat1");
  assert.deepEqual(runs.map(run => [run.verdict, run.error]), [["error", "exit 2: boom"], ["error", "exit 2: boom"], ["error", "exit 2: boom"]]);
  assert.equal((await store.list("chat1"))[0]!.status, "paused");
  assert.match(jobs.briefs[2]!, /The precheck failed: exit 2: boom\. It failed 3 runs in a row and the duty is paused until resumed/);
  assert.match(jobs.briefs[1]!, /The precheck failed: exit 2: boom\. Fix the precheck or check the duty by hand\./);
  now.at = at(11, 23, 7);
  await duties.tick();
  await duties.settled();
  assert.equal((await store.runs("chat1")).length, 3, "a paused duty does not run on schedule");
  now.at = at(12, 9);
  assert.equal(await duties.setStatus("chat1", "d1", "active", OWNER_UI), true);
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
  now.at += 60_000;
  await duties.runNow("chat1", "d1");
  await duties.settled();
  assert.equal((await store.runs("chat1"))[0]!.error, "timed out after 0 s");
  await store.update("chat1", list => { list[0]!.precheck.command = script("require('fs').writeFileSync(process.env.OUTPUT_FILE, 'nope')"); list[0]!.precheck.timeoutMs = 5000; });
  now.at += 60_000;
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
  const duties = new Duties(store, { isChat: async () => true, jobs: fakeJobs().host, tickMs: 0, now: () => now,
    checkIn: { view: async id => id === "chat1" ? view() : null, run: async () => {},
      set: async (_id, change) => { changes.push(change); if (change.everyMs !== undefined) setting.everyMs = change.everyMs; if (change.pause !== undefined) setting.pausedUntil = change.pause === null ? null : "forever"; return view(); } } });

  let views = await duties.view("chat1");
  assert.deepEqual(views.map(entry => [entry.duty.id, entry.builtin ?? "", entry.schedule, entry.paused]),
    [["checkin", "checkin", { kind: "every", minutes: 15 }, false], ["d1", "", { kind: "daily", at: "23:07" }, false]], "the check-in comes first, built in, on the chat's setting");
  assert.equal(views[0]!.duty.name, "Check-in");

  assert.equal(await duties.setSchedule("chat1", "checkin", { kind: "every", minutes: 30 }, OWNER_UI), true);
  assert.deepEqual(changes.at(-1), { everyMs: 30 * 60_000 }, "the card's cadence writes the check-in setting the header's control writes");
  await assert.rejects(duties.setSchedule("chat1", "checkin", { kind: "daily", at: "09:00" }, OWNER_UI), /every 1 to 240 minutes/);
  await assert.rejects(duties.setSchedule("chat1", "checkin", { kind: "every", minutes: 241 }, OWNER_UI), /every 1 to 240 minutes/);
  assert.equal(await duties.setStatus("chat1", "checkin", "paused", OWNER_UI), true);
  assert.deepEqual(changes.at(-1), { pause: "forever" });
  views = await duties.view("chat1");
  assert.deepEqual([views[0]!.paused, views[0]!.duty.status, views[0]!.nextAt], [true, "paused", null]);
  assert.equal(await duties.setStatus("chat1", "checkin", "active", OWNER_UI), true);
  assert.deepEqual(changes.at(-1), { pause: null });

  assert.equal(await duties.setSchedule("chat1", "d1", { kind: "daily", at: "07:30" }, OWNER_UI), true);
  let [d1] = await store.list("chat1");
  assert.deepEqual([d1!.schedule, d1!.lastSlotAt], [{ kind: "daily", at: "07:30" }, at(9, 7, 30)], "today's 07:30 already passed: no catch-up run for a cadence change");
  assert.equal(dutyDue(d1!, now).kind, "no");
  assert.equal(nextRunAt(d1!, now), at(10, 7, 30));
  assert.equal(await duties.setSchedule("chat1", "d1", { kind: "every", minutes: 45 }, OWNER_UI), true);
  [d1] = await store.list("chat1");
  assert.deepEqual(d1!.schedule, { kind: "every", minutes: 45 });
  assert.throws(() => parseSchedule({ kind: "every", minutes: 4 }), /5 to 10080/);
  await assert.rejects(duties.setSchedule("chat1", "d1", { kind: "daily", at: "25:00" }, OWNER_UI), /schedule/);
  assert.equal(await duties.setSchedule("chat1", "d9", { kind: "every", minutes: 45 }, OWNER_UI), false);
  const agent = { by: "agent", setter: "s-agent" } as const;
  assert.equal(await duties.setSchedule("chat1", "d1", { kind: "every", minutes: 60 }, agent), true, "an agent's cadence is taken; c66 is text");
  assert.deepEqual((await store.list("chat1"))[0]!.schedule, { kind: "every", minutes: 60 });
  assert.equal(await duties.setSchedule("chat1", "checkin", { kind: "every", minutes: 20 }, agent), true, "the check-in keeps its own cadence");
  assert.deepEqual(changes.at(-1), { everyMs: 20 * 60_000 });
  now = at(9, 19);
  duties.close();
});

test("check-in duty: each run starts one check-in job with the findings; the same slot twice starts one; a run while the last job works is skipped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duties-checkin-"));
  const store = new DutyStore(dir);
  const now = at(9, 18);
  const jobs = fakeJobs();
  const duties = new Duties(store, { isChat: async () => true, jobs: jobs.host, tickMs: 0, now: () => now });
  const quiet = { orphan_steps: 0, due_late: 0, stale_chase_24h: 0, job_end_unrecorded: 0, job_end_silent: 0, scope_misses: 0, idle_goals: 0, stalled_steps: 0, go_missing: 0, requirements_missing: 0, goal_gaps: 0, blocked_on_others: 0,
    finished_open: 0, loose_goals: 0, extra_goals: 0, open_under_closed: 0,
    held_elsewhere: 0, wait_met: 0, no_progress: 0, stale_steps: 0, goals_to_fold: 0, merges_without_go: 0, one_session_load: 0, redundant_heartbeats: 0, goals_without_duty: 0, stuck_steps: 0 };
  const run = (minutes: number, metrics = quiet): CheckInRun => ({ at: now + minutes * 60_000, trigger: "schedule", everyMs: 15 * 60_000, output: { metrics, flagged: [] }, classes: { live: 2 },
    findings: "### Every open step, oldest change first\n- p2 (live) \"Build\" doing" });
  await duties.checkIn("chat1", run(0));
  assert.deepEqual(jobs.calls, ["start chat1 check-in dev VP 18:00 s1"], "all targets met: the job still starts");
  assert.match(jobs.briefs[0]!, /^# check-in dev VP 18:00: the Check-in duty of the chat "dev VP"/);
  assert.match(jobs.briefs[0]!, /Goal: The check-in pushes every open goal to its outcome/);
  assert.match(jobs.briefs[0]!, /> YES\. it - checks and synchronizes the agent swarm with user intent/);
  assert.match(jobs.briefs[0]!, /Measured against the targets: goal_gaps 0 \(on target\); all 4 on target\./);
  assert.doesNotMatch(jobs.briefs[0]!, /### Every open step/, "the full precheck stays in the detail file");
  assert.match(await readFile(join(dir, "duties", "chat1", "checkin-261009-1800.flagged.md"), "utf8"), /### Every open step, oldest change first\n- p2 \(live\) "Build" doing/);
  assert.match(jobs.briefs[0]!, /When nothing needs work, end in one short turn and send nothing/);
  for (const line of CHECK_IN_FOCUS) assert.ok(jobs.briefs[0]!.includes(`- ${line}`), line);
  await Promise.all([duties.checkIn("chat1", run(0)), duties.checkIn("chat1", run(0))]);
  assert.equal(jobs.calls.length, 1, "the same slot again, even twice at once, starts no second job");
  jobs.working.add("s1");
  await duties.checkIn("chat1", run(15, { ...quiet, stuck_steps: 1 }));
  assert.equal(jobs.calls.length, 1);
  jobs.working.delete("s1");
  await duties.checkIn("chat1", run(30, { ...quiet, stuck_steps: 1 }));
  assert.deepEqual(jobs.calls, ["start chat1 check-in dev VP 18:00 s1", "retire s1", "start chat1 check-in dev VP 18:30 s2"]);
  const runs = (await store.runs("chat1")).reverse();
  assert.deepEqual(runs.map(entry => [(entry.at - now) / 60_000, entry.verdict, entry.job?.id ?? entry.summary]),
    [[0, "met", "s1"], [15, "skipped", `${STILL_WORKING} (job check-in dev VP 18:00)`], [30, "missed", "s2"]]);
  assert.deepEqual(runs[2]!.metrics.stuck_steps, { value: 1, target: 0, op: "<=", met: false }, "the measure is kept as information");
  assert.deepEqual([(await store.read("chat1")).checkIn?.runCount, (await store.read("chat1")).duties], [3, []]);
  assert.deepEqual(runs[0]!.classes, { live: 2 });
  assert.equal(CHECK_IN_DUTY.metrics.length, 4);
  duties.close();
});

test("check-in: a check-in job still working after 90 min is retired and a new one starts; under 90 min the slot is skipped", async () => {
  const store = new DutyStore(await mkdtemp(join(tmpdir(), "duties-stuck-")));
  const start = at(10, 19, 12);
  const jobs = fakeJobs();
  let now = start;
  const duties = new Duties(store, { isChat: async () => true, jobs: jobs.host, tickMs: 0, now: () => now });
  const run = async (minutes: number) => { now = start + minutes * 60_000; await duties.checkIn("chat1", { at: now, trigger: "schedule", everyMs: 30 * 60_000, output: { metrics: {}, flagged: [] }, classes: {}, findings: "" }); };
  await run(0);
  jobs.working.add("s1");
  await run(60);
  await run(90);
  assert.deepEqual(jobs.calls, ["start chat1 check-in dev VP 19:12 s1"], "a job working 90 min or less keeps its slot");
  await run(91);
  assert.deepEqual(jobs.calls, ["start chat1 check-in dev VP 19:12 s1", "retire s1", "start chat1 check-in dev VP 20:43 s2"]);
  const runs = (await store.runs("chat1")).reverse();
  assert.deepEqual(runs.map(entry => [(entry.at - start) / 60_000, entry.job?.id ?? entry.summary]), [
    [0, "s1"], [60, `${STILL_WORKING} (job check-in dev VP 19:12)`], [90, `${STILL_WORKING} (job check-in dev VP 19:12)`], [91, "s2"]]);
  assert.match(runs[3]!.summary, / \(replaced stuck job check-in dev VP 19:12, working 91 min\)$/, "the replacement shows on the run");
  duties.close();
});

test("stuckAfterMs: one interval, at least 90 min and at most 12 h", () => {
  assert.deepEqual([{ kind: "every", minutes: 10 } as const, { kind: "every", minutes: 120 } as const, { kind: "every", minutes: 240 } as const,
    { kind: "every", minutes: 7 * 24 * 60 } as const, { kind: "daily", at: "23:07" } as const].map(schedule => stuckAfterMs(schedule) / 60_000), [90, 120, 240, 720, 720]);
});

test("Duties: a daily duty whose last job still works a day later retires it and starts a new one (AI harness VP 10-11: three daily runs skipped)", async () => {
  const now = { at: at(8, 23, 7) };
  const { store, jobs, duties } = await setup(script(writeOutput({ orphans: 0, long_replies: 5 })), now);
  await duties.tick();
  await duties.settled();
  jobs.working.add("s1");
  now.at = at(9, 23, 7);
  await duties.tick();
  await duties.settled();
  assert.deepEqual(jobs.calls, ["start chat1 chat system dev VP 23:07 s1", "retire s1", "start chat1 chat system dev VP 23:07 s2"]);
  const [last] = await store.runs("chat1");
  assert.deepEqual([last!.verdict, last!.job?.id], ["met", "s2"]);
  assert.match(last!.summary, / \(replaced stuck job chat system dev VP 23:07, working 1440 min\)$/);
  duties.close();
});

test("Duties: a 10-minute duty measures but starts no job while its job works up to 90 min, then the next run replaces the job (ops guy 10-11: 17 h of skips)", async () => {
  const now = { at: at(8, 23, 7) };
  const { store, jobs, duties } = await setup(script(writeOutput({ orphans: 0, long_replies: 5 })), now);
  await store.update("chat1", list => { list[0]!.schedule = { kind: "every", minutes: 10 }; list[0]!.createdAt = now.at - 10 * 60_000; });
  const start = now.at;
  const tickAt = async (minutes: number) => { now.at = start + minutes * 60_000; await duties.tick(); await duties.settled(); };
  await tickAt(0);
  jobs.working.add("s1");
  await tickAt(80);
  await tickAt(90);
  assert.deepEqual(jobs.calls, ["start chat1 chat system dev VP 23:07 s1"], "a job working 90 min or less keeps the duty");
  await tickAt(100);
  assert.deepEqual(jobs.calls, ["start chat1 chat system dev VP 23:07 s1", "retire s1", "start chat1 chat system dev VP 00:47 s2"]);
  const runs = (await store.runs("chat1")).reverse();
  assert.deepEqual(runs.map(entry => [(entry.at - start) / 60_000, entry.verdict, entry.job?.id ?? entry.summary]), [
    [0, "met", "s1"], [80, "met", `orphans 0 (on target); all 2 on target; ${STILL_WORKING} (job chat system dev VP 23:07)`],
    [90, "met", `orphans 0 (on target); all 2 on target; ${STILL_WORKING} (job chat system dev VP 23:07)`], [100, "met", "s2"]]);
  assert.match(runs[3]!.summary, / \(replaced stuck job chat system dev VP 23:07, working 100 min\)$/);
  duties.close();
});

test("Duties: a slot that comes while the last run still starts its job gets a skipped record, once per slot (ops guy 10-12: the 14:45Z slot left none)", async () => {
  const now = { at: at(8, 23, 7) };
  const { store, jobs, duties } = await setup(script(writeOutput({ orphans: 0, long_replies: 5 })), now);
  await store.update("chat1", list => { list[0]!.schedule = { kind: "every", minutes: 10 }; list[0]!.createdAt = now.at - 10 * 60_000; });
  let release = () => {};
  let started = () => {};
  const starting = new Promise<void>(resolve => { started = resolve; });
  const fast = jobs.host.start;
  jobs.host.start = async (...args) => { started(); await new Promise<void>(resolve => { release = resolve; }); jobs.host.start = fast; return fast(...args); };
  const start = now.at;
  const tickAt = async (minutes: number) => { now.at = start + minutes * 60_000; await duties.tick(); };
  await tickAt(0);
  await starting;
  for (const minutes of [5, 10, 10.5, 15, 20]) await tickAt(minutes);
  release();
  await duties.settled();
  await tickAt(30);
  await duties.settled();
  const runs = (await store.runs("chat1")).reverse();
  assert.deepEqual(runs.map(entry => [(entry.at - start) / 60_000, entry.verdict, entry.job?.id ?? entry.summary]), [
    [0, "met", "s1"], [10, "skipped", `${STILL_GOING} starting its job (run of 23:07, 600 s ago)`],
    [20, "skipped", `${STILL_GOING} starting its job (run of 23:07, 1200 s ago)`], [30, "met", "s2"]], "slots 0, 10, 20 and 30 each have one record, the run's own before its job starts");
  duties.close();
});

test("duty store remove: a duty's definition, runs and saved files go; the second run finds nothing; remove.ts by name is idempotent and leaves other duties", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duties-remove-"));
  const store = new DutyStore(dir);
  for (const chat of ["c1", "c2"]) {
    await store.update(chat, duties => {
      duties.push({ ...parseDutyInput(input(), "d1", 0), name: "Board convergence" });
      if (chat === "c2") duties.push(parseDutyInput(input(), "d2", 0));
    });
    for (const id of ["d1", "d2"]) await store.appendRun(chat, { duty: id, at: 1, trigger: "schedule", ms: 0, verdict: "met", metrics: {}, summary: "" });
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

test("rename.ts: renames a live duty in place, keeping its id, run count and schedule; a second run changes nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duties-rename-"));
  const store = new DutyStore(dir);
  await store.update("c1", duties => { duties.push({ ...parseDutyInput(input(), "d3", 0), name: "Chat health", runCount: 7, lastRunAt: 5 }); });
  const script = (...args: string[]) => run(process.execPath, ["--import", "tsx", "scripts/duties/rename.ts", "c1", ...args, "--data-dir", dir],
    { cwd: join(import.meta.dirname, "..") });
  assert.equal((await script("Chat health", "Chat system")).stdout, "renamed d3 in c1\n");
  assert.equal((await script("Chat health", "Chat system")).stdout, "unchanged d3 in c1\n", "a second run changes nothing");
  const [renamed] = await store.list("c1");
  assert.deepEqual([renamed!.id, renamed!.name, renamed!.runCount, renamed!.lastRunAt, renamed!.schedule], ["d3", "Chat system", 7, 5, input().schedule]);
});

test("duty job host: a start creates the root in the chat's folder, registers its session id under the chat's name before the brief, so the chat's Agents card links it as a root; retire unregisters and queues the archive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-host-"));
  const registry = jobRegistry(join(dir, "chat-jobs.json"));
  const calls: string[] = [];
  const row = (id: string, name: string, extra: Partial<SessionRow> = {}): SessionRow => ({ id, name, cwd: "/repo/sieun-pi", kind: "live", status: "idle", archived: false,
    messageCount: 1, working: false, subagentsRunning: 0, unread: false, tags: [], priority: 0, progress: "none", ...extra });
  let rows: SessionRow[] = [row("chat1", "dev VP")];
  const host = dutyJobHost({ rows: async () => rows, registry, board: id => `/data/boards/${id}.json`, archives: { async add(job) { calls.push(`queue archive ${job.id}`); } }, threads: {
    async create(input) { calls.push(`create ${input.name} ${input.cwd}`); return { id: "job-1" }; },
    async prompt(id, input) { calls.push(`prompt ${id} ${input.mode} registered:${await registry.chatOf(id)}`); },
  } });
  const chat = await host.chat("chat1");
  assert.deepEqual(chat, { id: "chat1", name: "dev VP", cwd: "/repo/sieun-pi", board: "/data/boards/chat1.json" });
  assert.equal(await host.chat("gone"), null);
  const job = await host.start(chat!, "check-in dev VP 14:00", "brief");
  assert.deepEqual(job, { id: "job-1", name: "check-in dev VP 14:00" });
  assert.deepEqual(calls, ["create check-in dev VP 14:00 /repo/sieun-pi", "prompt job-1 steer registered:dev VP"], "registered before its first message, which the extension reads");
  assert.deepEqual(await registry.rootsOf(["chat1", "dev VP"]), ["job-1"]);
  rows = [...rows, row("job-1", "check-in dev VP 14:00", { working: true, origin: "agent" })];
  const agents = chatAgents({ self: { id: "chat1", name: "dev VP" }, children: [], childSessions: [], board: null, roots: await registry.rootsOf(["chat1", "dev VP"]),
    messages: [], rows: rows.map(entry => ({ row: entry })), now: 0 });
  assert.deepEqual(agents.map(agent => [agent.sessionId, agent.name, agent.link, agent.state]), [["job-1", "check-in dev VP 14:00", "root", "working"]], "it shows in the chat's Agents card");
  assert.equal(await host.working(job), true);
  rows = rows.map(entry => entry.id === "job-1" ? { ...entry, working: false } : entry);
  assert.equal(await host.working(job), false);
  await host.retire(job);
  assert.deepEqual(calls.slice(2), ["queue archive job-1"]);
  assert.deepEqual(await registry.rootsOf(["chat1", "dev VP"]), [], "unregistered: the Agents card lists only the current duty job");
  const archive = archiveDutyJob({ async archive(id) { calls.push(`archive ${id}`); } }, async () => rows);
  await archive("job-1");
  assert.deepEqual(calls.slice(3), ["archive job-1"], "the queue's archive ends a live session");
  rows = rows.map(entry => entry.id === "job-1" ? { ...entry, archived: true } : entry);
  await archive("job-1");
  rows = rows.filter(entry => entry.id !== "job-1");
  assert.equal(await host.working(job), false, "a job that is gone is done");
  await archive("job-1");
  assert.deepEqual(calls.slice(4), [], "an archived or gone job is not archived again");
});

const TIMED_OUT = 'Timed out after 180000ms waiting for the Prime Agent daemon response to "create".';
function slowDaemon(dir: string) {
  const registry = jobRegistry(join(dir, "chat-jobs.json"));
  const row = (id: string, name: string, extra: Partial<SessionRow> = {}): SessionRow => ({ id, name, cwd: "/repo/sieun-pi", kind: "live", status: "idle", archived: false,
    messageCount: 0, working: false, subagentsRunning: 0, unread: false, tags: [], priority: 0, progress: "none", ...extra });
  const state = { rows: [row("chat1", "dev VP")] as SessionRow[], calls: [] as string[], refreshes: 0, sleeps: [] as number[] };
  return { registry, row, state, chat: { id: "chat1", name: "dev VP", cwd: "/repo/sieun-pi", board: "/data/boards/chat1.json" } satisfies DutyChat,
    options: { rows: async () => state.rows, registry, board: (id: string) => `/data/boards/${id}.json`, lookupWaitsMs: [0, 10_000, 20_000],
      archives: { async add(job: DutyJobRef) { state.calls.push(`archive ${job.id}`); } },
      refresh: async () => { state.refreshes++; }, sleep: async (ms: number) => { state.sleeps.push(ms); } } };
}

test("duty job host: a create that times out after the daemon made the session adopts it: one create, registered under the chat, then the brief", async () => {
  const daemon = slowDaemon(await mkdtemp(join(tmpdir(), "duty-host-")));
  const { state } = daemon;
  const host = dutyJobHost({ ...daemon.options, threads: {
    async create(input) {
      state.calls.push(`create ${input.name}`);
      state.rows = [...state.rows, daemon.row("other", input.name, { cwd: "/elsewhere" }), daemon.row("late", input.name)];
      throw new Error(TIMED_OUT);
    },
    async prompt(id, input) { state.calls.push(`prompt ${id} ${input.message} registered:${await daemon.registry.chatOf(id)}`); },
  } });
  const job = await host.start(daemon.chat, "check-in dev VP 01:55", "brief");
  assert.deepEqual(job, { id: "late", name: "check-in dev VP 01:55" });
  assert.deepEqual(state.calls, ["create check-in dev VP 01:55", "prompt late brief registered:dev VP"], "no second create; the session in another folder is not taken");
  assert.deepEqual(await daemon.registry.rootsOf(["chat1", "dev VP"]), ["late"]);
  assert.equal(state.refreshes, 1, "found on the first look, after a fresh session list");
});

test("duty job host: a create that times out with no session creates once more; when that fails too the start fails with the cause, and an already registered session is never adopted", async () => {
  const daemon = slowDaemon(await mkdtemp(join(tmpdir(), "duty-host-")));
  const { state } = daemon;
  await daemon.registry.add(["taken"], "another chat");
  state.rows = [...state.rows, daemon.row("taken", "check-in dev VP 01:55")];
  let creates = 0;
  const threads = {
    async create(input: { name: string }) { creates++; state.calls.push(`create ${input.name}`); if (creates === 1) throw new Error(TIMED_OUT); return { id: "second" }; },
    async prompt(id: string) { state.calls.push(`prompt ${id}`); },
  };
  const job = await dutyJobHost({ ...daemon.options, threads }).start(daemon.chat, "check-in dev VP 01:55", "brief");
  assert.deepEqual(job, { id: "second", name: "check-in dev VP 01:55" });
  assert.deepEqual(state.calls, ["create check-in dev VP 01:55", "create check-in dev VP 01:55", "prompt second"]);
  assert.deepEqual(state.sleeps, [10_000, 20_000], "looked for about the lookup window before the retry");
  state.calls = [];
  const failing = dutyJobHost({ ...daemon.options, threads: { ...threads, async create(input: { name: string }) { state.calls.push(`create ${input.name}`); throw new Error("daemon client closed"); } } });
  await assert.rejects(failing.start(daemon.chat, "check-in dev VP 02:10", "brief"), /no session after 2 creates: daemon client closed/);
  assert.deepEqual(state.calls, ["create check-in dev VP 02:10", "create check-in dev VP 02:10"], "one retry, nothing briefed or archived");
});

test("duty job host: a name an archived job of an earlier day still holds is retried with the date, and the brief carries the new name", async () => {
  const daemon = slowDaemon(await mkdtemp(join(tmpdir(), "duty-host-")));
  const { state } = daemon;
  const threads = {
    async create(input: { name: string }) {
      state.calls.push(`create ${input.name}`);
      if (input.name === "check-in frontend bro 12:39") throw new Error('Agent name "check-in frontend bro 12:39" is unavailable: an agent of that name already exists at depth 0 under this parent');
      return { id: "fresh" };
    },
    async prompt(id: string, input: { message: string }) { state.calls.push(`prompt ${id} ${input.message}`); },
  };
  const job = await dutyJobHost({ ...daemon.options, threads, now: () => at(12, 12, 39) }).start(daemon.chat, "check-in frontend bro 12:39", "# check-in frontend bro 12:39: the Check-in duty");
  assert.deepEqual(job, { id: "fresh", name: "check-in frontend bro 10-12 12:39" });
  assert.deepEqual(state.calls, ["create check-in frontend bro 12:39", "create check-in frontend bro 10-12 12:39", "prompt fresh # check-in frontend bro 10-12 12:39: the Check-in duty"]);
});

test("duty job host: starts from several chats call the daemon's create one at a time", async () => {
  const daemon = slowDaemon(await mkdtemp(join(tmpdir(), "duty-host-")));
  let active = 0;
  let most = 0;
  const order: string[] = [];
  const host = dutyJobHost({ ...daemon.options, threads: {
    async create(input) {
      active++; most = Math.max(most, active); order.push(input.name);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      if (input.name.startsWith("check-in c2")) throw new Error(TIMED_OUT);
      return { id: `id-${input.name}` };
    },
    async prompt() {},
  } });
  const chats = ["c1", "c2", "c3", "c4"].map(id => ({ ...daemon.chat, id, name: id }));
  const results = await Promise.allSettled(chats.map(chat => host.start(chat, `check-in ${chat.name} 01:55`, "brief")));
  assert.equal(most, 1, "never two creates at once");
  assert.deepEqual(order, ["check-in c1 01:55", "check-in c2 01:55", "check-in c2 01:55", "check-in c3 01:55", "check-in c4 01:55"], "in start order, with c2's retry before c3");
  assert.deepEqual(results.map(result => result.status), ["fulfilled", "rejected", "fulfilled", "fulfilled"], "a failed start does not stop the queue");
});

test("duty job host: a session that cannot be registered or briefed is unregistered with its archive queued, and the start fails with the cause", async () => {
  const daemon = slowDaemon(await mkdtemp(join(tmpdir(), "duty-host-")));
  const { state } = daemon;
  const threads = {
    async create() { return { id: "job-1" }; },
    async prompt(id: string) { state.calls.push(`prompt ${id}`); throw new Error("attach timed out"); },
  };
  const broken = { ...daemon.registry, async add() { throw new Error("chat-jobs.json is locked"); } };
  await assert.rejects(dutyJobHost({ ...daemon.options, registry: broken, threads }).start(daemon.chat, "check-in dev VP 01:55", "brief"),
    /session job-1 could not be registered and briefed \(chat-jobs\.json is locked\); queued its archive/);
  assert.deepEqual(state.calls, ["archive job-1"], "no brief to an unregistered session");
  state.calls = [];
  await assert.rejects(dutyJobHost({ ...daemon.options, threads }).start(daemon.chat, "check-in dev VP 02:10", "brief"), /\(attach timed out\); queued its archive/);
  assert.deepEqual(state.calls, ["prompt job-1", "archive job-1"]);
  assert.deepEqual(await daemon.registry.rootsOf(["chat1", "dev VP"]), [], "the archived session leaves the registry");
});
