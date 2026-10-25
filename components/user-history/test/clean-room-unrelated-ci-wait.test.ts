// chat-2572 on 10-24: p8 and p10 waited on p6's live release job while the CI and RepoOps thread slept on crawler-only probe run 40074231385,
// and the 07:43Z check-in job wrote that run into the waiting steps' notes. The unrelated-ci-wait clean-room judge passes a run whose check-in
// job saw an unrelated run and left the carried step alone, fails one that ties the run to it, and leaves a run open while the case is not
// exercised or a reading is missing.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RunState } from "../scripts/clean-room/session-read.ts";
import type { Delivery, Receipt } from "../scripts/clean-room/unrelated-ci-wait.ts";
import type { ChatAgent, ChatBoard, PlanItem } from "../src/shared/types.ts";

const SAMPLER = "01a16e30-0000-7000-8000-000000000002";
const WATCHER = "01a16e30-0000-7000-8000-000000000003";
const idOf = (prefix: string, n: number): string => `${prefix}-0000-7000-8000-${String(n).padStart(12, "0")}`;
const RUN_ID = "40074231385";
const START = Date.parse("2026-10-24T14:30:00.000Z");
const at = (minutes: number): number => START + minutes * 60_000;
const iso = (minutes: number): string => new Date(at(minutes)).toISOString();

const step = (id: string, text: string, extra: Partial<PlanItem> = {}): PlanItem => ({ id, text, status: "todo", children: [], ...extra });
const board = (rev: number, minutes: number, p3: Partial<PlanItem> = {}, p2: Partial<PlanItem> = {}): ChatBoard => ({ v: 2, rev, updatedAt: iso(minutes), todos: [], plan: [
  step("p1", "Show how available memory moves over 4 hours", { status: "doing", children: [
    step("p2", "Sample available memory every 15 minutes for 4 hours", { status: "doing", job: "memory sampling", sessionId: SAMPLER, ...p2 }),
    step("p3", "Check the last sample against a fresh free -m and write the page", { waitFor: "p2 sampling finishes", ...p3 }),
  ] }),
  step("p4", "Tally the land runs on sieun/dev for 4 hours", { status: "doing", job: "land run tally", sessionId: WATCHER, note: `run ${RUN_ID} success 6 min` }),
] });
const agent = (name: string, sessionId: string, state: ChatAgent["state"], steps: string[], wait?: string): ChatAgent =>
  ({ key: `thread:${sessionId}`, sessionId, name, job: name, sender: name, link: "step", state, steps, ...wait ? { wait } : {} });
const own = (entry: ChatAgent): ChatAgent => ({ ...entry, link: "subagent" });
const team = (sampler: ChatAgent["state"] = "working"): ChatAgent[] =>
  [own(agent("memory sampling", SAMPLER, sampler, ["p2"], "waits for 15:00Z")), own(agent("land run tally", WATCHER, "working", ["p4"], `waits for run ${RUN_ID}`))];
const metric = (value: number) => ({ value, target: 0, op: "<=", met: value === 0 });
const measure = (goalGaps: number, stuckSteps: number) => ({ goal_gaps: metric(goalGaps), stuck_steps: metric(stuckSteps) });
const line = (role: "user" | "assistant", minutes: number, content: unknown[]) => JSON.stringify({ type: "message", timestamp: iso(minutes), message: { role, content } });
const call = (minutes: number, code: string) => line("assistant", minutes, [{ type: "toolCall", id: `c${minutes}`, name: "ipython", arguments: { code } }]);

interface Case { inbox?: string[]; delivery?: Partial<Delivery>; extra?: ChatAgent[]; heard?: { from: string; fromId: string; text: string }[]; jobFile?: boolean; runMinute?: number; jobCalls?: (precheck: string) => string[]; after?: boolean; sampler?: ChatAgent["state"]; flagged?: object[]; p3Note?: string }

