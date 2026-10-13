import type { HandoffRule } from "./chat-corrections.ts";
import { finishedOpen, looksDone } from "./checkin-done.ts";
import { heartbeatLine, oneSessionLoad, type RedundantHeartbeat, redundantHeartbeats, sessionLoadLine, type ScheduledJob, type SessionLoad, type Train } from "./checkin-load.ts";
import { REPEAT_HEAD, repeatLines } from "./checkin-repeats.ts";
import type { FlaggedSlice, PrecheckOutput } from "./shared/chat-duties.ts";
import { snapshotJsonFile, transactJsonFile, type JsonFile } from "./locked-json.ts";
import { BOARD_LIMITS, goWaitText, planJob, stepGoWait } from "./shared/chat-board.ts";
import type { ChatBoard, ChildAgent, PlanItem, SessionRow, StopReason, ThreadMessage } from "./shared/types.ts";
import { ago, CHASE_ESCALATE_MS, childName, childWorking, classLine, clip, type JobFact, type JobMessage, OPEN, openAsks, ownerLabel, parkedBy, quote, readySteps,
  noteFacts, recordedAt, STATE_WORD, STEP_CLASSES, type StepClass, type StepMemo, stepOwner, stepView, type StepView, todoForStep, waitsOnOwner, walk, withGoals } from "./checkin-steps.ts";
import { blockedLine, blockedOnOthers, type BlockedStep, countedGap, deadRunWaits, type DutyRef, extraGoals, extraGoalsLine, type FoldGoal, foldLine, type GateFinding,
  gateFindings, gateLine, type GoalGap, goalGapLine, goalGaps, goalsToFold, goalsWithoutDuty, heldElsewhere, type HeldGoal, heldLine, idleGoalLine, idleGoals,
  lookDoneLine, looseGoalLine, looseGoals, noDutyLine, noProgress, type NoProgress, noProgressLine, openUnderClosed, scopeLine, type ScopeMiss, scopeMisses,
  staleLine, type StaleStep, staleSteps, stalledLine, type StalledStep, stalledSteps, underClosedLine, type WaitMet, waitMetLine, waitsMet } from "./checkin-findings.ts";
import { CHECK_IN_MS, clockTime, localTime } from "./checkin-settings.ts";
export { finishedOpen, looksDone };

/**
 * The check-in duty's precheck (src/shared/chat-duties.ts, `CHECK_IN_DUTY`; src/chats.ts runs it). At the chat's own interval (CHECK_IN_MS in
 * src/checkin-settings.ts unless the owner set another, see CheckInSetting) the server reads the chat's jobs (its subagents, and every thread an
 * open plan step names as its owner) and the board, sorts every open step into a class (src/checkin-steps.ts), checks the plan's shape
 * (src/checkin-findings.ts), and hands the result to one duty job as context (`checkInPrecheckText`). Code measures; the duty job decides what to do.
 */
/** A job at work with no activity for this long is listed as quiet in the duty job's brief. */
export const STALE_MS = 30 * 60_000;
/** A failed turn (the chat's own, or a step owner's) is acted on again after these waits, then every 20 min while it stays failed. */
export const RETRY_BACKOFF_MS: readonly number[] = [5 * 60_000, 10 * 60_000, 20 * 60_000];
/** Whether retry number `attempts` (0 for the first) is due: its wait has passed since `since` (the failure, or the last retry). */
export const retryDue = (attempts: number, since: number, now: number): boolean =>
  now - since >= RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length - 1)]!;
/** The open steps the duty job's brief lists, oldest change first. */
const MAX_OPEN = 30;
/** What the last check-in saw for one chat: when it ran, and each plan item's last change. */
export interface CheckInMemory { at: number; steps: Record<string, StepMemo>;
  /** When this chat's memory began (its first check-in, kept across runs): the no-progress check needs a full hour of it. */
  since?: number;
  /** How many runs in a row flagged each finding, by `flagKey` (src/checkin-repeats.ts). */
  flags?: Record<string, number> }
/**
 * What the precheck needs besides the jobs and the board: the chat's own id and name (a step it owns is `mine`), a board read error, the
 * catalog rows (the threads a step's `waitFor` can name), and the ledger's handoffs (`handoffRules`: an open step on another thread's topics).
 */
export interface CheckInContext { self?: readonly string[]; boardError?: string; rows?: readonly Pick<SessionRow, "id" | "name" | "archived">[];
  handoffs?: readonly HandoffRule[];
  /** The ids of the owner corrections in force, for parked steps (`parkedBy`); every cited id counts when not given. */
  corrections?: readonly string[];
  /** The chat's check-in interval, for when a goal's measurement goes stale (`targetStaleMs`); CHECK_IN_MS when not given. */
  everyMs?: number;
  /** The chat's duties, for the goals they run (`goalsToFold`) and a chat with goals and no duty (`goalsWithoutDuty`); not given: neither counts them. */
  duties?: readonly DutyRef[];
  /** The roots the chat started (the job registry's names or ids): its own jobs, never another session's load (`oneSessionLoad`). */
  jobs?: readonly string[];
  /** The chat's own schedules (`readHeartbeats`), for the heartbeats the check-in covers (`redundantHeartbeats`); none when not given. */
  heartbeats?: readonly ScheduledJob[];
  /** The release train in the CI cache (`readTrain`), for steps that wait on it (`trainMoves`); not given: no step counts as on a moving train. */
  train?: Train }

