import { replaceableLine } from "./agent-outbox.ts";
import { type AlertJob, type AlertLine, ruleText } from "./alert-bridge.ts";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { clockTime, localTime } from "./checkin-settings.ts";
import type { JobRegistry } from "./chat-sources.ts";
import type { ArchiveBy } from "./service-archives.ts";
import { BRIEF_ITEMS } from "./shared/brief-cap.ts";
import { MERGE_RULE } from "./shared/chat-board.ts";
import { releaseGo } from "./shared/release-go.ts";
import { type DutyCard, type DutyCut, type DutyJobRef, headlineMetric, verdictMetrics } from "./shared/chat-duties.ts";
import { poolSlot } from "./shared/chat-feed.ts";
import { CUT_TAIL_BYTES, tailLines } from "./cut-end.ts";
import { lastTurnError } from "./held-turns.ts";
import { dutyLink } from "./shared/duty-fixes.ts";
import type { MetricStreak } from "./shared/duty-streak.ts";
import type { JobModel } from "./job-resume.ts";
import type { SessionRow, ThinkingLevel, ThreadSchedule } from "./shared/types.ts";
import { fileLines } from "./file-lines.ts";

/**
 * Duty jobs: on every scheduled run of a duty (the built-in check-in included) the server starts one job for it, a root session linked to the
 * chat the way a root the chat starts with rlm.create_session is (the job registry, by session id), so it shows in the chat's Agents card, gets
 * the job reply guideline, and reports to the chat. Its brief is the duty, the owner's words and the precheck; the job decides what to check,
 * what to fix and what to start. The server only measures and starts it.
 */

/**
 * The folder that holds scripts/board-apply.ts, the command a duty job applies its board ops with. A release folder is named through the live
 * `current` link, because a later release prunes it: on 10-20 a job ran add.ts from its brief's release-b8c6bba path, so d2's precheck cwd
 * pointed at a pruned folder and two runs failed with spawn ENOENT, and release-0575099 was gone 5 minutes after it went live.
 */
const USER_HISTORY = liveFolder(join(import.meta.dirname, ".."));

export function liveFolder(dir: string): string {
  const match = /^(.*\/sieun-pi-chat)\/release-[^/]+(\/.*)?$/.exec(dir);
  if (!match) return dir;
  const live = `${match[1]}/current${match[2] ?? ""}`;
  return existsSync(live) ? live : dir;
}

/** The chat a duty job works for: its session id and name (the job's reply target), its working folder, and its board file. */
export interface DutyChat { id: string; name: string; cwd: string; board: string }
/** What the duty runner needs to start and retire duty jobs; the backend wires it to the thread hub, the catalog and the job registry. */
export interface DutyJobHost {
  /**
   * The chat as a duty job needs it. A chat with no catalog row gets one full list of the daemon's sessions and a second look: null when that
   * list does not show it either, and a rejection when the list fails. After a restart the catalog has no rows until a full list answers
   * (10-12 16:07 to 16:27Z the list timed out at 30 s and 14 duty runs of 7 chats lost their job as "the catalog does not list the chat").
   */
  chat(chatId: string): Promise<DutyChat | null>;
  /** Whether a duty job still works: its own turn, a subagent below it, or anything else its tree waits on (`treeWait`). False when it is gone or archived. */
  working(job: DutyJobRef): Promise<boolean>;
  /**
   * Starts the job: a new root session named `name` in the chat's folder, registered as the chat's job, with `brief` as its first message.
   * `since` is when the run started: a session of the job's name made since then is this run's own, from a create that timed out before a restart.
   * `model` is the model and thinking level the session starts on; absent, the daemon's default.
   */
  start(chat: DutyChat, name: string, brief: string, since?: number, model?: JobModel): Promise<DutyJobRef>;
  /**
   * Drops a finished duty job from the registry, so the chat's Agents card lists only the current one, and queues its archive
   * (src/chat-archive-queue.ts): a slow daemon never holds up the next start.
   */
  retire(job: DutyJobRef): Promise<void>;
  /**
   * The duty jobs to archive now, with one catalog read: each `last` job (its duty's newest) whose turn has ended, listed, not archived, not
   * working, past its brief (2 or more messages) and not settled on a failed model call (the chat's revive restarts those), and each `older` job
   * that is still listed, not archived and not working; neither kind waits on a scheduled job or on its tree (`treeWait`). A host without it
   * (test fakes) stops no job early.
   */
  ended?(last: readonly DutyJobRef[], older?: readonly DutyJobRef[]): Promise<DutyJobRef[]>;
  /** Queues the archive of an ended duty job, so its worker and Python kernel stop; it stays registered until the next run retires it. */
  stop?(job: DutyJobRef): Promise<void>;
  /**
   * How the job was cut (`readJobCut`) when it does not work and its transcript ends on a failed model call; null otherwise. A host without
   * it (test fakes) reads no job as cut.
   */
  cut?(job: DutyJobRef): Promise<DutyCut | null>;
}

