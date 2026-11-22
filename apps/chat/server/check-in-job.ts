/**
 * An agent's check-in job, as Prime's chat runs one (legacy/prime/user-history): a due check-in reads the board, and when something is due it
 * starts one job filed under the agent with the brief below, which reports back to the agent's work thread (`Boards.startCheckIn`). The words
 * come from Prime's sources, named above each block, and change only where pi-host differs: the board and job steer go through this server's
 * API, the report through send_message. ~/work/agent-factory-checkin-job/diff-notes.md lists each change and why it stays.
 */
import type { ChatAgent, ChatBoard, GoalTarget, PlanItem } from "../web/src/lib/api/shared/types.ts";
import { GOAL_PUSH_LINK, needsGo, numberedGoal, openGoals, planJob, stepGo } from "../web/src/lib/api/shared/chat-board.ts";
import { OWNER_ZONE_OFFSET_MS } from "./search.ts";

/** Prime's IDLE_CHECK_IN_MS (checkin-settings.ts): the interval while the plan has no open step. */
export const IDLE_CHECK_IN_MS = 24 * 60 * 60_000;
const OPEN = new Set(["todo", "doing", "blocked"]);

/** Prime's `planHasOpenStep` (checkin-steps.ts): any plan item at any depth is todo, doing or blocked. */
export function planHasOpenStep(board: ChatBoard | null): boolean {
  const visit = (items: readonly PlanItem[]): boolean => items.some(item => OPEN.has(item.status) || visit(item.children));
  return visit(board?.plan ?? []);
}

/** Prime's `planCheckIn` (checkin-settings.ts): the daily interval while the plan has no open step, unless the setting is longer already. */
export const planEveryMs = (everyMs: number, planOpen: boolean): number => planOpen || everyMs >= IDLE_CHECK_IN_MS ? everyMs : IDLE_CHECK_IN_MS;