/** What one check-in precheck found: the memory to keep, every open leaf step with its class, the steps on another thread's work, the open items that look done, and other facts. */
export interface CheckInPrecheck {
  memory: CheckInMemory; steps: StepView[]; scope: ScopeMiss[]; gates: GateFinding[]; stalled: StalledStep[]; goals: GoalGap[]; blocked: BlockedStep[];
  done: { item: PlanItem; reason: string }[]; loose: PlanItem[]; extra: PlanItem[]; underClosed: { item: PlanItem; parent: PlanItem }[];
  held: HeldGoal[]; waitsMet: WaitMet[]; noProgress: NoProgress | null; stale: StaleStep[]; fold: FoldGoal[]; load: SessionLoad[]; heartbeats: RedundantHeartbeat[];
  /** The open goals when the chat has no active duty (`goalsWithoutDuty`); none when the context gave no duties. */
  noDuty: PlanItem[];
  /** A board read error, an ask overflow, steps that can start, and steps that wait on the owner with no question in For you. */
  facts: string[];
}

/**
 * The check-in's precheck, code only: each plan item's last change (when its status, text, owner or wait last differed; the board's `updatedAt`
 * for one never seen before; a note edit is no change), every open leaf step's class (`stepClass`), the open items on another thread's work by a
 * ledger handoff (`scopeMisses`), the open items that look done (`looksDone`), and the facts around them. A board read error keeps the last
 * steps. Nothing here decides what happens next: the duty job reads it as context.
 */
export function checkInPrecheck(previous: CheckInMemory | undefined, facts: readonly JobFact[], board: ChatBoard | null, now: number, context: CheckInContext = {}): CheckInPrecheck {
  const self = new Set(context.self ?? []);
  const openTodos = (board?.todos ?? []).filter(todo => todo.from === "agent" && !todo.done);
  /** Asks already answered: a step whose question the owner answered does not need a new one. */
  const answeredTodos = (board?.todos ?? []).filter(todo => todo.done || (todo.reply ?? "").trim() !== "");
  const firstSeen = Math.min(now, Date.parse(board?.updatedAt ?? "") || now);
  const steps: Record<string, StepMemo> = context.boardError ? { ...previous?.steps } : {};
  const views: StepView[] = [];
  const notes: string[] = [];
  const active = context.corrections ? new Set(context.corrections) : undefined;
  const visit = (item: PlanItem): boolean => {
    let openBelow = false;
    for (const child of item.children) openBelow = visit(child) || openBelow;
    const before = previous?.steps[item.id];
    const memo = stepMemo(item, before, now, firstSeen);
    steps[item.id] = memo;
    const isOpen = OPEN.has(item.status);
    if (!isOpen || openBelow) return isOpen || openBelow;
    views.push(stepView(item, memo.at, self, facts, openTodos, context.rows ?? [], now, active));
    if (waitsOnOwner(item) && parkedBy(item, active) === undefined && !todoForStep(item, openTodos) && !todoForStep(item, answeredTodos)) notes.push(`${item.id} ${quote(item.text)} waits on the owner but For you has no question for it`);
    const leave = stepGoWait(item);
    if (leave) notes.push(`${item.id} ${quote(item.text)} ${goWaitText(leave)}, a wait nobody needs (c47): take the action now and clear the waitFor`);
    return true;
  };
  if (!context.boardError) for (const item of board?.plan ?? []) visit(item);
  if (context.boardError) notes.push(`the board cannot be read: ${clip(context.boardError, 160)}`);
  const asks = openAsks(board);
  if (!context.boardError && asks > BOARD_LIMITS.openAsks) notes.push(`${asks} open owner todos; the limit is ${BOARD_LIMITS.openAsks}`);
  const gates = context.boardError ? [] : gateFindings(board, facts, active);
  const held = new Set(gates.map(gate => gate.item.id));
  if (!context.boardError) {
    for (const step of readySteps(board)) if (!held.has(step.id)) notes.push(`${step.id} ${quote(step.text)} can start: the steps before it are done and it has no job`);
  }
  for (const gate of gates) if (gate.kind === "go_waiting") notes.push(gateLine(gate));
  const goaled = withGoals(views, board);
  const since = previous?.since ?? previous?.at ?? now;
  const blocked = context.boardError ? [] : blockedOnOthers(goaled, context.rows ?? [], self, now, board?.scratch, context.train);
  // A step blocked on others gets that one finding, which names the blocker and the action; stalled_steps' "act on it" on the same step gave
  // two lines with two different asks (34 steps from 10-13 09:15 to 23:59 KST, VP of CI's nine waits on the secrets cache at 14:29 among them).
  const onOthers = new Set(blocked.map(block => block.view.item.id));
  return { memory: { at: now, steps, since }, steps: goaled, scope: context.boardError ? [] : scopeMisses(board, context.handoffs ?? [], context.self ?? []), gates,
    stalled: context.boardError ? [] : stalledSteps(goaled, steps, context.rows ?? [], self, now, context.train).filter(stall => !onOthers.has(stall.view.item.id)),
    goals: context.boardError ? [] : goalGaps(board, goaled, context.everyMs ?? CHECK_IN_MS, now), blocked, done: context.boardError ? [] : finishedOpen(board),
    loose: context.boardError ? [] : looseGoals(board), extra: context.boardError ? [] : extraGoals(board), underClosed: context.boardError ? [] : openUnderClosed(board),
    held: context.boardError ? [] : heldElsewhere(goaled, board, context.rows ?? [], self),
    noProgress: context.boardError ? null : noProgress(board, goaled, steps, since, context.rows ?? [], self, now, context.train),
    waitsMet: context.boardError ? [] : [...waitsMet(goaled, board, context.rows ?? [], self), ...deadRunWaits(goaled, context.train, now)],
    stale: context.boardError ? [] : staleSteps(board, facts, item => steps[item.id] ? recordedAt(steps[item.id]!) : now, self, context.everyMs ?? CHECK_IN_MS, now),
    fold: context.boardError ? [] : goalsToFold(board, facts, self, context.duties ?? []), load: oneSessionLoad(goaled, context.jobs),
    heartbeats: redundantHeartbeats(context.heartbeats ?? [], context.duties ?? []), noDuty: context.boardError || !context.duties ? [] : goalsWithoutDuty(board, context.duties), facts: notes };
}