/**
 * The cut a duty job's transcript lines end on: the last turn failed on the model call (`lastTurnError`), a pi-pool wait or a provider error,
 * with its time, its provider and pi-pool's slot when the error names one (`poolSlot`). Null when the last turn ended any other way. The run
 * record's own `failure` flag cannot say it: on 10-19 the daemon reloaded check-in 01a1521d after the idle unload stopped it at 03:06:30Z,
 * its row lost the failure, and the runner read the job as finished.
 */
export function jobCut(lines: readonly string[]): DutyCut | null {
  const error = lastTurnError(lines.join("\n"));
  if (error === undefined) return null;
  for (let index = lines.length - 1; index >= 0; index--) {
    let entry: { type?: unknown; timestamp?: unknown; message?: { role?: unknown; provider?: unknown } };
    try { entry = JSON.parse(lines[index]!); } catch { continue; }
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    const slotAt = poolSlot(error);
    return { error, at: Date.parse(String(entry.timestamp)), ...typeof entry.message.provider === "string" ? { provider: entry.message.provider } : {},
      ...slotAt === null ? {} : { slotAt } };
  }
  return null;
}

/** `jobCut` of a session file's tail (`CUT_TAIL_BYTES`); null when the file is gone. */
export const readJobCut = async (file: string): Promise<DutyCut | null> => jobCut(await tailLines(file, CUT_TAIL_BYTES));

/**
 * A duty job's name: the duty's name in lowercase, the chat's name and the start time, like `check-in frontend bro 14:00`. Root sessions share
 * one parent, so a name without the chat collided at the first live tick: 4 of 9 chats got "check-in 01:40 is unavailable" (10-09).
 */