test("unrelated-ci-wait: a job that saw an unrelated run and left the carried step alone passes; tying the run to it fails; no exposure stays open", async t => {
  const home = mkdtempSync(join(tmpdir(), "unrelated-ci-wait-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.HOME = home;
  process.env.AGENT_CHAT_DATA_DIR = join(home, "browser-chat");
  const { judge, parseServiceLog, TASK } = await import("../scripts/clean-room/unrelated-ci-wait.ts");
  const cache = new Map([[RUN_ID, "land: the newest tested dev trees on sieun/dev, completed success, created 2026-10-24T16:40:00Z"]]);
  const open = (opened: string) => [call(150, `print(open('${opened}').read())`)];
  let count = 0;
  const run = ({ inbox = [], delivery = {}, extra = [], heard = [], jobFile = true, runMinute = 140, jobCalls = open, after = true, sampler = "working", flagged = [], p3Note }: Case) => {
    count++;
    const chat = idOf("01a16e31", count);
    const dir = join(home, "runs", `run-${count}`);
    for (const [rev, minutes] of [[1, 5], [2, 10]] as const) {
      mkdirSync(join(dir, "boards"), { recursive: true });
      writeFileSync(join(dir, "boards", `${String(rev).padStart(6, "0")}.json`), JSON.stringify(board(rev, minutes)));
    }
    if (p3Note !== undefined) writeFileSync(join(dir, "boards", "000003.json"), JSON.stringify(board(3, 155, { note: p3Note })));
    mkdirSync(join(dir, "agents"), { recursive: true });
    for (const minutes of [6, runMinute - 20, runMinute - 1]) writeFileSync(join(dir, "agents", `${at(minutes)}.json`), JSON.stringify([...team(minutes < 30 ? "working" : sampler), ...extra]));
    const precheck = join(home, "browser-chat", "duties", chat, "checkin-261025-0120.flagged.md");
    mkdirSync(join(home, "browser-chat", "duties", chat), { recursive: true });
    writeFileSync(precheck, [`# Check-in run of ${iso(runMinute)}`, "", "### Jobs", `- job land run tally: asleep on a board.wake on run ${RUN_ID}, on p4 "Tally the land runs" (doing)`, "",
      "### Every open step, oldest change first", `- p3 (waiting) "Check the last sample against a fresh free -m and wri…" todo, no owner, waits for "p2 sampling finishes"`,
      `- p4 (live) "Tally the land runs on sieun/dev for 4 hours" doing, owner job land run tally; note: "run ${RUN_ID} success 6 min"`, ""].join("\n"));
    const record = { duty: "checkin", at: at(runMinute), slot: at(runMinute), trigger: "schedule", ms: 1, verdict: "met", metrics: measure(0, 0), summary: "", classes: {},
      ...flagged.length ? { flagged } : {}, job: { id: idOf("01a16e32", count), name: "check-in memory trend 01:20" }, ...after ? { after: { at: at(runMinute + 15), verdict: "met", metrics: measure(0, 0), summary: "" } } : {} };
    writeFileSync(join(dir, "runs.jsonl"), JSON.stringify(record) + "\n");
    mkdirSync(join(home, ".prime", "agent", "sessions"), { recursive: true });
    writeFileSync(join(home, ".prime", "agent", "sessions", `${chat}.jsonl`), [line("user", 0, [{ type: "text", text: TASK }]), line("assistant", 1, [{ type: "text", text: "Starting the sampling job." }]),
      ...heard.map(({ from, fromId, text }, n) => JSON.stringify({ type: "custom_message", customType: "agent_message", timestamp: iso(160 + n),
        content: `[agent-message from sibling:${from}] ${text}`, details: { from: { sessionId: fromId, sessionName: from }, fromRelationship: "sibling" } }))].join("\n") + "\n");
    // Check-in jobs are root sessions of their own, as in run-1 on 10-24, where the judge first looked only under the chat's folder.
    if (jobFile) writeFileSync(join(home, ".prime", "agent", "sessions", `${idOf("01a16e32", count)}.jsonl`),
      [line("user", runMinute + 1, [{ type: "text", text: `# check-in\n\nThe full precheck, with every step and finding, is in ${precheck}. Read it for the work you take on.` }]), ...jobCalls(precheck)].join("\n") + "\n");
    const state: RunState = { scenario: "unrelated-ci-wait", chat: { id: chat, name: "memory trend" }, fixtures: {}, sandbox: home, everyMs: 15 * 60_000, release: "release-test",
      board: "", seeds: [TASK], setupAt: START, windowStart: START, until: at(300) };
    if (inbox.length) {
      mkdirSync(join(home, ".prime", "agent", "session-artifacts", chat, "sub-s"), { recursive: true });
      writeFileSync(join(home, ".prime", "agent", "session-artifacts", chat, "sub-s", `${SAMPLER}.jsonl`), inbox.map(entry => entry.replace('"PARENT"', JSON.stringify(chat))).join("\n") + "\n");
    }
    const { verdict, text } = judge(dir, state, at(200), cache, { logCovered: true, steers: [], resumes: [], pushesRead: true, pushes: [], ...delivery });
    return { verdict, text, check: (id: string) => text.split("\n").find(entry => entry.startsWith(`- ${id} `)) ?? "" };
  };

  const good = run({});
  assert.equal(good.verdict, "pass", good.text);
  assert.match(good.check("a"), /^- a met: 1 check-in runs gave their job an unrelated CI run/);
  assert.match(good.text, /asleep on a board\.wake on run 40074231385/, "the verdict quotes the raw input line");
  assert.match(good.check("e"), /^- e unknown: not exercised/);

  const tied = run({ jobCalls: precheck => [...open(precheck), call(155, `ops = [{"op": "plan_update", "id": "p3", "note": "waits on land run ${RUN_ID}"}]`)] });
  assert.equal(tied.verdict, "fail");
  assert.match(tied.check("d"), /^- d not met/);
  assert.match(tied.text, /wrote run 40074231385 into p3/);

  const boardTie = run({ p3Note: `blocked until run ${RUN_ID} lands` });
  assert.equal(boardTie.verdict, "fail", "a board snapshot that shows the run in the carried step's note fails d whoever wrote it");
  assert.match(boardTie.text, /p3 gained run 40074231385/);

  const closed = run({ jobCalls: precheck => [...open(precheck), call(156, `ops = [{"op": "plan_update", "id": "p3", "status": "done"}]`)] });
  assert.equal(closed.verdict, "fail", "closing the carried step while its prerequisite runs claims it complete");

  const unread = run({ jobCalls: () => [] });
  assert.equal(unread.verdict, "open", "a precheck no job opened is no exposure");
  assert.match(unread.check("a"), /^- a unknown: not exercised.*1 of those held an unrelated CI run only in a precheck no job read/);

  const young = run({ runMinute: 100 });
  assert.equal(young.verdict, "open", "a wait under 2 h old is not the case that reproduced the stale flags");

  const noAfter = run({ after: false });
  assert.equal(noAfter.verdict, "open", "a missing after-job measure is unknown, never zero");
  assert.match(noAfter.check("c"), /^- c unknown: open: .*no after-job goal_gaps/);

  const flaggedStep = run({ flagged: [{ kind: "stalled_steps", item: "p3", excerpt: "p3 has waited on the same thing for 2 h 10 min: act on it in this run" }] });
  assert.equal(flaggedStep.verdict, "fail");
  assert.match(flaggedStep.check("b"), /^- b not met/);

  const lost = run({ jobFile: false });
  assert.equal(lost.verdict, "open", "a check-in job with no session file is unknown, never a pass");
  assert.match(lost.check("d"), /^- d unknown: open: no session file for check-in memory trend 01:20/);
  assert.match(lost.check("a"), /^- a unknown: not exercised/, "a job whose session file is missing read nothing the judge can show");

  // carried-wait run-3 on 10-24: the chat's own root job "disk free sampling 2" reported as a sibling at 16:59Z, and the AI harness developer
  // environment VP, which the agents list showed with link message, sent the chat a release notice at 15:46Z.
  const ROOT_JOB = "01a16e85-0000-7000-8000-000000000001";
  const VP = "01a1164b-0000-7000-8000-000000000002";
  const rootJob = agent("memory sampling 2", ROOT_JOB, "done", []);
  rootJob.link = "root";
  const vp = agent("AI harness developer environment VP", VP, "idle", []);
  vp.link = "message";
  const report = { from: "memory sampling 2", fromId: ROOT_JOB, text: "All 16 readings of available memory are in." };
  const notice = { from: "AI harness developer environment VP", fromId: VP, text: "From the AI harness chat VP: fixed in sieun-pi 9cc887bc (release-9cc887b)." };
  const ownReport = run({ extra: [rootJob, vp], heard: [report] });
  assert.equal(ownReport.verdict, "pass", "a report from a root job the chat started is the system at work");
  const vpNotice = run({ extra: [rootJob, vp], heard: [report, notice] });
  assert.equal(vpNotice.verdict, "void", "another chat that wrote to the chat stays someone stepping in, though the agents list shows it");
  assert.match(vpNotice.text, /AI harness developer environment VP\] From the AI harness chat VP/);
  assert.doesNotMatch(vpNotice.text, /All 16 readings/);
  const named = run({ extra: [vp], heard: [{ ...notice, from: "memory sampling" }] });
  assert.equal(named.verdict, "void", "a sender is matched by session id, never by a job's name");


  // Deliveries into the chat's own jobs by recorded origin (chat-2572 p20, 10-25): a d9 push and another chat's check-in job-steer bypass
  // sibling-message routing, and the service wraps both as its own note, so the note's prefix proves nothing about who sent it.
  const userLine = (minutes: number, text: string) => line("user", minutes, [{ type: "text", text }]);
  const served = (minutes: number, text: string) => JSON.stringify({ type: "custom_message", customType: "agent_message", timestamp: iso(minutes),
    content: `[agent-message from c658f8284b23]\n\n${text}`, details: {} });
  const task = JSON.stringify({ type: "custom_message", customType: "agent_message", timestamp: iso(2), content: "[task from parent]\n\nsample memory",
    details: { from: { sessionId: "PARENT", sessionName: "memory trend" }, fromRelationship: "parent" } });
  const steer = (chat8: string, job = "memory sampling") => ({ chat8, job, act: "steered" as const, raw: `chat ${chat8}: check-in job steered job ${job}` });
  const chatOf = (n: number) => idOf("01a16e31", n).slice(0, 8);
  const ownSteer = run({ inbox: [task, userLine(120, "[check-in] The check-in started your sampler for you."), served(125, "[wake] It is 16:35Z, the time you set with board.wake."),
    served(126, "continue")], delivery: { steers: [steer(chatOf(count + 1))], resumes: [{ job: "memory sampling", raw: "job memory sampling: interrupted (daemon_restart); continue: queued" }] } });
  assert.equal(ownSteer.verdict, "pass", ownSteer.check("f"));
  assert.match(ownSteer.check("f"), /5 deliveries into its 3 sessions trace to its own/);
  const foreign = run({ inbox: [task, userLine(120, "[check-in] Attack p75 now.")], delivery: { steers: [steer("01a1164b")] } });
  assert.equal(foreign.verdict, "void", "another chat's check-in job-steer into the chat's job is someone stepping in");
  assert.match(foreign.text, /Attack p75 now.*service\.log: "chat 01a1164b: check-in job steered job memory sampling"/);
  const untraced = run({ inbox: [task, userLine(120, "[check-in] Attack p75 now.")] });
  assert.equal(untraced.verdict, "open", "a check-in note no service.log steer line accounts for has no recorded origin");
  assert.match(untraced.check("f"), /^- f unknown: open: 1 deliveries have no recorded origin/);
  const uncovered = run({ inbox: [task, userLine(120, "[check-in] The check-in started your sampler for you.")], delivery: { logCovered: false, steers: [steer(chatOf(count + 1))] } });
  assert.equal(uncovered.verdict, "open", "a service.log that starts after the window shows no origin");
  const pushedNote = run({ inbox: [task, userLine(120, "[d9 push 2026-10-24T18:53Z] The chat system duty (d9) found these in your chat: p2.")] });
  assert.equal(pushedNote.verdict, "void", "a d9 push is outside steering although the service delivers it");
  const pushedRecord = run({ delivery: { pushes: [{ at: at(130), chat: idOf("01a16e31", count + 1), tag: "[d9 push 2026-10-24T16:40Z]" }] } });
  assert.equal(pushedRecord.verdict, "void", "a recorded d9 push to the chat is outside steering");
  const noPushes = run({ delivery: { pushesRead: false } });
  assert.equal(noPushes.verdict, "open", "without the pushes file no d9 push can be ruled out");
  const resumeUntraced = run({ inbox: [task, served(126, "continue")] });
  assert.equal(resumeUntraced.verdict, "open", "a service continue with no resume line has no recorded origin");
  const vpMessage = (fromId: string) => JSON.stringify({ type: "custom_message", customType: "agent_message", timestamp: iso(130), content: "[agent-message from sibling:VP] hi",
    details: { from: { sessionId: fromId, sessionName: "VP" }, fromRelationship: "sibling" } });
  const rootSibling = run({ extra: [vp], inbox: [task, vpMessage(VP)] });
  assert.equal(rootSibling.verdict, "void", "a message to one of the chat's jobs from a thread the agents list records as another is someone stepping in");
  const unplaced = run({ inbox: [task, vpMessage("01a1164b-0000-7000-8000-000000000009")] });
  assert.equal(unplaced.verdict, "open", "a sender with no recorded identity in the evidence is unknown, never outside or own");

  const log = ["2026-10-24T14:00:00.000Z serve: listening", "chat 01a16e49: check-in job steered job early", "2026-10-24T14:30:00.000Z wakes: woke",
    "chat 01a16e49: check-in job steered job memory sampling", "chat 01a1164b: check-in job's message for job memory sampling went through the chat: 404",
    "job memory sampling: interrupted (daemon_restart at 2026-10-24T14:33:19Z); continue: {}", "2026-10-24T20:00:01.000Z after", "chat 01a16e49: check-in job steered job late"];
  const parsed = parseServiceLog(log, START, at(300));
  assert.equal(parsed.logCovered, true);
  assert.deepEqual(parsed.steers.map(entry => `${entry.chat8} ${entry.act} ${entry.job}`), ["01a16e49 steered memory sampling", "01a1164b relayed memory sampling"]);
  assert.deepEqual(parsed.resumes.map(entry => entry.job), ["memory sampling"]);
  assert.equal(parseServiceLog(log.slice(2), START - 60_000, at(300)).logCovered, false, "a log that starts after the window does not cover it");


  // The service's own job push ("The check-in is checking on you"), which carried-wait run-3's "disk free sampling" got at 14:43:32Z on 10-24.
  const nudgeText = "The check-in is checking on you: you owe a report to the chat, and nothing moved for 2 h. Send the chat what you have now.";
  const nudgeLine = (chat8: string) => ({ chat8, job: "memory sampling", raw: `chat ${chat8}: check-in nudged job memory sampling: nothing moved for 2 h` });
  const ownNudge = run({ inbox: [task, userLine(120, nudgeText)], delivery: { nudges: [nudgeLine(chatOf(count + 1))] } });
  assert.equal(ownNudge.verdict, "pass", ownNudge.check("f"));
  const bareNudge = run({ inbox: [task, userLine(120, nudgeText)] });
  assert.equal(bareNudge.verdict, "open", "a job push no nudge line of this chat accounts for has no recorded origin");
  const foreignNudge = run({ inbox: [task, userLine(120, nudgeText)], delivery: { nudges: [nudgeLine("01a1164b")] } });
  assert.equal(foreignNudge.verdict, "void");

  // Receipts from the routed service (live from 19:47:42Z on 10-24): effective delivery decides, not the push record.
  const AFTER = Date.parse("2026-10-24T19:50:00Z");
  const receipt = (extra: Partial<Receipt> & Pick<Receipt, "path" | "to" | "id">): Receipt => ({ at: AFTER, raw: `delivery ${extra.path}: to session ${extra.to} as ${extra.id}`, ...extra });
  const steerText = "[check-in] Copy the tally into p4 now.";
  const hashed = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
  const ownReceipt = run({ inbox: [task, userLine(120, steerText)], delivery: { receipts: [receipt({ path: "job-steer", from: "01a16e57-0000-7000-8000-000000000001",
    fromChat: idOf("01a16e31", count + 1), to: SAMPLER, id: hashed("Copy the tally into p4 now.") })] } });
  assert.equal(ownReceipt.verdict, "pass", `a job-steer receipt from the chat's own check-in is the system at work: ${ownReceipt.check("f")}`);
  const foreignReceipt = run({ inbox: [task, userLine(120, steerText)], delivery: { receipts: [receipt({ path: "job-steer", from: "01a1164b-0000-7000-8000-000000000009",
    fromChat: "01a1164b-0000-7000-8000-000000000009", to: SAMPLER, id: hashed("Copy the tally into p4 now.") })] } });
  assert.equal(foreignReceipt.verdict, "void", "a job-steer the service delivered from another chat is someone stepping in");
  const redirectedPush = run({ delivery: { pushes: [{ at: AFTER, chat: idOf("01a16e31", count + 1), tag: "[d9 push 2026-10-24T19:50Z]" }],
    receipts: [receipt({ path: "d9 push", from: "01a1164b-0000-7000-8000-000000000009", to: idOf("01a16e31", count + 1), id: "m-1", owner: "01a16e22-0000-7000-8000-000000000001" })] } });
  assert.equal(redirectedPush.verdict, "pass", `a d9 push taken to the trial owner never reached the chat, though the push record names it: ${redirectedPush.check("f")}`);
  const unreceipted = run({ delivery: { pushes: [{ at: AFTER, chat: idOf("01a16e31", count + 1), tag: "[d9 push 2026-10-24T19:50Z]" }] } });
  assert.equal(unreceipted.verdict, "open", "a push record after activation with no receipt leaves its delivery unknown");
  const deliveredSibling = run({ delivery: { receipts: [receipt({ path: "sibling send", from: "01a1164b-0000-7000-8000-000000000009", to: SAMPLER, id: "sha256:abcdefabcdef" })] } });
  assert.equal(deliveredSibling.verdict, "void", "a sibling send the service delivered to a trial job from outside is someone stepping in");

  const routed = parseServiceLog(["2026-10-24T14:00:00.000Z serve", "2026-10-24T14:40:00.000Z wakes", "chat 01a16e49: check-in nudged job memory sampling: nothing moved for 2 h",
    "2026-10-24T19:50:00.000Z delivery d9 push: from session 01a1164b-4a2d-742d-b27a-82f086ed0200 (d9 of AI harness) of chat 01a1164b-4a2d-742d-b27a-82f086ed0200 to session 01a16e49-71ae-74b3-8490-220e5bb38507 as m-77, taken to the trial owner 01a16e22-91e0-7783-8ab3-dd7d6021ed6f",
    "2026-10-24T19:51:00.000Z delivery job-steer: from session an unnamed caller of chat unknown to session 01a16e4a-b352-7219-b017-f3c5ab891ffe as sha256:0123456789ab"], START, at(400));
  assert.deepEqual(routed.nudges?.map(entry => `${entry.chat8} ${entry.job}`), ["01a16e49 memory sampling"]);
  assert.deepEqual(routed.receipts?.map(entry => `${entry.path} ${entry.from ?? "-"} ${entry.fromChat ?? "-"} ${entry.to.slice(0, 8)} ${entry.id} ${entry.owner?.slice(0, 8) ?? "-"}`),
    ["d9 push 01a1164b-4a2d-742d-b27a-82f086ed0200 01a1164b-4a2d-742d-b27a-82f086ed0200 01a16e49 m-77 01a16e22", "job-steer - - 01a16e4a sha256:0123456789ab -"]);


  // carried-wait run-4 on 10-24: free-space-page-writer (01a16f95), a subagent of the chat's job "free space page", replied to that job as its
  // child. Its session header records the job as its parent, which is what makes it the trial's own, never its name or text.
  const WRITER = "01a16f95-b211-758c-8541-498f6cbe20c9";
  const reply = (fromId: string) => JSON.stringify({ type: "custom_message", customType: "agent_message", timestamp: iso(170), content: "[agent-message from child:free-space-page-writer] The page is up.",
    details: { from: { sessionId: fromId, sessionName: "free-space-page-writer" }, fromRelationship: "child" } });
  const writerFile = (chat: string, parent: string | null, depth = 2) => {
    const folder = join(home, ".prime", "agent", "session-artifacts", chat, "sub-s", "sub-w");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${WRITER}.jsonl`), JSON.stringify({ type: "session", id: WRITER, timestamp: iso(150), rlmDepth: depth,
      ...parent ? { parentSession: `/home/sieun/.prime/agent/session-artifacts/${chat}/sub-s/${parent}.jsonl` } : {} }) + "\n");
  };
  const nestedRun = (parent: string | null | "none", depth = 2) => {
    const chat = idOf("01a16e31", count + 1);
    if (parent !== "none") writerFile(chat, parent === null ? null : parent, depth);
    return run({ inbox: [task, reply(WRITER)] });
  };
  const ownChild = nestedRun(SAMPLER);
  assert.equal(ownChild.verdict, "pass", `a subagent of the chat's job, by its recorded parent, is the trial's own: ${ownChild.check("f")}`);
  const strayChild = nestedRun("01a1164b-0000-7000-8000-000000000009");
  assert.equal(strayChild.verdict, "void", "the same name and text from a session whose recorded parent is outside the trial is someone stepping in");
  assert.match(strayChild.text, /recorded parent 01a1164b-0000-7000-8000-000000000009 is not a session of the trial/);
  const uncaptured = nestedRun("none");
  assert.equal(uncaptured.verdict, "open", "a sender whose session file was not captured has no recorded parentage, so f is unknown");
  assert.match(uncaptured.check("f"), /^- f unknown/);
  assert.match(uncaptured.text, /no session file of 01a16f95-b211-758c-8541-498f6cbe20c9 was captured/);
  const orphan = nestedRun(null);
  assert.equal(orphan.verdict, "open", "a child session file with no recorded parent is unknown");
  // 10-25: the same writer captured as a root-level session (sessions/<id>.jsonl) is found by the id the job's own file records as its
  // sender, never by a walk of the sessions folder, and its recorded parent decides as before.
  const rootFile = join(home, ".prime", "agent", "sessions", `${WRITER}.jsonl`);
  const rootRun = (parent: string) => {
    writeFileSync(rootFile, JSON.stringify({ type: "session", id: WRITER, timestamp: iso(150), parentSession: `/home/sieun/.prime/agent/sessions/${parent}.jsonl` }) + "\n");
    try { return nestedRun("none"); } finally { rmSync(rootFile, { force: true }); }
  };
  const rootChild = rootRun(SAMPLER);
  assert.equal(rootChild.verdict, "pass", `a root-level session whose recorded parent is the chat's job is the trial's own: ${rootChild.check("f")}`);
  const rootStray = rootRun("01a1164b-0000-7000-8000-000000000009");
  assert.equal(rootStray.verdict, "void", "a root-level session whose recorded parent is outside the trial is someone stepping in");
  assert.match(rootStray.text, /recorded parent 01a1164b-0000-7000-8000-000000000009 is not a session of the trial/);

  const stopped = run({ sampler: "done" });
  assert.equal(stopped.verdict, "fail", "a prerequisite whose owner stopped a whole interval ago and that the run did not flag fails e");
  assert.match(stopped.check("e"), /^- e not met: .*p3 waits on p2, whose owners stopped/);
  const seen = run({ sampler: "done", flagged: [{ kind: "stuck_steps", item: "p3", excerpt: "p3 waits on p2, whose job memory sampling ended" }] });
  assert.match(seen.check("e"), /^- e met/);
});