/**
 * A step's memo at this run: `at` moves when its sig changes, `waitAt` when its wait changes, and a new waitUntil joins `untils`. A cleared
 * waitUntil or a new waitFor starts `untils` over, so only the current wait's pushes count (api portal vp p4: its 14:00Z to 14:30Z push was for a
 * wait cleared at 14:25Z).
 */
export function stepMemo(item: PlanItem, before: StepMemo | undefined, now: number, firstSeen: number): StepMemo {
  const sig = stepSig(item);
  const wait = waitSig(item);
  const newWait = item.waitUntil === undefined || (before?.wait !== undefined && (JSON.parse(before.wait) as string[])[0] !== (item.waitFor ?? ""));
  const seen = newWait ? [] : before?.untils ?? [];
  const untils = item.waitUntil && seen.at(-1) !== item.waitUntil ? [...seen, item.waitUntil].slice(-STALL_UNTILS) : seen;
  const turnedDone = item.status === "done" && before !== undefined && !before.sig.startsWith('["done"');
  const doneAt = turnedDone ? now : item.status === "done" ? before?.doneAt : undefined;
  const facts = OPEN.has(item.status) ? noteFacts(item.note) : [];
  const factsAt = before?.facts && facts.some(fact => !before.facts!.includes(fact)) ? now : before?.factsAt;
  return { sig, at: before ? before.sig === sig ? before.at : now : firstSeen, wait, ...(doneAt !== undefined ? { doneAt } : {}),
    ...(facts.length ? { facts } : {}), ...(factsAt !== undefined && facts.length ? { factsAt } : {}),
    // A memo from before `wait` existed counts its last change (its sig holds the waits) as the wait's start.
    waitAt: !before ? firstSeen : before.wait === undefined ? before.at : before.wait === wait ? before.waitAt ?? before.at : now, ...(untils.length ? { untils } : {}) };
}
/** What a step waits on: its waitFor, its waitUntil and its owner. */
const waitSig = (item: PlanItem): string => JSON.stringify([item.waitFor ?? "", item.waitUntil ?? "", stepOwner(item) ?? ""]);

/** The waitUntil values a step's memo keeps. */
export const STALL_UNTILS = 5;

/** One job of the chat as the brief lists it: its name, state, last activity, its step and its last message. */
function jobLine(fact: JobFact, now: number): string {
  const state = fact.cancelled ? "ended (cancelled)" : STATE_WORD[fact.state];
  const quiet = fact.state === "working" && fact.activityAt !== undefined && now - fact.activityAt > STALE_MS ? `, no activity for ${ago(now - fact.activityAt)}` : "";
  const last = fact.activityAt !== undefined ? `, last activity ${ago(now - fact.activityAt)} ago` : "";
  const step = fact.item ? `, on ${fact.item.id} ${quote(fact.item.text)} (${fact.item.status})` : "";
  const error = fact.state === "failed" && fact.error ? `, error: ${clip(fact.error, 120)}` : "";
  const said = fact.lastMessage ? `, last message at ${clockTime(fact.lastMessage.at)}: ${quote(fact.lastMessage.text)}` : "";
  return `${ownerLabel(fact)}: ${state}${quiet || last}${step}${error}${said}`;
}

/**
 * The check-in precheck as the duty job's brief gives it, plain markdown: the goals nobody works on (`idleGoals`), the steps whose class needs action (`classLine`), the open items that
 * look done, the steps on another thread's work, the other facts, the flagged items the class lines do not cover (a job end with no update),
 * the chat's jobs, and every open step with its class, owner and age, oldest change first. Findings flagged in REPEAT_RUNS or more runs in a
 * row (`streaks`, `flagStreaks`) come first, under Flagged again.
 */