export const dutyJobName = (duty: string, chat: string, at: number): string => {
  const short = chat.replace(/[*_`#]/g, "").replace(/\s+/g, " ").trim().slice(0, 32).trim();
  return `${duty.trim().toLowerCase()}${short ? " " + short : ""} ${clockTime(at)}`;
};

/** What a duty job's brief holds: the duty, the chat, the job's name and start, the measure against the targets, and the precheck's findings (markdown). */
export interface DutyJobInput {
  duty: Pick<DutyCard, "name" | "ownerWords" | "goal" | "metrics"> & { id?: string; onMiss?: string; boardGoal?: string };
  chat: Pick<DutyChat, "id" | "name" | "board">;
  job: string; at: number; measure: string; findings: string;
  /** What this duty's job looks at besides the generic rules, in the owner's terms. */
  focus?: readonly string[];
  /** The miss streak of each metric this run missed (`metricStreaks`), with the fix step the run found for it. */
  misses?: readonly MetricStreak[];
  /** How this duty's job reports to the chat, in place of the generic report rule; the check-in's is `CHECK_IN_REPORT`. */
  report?: string;
  /** The check-in's own prompt body (`checkInPrompt` and its detail file): set, the brief is `checkInJobBrief` with no stock rules (c90). */
  prompt?: string;
}

/** The owner's sentence for the check-in (c90, 2026-10-15 23:52Z), which the check-in prompt opens with. */
export const CHECK_IN_WORDS = "check conversation and sync Plans to actual status, and resume tasks, nudge agents to achieve the goal. be aggressive, poteto mode use subagents aggressively";

/**
 * The check-in job's brief (c80, c90; owner 10-16: "it should be based on metrics, more sophisticated"): the owner's sentence, where the chat's
 * board and conversation are, the goals' numbers and the actions due (`prompt`), and the four calls the job acts with. No stock rule lines and
 * no list of step ids: the detail file the prompt names holds every finding.
 */
export function checkInJobBrief({ chat, job, at, prompt, report }: Pick<DutyJobInput, "chat" | "job" | "at" | "report"> & { prompt: string }): string {
  const agentDir = dirname(dirname(dirname(chat.board)));
  return [
    `# ${job}: the check-in of the chat "${chat.name}"`,
    `You are the check-in job "${job}" of the chat "${chat.name}", started ${localTime(at)}. The owner's words for the check-in (verbatim):\n\n> ${CHECK_IN_WORDS}`,
    "The plan holds only tasks that finish, and this run pushes each open step toward done: resume its job, start a fix job, or close it with the " +
      "evidence you checked. Upkeep is a duty metric, so a goal or step whose title says keep, stays, always or every ... is green leaves the plan. " +
      "Goals are a few measured outcomes in the owner's terms, like \"Instagram profiles crawl at 10k a minute, held 6 h\", with their steps under " +
      "them. A problem that kept coming back in the thread becomes a duty metric, and a goal or step whose target reads met closes at once when a duty keeps its metric.",
    `The chat's session id is ${chat.id}. Its board is ${chat.board}, and its conversation is ${join(agentDir, "sessions", `${chat.id}.jsonl`)}.`,
    prompt,
    "## How to act",
    [
      `Apply board changes with \`import json, shlex\` and \`${boardApplyCall(chat)}\`, where ops are chat_board ops.`,
      "Start a job with `await rlm.create_session(brief, name=..., cwd=...)` and set it as its step's job in the same board change. Message a " +
        `job of the chat with \`${jobSteerCall(chat)}\`: the server delivers it, and restarts a job whose last turn failed. Write that message ` +
        "in a few plain sentences that name at most 2 step ids in a paragraph, and the other steps by a few words of their title: on 10-18 the " +
        "12:40 steer to a gaps job listed four step ids in one paragraph, which the job had to look up on the board.",
      `${report ?? "Send the chat one short report when your work is done."} Send it with \`${checkInReportCall(chat)}\`. Its first line tells the ` +
        "chat service that your report replaces an older check-in report still waiting for the chat, so a chat that was away reads only the newest.",
    ].map(line => `- ${line}`).join("\n"),
  ].join("\n\n") + "\n";
}

/** The owner's words an alert job opens with, from ops guy's goal p195. */
export const ALERT_OWNER_WORDS = "One place to monitor and debug everything, and a firing prod alert wakes the thread that owns it";

/**
 * The brief of the triage job the alert bridge starts for an owner chat, with every fire of that chat no job holds. Later fires of the chat
 * come to this job by message while it lives. The bridge files no plan step for it (owner 10-18: "stop being paranoid in plan under p45,
 * p221"); the chat's duty counts the rules that fire, and this job holds them until they stop. On 10-19 one job per rule had made 78 fires
 * into 78 jobs across 4 chats.
 */
export function alertJobBrief(chat: DutyChat, job: string, at: number, lines: readonly AlertLine[], previous?: AlertJob & { at: number }): string {
  const agentDir = dirname(dirname(dirname(chat.board)));
  const rule = (line: AlertLine): string => [`- ${ruleText(line)}`, line.summary ? `  Summary: ${line.summary}` : "", line.values ? `  Values: ${line.values}.` : "",
    line.url ? `  Grafana: ${line.url}` : ""].filter(Boolean).join("\n");
  return [
    `# ${job}: the firing alerts of the chat "${chat.name}"`,
    `Owner's words (verbatim):\n\n> ${ALERT_OWNER_WORDS}`,
    `You are the job "${job}" of the chat "${chat.name}" (session ${chat.id}), started ${localTime(at)} by the alert bridge, and its conversation is ` +
      `${join(agentDir, "sessions", `${chat.id}.jsonl`)}. You are this chat's one triage job: the bridge gave you ${lines.length === 1 ? "this Grafana rule" : `these ${lines.length} Grafana rules`}, ` +
      "and every rule of the chat that fires while you work comes to you by message.",
    lines.map(rule).join("\n"),
    previous ? `The chat's last triage job was "${previous.name}" (session ${previous.id}), started ${localTime(previous.at)}, and it has ended while ` +
      "these rules fire. Read its conversation first and start from what it found." : "",
    "Group the rules by cause first: several rules often fire on one fault. Find each cause from evidence: the Grafana rule and its query, the " +
      "metrics and logs, and read-only reads on the box. Fix it at the root: a fix in our code or alert rules goes through the repo's normal land " +
      "path, and a rule that fires on something that is not a fault gets fixed or deleted. Follow the chat's rules for any box or repo you touch, and " +
      "send nothing outside (no email, ticket or vendor chat). Put no step on the chat's plan: the chat's duty counts the rules that fire, and you hold them.",
    "## How to act",
    [
      `Read ${join(agentDir, "skills/poteto-mode/SKILL.md")} and ${join(agentDir, "skills/unslop/SKILL.md")} first.`,
      `When your rules stop firing for causes you fixed, or you are blocked, report in 3 short lines that lead with the causes, with \`${reportCall(chat)}\`.`,
    ].map(line => `- ${line}`).join("\n"),
  ].filter(Boolean).join("\n\n") + "\n";
}

const runs = (count: number): string => `${count} ${count === 1 ? "run" : "runs"}`;
const owner = (fix: NonNullable<MetricStreak["fix"]>): string => fix.job ? `job ${fix.job}` : "no job";

/**
 * One line per missed metric: its streak and what this run must do about it. A metric with a live fix job gets a steer, one with none gets a
 * new fix job, and a stuck one (CHANGE_APPROACH_MISSES misses with no move) gets a new root-cause job that names the fix that did not work. A
 * windowed count with no new event since the last run (`quietSince`) gets no job.
 */
export function missLine(dutyId: string, streak: MetricStreak, label: string, unit = ""): string {
  const link = JSON.stringify(dutyLink(dutyId, streak.key));
  const where = `${streak.key} (${label}) is ${streak.value}${unit}, target ${streak.op} ${streak.target}${unit}, missed ${runs(streak.misses)} in a row` +
    `${streak.misses > 1 ? streak.moved ? ", moving toward the target" : ", not moving toward the target" : ""}.`;
  const fix = streak.fix;
  if (streak.quietSince !== undefined) {
    return `${where} Its newest counted event is from ${localTime(streak.quietSince)}, before the last run, so no new event came since and the number ` +
      `moves toward its target as older events leave its window. Start no new job for it${fix ? ` and leave ${fix.step} as it is` : ""}; check the source for a new event.`;
  }
  if (streak.stuck) {
    return `${where} Change approach: ${fix ? `the fix ${fix.step} (${owner(fix)}) did not move it` : "no fix step moved it"}. Start a new ` +
      "root-cause job with rlm.create_session that finds why the last fix did not move the number and fixes that cause in code. Do not run the " +
      `same fix again. Once it returns the job's session id, add its own plan step with duty ${link}, the new job and its sessionId${fix ? `, and close or drop ${fix.step} with a note naming the new step` : ""}.`;
  }
  if (fix?.live) return `${where} Its fix step ${fix.step} has the live job ${fix.job}: steer that job with this number and what the precheck found, and push it to land the code fix. ` +
    `${fix.job} stays the owner when your own lookup of it fails, times out or does not find it, since the server found it at work.`;
  return `${where} ${fix ? `Its fix step ${fix.step} has ${fix.job ? `no live job (${fix.job} is not at work)` : "no job"}.` : "No plan step fixes it."} Start a fix job with ` +
    "rlm.create_session whose brief is to find the cause and land a code change that moves this number. Once it returns the job's session id, " +
    `${fix ? `set that job and its sessionId on ${fix.step} if it is still open, else add a plan step` : "add a plan step"} with duty ${link}, that job and its sessionId.`;
}

/** The rules every job the server starts for a chat follows, in brief order. */
function chatJobRules(): string[] {
  return [
    "Two hard gates hold for every chat. A step marked as needing the owner's go moves only after the owner answers its For you todo with a go " +
      "(a step whose only target is staging never needs one): " +
      "never start, steer or report work on it as approved before that, and stop a job that started without it. A Build step starts only after " +
      "its goal's requirements check: a plan or design job's report quotes the original owner request and checks each line of it against the " +
      "design before build.",
    releaseGo.preapproval ? MERGE_RULE : `${MERGE_RULE} A merge step done without that go is a repo rule breach: report it to the owner in your report, with the PR.`,
    "A goal can carry a target: when you measure it, apply plan_update with its whole target, like " +
      "`{\"op\":\"plan_update\",\"id\":\"p1\",\"target\":{\"metric\":\"proxy bandwidth used\",\"target\":200,\"unit\":\"Mbps\",\"current\":8,\"measuredAt\":\"2026-10-09T21:00:00+09:00\",\"source\":\"proxy dashboard, 24 h average\",\"direction\":\"up\"}}`. Give direction \"down\" when lower is better, such as a wait. " +
      "Close the largest gap first: start or steer the job that moves the number.",
    "Never push a ci/ branch or use --push-ci: build the commit object for auto-sns-agent " +
      "(`node scripts/repo/agent/commit.mjs --object-only -m \"<type>(<scope>): <what>\" <files>`) and send it to the chat, which asks Fable for a probe slot; " +
      "code reaches the shared tip only after its own green probe. Every file you touch stays " +
      "under its light-guard line limit (1,000 lines for most source files); split a file before it would cross it.",
    "Never cancel or rerun an auto-sns-agent CI run (`gh run cancel`, `gh run rerun` or their API calls), yours included; a superseded run is cancelled by " +
      "Fable's loop or its own probe family, so send Fable its id through the chat, and push a fresh run for a new attempt.",
    "Do what you can reach yourself: Convex data is read or written with `npx convex run` or a query using the deploy key and an identity; " +
      "never ask the owner for his browser or to act as him, and turn such a For you todo into a job.",
    "Never send anything outside on your own: an email, a vendor or support ticket reply, a customer message or a public post is drafted and " +
      "put in For you with the draft and choices; it goes out only after the owner approves it there. A vendor's support is never asked for help " +
      "at all, not even with his ok: solve it through the portal, the API, the console and SSH (c79).",
    "Act directly and ship: do not invent waiting rules, extra review rounds or safety gates of your own; keep only the gates the owner asked for.",
    "No cap, throttle, timeout, rate or caution line without a measurement, a vendor limit or an incident cited next to the number; remove unbacked ones.",
  ];
}

/** The board-apply call a job the server starts runs for its board ops, as Python. */
const boardApplyCall = (chat: Pick<DutyChat, "id" | "board">): string =>
  `await bash("cd ${USER_HISTORY} && node --import tsx scripts/board-apply.ts ${chat.id} " + shlex.quote(json.dumps(ops)) + " --data-dir ${dirname(dirname(chat.board))}")`;
/** The call a job the server starts uses to message a job of its chat, as Python: the server delivers it (`Chats.steerJob`). */
const jobSteerCall = (chat: Pick<DutyChat, "id">): string =>
  `await bash("cd ${USER_HISTORY} && node --import tsx scripts/job-steer.ts ${chat.id} " + shlex.quote(job_name) + " " + shlex.quote(text))`;
/** A check-in job's report call: the report opens with a replaceable key (src/agent-outbox.ts), since each check-in restates the chat's whole state. */
const checkInReportCall = (chat: Pick<DutyChat, "name">): string =>
  `await agent_message.send(${JSON.stringify(replaceableLine(CHECK_IN_REPORT_KEY) + "\n\n")} + report, receiver_role="sibling", receiver_name=${JSON.stringify(chat.name)})`;
/** The replaceable key of a check-in job's report. */
export const CHECK_IN_REPORT_KEY = "check-in report";
/** The report call a job the server starts ends with. */
const reportCall = (chat: Pick<DutyChat, "name">): string => `await agent_message.send(report, receiver_role="sibling", receiver_name=${JSON.stringify(chat.name)})`;

/**
 * The duty job's brief (owner 10-09: "every (n min/h/day) -> code precheck -> run job with that context to 'fix issues, check what duty
 * specifies, be a VP, report to user what needed'"; "control flow should be dynamically defined by agent"): the duty in the owner's words, the
 * precheck as information, and how a chat job works. It names no fixed list of checks and no verdict; a quiet run ends in one short turn.
 */
export function dutyJobBrief({ duty, chat, job, at, measure, findings, focus = [], misses = [], report, prompt }: DutyJobInput): string {
  if (prompt !== undefined) return checkInJobBrief({ chat, job, at, prompt, ...(report ? { report } : {}) });
  const send = reportCall(chat);
  const headline = headlineMetric(duty.metrics);
  const counted = verdictMetrics(duty.metrics);
  const shown = misses.filter(streak => counted.some(metric => metric.key === streak.key));
  const apply = boardApplyCall(chat);
  return [
    `# ${job}: the ${duty.name} duty of the chat "${chat.name}"`,
    `You are the duty job "${job}" of the chat "${chat.name}" (session id ${chat.id}), started ${localTime(at)}. The server starts one duty job ` +
      `on each scheduled run of this duty, with the precheck below as context. Act as the chat's VP for this duty.`,
    "## The duty",
    `Goal: ${duty.goal}`,
    `Owner's words (verbatim):\n\n${duty.ownerWords.split("\n").map(line => `> ${line}`).join("\n")}`,
    ...(duty.onMiss ? [`What to do about a miss: ${duty.onMiss}${duty.boardGoal ? ` Fixes go under the plan item ${duty.boardGoal}.` : ""}`] : []),
    ...(headline ? [`## Headline KPI\nThis run is judged on moving one number: ${headline.label} (${headline.key} ${headline.op} ${headline.target}${headline.unit ?? ""}). ` +
      "Spend the run on the work that moves it most; the other targets and the number of checks you run are detail."] : []),
    `Targets: ${counted.map(metric => `${metric.key} ${metric.op} ${metric.target}${metric.unit ?? ""} (${metric.label})`).join("; ")}.`,
    "## What the precheck found",
    `Measured against the targets: ${measure}. This is information, not a verdict: a met target does not mean nothing needs work, and code ` +
      "cannot see everything. Check the real state.",
    findings,
    ...(shown.length ? [`## Missed metrics: each one needs a fix step with a live job\n` +
      shown.map(streak => { const metric = counted.find(entry => entry.key === streak.key); return `- ${missLine(duty.id ?? "<dutyId>", streak, metric?.label ?? streak.key, metric?.unit)}`; }).join("\n") +
      "\n\nA miss is never accepted as it stands. A fix step is a plan step with `duty` set to `<dutyId>/<metricKey>` and `job` set to a job that " +
      "works on a code change, not a note or a later wait. When a fix step closes, the server runs this duty again at once to check the number moved."] : []),
    "## How to work",
    [
      `The chat's board is the JSON file ${chat.board}: the plan with its step notes and the For you todos with the owner's answers. Read it, then ` +
        "check the real state behind it: the jobs (`await agent_observe.list_agents()`, `await agent_observe.recent_messages(name)`), the commits, " +
        "the live pages, and other threads' last messages.",
      "Fix the issues you find and check what the duty specifies. You decide what to check and what to start from what you find: control flow " +
        "is decided by agents, not by loops in code.",
      "Work like the engineer who owns this system. Script what can be scripted, read the monitoring the owner would read (his dashboard, the live " +
        "page, the real logs), and decide from what you see. When a duty rule or metric does not make sense, change or drop it: edit its duty JSON or " +
        `check script under ${join(USER_HISTORY, "scripts/duties")}, apply it with \`node --import tsx scripts/duties/add.ts ${chat.id} <duty.json>\`, ` +
        "or delete a whole duty with `scripts/duties/remove.ts`, and say why in your report. Skip nitpicks and spend the run only where it has real " +
        "impact on a system that breaks easily.",
      ...focus,
      "Split work by the job rules: one goal per job, one subagent per unit of output, and work of 1 to 3 tool calls stays inline. Start " +
        "subagents with `await rlm.spawn(brief, name=...)`, all at once, each brief ending with `await agent_message.send(report, receiver_role=\"parent\")`; " +
        "end your turn, read each reply as it comes, and delete each subagent after its report. Work for another repository goes to " +
        "`await rlm.create_session(brief, name=..., cwd=...)`.",
      "Map the chat's work as a graph: one job or subagent per part, never steps piled on one old long-running session; when the findings list " +
        "a session that carries too much, move its steps to new jobs per part. Heartbeats the check-in covers go: name each for the chat to delete.",
      "You can message another thread yourself to chase it: `await agent_message.send(text, receiver_role=\"sibling\", receiver_name=<thread name>)`. " +
        `A job of the chat is its subagent, which that cannot reach: message it with \`${jobSteerCall(chat)}\`.`,
      `Apply each board change to the chat's board yourself in this run, with \`import json, shlex\` and \`${apply}\`, where ops is a list of ` +
        "chat_board ops like `[{\"op\":\"plan_update\",\"id\":\"p4\",\"status\":\"done\",\"note\":\"live on production at 4f1c2a, checked on the live page\"}]`. " +
        "It checks and flags them as chat_board does and prints each op's summary with its flags; fix a flagged op in the same run. Close a step only on evidence you name in its note. A step whose run, " +
        "probe, land or push has not finished green and landed stays open with its job, which is a live owner.",
      "Every stuck step needs a live owner, a For you todo, or a close in this run. Give a step an owner that outlives this run with " +
        "`await rlm.create_session(brief, name=..., cwd=...)`, which registers the session as a job of the chat, and set the step's job to that " +
        "name in the same board change. A subagent you spawn is archived when the next run retires you, so spawn only for work that ends inside this run. " +
        "A step that waits on a CI run, a land or another thread has a live owner only while a job sleeps on a `board.wake` for that run or land, " +
        "or chases that thread; a wait nobody watches stays stuck, so give it that owner, or check the run now and do the next step.",
      ...chatJobRules(),
      "When nothing needs work, end in one short turn and send nothing; the server keeps this run's record.",
      `${report ? `Otherwise ${report[0]!.toLowerCase()}${report.slice(1)}` : `Otherwise send the chat one short report when your work is done, with only what the chat must act on: the headline number, the board ops ` +
        `you applied, at most ${BRIEF_ITEMS} items in plain words (like "p412 waits on land 37 with no job moving it", never a ` +
        `kind label or a list of step ids) or "nothing to act on", and the detail file path the findings name. Never paste the full flagged list.`} ` +
        `Send it with \`${send}\`.`,
    ].map(line => `- ${line}`).join("\n"),
  ].filter(part => part !== "").join("\n\n") + "\n";
}

/** The parts of the thread hub a duty job host uses. */
export interface DutyJobThreads {
  create(input: { cwd: string; name: string; provider?: string; modelId?: string; thinkingLevel?: ThinkingLevel }): Promise<{ id: string }>;
  prompt(id: string, input: { message: string; images: []; mode: "steer" }): Promise<void>;
}

/**
 * The archive the duty archive queue runs for a duty job: a session the catalog lists as live is archived as the service's (`duty_job_end`),
 * never as the owner's; one archived or gone is done.
 */
export const archiveDutyJob = (threads: { archive(id: string, by: ArchiveBy): Promise<void> }, rows: () => Promise<readonly SessionRow[]>) => async (id: string): Promise<void> => {
  const found = (await rows()).find(candidate => candidate.id === id);
  if (found && !found.archived) await threads.archive(id, "duty_job_end");
};

/** The waits before each look for a session whose create failed (a timeout, a lost client): about 2 min in all. */
export const DUTY_LOOKUP_WAITS_MS: readonly number[] = [0, 10_000, 20_000, 30_000, 60_000];
/**
 * The daemon's refusal of a root name that any session ever had, archived ones included. A duty job's name holds only the clock time, so a
 * job started at the same minute on a later day collides with an archived one (frontend bro 10-12 03:41Z: "check-in frontend bro 12:39" was
 * taken by the archived job of 10-10, and both creates failed, so the check-in skipped).
 */
const NAME_TAKEN = /name .* is unavailable: an agent of that name already exists/i;
/** A taken duty job name with the local date before its time: `check-in frontend bro 10-12 12:39`. */
export const datedName = (name: string, at: number): string => {
  const date = localTime(at).slice(5, 10);
  return /\d\d:\d\d$/.test(name) ? name.replace(/(\d\d:\d\d)$/, `${date} $1`) : `${name} ${date}`;
};
/** Creates per start that fail for a reason other than a taken name: the first and one retry when the session never appeared. */
const CREATE_TRIES = 2;

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** A chat's name and folder from its session file: the header's cwd and the first session_info name (a chat is named at create). */
export async function savedChat(file: string): Promise<{ name: string; cwd: string } | null> {
  const lines = fileLines(file);
  let cwd: string | undefined;
  try {
    for await (const line of lines) {
      if (cwd === undefined) {
        const header = JSON.parse(line) as { type?: unknown; cwd?: unknown };
        if (header.type !== "session" || typeof header.cwd !== "string") return null;
        cwd = header.cwd;
      } else if (line.startsWith('{"type":"session_info"')) {
        const name = (JSON.parse(line) as { name?: unknown }).name;
        if (typeof name === "string" && name.trim()) return { name: name.trim(), cwd };
      }
    }
    return null;
  } catch { return null; }
}

/**
 * The backend's duty job host: the chat's name and folder from the catalog rows, a job's state from its row (gone counts as done), a start, and
 * a retire that unregisters and queues the archive. Starts from every chat run one at a time (10-09: 9 chats' check-ins fired within 3 min and 6 creates
 * timed out). A start creates the root; a create that fails may still have made the session, so the start looks for an unregistered session
 * with the job's exact name in the chat's folder for about 2 min and adopts it, else creates once more. It then registers the session id under
 * the chat's name before the first message (the extension reads the registry at that message) and sends the brief. A session it cannot
 * register or brief has its archive queued, so no duty job session is left outside the registry. Every archive goes through `archives`.
 */
export function dutyJobHost(input: { threads: DutyJobThreads; archives: { add(job: DutyJobRef): Promise<void> }; rows: () => Promise<readonly SessionRow[]>;
  registry: JobRegistry; board: (chatId: string) => string;
  /** Runs after the job is registered and before its brief, so its first request already carries its pool class (`dutyJobPriority`). */
  started?: (id: string, chat: DutyChat, name: string) => Promise<void>;
  /**
   * The chat's name and folder from its own session file (`savedChat`), for when the catalog has no row and its refresh fails. On 10-17 at
   * 21:00:50Z the first check-in slot of the new chat "YouTube index gaps" started no job, because the daemon's list timed out at 30 s at load 70.
   */
  saved?: (chatId: string) => Promise<{ name: string; cwd: string } | null>;
  /** A session's transcript file (`sessionFileOf`), which `cut` reads; absent, no job reads as cut. */
  sessionFile?: (id: string) => Promise<string | null>;
  /**
   * Each session's active or paused scheduled job, read from the daemon now (`Catalog.schedulesNow`), so `ended` keeps a job that waits on
   * one; absent: no job waits. A quota-parked session's resume is such a job ("quota-resume"), and an archive cancels it: at 04:27:06Z and
   * 04:33:30Z on 10-20 the runner archived roots 01a15622 and 01a1571c 2 min and 9 s after each parked on a 429, and the relays they held for
   * their subagents repeat c129, c110-plan-vs-duty and c48-ui-reference never went out.
   */
  schedules?: () => Promise<ReadonlyMap<string, ThreadSchedule>>;
  /**
   * What still waits on the job's tree (`treeWait` in src/duty-tree-wait.ts), given the daemon's scheduled jobs by session, so `ended` keeps a
   * job whose subagents, their scheduled jobs and wakes, queued input or outbox relays still wait, and `working` counts it as at work; absent:
   * nothing waits. A failed read stops no job that scan.
   */
  treeWait?: (id: string, scheduled?: ReadonlyMap<string, ThreadSchedule>) => Promise<string | null>;
  refresh?: () => Promise<void>; lookupWaitsMs?: readonly number[]; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void; now?: () => number }): DutyJobHost {
  const row = async (id: string) => (await input.rows()).find(candidate => candidate.id === id);
  const waits = input.lookupWaitsMs ?? DUTY_LOOKUP_WAITS_MS;
  const sleep = input.sleep ?? (ms => new Promise<void>(resolve => { setTimeout(resolve, ms); }));
  let queue: Promise<unknown> = Promise.resolve();
  /** The last wait `ended` logged for each job it kept, so a wait that holds over many scans is logged once. */
  const held = new Map<string, string>();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
  };
  /**
   * An unregistered live session with the job's name in the chat's folder, made since `since`. An older one is a past job with the same clock
   * time: 10-12 13:24Z the 22:24 Local dev servers start adopted the 10-10 22:24 job, its brief failed, and that session stayed loaded.
   */
  const find = async (chat: DutyChat, name: string, since: number, after: readonly number[]): Promise<string | undefined> => {
    for (const wait of after) {
      if (wait > 0) await sleep(wait);
      await input.refresh?.().catch(() => {});
      for (const candidate of await input.rows().catch(() => [])) {
        if (candidate.name !== name || candidate.cwd !== chat.cwd || candidate.archived || Date.parse(candidate.created ?? "") < since) continue;
        if (await input.registry.chatOf(candidate.id) === undefined) return candidate.id;
      }
    }
    return undefined;
  };
  const createOrAdopt = async (chat: DutyChat, first: string, runAt?: number, model?: JobModel): Promise<{ id: string; name: string }> => {
    let cause = "";
    // A session made since the run started is its own. On 10-17 slack green guy's 22:11:50Z check-in run made "check-in slack green guy 07:11"
    // with a create that timed out, and each of the 3 service restarts after it counted only sessions made since its own attempt, found the name
    // taken, made the dated name, and then found that taken too: the run never got its job.
    const since = runAt ?? (input.now ?? Date.now)();
    // A taken name moves to the run's dated name, then to a numbered one, until the daemon takes one; a refusal is no failed create. On 10-18
    // the 05:06 KST catch-up of the 10-17 07:29 slot of "portal stays up" was dated with the day it ran, "10-18 07:29", so the real 10-18 07:29
    // run found both its names taken and started no job; "ci system" lost its 07:39 run the same way.
    const dated = datedName(first, since);
    let taken = 0;
    for (let tries = 1; tries <= CREATE_TRIES;) {
      const name = taken === 0 ? first : taken === 1 ? dated : `${dated} (${taken})`;
      try { return { id: (await input.threads.create({ cwd: chat.cwd, name, ...model ? { provider: model.provider, modelId: model.modelId } : {},
        ...model?.thinkingLevel ? { thinkingLevel: model.thinkingLevel } : {} })).id, name }; }
      catch (error) { cause = reason(error); }
      const refused = NAME_TAKEN.test(cause);
      const found = await find(chat, name, since, refused ? [0] : waits);
      if (found) { input.log?.(`duty job ${name}: the create failed (${cause}) but the session exists; adopting it`); return { id: found, name }; }
      if (refused) { input.log?.(`duty job ${name}: the name is taken by another session; trying the next name`); taken++; continue; }
      input.log?.(`duty job ${name}: create ${tries} of ${CREATE_TRIES} failed and no session appeared: ${cause}`);
      tries++;
    }
    throw new Error(`no session after ${CREATE_TRIES} creates: ${cause}`);
  };
  return {
    async chat(chatId) {
      let found = await row(chatId);
      if (!found && input.refresh) {
        const failed = await input.refresh().then(() => undefined, error => reason(error));
        if (failed !== undefined) {
          const saved = await input.saved?.(chatId).catch(() => null);
          if (!saved) throw new Error(`the catalog cannot list the chat: ${failed}`);
          input.log?.(`duty ${chatId.slice(0, 8)}: the catalog cannot list the chat (${failed}); its session file names it "${saved.name}" in ${saved.cwd}`);
          return { id: chatId, name: saved.name || chatId, cwd: saved.cwd, board: input.board(chatId) };
        }
        found = await row(chatId);
      }
      return found ? { id: chatId, name: found.name.trim() || chatId, cwd: found.cwd, board: input.board(chatId) } : null;
    },
    async working(job) {
      const found = await row(job.id);
      if (!found || found.archived) return false;
      if (found.working || !input.treeWait) return found.working;
      const scheduled = input.schedules ? await input.schedules().catch(() => null) : new Map<string, ThreadSchedule>();
      return scheduled === null || await input.treeWait(job.id, scheduled).catch(() => "unread") !== null;
    },
    start: (chat, planned, brief, since, model) => serial(async () => {
      const { id, name } = await createOrAdopt(chat, planned, since, model);
      try {
        await input.registry.add([id], chat.name, chat.id);
        await input.started?.(id, chat, name);
        await input.threads.prompt(id, { message: name === planned ? brief : brief.split(planned).join(name), images: [], mode: "steer" });
      } catch (error) {
        await input.registry.remove([id]).catch(() => {});
        const archived = await input.archives.add({ id, name }).then(() => "queued its archive", archiveError => `its archive could not be queued: ${reason(archiveError)}`);
        throw new Error(`session ${id} could not be registered and briefed (${reason(error)}); ${archived}`);
      }
      return { id, name };
    }),
    async retire(job) {
      await input.registry.remove([job.id]);
      await input.archives.add(job);
    },
    async ended(last, older = []) {
      if (!last.length && !older.length) return [];
      const byId = new Map((await input.rows()).map(candidate => [candidate.id, candidate]));
      const idle = (job: DutyJobRef) => { const found = byId.get(job.id); return found !== undefined && !found.archived && !found.working ? found : undefined; };
      let ended = [...last.filter(job => { const found = idle(job); return found !== undefined && found.messageCount >= 2 && found.failure === undefined; }),
        ...older.filter(job => idle(job) !== undefined)];
      let scheduled: ReadonlyMap<string, ThreadSchedule> = new Map();
      if (ended.length && input.schedules) {
        const read = await input.schedules().catch(error => { input.log?.(`duty jobs: no job stops this scan, the daemon's scheduled jobs did not read: ${reason(error)}`); return null; });
        if (read === null) return [];
        scheduled = read;
        ended = ended.filter(job => !read.has(job.id));
      }
      if (!input.treeWait) return ended;
      const free: DutyJobRef[] = [];
      for (const job of ended) {
        const wait = await input.treeWait(job.id, scheduled).catch(error => `its tree did not read: ${reason(error)}`);
        if (wait === null) { held.delete(job.id); free.push(job); continue; }
        if (held.get(job.id) !== wait) input.log?.(`duty job ${job.name}: not stopped, ${wait}`);
        held.set(job.id, wait);
      }
      return free;
    },
    stop: job => input.archives.add(job),
    async cut(job) {
      if ((await row(job.id))?.working) return null;
      const file = await input.sessionFile?.(job.id);
      return file ? readJobCut(file) : null;
    },
  };
}