/** The owner's "YYYY-MM-DD HH:MM" in KST, as Prime's `localTime` reads the box clock. */
const localTime = (at: number): string => new Date(at + OWNER_ZONE_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");

/** Prime's `dutyJobName("check-in", chat, at)` (chat-duty-job.ts): `check-in frontend bro 14:00`, the agent's name cut to 32 characters. */
export function checkInJobName(agent: string, at: number): string {
  const short = agent.replace(/[*_`#]/g, "").replace(/\s+/g, " ").trim().slice(0, 32).trim();
  return `check-in${short ? " " + short : ""} ${localTime(at).slice(11)}`;
}

/** Prime's `datedName` (chat-duty-job.ts): a taken name with the date before its time, `check-in frontend bro 10-12 12:39`. */
export function datedName(name: string, at: number): string {
  const date = localTime(at).slice(5, 10);
  return /\d\d:\d\d$/.test(name) ? name.replace(/(\d\d:\d\d)$/, `${date} $1`) : `${name} ${date}`;
}

/** Prime's CHECK_IN_WORDS (chat-duty-job.ts): the owner's sentence for the check-in (c90, 2026-10-15 23:52Z). */
export const CHECK_IN_WORDS = "check conversation and sync Plans to actual status, and resume tasks, nudge agents to achieve the goal. be aggressive, poteto mode use subagents aggressively";

/** Prime's CHECK_IN_REPORT (chat-duty-run.ts), with "chat" read as the agent (c80). */
export const CHECK_IN_REPORT = "Send the agent one report of at most 3 plain lines when your work is done: the number and gap of the goal furthest " +
  "from its target (like \"Instagram Tier A indexed 14.9 of 100%, +4.7 points since 10-15 06:42Z, about 10 days to target at this rate\"), what " +
  "you steered or started for the goals, and the detail file path the findings name. A stuck step or plan fix goes in only when it blocks a goal. " +
  "Never a list of step ids, a finding kind or the flagged list.";

/** Prime's BRIEF_ITEMS (shared/brief-cap.ts): goal items the prompt lists before it points at the detail file. */
const BRIEF_ITEMS = 3;

/** One open goal as the precheck reads it: its target's state and the live job that owns it. */
export interface GoalView {
  goal: PlanItem;
  /** null with no target, else whether the reading meets it. */
  met: boolean | null;
  /** The live job of the goal or of an open step under it. */
  owner?: string;
  /** The goal's push step (`GOAL_PUSH_LINK`), if it has one. */
  pushStep?: string;
  /** Open steps under the goal, which keep a goal at target open. */
  left: number;
}

export interface CheckInPrecheck {
  goals: GoalView[];
  /** Open leaf steps with no live job, no open For you todo and no missing go. */
  stuck: PlanItem[];
  jobs: readonly ChatAgent[];
  planOpen: boolean;
}

const met = (target: GoalTarget): boolean | null =>
  target.current === undefined ? false : target.direction === "down" ? target.current <= target.target : target.current >= target.target;

/**
 * The check-in's small precheck over the board, in place of Prime's whole one (chat-checkin.ts `checkInPrecheck`): the open goals with their
 * target numbers, the open leaf steps no live job moves, and the agent's jobs. `working` holds the names of the jobs at work (`workingJobs`).
 */
export function checkInPrecheck(board: ChatBoard | null, jobs: readonly ChatAgent[], working: ReadonlySet<string>): CheckInPrecheck {
  const plan = board?.plan ?? [];
  const names = new Map(jobs.flatMap(job => job.sessionId ? [[job.sessionId, job.name] as const] : []));
  const liveJob = (item: PlanItem): string | undefined => {
    const refs = [planJob(item.job), item.sessionId].filter((ref): ref is string => !!ref);
    return refs.map(ref => names.get(ref) ?? ref).find(name => working.has(name));
  };
  const openUnder = (item: PlanItem): PlanItem[] => item.children.flatMap(child => OPEN.has(child.status) ? [child, ...openUnder(child)] : []);
  const goals = openGoals(plan).map((goal): GoalView => {
    const under = openUnder(goal);
    const owner = [goal, ...under].map(liveJob).find(Boolean);
    const push = under.find(item => item.duty === GOAL_PUSH_LINK);
    return { goal, met: goal.target ? met(goal.target) : null, ...owner ? { owner } : {}, ...push ? { pushStep: push.id } : {}, left: under.length };
  });
  const asked = new Set((board?.todos ?? []).filter(todo => !todo.done && todo.step).map(todo => todo.step!));
  const stuck: PlanItem[] = [];
  const visit = (items: readonly PlanItem[]): void => {
    for (const item of items) {
      visit(item.children);
      if (!OPEN.has(item.status) || numberedGoal(item) || item.children.some(child => OPEN.has(child.status))) continue;
      if (liveJob(item) || asked.has(item.id) || (board && needsGo(item) && !stepGo(board, item))) continue;
      stuck.push(item);
    }
  };
  visit(plan);
  return { goals, stuck, jobs, planOpen: planHasOpenStep(board) };
}

const clip = (text: string, max: number): string => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const quote = (text: string): string => `"${clip(text.replace(/\s+/g, " ").trim(), 120)}"`;
/** Prime's `amount` and `unitText` (checkin-goals.ts). */
const amount = (value: number): string => value.toLocaleString("en-US", { maximumFractionDigits: 2 });
const unitText = (unit: string): string => !unit ? "" : unit === "%" ? "%" : ` ${unit}`;

/** Prime's `numberText` (checkin-goals.ts): "Instagram Tier A indexed 14.9 of 100%", or "... has target 100% and no measurement yet". */
function numberText(target: GoalTarget): string {
  const unit = unitText(target.unit);
  if (target.current === undefined) return `${target.metric} has target ${amount(target.target)}${unit} and no measurement yet`;
  return target.direction === "down" ? `${target.metric} ${amount(target.current)}${unit}, target at most ${amount(target.target)}${unit}`
    : `${target.metric} ${amount(target.current)} of ${amount(target.target)}${unit}`;
}

/** Prime's `gapText` (checkin-goals.ts): "85.1 points short", "738 over", "" when unmeasured or met. */
function gapText(target: GoalTarget): string {
  if (target.current === undefined) return "";
  const gap = target.direction === "down" ? target.current - target.target : target.target - target.current;
  if (gap <= 0) return "";
  return `${amount(gap)}${target.unit === "%" ? " points" : unitText(target.unit)} ${target.direction === "down" ? "over" : "short"}`;
}

/** Prime's `goalPromptLine` (checkin-goals.ts), without the trend and pace this server keeps no readings for. */
function goalPromptLine(view: GoalView): string {
  const { goal } = view;
  const title = `${quote(goal.text)} (${goal.id})`;
  if (!goal.target) return `${title} has no number yet: no target${goal.duty ? "" : " and no duty metric"}.`;
  const gap = gapText(goal.target);
  const pace = view.met ? view.left ? `at target, and it stays open for ${view.left} open ${view.left === 1 ? "step" : "steps"}` : "at target" : "";
  const owner = view.owner ? `${view.owner} owns it` : "no live job owns it";
  return `${title}: ${numberText(goal.target)}${gap ? `, ${gap}` : ""}${pace ? `; ${pace}` : ""}; ${owner}.`;
}

/** Prime's `goalSteer` (checkin-goals.ts): the message for a goal's owner job, with no owner's words on the board to quote. */
function goalSteer(view: GoalView): string {
  const gap = view.goal.target ? `${numberText(view.goal.target)}${gapText(view.goal.target) ? `, ${gapText(view.goal.target)}` : ""}.` : "";
  return `Goal ${view.goal.id}: ${quote(view.goal.text)}\n\nOwner's words: none on the board for this goal; quote him only from his messages in the agent's DM, with their message id.\n\n` +
    `${gap} Name the biggest blocker on this number and attack it now. Measure the number again when you have moved it, write it in the goal's target, and report it to the agent.`;
}

/** Prime's `goalDueLine` (checkin-goals.ts) for a goal with no number, or one off target with no live owner; null for any other goal. */
function goalDueLine(view: GoalView): string | null {
  const title = quote(view.goal.text);
  if (!view.goal.target) return `Give ${title} a target from the owner's words, with plan_update target.`;
  if (view.met || view.owner) return null;
  const ask = `${view.pushStep ? `Set one job on the push step ${view.pushStep} of ${title},` : `Add a push step under ${view.goal.id} with duty "${GOAL_PUSH_LINK}" for ${title}, set its job to`} ` +
    `a live job of the goal or a new one, and send it this message. Read the board first: a duty job may have added a fix step since this brief, ` +
    "and when one has a working job, steer that job instead and start none";
  const live = `\n\nRead the goal on the board right before you send it, and send the goal's live title and target metric where they changed since this precheck.`;
  return `${ask}:\n\n${goalSteer(view).split("\n").map(line => line ? `   ${line}` : "").join("\n")}${live}`;
}

/** What the prompt says about an empty board (no open step): the brief path, or nothing for a root chat with no brief. */
export interface CheckInExtras { brief?: string }

/** The empty-board item: the old in-thread check-in named the brief because the knowledge manager agent (11-20) answered seven check-ins with "the board is empty". */
const emptyLine = (brief: string): string => `The board has no open step. Read the agent's brief at ${brief} and add the steps it calls for with plan_add, ` +
  "each with a \"Done when\" line, then start or steer the job for each. When the brief asks for nothing more than the board shows, end in one short turn.";

/** The numbered items of Due this run, which `checkInPrompt` lists and `checkInIdle` counts. */
function dueItems(precheck: CheckInPrecheck, extras: CheckInExtras): string[] {
  const due = precheck.goals.flatMap(view => { const line = goalDueLine(view); return line ? [line] : []; });
  const stuck = precheck.stuck.length;
  // Prime's met line (chat-checkin.ts `checkInPrompt`): an item at target closes now when a duty keeps its number (c110).
  const metGoals = precheck.goals.filter(view => view.met && !view.left).map(view => view.goal);
  const keepers = [...new Set(metGoals.flatMap(goal => goal.duty ? [`duty ${goal.duty.split("/")[0]}`] : []))];
  const unkept = metGoals.filter(goal => !goal.duty).length;
  return [
    ...due.slice(0, BRIEF_ITEMS), ...due.length > BRIEF_ITEMS ? [`${due.length - BRIEF_ITEMS} more goals need the same, listed in the detail file.`] : [],
    ...stuck ? [`${stuck} open ${stuck === 1 ? "step has" : "steps have"} no live owner. Push each one toward done in this run: resume its job, start a fix job, ` +
      "or close it with the evidence you checked, and give a step only the owner can unblock a For you todo. The detail file lists them."] : [],
    ...metGoals.length ? [`${metGoals.length === 1 ? `${metGoals[0]!.id} ${quote(metGoals[0]!.text)} meets its target. Close it now` : `${metGoals.length} open items, like ` +
      `${metGoals[0]!.id} ${quote(metGoals[0]!.text)}, meet their target. Close each now`} with a note that names the reading, and wait for no further run: ` +
      `a duty keeps the metric from here and puts a fix step back when it slips (c110). ${keepers.length ? `${keepers.join(", ").replace(/^d/, "D")} ${keepers.length === 1 ? "keeps" : "keep"} ` +
      `${metGoals.length === 1 ? "it" : "theirs"}${unkept ? `, and the detail file names the ${unkept === 1 ? "one" : `${unkept}`} no duty keeps yet: add ${unkept === 1 ? "its" : "each"} metric to a duty first` : ""}.`
      : "No duty keeps it yet: add the metric to a duty first."}`] : [],
    ...!precheck.planOpen && extras.brief ? [emptyLine(extras.brief)] : [],
  ];
}

/** Prime's `checkInPrompt` (chat-checkin.ts): the Goals and Due this run sections of the brief. */
export function checkInPrompt(precheck: CheckInPrecheck, extras: CheckInExtras = {}): string {
  const goals = precheck.goals.map(view => `- ${goalPromptLine(view)}`);
  const items = dueItems(precheck, extras);
  return [
    `## Goals\n${goals.length ? goals.join("\n") : "The agent has no open goal."}`,
    `## Due this run\n${items.length ? items.map((line, at) => `${at + 1}. ${line}`).join("\n") : "Nothing is due: every goal moves on pace with a live owner. End in one short turn."}`,
  ].join("\n\n");
}

/** Prime's `checkInIdle` (chat-checkin.ts): nothing is due, so the check-in starts no job. */
export const checkInIdle = (precheck: CheckInPrecheck, extras: CheckInExtras = {}): boolean => dueItems(precheck, extras).length === 0;

/** The run's detail file, after Prime's `checkInPrecheckText` (chat-checkin.ts) cut to the sections this precheck has. */
export function checkInDetail(precheck: CheckInPrecheck, at: number): string {
  const section = (head: string, lines: readonly string[]) => lines.length ? [`### ${head}\n${lines.map(line => `- ${line}`).join("\n")}`] : [];
  const due = precheck.goals.flatMap(view => { const line = goalDueLine(view); return line ? [`${goalPromptLine(view)}\n\n  ${line.split("\n").join("\n  ")}`] : []; });
  return [
    `# Check-in run of ${localTime(at)} KST`,
    ...section("Goals, the check-in's first job (steer or start one owner job per goal; the message for each is under it)", due),
    ...section("Stuck steps (each ends this run with a live owner, a For you todo or a close)", precheck.stuck.map(item =>
      `${item.id} ${quote(item.text)} ${item.status}${item.job ? `, job ${item.job} (not working)` : ", no job"}${item.waitFor ? `, waits for ${quote(item.waitFor)}` : ""}` +
      `${item.note ? `; note: "${clip(item.note.replace(/\s+/g, " "), 300)}"` : ""}`)),
    ...section("Jobs", precheck.jobs.map(job => `${job.name} (${job.state}${job.lastActivityAt ? `, last active ${job.lastActivityAt.slice(0, 16)}Z` : ""})${job.activity ? `: ${clip(job.activity.replace(/\s+/g, " "), 160)}` : ""}`)),
  ].join("\n\n") + "\n";
}

/** Where the check-in job reaches this server: the board, the job steer, and the detail file. */
export interface CheckInJobInput {
  agent: string; workThread: string; job: string; at: number; prompt: string; detail: string; boardApi: string; steerApi: string; itemsApi: string;
}

/**
 * Prime's `checkInJobBrief` (chat-duty-job.ts, c80, c90): the owner's sentence, where the agent's board and conversation are, the goals and
 * the actions due (`prompt`), and the calls the job acts with. No stock rule lines and no list of step ids: the detail file holds the findings.
 */
export function checkInJobBrief({ agent, workThread, job, at, prompt, detail, boardApi, steerApi, itemsApi }: CheckInJobInput): string {
  return [
    `# ${job}: the check-in of the agent "${agent}"`,
    `You are the check-in job "${job}" of the agent "${agent}", started ${localTime(at)} KST. The owner's words for the check-in (verbatim):\n\n> ${CHECK_IN_WORDS}`,
    "The plan holds only tasks that finish, and this run pushes each open step toward done: resume its job, start a fix job, or close it with the " +
      "evidence you checked. Upkeep is a duty metric, so a goal or step whose title says keep, stays, always or every ... is green leaves the plan. " +
      "Goals are a few measured outcomes in the owner's terms, like \"Instagram profiles crawl at 10k a minute, held 6 h\", with their steps under " +
      "them. A problem that kept coming back in the thread becomes a duty metric, and a goal or step whose target reads met closes at once when a duty keeps its metric.",
    `The agent's work thread is ${workThread}. Its board is GET ${boardApi}, and its conversation is GET ${itemsApi}?limit=40, newest page first.`,
    `${prompt}\n\nThe full precheck, with every step and finding, is in ${detail}. Read it for the work you take on; never paste it into a message.`,
    "## How to act",
    [
      `Apply board changes with \`import httpx\` and \`httpx.post(${JSON.stringify(boardApi)}, json={"actor": "agent", "ops": ops}, timeout=60).json()\`, where ops are chat_board ops.`,
      "Start a job with `await rlm.create_session(brief, name=..., cwd=...)` and set it as its step's job in the same board change. Message a " +
        `job of the agent with \`httpx.post(${JSON.stringify(steerApi)}, json={"job": job_name, "text": text, "from": ${JSON.stringify(job)}}, timeout=60).json()\`: the server delivers it, ` +
        "and a job whose turn ended takes it as a new turn. Write that message " +
        "in a few plain sentences that name at most 2 step ids in a paragraph, and the other steps by a few words of their title: on 10-18 the " +
        "12:40 steer to a gaps job listed four step ids in one paragraph, which the job had to look up on the board.",
      `${CHECK_IN_REPORT} Send it with send_message (with no such tool, make it your final answer), and the chat server posts it to the agent's ` +
        "work thread as a `[check-in]` note; when nothing needs the agent, send nothing.",
    ].map(line => `- ${line}`).join("\n"),
  ].join("\n\n") + "\n";
}