export function checkInPrecheckText(precheck: CheckInPrecheck, facts: readonly JobFact[], flagged: readonly FlaggedSlice[], now: number,
  streaks: Readonly<Record<string, number>> = {}): string {
  const stale = flagged.filter(slice => slice.kind === "stale_steps");
  /** A stale step is listed once, under Stale steps. */
  const staleIds = new Set(stale.map(slice => slice.item));
  const act = precheck.steps.flatMap(view => {
    /** An orphan that looks done needs a check and a close, not a new job: it is listed under Look done only. */
    const line = staleIds.has(view.item.id) || (view.cls === "orphan" && looksDone(view.item) !== null) ? null : classLine(view, now);
    return line ? [view.target ? `${line} (the thread to chase: ${clip(view.target.name, 40)}, thread:${view.target.id})` : line] : [];
  });
  const ended = flagged.filter(slice => slice.kind === "job_end_unrecorded" || slice.kind === "job_end_silent").map(slice => slice.excerpt);
  const idle = flagged.filter(slice => slice.kind === "idle_goals").map(slice => slice.excerpt);
  const gated = flagged.filter(slice => slice.kind === "go_missing" || slice.kind === "requirements_missing").map(slice => slice.excerpt);
  const merged = flagged.filter(slice => slice.kind === "merges_without_go").map(slice => slice.excerpt);
  const open = [...precheck.steps].sort((a, b) => a.changedAt - b.changedAt).map(view => {
    const { item, owner, mine, cls } = view;
    const who = mine ? "owner the chat" : owner ? `owner ${ownerLabel(owner)} (${owner.cancelled ? "ended" : STATE_WORD[owner.state]})` : item.job ? `owner ${item.job} (not found)` : "no owner";
    const until = Date.parse(item.waitUntil ?? "");
    const waits = `${Number.isFinite(until) ? `, waits until ${localTime(until)}` : ""}${item.waitFor ? `, waits for ${quote(item.waitFor)}` : ""}`;
    const note = item.note ? `; note: "${clip(item.note.replace(/\s+/g, " "), 300)}"` : "";
    return `${item.id} (${cls}) ${quote(item.text)} ${item.status}, ${who}${waits}, last change ${ago(now - view.changedAt)} ago${note}`;
  });
  const listed = open.length > MAX_OPEN ? [...open.slice(0, MAX_OPEN - 1), `and ${open.length - MAX_OPEN + 1} more`] : open;
  const section = (head: string, lines: readonly string[]) => lines.length ? [`### ${head}\n${lines.map(line => `- ${line}`).join("\n")}`] : [];
  /** A goal to fold is listed once, under Goals to fold. */
  const folded = new Set(precheck.fold.map(fold => fold.goal.id));
  return [
    ...section(REPEAT_HEAD, repeatLines(streaks, flagged)),
    ...section("Merged without the owner's go (a repo rule breach: report each to the owner in this run; never merge without his go on that PR)", merged),
    ...section("Hard gates broken (the owner's go, the requirements check): fix each now", gated),
    ...section("Goals to fold (apply these board ops in this run, in this order; no goal stays open only to wait)", precheck.fold.map(foldLine)),
    ...section("Plan shape (fix it in this run with board ops: close or fold what shipped, move a loose step under its goal with plan_update parent, " +
      "hand off or remove the rest; the owner should never have to tidy the plan)", [...precheck.held.filter(held => !folded.has(held.goal.id)).map(heldLine),
      ...precheck.loose.filter(goal => !folded.has(goal.id)).map(looseGoalLine),
      ...precheck.extra.length ? [extraGoalsLine(precheck.extra)] : [], ...precheck.underClosed.map(underClosedLine)]),
    ...section("Waits that are over (act on each in this run)", precheck.waitsMet.map(waitMetLine)),
    ...section("No progress in the last hour (work should be moving)", precheck.noProgress ? [noProgressLine(precheck.noProgress)] : []),
    ...section("Goal gaps, largest first (for the largest gaps, push the next concrete step that closes the gap in this run: start or steer a job, " +
      "pull a slot forward; confirming that steps are waiting is not an answer)", precheck.goals.filter(gap => !folded.has(gap.goal.id)).map(goalGapLine)),
    ...section("Blocked on CI, a release or another thread with no job on it (start a job that fixes each blocker in this run, or send its owner a " +
      "concrete patch; marking the step waiting is not an answer)", precheck.blocked.map(blocked => blockedLine(blocked, now))),
    ...section("One session carries too much (split these into your own jobs per part)", flagged.filter(slice => slice.kind === "one_session_load").map(slice => slice.excerpt)),
    ...section("Heartbeats the check-in or a duty covers (have the chat delete each)", flagged.filter(slice => slice.kind === "redundant_heartbeats").map(slice => slice.excerpt)),
    ...section("Open goals and no duty", flagged.filter(slice => slice.kind === "goals_without_duty").map(slice => slice.excerpt)),
    ...section("Goals nobody works on (start parallel jobs for their independent work)", idle),
    ...section("Stalled waits (take one action on each in this run: check whether what it waits for already happened, do the next action yourself, start or steer a job, or add a For you todo; \"still waiting\" and a later waitUntil are not answers)",
      precheck.stalled.map(stalledLine)),
    ...section("Stale steps (update or close each in this run: the job's result, the next action, done or dropped; the board refuses a later waitUntil)", stale.map(slice => slice.excerpt)),
    ...section("Steps whose class needs action", act),
    ...section("Look done (check the real state: close, keep or reopen)", precheck.done.filter(found => !folded.has(found.item.id)).map(lookDoneLine)),
    ...section("Owned by another thread by an owner ruling", precheck.scope.map(scopeLine)),
    ...section("Job ends the board does not show", ended),
    ...section("Other facts", precheck.facts),
    ...section("Jobs", facts.map(fact => jobLine(fact, now))),
    ...section("Every open step, oldest change first", listed),
  ].join("\n\n") || "The board has no open step and no job.";
}

/** What a step's last change compares: its status, text, owner and waits. A note edit is no change, so a chase note does not hide a stall. */
export const stepSig = (item: PlanItem): string =>
  JSON.stringify([item.status, item.text, planJob(item.job) ?? "", ...(item.waitUntil || item.waitFor ? [item.waitUntil ?? "", item.waitFor ?? ""] : [])]);

/**
 * The check-in duty's metrics (`CHECK_IN_DUTY`), each at most 0. `idle_goals` is an open goal nobody works on (`idleGoals`). `job_end_silent` is a step whose job ended badly (a provider error, an abort,
 * a stop mid-tool, the length limit) with no report, which the server told the chat at once (the check-in record's told ends), not updated a
 * check-in later; such a step is counted there and not again in `job_end_unrecorded`. `scope_misses` is an open step on another thread's work
 * by a ledger handoff (`scopeMisses`, correction c7). `stalled_steps` is a step on a passive wait (`stalledSteps`, c23). `go_missing` and
 * `requirements_missing` are the broken hard gates (`gateFindings`, W50), `merges_without_go` a merge step done without the owner's go on its PR (c49). `goal_gaps` is a goal under half its target with no live job (`countedGap`, W54).
 * `blocked_on_others` is a step blocked on CI, a release or another thread for over an hour with no live job (`blockedOnOthers`, W56).
 * `finished_open` is an open item that looks done (`looksDone`), `loose_goals` an open goal with no step under it (`looseGoals`) and
 * `extra_goals` the open goals over BOARD_LIMITS.openGoals (`extraGoals`), `open_under_closed` an open item right under a closed one
 * (`openUnderClosed`), the plan's shape (c44). `held_elsewhere` is a goal whose every open step another thread holds (`heldElsewhere`) and
 * `wait_met` a step whose named wait is over (`waitsMet`), finished work left open behind a wait (c45). `no_progress` is 1 when no plan
 * item was done in the last hour and some open step is not blocked under a goal that did not move (`noProgress`). `stale_steps` is an open item with a waitUntil over 24 h
 * past or a job that ended with no update (`staleSteps`, c44); an item counted in `finished_open` or `wait_met` is not counted again. A step's
 * record is counted once, by the first that applies: `job_end_silent`, `job_end_unrecorded`, `stale_steps`, `due_late`. `goals_to_fold` is an
 * open goal whose work runs as a duty or rides other goals' jobs (`goalsToFold`, c46); that goal is not counted again in `finished_open`,
 * `loose_goals`, `held_elsewhere` or `goal_gaps`. `one_session_load` is a goal and another session that owns too many of its open steps (`oneSessionLoad`, c51),
 * `redundant_heartbeats` an active heartbeat of the chat whose work the check-in or one of its duties already does (`redundantHeartbeats`, c51).
 * `goals_without_duty` is 1 for a chat with an open goal and no active duty (`goalsWithoutDuty`).
 */
export type ConvergenceMisses = { orphan_steps: number; due_late: number; stale_chase_24h: number; job_end_unrecorded: number; job_end_silent: number; scope_misses: number;
  idle_goals: number; stalled_steps: number; go_missing: number; requirements_missing: number; merges_without_go: number; goal_gaps: number; blocked_on_others: number; finished_open: number;
  loose_goals: number; extra_goals: number; open_under_closed: number; held_elsewhere: number; wait_met: number;
  no_progress: number; stale_steps: number; goals_to_fold: number; one_session_load: number; redundant_heartbeats: number; goals_without_duty: number };
export const NO_MISSES: ConvergenceMisses = { orphan_steps: 0, due_late: 0, stale_chase_24h: 0, job_end_unrecorded: 0, job_end_silent: 0, scope_misses: 0, idle_goals: 0,
  stalled_steps: 0, go_missing: 0, requirements_missing: 0, merges_without_go: 0, goal_gaps: 0, blocked_on_others: 0, finished_open: 0, loose_goals: 0, extra_goals: 0, open_under_closed: 0,
  held_elsewhere: 0, wait_met: 0, no_progress: 0, stale_steps: 0, goals_to_fold: 0, one_session_load: 0, redundant_heartbeats: 0, goals_without_duty: 0 };
/** What the precheck found on the board besides the step classes: steps on another thread's work, broken hard gates, stalled waits, the plan's shape. */
export interface BoardFindings { scope: readonly ScopeMiss[]; gates: readonly GateFinding[]; stalled: readonly StalledStep[]; goals: readonly GoalGap[]; blocked: readonly BlockedStep[];
  done: readonly { item: PlanItem; reason: string }[]; loose: readonly PlanItem[]; extra: readonly PlanItem[]; underClosed: readonly { item: PlanItem; parent: PlanItem }[];
  held: readonly HeldGoal[]; waitsMet: readonly WaitMet[]; noProgress: NoProgress | null; stale: readonly StaleStep[]; fold: readonly FoldGoal[];
  load?: readonly SessionLoad[]; heartbeats?: readonly RedundantHeartbeat[]; noDuty?: readonly PlanItem[];
  /** The step memos of this run (`checkInPrecheck`), for when a step's record last moved (`recordedAt`). */
  memory?: Pick<CheckInMemory, "steps"> }

/**
 * The misses of one chat's classified steps: orphan steps; due steps whose waitUntil passed more than one tick (`everyMs`) ago; stale chases of
 * 24 h or more (a step with an open For you todo is `foryou`, never a chase); steps whose job ended more than one tick ago, after the step last
 * changed (`job_end_silent` when the server told that end as a bad one, else `job_end_unrecorded`, where a note that gained a fact since the end
 * is a change too, `recordedAt`); open steps on another thread's work; stalled waits; and broken hard gates (a go still waiting is a fact, not a
 * miss). Each flagged slice names its step (`item`).
 */
export function convergenceMisses(chat: string, steps: readonly StepView[], { scope, gates, stalled, goals, blocked, done, loose, extra, underClosed, held, waitsMet: over,
  noProgress: still, stale, fold, load = [], heartbeats = [], noDuty = [], memory }: BoardFindings, told: Readonly<Record<string, ToldEnd>>, everyMs: number, now: number): PrecheckOutput & { metrics: ConvergenceMisses; flagged: FlaggedSlice[] } {
  const misses: ConvergenceMisses = { ...NO_MISSES };
  const flagged: FlaggedSlice[] = [];
  const flag = (kind: keyof ConvergenceMisses, item: string, excerpt: string) => { misses[kind]++; flagged.push({ chat, at: now, kind, excerpt, item }); };
  const counted = new Set([...done.map(found => found.item.id), ...over.map(met => met.view.item.id)]);
  const staleById = new Map(stale.filter(entry => !counted.has(entry.item.id)).map(entry => [entry.item.id, entry]));
  for (const view of steps) {
    const id = view.item.id;
    const line = classLine(view, now) ?? `${id} ${view.cls}`;
    // An item that looks done or whose wait is over gets that finding's "close it" or "act on it"; "start a job" on it too was a second, wrong ask
    // (AI harness 10-13 23:07 KST: p1 had every step closed and read both finished_open and orphan_steps).
    if (view.cls === "orphan" && !counted.has(id)) flag("orphan_steps", id, line);
    if (view.cls === "stale-chase" && now - view.changedAt >= CHASE_ESCALATE_MS) flag("stale_chase_24h", id, line);
    const owner = view.owner;
    const silent = owner && owner.state !== "working" ? told[owner.key] : undefined;
    const end = owner && !owner.key.startsWith("thread:") && owner.state !== "working" && !owner.cancelled && !holdsOnWait(view.item, now) ? owner.activityAt : undefined;
    const staleStep = staleById.get(id);
    staleById.delete(id);
    const memo = memory?.steps[id];
    const recorded = memo ? recordedAt(memo) : view.changedAt;
    if (silent && silent.at > view.changedAt) {
      if (now - silent.at > everyMs) {
        flag("job_end_silent", id, `${id} "${view.item.text.slice(0, 60)}": job ${owner!.name} ${jobEndWords(silent)} ${Math.round((now - silent.at) / 60_000)} min ago with no report and the step has not changed since`);
        continue;
      }
    } else if (end !== undefined && end > recorded && now - end > everyMs) {
      flag("job_end_unrecorded", id, `${id} "${view.item.text.slice(0, 60)}": job ${owner!.name} ended ${Math.round((now - end) / 60_000)} min ago and the step has not changed since`);
      continue;
    }
    if (staleStep) flag("stale_steps", id, staleLine(staleStep));
    else if (view.cls === "due" && now - Date.parse(view.item.waitUntil!) > everyMs) flag("due_late", id, line);
  }
  // An open item with open steps under it is no step view; its stale record still counts.
  for (const entry of staleById.values()) flag("stale_steps", entry.item.id, staleLine(entry));
  for (const miss of scope) { misses.scope_misses++; flagged.push({ chat, at: now, kind: "scope_misses", excerpt: scopeLine(miss), item: miss.item.id }); }
  for (const idle of idleGoals(steps)) { misses.idle_goals++; flagged.push({ chat, at: now, kind: "idle_goals", excerpt: idleGoalLine(idle), item: idle.goal.id }); }
  for (const stall of stalled) { misses.stalled_steps++; flagged.push({ chat, at: now, kind: "stalled_steps", excerpt: stalledLine(stall), item: stall.view.item.id }); }
  for (const gate of gates) {
    if (gate.kind === "go_waiting") continue;
    misses[gate.kind]++;
    flagged.push({ chat, at: now, kind: gate.kind, excerpt: gateLine(gate), item: gate.item.id });
  }
  // A goal the check-in folds into a duty gets the fold alone: the duty carries its target. goal_gaps' "push the next step" on it was a second
  // ask (slack green guy p48 at 10-13 00:11 KST, the duty d1 made at 23:58).
  const folded = new Set(fold.map(entry => entry.goal.id));
  for (const gap of goals.filter(gap => countedGap(gap) && !folded.has(gap.goal.id))) { misses.goal_gaps++; flagged.push({ chat, at: now, kind: "goal_gaps", excerpt: goalGapLine(gap), item: gap.goal.id }); }
  for (const block of blocked) { misses.blocked_on_others++; flagged.push({ chat, at: now, kind: "blocked_on_others", excerpt: blockedLine(block, now), item: block.view.item.id }); }
  for (const entry of fold) flag("goals_to_fold", entry.goal.id, foldLine(entry));
  for (const found of done.filter(found => !folded.has(found.item.id))) { misses.finished_open++; flagged.push({ chat, at: now, kind: "finished_open", excerpt: lookDoneLine(found), item: found.item.id }); }
  for (const goal of loose.filter(goal => !folded.has(goal.id))) { misses.loose_goals++; flagged.push({ chat, at: now, kind: "loose_goals", excerpt: looseGoalLine(goal), item: goal.id }); }
  if (extra.length) { misses.extra_goals = extra.length - BOARD_LIMITS.openGoals; flagged.push({ chat, at: now, kind: "extra_goals", excerpt: extraGoalsLine(extra) }); }
  for (const found of underClosed) { misses.open_under_closed++; flagged.push({ chat, at: now, kind: "open_under_closed", excerpt: underClosedLine(found), item: found.item.id }); }
  for (const goal of held.filter(goal => !folded.has(goal.goal.id))) { misses.held_elsewhere++; flagged.push({ chat, at: now, kind: "held_elsewhere", excerpt: heldLine(goal), item: goal.goal.id }); }
  if (still) { misses.no_progress = 1; flagged.push({ chat, at: now, kind: "no_progress", excerpt: noProgressLine(still) }); }
  for (const met of over) { misses.wait_met++; flagged.push({ chat, at: now, kind: "wait_met", excerpt: waitMetLine(met), item: met.view.item.id }); }
  for (const entry of load) flag("one_session_load", entry.goal.id, sessionLoadLine(entry));
  for (const entry of heartbeats) { misses.redundant_heartbeats++; flagged.push({ chat, at: now, kind: "redundant_heartbeats", excerpt: heartbeatLine(entry) }); }
  if (noDuty.length) flag("goals_without_duty", noDuty[0]!.id, noDutyLine(noDuty));
  return { metrics: misses, flagged };
}

/** Step counts per class, for a check-in run's record. */
export function classCounts(steps: readonly Pick<StepView, "cls">[]): Record<StepClass, number> {
  const counts = Object.fromEntries(STEP_CLASSES.map(cls => [cls, 0])) as Record<StepClass, number>;
  for (const view of steps) counts[view.cls]++;
  return counts;
}

/**
 * A step that names its wait (a `waitFor`, or a `waitUntil` still ahead): a job that went idle under it is holding on purpose (Crawler VP 10-09:
 * obs-p0 idled for a CI slot and was flagged "ended, unrecorded" every hour). Its end is not "unrecorded"; the wait's own class (waiting, then
 * stale-chase after 2 h without change, or due) keeps the step moving. A bad end (error, abort, length) is still told at once.
 */
export function holdsOnWait(item: Pick<PlanItem, "waitFor" | "waitUntil">, now: number): boolean {
  return item.waitFor !== undefined || Date.parse(item.waitUntil ?? "") > now;
}

/**
 * Subagents that just ended a follow-up task (one sent after the first, so the status did not change) without messaging the chat. The daemon's
 * own notice (`rlm_child_terminal_notice`) covers a first task that ends with no reply, and a failure; this covers the rest. A child the daemon
 * cannot vouch for (`repliedSinceTask` unknown) is not reported.
 */
export function endedWithoutReport(before: readonly ChildAgent[], after: readonly ChildAgent[]): ChildAgent[] {
  const previous = new Map(before.map(child => [child.id, child]));
  return after.filter(child => {
    const was = previous.get(child.id);
    return was !== undefined && childWorking(was) && !childWorking(child) && was.status === child.status && child.status !== "cancelled" &&
      child.repliedSinceTask === false;
  });
}

/** A finished job is deleted once it has been quiet this long; the check runs at most once per JOB_CLEANUP_EVERY_MS per chat. */
export const JOB_CLEANUP_IDLE_MS = 60 * 60_000;
export const JOB_CLEANUP_EVERY_MS = 10 * 60_000;

/**
 * The chat's finished jobs to delete (each holds a worker process and a Python kernel until it is deleted): a direct subagent that is done, sent
 * its final report (`repliedSinceTask` true), has been quiet JOB_CLEANUP_IDLE_MS, and that no open step keeps: one it owns, or one waiting on
 * purpose (`waitUntil`, `waitFor`) whose `waitFor` names it.
 */
export function finishedJobs(children: readonly ChildAgent[], board: ChatBoard | null, now: number): ChildAgent[] {
  const ids = new Set(children.map(child => child.id));
  const keeps: { owner?: string; waitFor?: string }[] = [];
  walk(board?.plan ?? [], item => {
    if (!OPEN.has(item.status)) return;
    const owner = stepOwner(item);
    keeps.push({ ...(owner !== undefined ? { owner } : {}), ...(item.waitFor ? { waitFor: item.waitFor } : {}) });
  });
  return children.filter(child => {
    if (child.parentId !== undefined && ids.has(child.parentId)) return false;
    if (child.status !== "done" || childWorking(child) || child.repliedSinceTask !== true) return false;
    if (child.lastActivityAt === undefined || now - child.lastActivityAt < JOB_CLEANUP_IDLE_MS) return false;
    const names = [child.id, childName(child), child.label];
    return !keeps.some(keep => (keep.owner !== undefined && names.includes(keep.owner)) || (keep.waitFor !== undefined && names.some(name => keep.waitFor!.includes(name))));
  });
}

/**
 * Each job's last agent message to the chat, by the name its header gives (`[agent-message from child:<name>]`, the `child:` cut), with when the
 * job last sent one that carries a fact (`noteFacts` over the whole message).
 */
export function lastJobMessages(messages: readonly { role: string; customType?: string; content?: unknown; timestamp?: number }[]): Map<string, JobMessage> {
  const last = new Map<string, JobMessage>();
  for (const message of messages) {
    if (message.role !== "custom" || message.customType !== "agent_message") continue;
    const text = typeof message.content === "string" ? message.content
      : Array.isArray(message.content) ? message.content.map(part => typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : "").join("") : "";
    const header = /^\s*\[agent-message from\s+(?:child:)?([^\]]+)\]/.exec(text);
    if (!header) continue;
    const body = text.slice(header[0].length);
    const name = header[1]!.trim();
    const at = message.timestamp ?? 0;
    const factsAt = noteFacts(body).length ? at : last.get(name)?.factsAt;
    last.set(name, { at, text: body.split("\n").map(line => line.trim()).find(Boolean) ?? "", ...(factsAt !== undefined ? { factsAt } : {}) });
  }
  return last;
}
/**
 * The `[job]` notice for a job that went quiet while the daemon says it did not reply to its task: one that messaged the chat at or after its
 * last wake asked something and waits for an answer, since that message; any other ended at its last activity with no report.
 */
export function noReportNotice(name: string, message: JobMessage | undefined, wokeAt: number, end: number): string {
  return message !== undefined && message.at >= wokeAt
    ? `${name} is waiting for you since ${clockTime(message.at)} (last message: "${clip(message.text, 140)}")`
    : `${name} ended at ${clockTime(end)} with no report`;
}

/**
 * How a job's last turn ended when it ended badly (audit 10-09: 51 of 397 finished jobs sent no report; 20 stopped mid-tool, 18 on a provider
 * error, 7 aborted, 5 at the length limit): `error` a provider error (`error` its message), `aborted`, `mid-tool` (the last message is a tool
 * call or a tool result the model never answered), `length` the output length limit. `startedAt` is the job's last start: the last user
 * message or agent message before that end (0 when none).
 */
export type JobEndCause = "error" | "aborted" | "mid-tool" | "length";
export interface JobEnd { cause: JobEndCause; at: number; error?: string; startedAt: number }
const ENDED_BADLY: Partial<Record<StopReason, JobEndCause>> = { error: "error", aborted: "aborted", length: "length", toolUse: "mid-tool" };
/** A job's bad end from its transcript, or null when its last turn ended well or a new input waits after it. Notices and summaries are skipped. */
export function jobEnd(messages: readonly ThreadMessage[]): JobEnd | null {
  let end: Omit<JobEnd, "startedAt"> | null = null;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (!end) {
      if (message.role === "user") return null;
      if (message.role === "toolResult") end = { cause: "mid-tool", at: message.timestamp };
      else if (message.role === "assistant") {
        const cause = ENDED_BADLY[message.stopReason];
        if (!cause) return null;
        const error = cause === "error" ? message.errorMessage?.trim().replace(/\s+/g, " ") : undefined;
        end = { cause, at: message.timestamp, ...(error ? { error } : {}) };
      }
      continue;
    }
    if (message.role === "user" || (message.role === "custom" && message.customType === "agent_message")) return { ...end, startedAt: message.timestamp };
  }
  return end ? { ...end, startedAt: 0 } : null;
}
/** The cause in plain words: a provider error with the first 120 characters of its message, aborted, stopped mid-tool, the length limit. */
export function jobEndWords(end: Pick<JobEnd, "cause" | "error">): string {
  switch (end.cause) {
    case "error": return `stopped on a provider error${end.error ? ` ("${clip(end.error, 120)}")` : ""}`;
    case "aborted": return "was aborted";
    case "mid-tool": return "stopped in the middle of a tool call";
    case "length": return "hit the output length limit";
  }
}
/** The `[job]` line the server sends the chat about a job that ended badly with no report: information, the chat decides what to do. */
export const jobEndText = (name: string, end: Pick<JobEnd, "cause" | "error" | "at">): string =>
  `${name} ${jobEndWords(end)} at ${clockTime(end.at)} and sent no report`;

/** `<data dir>/check-ins.json`: the last precheck's memory per chat, and the bad job ends told to each chat (`ends`), through locked-json. */
export interface CheckInRecord {
  get(id: string): Promise<CheckInMemory | undefined>;
  set(id: string, memory: CheckInMemory): Promise<void>;
  forget(id: string): Promise<void>;
  /** The bad job ends already told to a chat, by job key (a child id, or `thread:<sessionId>` for a root): once per end, across restarts. */
  ends(id: string): Promise<Record<string, ToldEnd>>;
  /** Records a told end; ends older than TOLD_END_KEEP_MS before it go. */
  told(id: string, key: string, end: ToldEnd): Promise<void>;
}
/** A bad job end the server told the chat at once: when the job ended and why. Kept apart from the precheck's memory, which each run rewrites. */
export interface ToldEnd { at: number; cause: JobEndCause }
export const TOLD_END_KEEP_MS = 7 * 24 * 60 * 60_000;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isStepMemo = (value: unknown): value is StepMemo => isRecord(value) && typeof value.sig === "string" && typeof value.at === "number";
const stepMemoOf = (memo: StepMemo): StepMemo => ({ sig: memo.sig, at: memo.at, ...(typeof memo.wait === "string" ? { wait: memo.wait } : {}),
  ...(typeof memo.waitAt === "number" ? { waitAt: memo.waitAt } : {}),
  ...(typeof memo.doneAt === "number" ? { doneAt: memo.doneAt } : {}),
  ...(Array.isArray(memo.facts) && memo.facts.every(fact => typeof fact === "string") ? { facts: memo.facts } : {}),
  ...(typeof memo.factsAt === "number" ? { factsAt: memo.factsAt } : {}),
  ...(Array.isArray(memo.untils) && memo.untils.every(until => typeof until === "string") ? { untils: memo.untils.slice(-STALL_UNTILS) } : {}) });
function parseMemory(value: unknown): CheckInMemory | undefined {
  if (!isRecord(value) || typeof value.at !== "number") return undefined;
  const steps = isRecord(value.steps) ? Object.entries(value.steps).flatMap(([id, memo]) => isStepMemo(memo) ? [[id, stepMemoOf(memo)] as const] : []) : [];
  const flags = isRecord(value.flags) ? Object.entries(value.flags).filter((entry): entry is [string, number] => typeof entry[1] === "number") : [];
  return { at: value.at, steps: Object.fromEntries(steps), ...(typeof value.since === "number" ? { since: value.since } : {}),
    ...(flags.length ? { flags: Object.fromEntries(flags) } : {}) };
}
const JOB_END_CAUSES: Record<JobEndCause, true> = { error: true, aborted: true, "mid-tool": true, length: true };
const isToldEnd = (value: unknown): value is ToldEnd => isRecord(value) && typeof value.at === "number" && typeof value.cause === "string" && value.cause in JOB_END_CAUSES;
export function checkInRecord(path: string): CheckInRecord {
  type State = { chats: Record<string, CheckInMemory>; ends: Record<string, Record<string, ToldEnd>> };
  const file: JsonFile<State> = { path, label: "Check-in record", initial: () => ({ chats: {}, ends: {} }), parse(value: unknown) {
    const chats = isRecord(value) && isRecord(value.chats) ? value.chats : {};
    const ends = isRecord(value) && isRecord(value.ends) ? value.ends : {};
    return { chats: Object.fromEntries(Object.entries(chats).flatMap(([id, memo]) => { const parsed = parseMemory(memo); return parsed ? [[id, parsed]] : []; })),
      ends: Object.fromEntries(Object.entries(ends).flatMap(([id, told]) => isRecord(told)
        ? [[id, Object.fromEntries(Object.entries(told).filter((entry): entry is [string, ToldEnd] => isToldEnd(entry[1])))]] : [])) };
  } };
  return {
    async get(id) { return (await snapshotJsonFile(file)).chats[id]; },
    async set(id, memory) { await transactJsonFile(file, state => { state.chats[id] = memory; }); },
    async forget(id) { await transactJsonFile(file, state => { delete state.chats[id]; delete state.ends[id]; }); },
    async ends(id) { return { ...(await snapshotJsonFile(file)).ends[id] }; },
    async told(id, key, end) {
      await transactJsonFile(file, state => {
        const told = state.ends[id] ??= {};
        for (const [other, entry] of Object.entries(told)) if (end.at - entry.at > TOLD_END_KEEP_MS) delete told[other];
        told[key] = end;
      });
    },
  };
}
