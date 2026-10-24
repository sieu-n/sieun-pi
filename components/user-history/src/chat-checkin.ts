import type { HandoffRule } from "./chat-corrections.ts";
import { type DoneFacts, finishedOpen, looksDone, NO_FACTS } from "./checkin-done.ts";
import { heartbeatLine, oneSessionLoad, type RedundantHeartbeat, redundantHeartbeats, sessionLoadLine, sessionLoadSig, type ScheduledJob, type SessionLoad, type Train, wakeWatches } from "./checkin-load.ts";
import { flagKey, REPEAT_HEAD, REPEAT_RUNS, repeatLines } from "./checkin-repeats.ts";
import type { FlaggedSlice, PrecheckOutput } from "./shared/chat-duties.ts";
import { cachedJsonFile, snapshotJsonFile, transactJsonFile, type JsonFile } from "./locked-json.ts";
import { dutyKeeper, goWaitText, type MetOpen, metOpenItems, metOpenLine, planJob, stepGoWait } from "./shared/chat-board.ts";
import { BRIEF_ITEMS } from "./shared/brief-cap.ts";
import type { OwnerMessage } from "./shared/brief-check.ts";
import type { ChatAgent, ChatBoard, ChildAgent, PlanItem, SessionRow, StopReason, ThreadMessage } from "./shared/types.ts";
import { ago, capacityWait, CHASE_ESCALATE_MS, childName, childWorking, classLine, clip, type JobFact, type JobMessage, OPEN, ownerLabel, ownerOf, ownerState, parkedBy, quote, readySteps,
  noteFacts, readyReviewLine, readyReviews, recordedAt, STEP_CLASSES, type StepClass, type StepMemo, stepNamesJob, stepOwner, stepView, type StepView, todoForStep,
  waitsOnOwner, walk, withGoals } from "./checkin-steps.ts";
import { blockedLine, blockedOnOthers, type BlockedStep, deadRunWaits, type DutyRef, type ExtraGoal, extraGoals, extraGoalsLine, type FoldGoal, foldLine, type GateFinding,
  gateFindings, gateLine, goalsToFold, goalsWithoutDuty, heldElsewhere, type HeldGoal, heldLine, idleGoalLine, idleGoals,
  lookDoneLine, looseGoalLine, looseGoals, noDutyLine, noProgress, type NoProgress, noProgressLine, openUnderClosed, scopeLine, type ScopeMiss, scopeMisses,
  staleLine, type StaleStep, staleSteps, stalledLine, type StalledStep, stalledSteps, underClosedLine, type WaitMet, waitMetLine, waitsMet, goalsWithoutDoneLine, planRiskSteps,
  noDoneLineLine, riskStepsLine } from "./checkin-findings.ts";
import { upkeepWords } from "./shared/upkeep-title.ts";
import { CHECK_IN_MS, clockTime, localTime } from "./checkin-settings.ts";
import { turnErrorCause } from "./turn-error.ts";
import { agentMessageHead } from "./no-report.ts";
import { heldByTodo } from "./shared/todo-hold.ts";
import { endState, endStateKpi, endStateLine, type EndStateView, type Movers, OK_STATES, stepCarrier, stepCarriers, stuckLine } from "./checkin-end-state.ts";
import { goalDueLine, goalGap, type GoalMemo, goalLine, goalPromptLine, type GoalPush, goalPushes, goalsDetail, goalsHeadline, pushNeeded, threadPaused } from "./checkin-goals.ts";
import { type JobMemo, type JobPush, jobPushes } from "./checkin-jobs.ts";
import type { Wake } from "./wakes.ts";
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
/** What the last check-in saw for one chat: when it ran, and each plan item's last change. */
export interface CheckInMemory { at: number; steps: Record<string, StepMemo>;
  /** When this chat's memory began (its first check-in, kept across runs): the no-progress check needs a full hour of it. */
  since?: number;
  /** How many runs in a row flagged each finding, by `flagKey` (src/checkin-repeats.ts). */
  flags?: Record<string, number>;
  /** The sig of each finding with one that a started check-in job got, by `flagKey` (`unsentFindings`). */
  sent?: Record<string, string>;
  /** Each open goal's last readings of its number, for its trend and pace (`goalPushes`). */
  goals?: Record<string, GoalMemo>;
  /** Each job's progress mark and last push (`jobPushes`). */
  jobs?: Record<string, JobMemo> }
/**
 * What the precheck needs besides the jobs and the board: the chat's own id and name (a step it owns is `mine`), a board read error, the
 * catalog rows (the threads a step's `waitFor` can name), and the ledger's handoffs (`handoffRules`: an open step on another thread's topics).
 */
export interface CheckInContext { self?: readonly string[];
  boardError?: string; rows?: readonly Pick<SessionRow, "id" | "name" | "archived">[];
  handoffs?: readonly HandoffRule[];
  /** The ids of the owner corrections in force, for parked steps (`parkedBy`); every cited id counts when not given. */
  corrections?: readonly string[];
  /** The chat's check-in interval, for when a goal's measurement goes stale (`targetStaleMs`); CHECK_IN_MS when not given. */
  everyMs?: number;
  /** The chat's duties, for the goals they run (`goalsToFold`) and a chat with goals and no duty (`goalsWithoutDuty`); not given: neither counts them. */
  duties?: readonly DutyRef[];
  /** The roots the chat started (the job registry's names or ids): its own jobs, never another session's load (`oneSessionLoad`) or a thread that holds a goal (`heldElsewhere`). */
  jobs?: readonly string[];
  /**
   * The chats whose check-in the owner paused, by session id: a thread among them is parked by him, so no goal push, job push or held-elsewhere
   * line asks it for anything (`goalWait`, `jobPushes`, `heldElsewhere`). Not given: none.
   */
  paused?: ReadonlySet<string>;
  /** The daemon's subagents by parent session (`Chats.roster`): a thread with one working subagent per SESSION_LOAD_STEPS_PER_JOB of its steps fans out (`oneSessionLoad`). Not given: none. */
  subagents?: ReadonlyMap<string, readonly ChildAgent[]>;
  /** The chat's own schedules (`readHeartbeats`), for the heartbeats the check-in covers (`redundantHeartbeats`); none when not given. */
  heartbeats?: readonly ScheduledJob[];
  /** The release train in the CI cache (`readTrain`), for steps that wait on it (`trainMoves`); not given: no step counts as on a moving train. */
  train?: Train;
  /**
   * The sessions the Mac-wide turn queue holds (`pi-pool queue --json`), by session id: a step whose owner, chat or awaited thread waits for a
   * working slot is queued, not blocked or stalled (`queueHolds`). A job's own place is on its fact (`JobFact.queued`). Not given: none.
   */
  queued?: ReadonlyMap<string, unknown>;
  /** The sessions asleep on a board.wake the service still owes (`pendingWakes`): a blocker thread among them is not blocked on. Not given: none. */
  asleep?: ReadonlySet<string>;
  /** The board.wakes the service still owes (`pendingWakes`): a step whose owner session, run, land or thread one of them watches is moving (`wakeMover`). Not given: none. */
  wakes?: readonly Wake[];
  /** The commits of open steps' land waits that each waited-on land.yml run carries, by run id (`landCarries`). Not given: none. */
  carried?: ReadonlyMap<string, ReadonlySet<string>>;
  /** What the owner wrote in the chat (`ownerSaid`), for when he last ruled on a review (`readyReviews`); none when not given. */
  owner?: readonly OwnerMessage[];
  /** The duty metric verdicts and PR states that say an item is done (`looksDone`) and that a merge moved work (`noProgress`). Not given: nothing looks done. */
  doneFacts?: DoneFacts;
  /** The chat's box and the offline boxes an open For you todo asks the owner to bring back (`hostHeld`). Not given: no step is held on a box. */
  hosts?: Movers["hosts"] }

/** What one check-in precheck found: the memory to keep, every open leaf step with its class, the steps on another thread's work, the open items that look done, and other facts. */
export interface CheckInPrecheck {
  memory: CheckInMemory; steps: StepView[]; scope: ScopeMiss[]; gates: GateFinding[]; stalled: StalledStep[];
  /** Each open goal's number, trend, pace and owner, and whether to steer or start its owner job (`goalPushes`): the check-in's first job. */
  goals: GoalPush[]; blocked: BlockedStep[];
  /** The chat's jobs with no progress for a check-in interval or whose last turn failed, to nudge or restart (`jobPushes`). */
  jobs: JobPush[];
  done: { item: PlanItem; reason: string; at: number }[]; loose: PlanItem[]; extra: ExtraGoal[]; underClosed: { item: PlanItem; parent: PlanItem }[];
  held: HeldGoal[]; waitsMet: WaitMet[]; noProgress: NoProgress | null; stale: StaleStep[]; fold: FoldGoal[]; load: SessionLoad[]; heartbeats: RedundantHeartbeat[];
  /** The open goals when the chat has no active duty (`goalsWithoutDuty`); none when the context gave no duties. */
  noDuty: PlanItem[];
  /** The open goals with no done line (`goalsWithoutDoneLine`) and the open standing-risk steps (`planRiskSteps`), owner 10-18 (c110). */
  noDoneLine?: PlanItem[]; risks?: PlanItem[];
  /** The open items whose target reads met with nothing left under them (`metOpenItems`), to close now: a duty keeps the metric (c110). */
  metOpen?: MetOpen[];
  /** A board read error, an ask overflow, steps that can start, steps that wait on the owner with no question in For you, and reviews ready with no todo. */
  facts: string[];
  /** Every open leaf step in the owner's end state or stuck (`endState`), the KPI the brief leads with. */
  end: EndStateView[];
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
  const paused = context.paused ?? new Set<string>();
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
  const gates = context.boardError ? [] : gateFindings(board, facts, active);
  const held = new Set(gates.map(gate => gate.item.id));
  if (!context.boardError) {
    for (const step of readySteps(board)) if (!held.has(step.id)) notes.push(`${step.id} ${quote(step.text)} can start: the steps before it are done and it has no job`);
  }
  for (const gate of gates) if (gate.kind === "go_waiting") notes.push(gateLine(gate));
  if (!context.boardError) for (const review of readyReviews(board, active, { memos: steps, owner: context.owner ?? [] })) notes.push(readyReviewLine(review));
  if (!context.boardError) notes.push(...parkedUnnamed(board, facts));
  notes.push(...facts.flatMap(fact => fact.deadWake ? [deadWaitLine(fact)] : []));
  const goaled = withGoals(views, board);
  const since = previous?.since ?? previous?.at ?? now;
  const queued = context.queued ?? new Map<string, unknown>();
  const carriers = stepCarriers(board, goaled, item => self.has(stepOwner(item) ?? "") ? undefined : ownerOf(item, facts));
  // A chase whose wait names a plan item that a live owner carries waits on that owner's work, as its end state reads it moving: chat-2572's p8
  // and p10 read "chase it now" for 16 h while p6's release job was live.
  for (const view of goaled) if (view.cls === "stale-chase" && stepCarrier(view.item, carriers)) { view.cls = "waiting"; delete view.target; }
  const blocked = context.boardError ? [] : blockedOnOthers(goaled, context.rows ?? [], self, now, context.train, queued, context.asleep, openTodos, { steps: carriers });
  // A step blocked on others gets that one finding, which names the blocker and the action; stalled_steps' "act on it" on the same step gave
  // two lines with two different asks (34 steps from 10-13 09:15 to 23:59 KST, VP of CI's nine waits on the secrets cache at 14:29 among them).
  const onOthers = new Set(blocked.map(block => block.view.item.id));
  const movers = { watches: wakeWatches(context.wakes ?? [], context.train, context.carried), queued,
    steps: carriers, ...context.hosts ? { hosts: context.hosts } : {} };
  const working = new Set<string>();
  walk(board?.plan ?? [], item => { if (OPEN.has(item.status) && ownerOf(item, facts)?.state === "working") working.add(item.id); });
  const doneFacts = { ...context.doneFacts ?? NO_FACTS, working };
  const done = context.boardError ? [] : finishedOpen(board, doneFacts);
  const fold = context.boardError ? [] : goalsToFold(board, facts, self, context.duties ?? []);
  const roots = new Set(context.jobs ?? []);
  // A thread the chat did not start, such as another chat that owns a step on this board, is no job of this chat: on 10-23 at 16:25Z VP of CI's
  // check-in sent its p1 goal steer to the AI harness chat, which held p342 under p1.
  const ownJob = (fact: JobFact): boolean => !fact.key.startsWith("thread:") || roots.has(fact.name) || roots.has(fact.key.slice("thread:".length));
  const goals = context.boardError ? { pushes: [], memos: previous?.goals ?? {} }
    : goalPushes(board, goaled, previous?.goals, context.everyMs ?? CHECK_IN_MS, now, doneFacts.metrics, new Set(fold.map(entry => entry.goal.id)), paused, ownJob, carriers);
  const pushed = context.boardError ? { pushes: [], memos: previous?.jobs ?? {} }
    : jobPushes(facts, goaled, previous?.jobs, context.everyMs ?? CHECK_IN_MS, now,
      fact => !fact.name.startsWith("check-in ") && ownJob(fact),
      view => steps[view.item.id] ? recordedAt(steps[view.item.id]!) : view.changedAt,
      { job: fact => threadPaused(fact, fact, paused),
        step: view => view.cls === "foryou" || view.cls === "parked" || heldByTodo(view.item, openTodos) || Date.parse(view.item.waitUntil ?? "") > now ||
          threadPaused(view.owner, view.item, paused) });
  return { memory: { at: now, steps, since, goals: goals.memos, jobs: pushed.memos }, jobs: pushed.pushes, steps: goaled, scope: context.boardError ? [] : scopeMisses(board, context.handoffs ?? [], context.self ?? []), gates,
    stalled: context.boardError ? [] : stalledSteps(goaled, steps, context.rows ?? [], self, now, context.train, movers).filter(stall => !onOthers.has(stall.view.item.id)),
    goals: goals.pushes, blocked, done,
    loose: context.boardError ? [] : looseGoals(board), extra: extraGoals(goals.pushes), underClosed: context.boardError ? [] : openUnderClosed(board),
    held: context.boardError ? [] : heldElsewhere(goaled, board, context.rows ?? [], self, context.jobs, paused),
    noProgress: context.boardError ? null : noProgress(board, goaled, steps, since, context.rows ?? [], self, now, context.train, queued, { done, prs: doneFacts.prs }, movers),
    waitsMet: context.boardError ? [] : [...waitsMet(goaled, board, context.rows ?? [], self), ...deadRunWaits(goaled, context.train, now)],
    stale: context.boardError ? [] : staleSteps(board, facts, item => steps[item.id] ? recordedAt(steps[item.id]!) : now, self, context.everyMs ?? CHECK_IN_MS, now,
      context.rows ?? [], context.train),
    fold, load: oneSessionLoad(goaled, context.jobs, context.subagents, new Set([...context.queued?.keys() ?? [], ...context.asleep ?? []]), now),
    heartbeats: redundantHeartbeats(context.heartbeats ?? [], context.duties ?? []), noDuty: context.boardError || !context.duties ? [] : goalsWithoutDuty(board, context.duties, now), facts: notes,
    noDoneLine: context.boardError ? [] : goalsWithoutDoneLine(board), risks: context.boardError ? [] : planRiskSteps(board),
    metOpen: context.boardError ? [] : metOpenItems(board?.plan ?? []),
    end: context.boardError ? [] : goaled.map(view => endState(view, board?.todos ?? [], context.rows ?? [], self, now, facts, movers)) };
}

/** A job asleep on dead waits (`JobFact.deadWake`): the wake service did not send them, so the chat tells the job how its run ended. */
export const deadWaitLine = (fact: JobFact): string =>
  `${ownerLabel(fact)} is a dead wait: it sleeps on ${fact.deadWake}, and the wake never went out. Tell it the run's result now so it acts on it`;

/**
 * The ended jobs whose last reply says they hold parked work (`JobMessage.parked`) while no open step names them (`stepNamesJob`), one line each.
 * The cleanup keeps such a job (`finishedJobs`), but the board no longer says which step its work is for. launch main bro 10-14 04:1xZ to
 * 04:2xZ: a check-in relinked 13 build steps to the job "release driver", and a relink whose note drops the build job leaves its parked pushes
 * on no step.
 */
export function parkedUnnamed(board: ChatBoard | null, facts: readonly JobFact[]): string[] {
  const open: PlanItem[] = [];
  walk(board?.plan ?? [], item => { if (OPEN.has(item.status)) open.push(item); });
  return facts.flatMap(fact => {
    const said = fact.lastMessage;
    if (fact.state !== "ended" || fact.cancelled || fact.key.startsWith("thread:") || said?.parked === undefined) return [];
    if (open.some(item => stepNamesJob(item, { id: fact.key, names: [fact.name, fact.sessionId] }))) return [];
    return [`${fact.name} said at ${clockTime(said.at)} that it holds parked work (${quote(said.parked)}), but no open step names it in job, waitFor, note or text: ` +
      "name it in the note of the step its work is for, or tell it to drop the work"];
  });
}

/**
 * A step's memo at this run: `at` moves when its sig (status, text, owner) changes, `waitAt` when it starts or stops waiting or its owner
 * changes, and a new waitUntil joins `untils`. A rewritten waitFor moves neither clock (c63): Crawler VP p39 sat blocked from 10-13 09:58Z while
 * its waitFor was rewritten 98 times, the last at 10-14 04:01Z, and every rewrite made it a fresh wait, so it never read as a stale chase or a
 * stall. A cleared waitUntil or a wait that starts over starts `untils` over, so only the current wait's pushes count (api portal vp p4: its
 * 14:00Z to 14:30Z push was for a wait cleared at 14:25Z). A memo written before this rule (its sig and wait hold the wait texts) is read in the
 * new form (`coreSig`, `waitKey`), so the release keeps every step's clock.
 */
export function stepMemo(item: PlanItem, before: StepMemo | undefined, now: number, firstSeen: number): StepMemo {
  const sig = stepSig(item);
  const wait = waitSig(item);
  const sameWait = before?.wait !== undefined && waitKey(before.wait) === wait;
  const newWait = item.waitUntil === undefined || (before?.wait !== undefined && !sameWait);
  const seen = newWait ? [] : before?.untils ?? [];
  const untils = item.waitUntil && seen.at(-1) !== item.waitUntil ? [...seen, item.waitUntil].slice(-STALL_UNTILS) : seen;
  const turnedDone = item.status === "done" && before !== undefined && !before.sig.startsWith('["done"');
  const doneAt = turnedDone ? now : item.status === "done" ? before?.doneAt : undefined;
  const facts = OPEN.has(item.status) ? noteFacts(item.note) : [];
  const factsAt = before?.facts && facts.some(fact => !before.facts!.includes(fact)) ? now : before?.factsAt;
  return { sig, at: before ? coreSig(before.sig) === sig ? before.at : now : firstSeen, wait, ...(doneAt !== undefined ? { doneAt } : {}),
    ...(facts.length ? { facts } : {}), ...(factsAt !== undefined && facts.length ? { factsAt } : {}),
    // A memo from before `wait` existed counts its last change as the wait's start.
    waitAt: !before ? firstSeen : before.wait === undefined ? before.at : sameWait ? before.waitAt ?? before.at : now, ...(untils.length ? { untils } : {}) };
}
/** Whether a step waits (a waitFor or a waitUntil), and its owner; the wait's wording is left out (c63). */
const waitSig = (item: PlanItem): string => JSON.stringify([item.waitFor !== undefined || item.waitUntil !== undefined ? "waits" : "", stepOwner(item) ?? ""]);
/** A stored sig in today's form: a memo before c63 added the waitUntil and waitFor after the status, text and owner. */
const coreSig = (sig: string): string => { try { return JSON.stringify((JSON.parse(sig) as unknown[]).slice(0, 3)); } catch { return sig; } };
/** A stored wait in today's form: a memo before c63 held [waitFor, waitUntil, owner]. */
const waitKey = (wait: string): string => {
  try {
    const parts = JSON.parse(wait) as string[];
    return parts.length === 3 ? JSON.stringify([parts[0] || parts[1] ? "waits" : "", parts[2] ?? ""]) : wait;
  } catch { return wait; }
};

/** The waitUntil values a step's memo keeps. */
export const STALL_UNTILS = 5;

/** One job of the chat as the brief lists it: its name, state, last activity, its step and its last message. */
function jobLine(fact: JobFact, now: number): string {
  const state = fact.cancelled ? "ended (cancelled)" : ownerState(fact);
  const waiting = capacityWait(fact) !== undefined;
  const quiet = fact.state === "working" && !fact.wake && !waiting && fact.activityAt !== undefined && now - fact.activityAt > STALE_MS ? `, no activity for ${ago(now - fact.activityAt)}` : "";
  const last = fact.activityAt !== undefined ? `, last activity ${ago(now - fact.activityAt)} ago` : "";
  const step = fact.item ? `, on ${fact.item.id} ${quote(fact.item.text)} (${fact.item.status})` : "";
  const error = fact.state === "failed" && fact.error ? `, error: ${clip(fact.error, 120)}` : "";
  const queued = fact.queued ? `, in the queue for ${ago(now - fact.queued.since)}` : fact.inTurn ? ", in its turn (streaming or in a tool call)" : "";
  const said = fact.lastMessage ? `, last message at ${clockTime(fact.lastMessage.at)}: ${quote(fact.lastMessage.text)}` : "";
  return `${ownerLabel(fact)}: ${state}${queued}${quiet || last}${step}${error}${said}`;
}

/**
 * The check-in precheck as the duty job's brief gives it, plain markdown: first each open goal's number, trend and owner with the steer or start
 * it needs (`goalsDetail`), then the stuck steps, the goals nobody works on (`idleGoals`), the steps whose class needs action (`classLine`), the open items that
 * look done, the steps on another thread's work, the other facts, the flagged items the class lines do not cover (a job end with no update),
 * the chat's jobs, and every open step with its class, owner and age, oldest change first. Findings flagged in REPEAT_RUNS or more runs in a
 * row (`streaks`, `flagStreaks`) come first, under Flagged again.
 */
export function checkInPrecheckText(precheck: CheckInPrecheck, facts: readonly JobFact[], flagged: readonly FlaggedSlice[], now: number,
  streaks: Readonly<Record<string, number>> = {}): string {
  const stale = flagged.filter(slice => slice.kind === "stale_steps");
  /** A stale step is listed once, under Stale steps. */
  const staleIds = new Set(stale.map(slice => slice.item));
  const doneIds = new Set(precheck.done.map(found => found.item.id));
  const onHost = flagged.filter(slice => slice.kind === "host_held");
  const hostIds = new Set(onHost.map(slice => slice.item));
  const act = precheck.steps.flatMap(view => {
    /** An orphan that looks done needs a check and a close, not a new job: it is listed under Look done only. */
    const line = staleIds.has(view.item.id) || hostIds.has(view.item.id) || (view.cls === "orphan" && doneIds.has(view.item.id)) ? null : classLine(view, now);
    return line ? [view.target ? `${line} (the thread to chase: ${clip(view.target.name, 40)}, thread:${view.target.id})` : line] : [];
  });
  const ended = flagged.filter(slice => slice.kind === "job_end_unrecorded" || slice.kind === "job_end_silent").map(slice => slice.excerpt);
  const idle = flagged.filter(slice => slice.kind === "idle_goals").map(slice => slice.excerpt);
  const gated = flagged.filter(slice => slice.kind === "go_missing" || slice.kind === "requirements_missing").map(slice => slice.excerpt);
  const merged = flagged.filter(slice => slice.kind === "merges_without_go").map(slice => slice.excerpt);
  const open = [...precheck.steps].sort((a, b) => a.changedAt - b.changedAt).map(view => {
    const { item, owner, mine, cls } = view;
    const who = mine ? "owner the chat" : owner ? `owner ${ownerLabel(owner)} (${ownerState(owner)})` : item.job ? `owner ${item.job} (not found)` : "no owner";
    const until = Date.parse(item.waitUntil ?? "");
    const waits = `${Number.isFinite(until) ? `, waits until ${localTime(until)}` : ""}${item.waitFor ? `, waits for ${quote(item.waitFor)}` : ""}`;
    const note = item.note ? `; note: "${clip(item.note.replace(/\s+/g, " "), 300)}"` : "";
    return `${item.id} (${cls}) ${quote(item.text)} ${item.status}, ${who}${waits}, last change ${ago(now - view.changedAt)} ago${note}`;
  });
  const section = (head: string, lines: readonly string[]) => lines.length ? [`### ${head}\n${lines.map(line => `- ${line}`).join("\n")}`] : [];
  /** A goal to fold is listed once, under Goals to fold. */
  const folded = new Set(precheck.fold.map(fold => fold.goal.id));
  const kpi = endStateKpi(precheck.end);
  const stuck = precheck.end.filter(entry => !OK_STATES.has(entry.state)).map(entry => {
    const runs = streaks[flagKey({ kind: "stuck_steps", item: entry.view.item.id })] ?? 0;
    return `${stuckLine(entry, now)}${runs >= REPEAT_RUNS ? ` (stuck in ${runs} check-ins in a row)` : ""}`;
  });
  const goals = goalsDetail(precheck.goals);
  return [
    ...precheck.goals.length ? [goalsHeadline(precheck.goals)] : [],
    ...goals ? [goals] : [],
    ...precheck.end.length ? [endStateLine(kpi)] : [],
    ...section("Stuck steps (the owner's end state: every open step is moved by a live owner now, held by an open For you todo that links it, or " +
      "parked by his correction. Each step below ends this run with a live owner, a For you todo or a close; a chase, a new wait text or a later " +
      "waitUntil leaves it stuck)", stuck),
    ...section("Held on an offline box (no action here: each job's box is off, and the owner's For you todo asks him to bring it back)", onHost.map(slice => slice.excerpt)),
    ...section(REPEAT_HEAD, repeatLines(streaks, flagged)),
    ...section("Merged without the owner's go (a repo rule breach: report each to the owner in this run; never merge without his go on that PR)", merged),
    ...section("Hard gates broken (the owner's go, the requirements check): fix each now", gated),
    ...section("Goals to fold (apply these board ops in this run, in this order; no goal stays open only to wait)", precheck.fold.map(foldLine)),
    ...section("Plan shape (fix it in this run with board ops: close or fold what shipped, move a loose step under its goal with plan_update parent, " +
      "hand off or remove the rest; the owner should never have to tidy the plan)", [...precheck.held.filter(held => !folded.has(held.goal.id)).map(heldLine),
      ...precheck.loose.filter(goal => !folded.has(goal.id)).map(looseGoalLine),
      ...precheck.extra.map(extraGoalsLine), ...precheck.underClosed.map(underClosedLine)]),
    ...section("Waits that are over (act on each in this run)", precheck.waitsMet.map(waitMetLine)),
    ...section("No progress in the last hour (work should be moving)", precheck.noProgress ? [noProgressLine(precheck.noProgress)] : []),
    ...section("Blocked on CI, a release or another thread with no job on it (start a job that fixes each blocker in this run, or send its owner a " +
      "concrete patch; marking the step waiting is not an answer)", precheck.blocked.map(blocked => blockedLine(blocked, now))),
    ...section("One session carries too much (split these into your own jobs per part)", flagged.filter(slice => slice.kind === "one_session_load").map(slice => slice.excerpt)),
    ...section("Heartbeats the check-in or a duty covers (have the chat delete each)", flagged.filter(slice => slice.kind === "redundant_heartbeats").map(slice => slice.excerpt)),
    ...section("Open goals and no duty", flagged.filter(slice => slice.kind === "goals_without_duty").map(slice => slice.excerpt)),
    ...section("Plan and duties (owner 10-18 and 10-19, c110: the plan holds only tasks that finish, each with a done line; upkeep is a duty metric, and a " +
      "standing risk goes to a wiki risk page that a duty checks)",
      [...precheck.noDoneLine?.length ? [noDoneLineLine(precheck.noDoneLine)] : [], ...precheck.risks?.length ? [riskStepsLine(precheck.risks)] : []]),
    ...section("Goals nobody works on (start parallel jobs for their independent work)", idle),
    ...section("Stalled waits (take one action on each in this run: check whether what it waits for already happened, do the next action yourself, start or steer a job, or add a For you todo; \"still waiting\" and a later waitUntil are not answers)",
      precheck.stalled.map(stalledLine)),
    ...section("Stale steps (update or close each in this run: the job's result, the next action, done or dropped; a later waitUntil is no answer, and the board flags it (c47))", stale.map(slice => slice.excerpt)),
    ...section("Steps whose class needs action", act),
    ...section("Met and still open (close each now: a duty keeps its metric from here, c110)", (precheck.metOpen ?? []).map(metOpenLine)),
    ...section("Look done (a met metric or target, or merged PRs: close each)", precheck.done.filter(found => !folded.has(found.item.id)).map(lookDoneLine)),
    ...section("Owned by another thread by an owner ruling", precheck.scope.map(scopeLine)),
    ...section("Job ends the board does not show", ended),
    ...section("Other facts", precheck.facts),
    ...section("Jobs", facts.map(fact => jobLine(fact, now))),
    ...section("Every open step, oldest change first", open),
  ].join("\n\n") || "The board has no open step and no job.";
}

/**
 * What the check-in job's prompt carries from the precheck (owner 10-16: "it should be based on metrics, more sophisticated"; c80, c90): each
 * open goal's number, gap, trend, days to target and pace, and the actions due this run in plain words, with no list of step ids and no stock
 * rules. Every step finding stays in the run's detail file and its record.
 */
export function checkInPrompt(precheck: Pick<CheckInPrecheck, "goals" | "end" | "risks" | "metOpen">, jobLine: string | null): string {
  const goals = precheck.goals.map(push => `- ${goalPromptLine(push)}`);
  const due = precheck.goals.flatMap(push => { const line = goalDueLine(push); return line ? [line] : []; });
  const stuck = precheck.end.filter(entry => !OK_STATES.has(entry.state)).length;
  const upkeep = (precheck.risks ?? []).filter(item => upkeepWords(item.text));
  // A goal at target with an open step under it (`GoalPush.left`) is not finished: its line in Goals names what holds it open.
  const metGoals = precheck.goals.filter(push => push.trend?.kind === "met" && !push.left?.length);
  // An item at target closes now when a duty keeps its number (c110). Until 10-22 this line said "once it has held long enough, such as 6 h",
  // and the AI harness chat held p200 open after p850 read 0 of 0 at 03:57Z, waiting for d4's next run, until the owner said "so then close it!!".
  const metOpen = precheck.metOpen ?? [];
  const metIds = new Set(metOpen.map(found => found.item.id));
  const metNew = metGoals.filter(push => !metIds.has(push.goal.id));
  const met = [...metOpen.map(found => found.item), ...metNew.map(push => push.goal)];
  const kept = [...metOpen.map(found => found.keeper), ...metNew.map(push => dutyKeeper(push.goal.duty))];
  const keepers = [...new Set(kept.flatMap(keeper => keeper ? [`duty ${keeper.split("/")[0]}`] : []))];
  const unkept = kept.filter(keeper => !keeper).length;
  const items = [...due.slice(0, BRIEF_ITEMS), ...due.length > BRIEF_ITEMS ? [`${due.length - BRIEF_ITEMS} more goals need the same, listed in the detail file.`] : [],
    ...jobLine ? [`${jobLine.replace(/^Check-in: /, "The server already ")} Check in this run that each one reported; start a job in place of one that did not.`] : [],
    ...stuck ? [`${stuck} open ${stuck === 1 ? "step has" : "steps have"} no live owner. Push each one toward done in this run: resume its job, start a fix job, ` +
      "or close it with the evidence you checked, and give a step only the owner can unblock a For you todo. The detail file lists them."] : [],
    ...upkeep.length ? [`${upkeep.length === 1 ? `${upkeep[0]!.id} ${quote(upkeep[0]!.text)} reads` : `${upkeep.length} open goals and steps, like ${upkeep[0]!.id} ` +
      `${quote(upkeep[0]!.text)}, read`} like upkeep, and the plan holds only tasks that finish. Make the keeping a duty metric, close the item with a note ` +
      "naming the duty, and keep only a fix that is still open as a step with a \"Done when\" line."] : [],
    ...met.length ? [`${met.length === 1 ? `${met[0]!.id} ${quote(met[0]!.text)} meets its target. Close it now` : `${met.length} open items, like ` +
      `${met[0]!.id} ${quote(met[0]!.text)}, meet their target. Close each now`} with a note that names the reading, and wait for no further run: ` +
      `a duty keeps the metric from here and puts a fix step back when it slips (c110). ${keepers.length ? `${keepers.join(", ").replace(/^d/, "D")} ${keepers.length === 1 ? "keeps" : "keep"} ` +
      `${met.length === 1 ? "it" : "theirs"}${unkept ? `, and the detail file names the ${unkept === 1 ? "one" : `${unkept}`} no duty keeps yet: add ${unkept === 1 ? "its" : "each"} metric to a duty first` : ""}.`
      : "No duty keeps it yet: add the metric to a duty first."}`] : []];
  return [
    `## Goals\n${goals.length ? goals.join("\n") : "The chat has no open goal."}`,
    `## Due this run\n${items.length ? items.map((line, at) => `${at + 1}. ${line}`).join("\n") : "Nothing is due: every goal moves on pace with a live owner. End in one short turn."}`,
  ].join("\n\n");
}

/**
 * Whether a check-in run has nothing for a job to do: no goal to steer or start (a quiet push sends nothing), no job the server pushed, no step
 * without a live owner, no upkeep item and no item at target to close. Such a run starts no job. From 10-23 07:00Z to 10-24 07:00Z the check-ins
 * started 211 jobs, and 181 of them on runs that read met, most with a prompt that said "Nothing is due". Each one waited in pi-pool's turn line,
 * where turns waited a median 872 s from 05:40Z to 06:41Z on 10-24, behind the fix jobs of the red duties.
 */
export function checkInIdle(precheck: Pick<CheckInPrecheck, "goals" | "end" | "risks" | "metOpen">, jobLine: string | null): boolean {
  if (jobLine) return false;
  if (precheck.goals.some(push => !push.quiet && goalDueLine(push) !== null)) return false;
  if (precheck.goals.some(push => push.trend?.kind === "met" && !push.left?.length)) return false;
  if (precheck.end.some(entry => !OK_STATES.has(entry.state))) return false;
  if ((precheck.risks ?? []).some(item => upkeepWords(item.text))) return false;
  return !(precheck.metOpen ?? []).length;
}

/**
 * What a step's last change compares: its status, text and owner. A note edit is no change, so a chase note does not hide a stall, and neither is
 * a wait rewrite (c63): a new ETA or run id in the waitFor is no progress.
 */
export const stepSig = (item: PlanItem): string => JSON.stringify([item.status, item.text, planJob(item.job) ?? ""]);

/**
 * The check-in duty's metrics (`CHECK_IN_DUTY`), each at most 0. `idle_goals` is an open goal nobody works on (`idleGoals`). `job_end_silent` is a step whose job ended badly (a provider error, an abort,
 * a stop mid-tool, the length limit) with no report, which the server told the chat at once (the check-in record's told ends), not updated a
 * check-in later; such a step is counted there and not again in `job_end_unrecorded`. `scope_misses` is an open step on another thread's work
 * by a ledger handoff (`scopeMisses`, correction c7). `stalled_steps` is a step on a passive wait (`stalledSteps`, c23). `go_missing` and
 * `requirements_missing` are the broken hard gates (`gateFindings`, W50), `merges_without_go` a merge step done without the owner's go on its PR (c49). `goal_gaps`, the headline, is an open goal no live job works on (`goalGap`, owner 10-15 on p71), and `goals_off_pace` one a live job works on whose number is off pace, which the check-in steers and the duty does not judge.
 * `blocked_on_others` is a step blocked on CI, a release or another thread for over an hour with no live job (`blockedOnOthers`, W56).
 * `finished_open` is an open item that looks done (`looksDone`), `loose_goals` an open top-level item with no step under it (`looseGoals`) and
 * `extra_goals` an open goal past BOARD_LIMITS.openGoals with no number or no live owner job (`extraGoals`), `open_under_closed` an open item right under a closed one
 * (`openUnderClosed`), the plan's shape (c44). `held_elsewhere` is a goal whose every open step another thread holds (`heldElsewhere`) and
 * `wait_met` a step whose named wait is over (`waitsMet`), finished work left open behind a wait (c45). `no_progress` is 1 when no plan
 * item was done in the last hour and some open step is not blocked under a goal that did not move (`noProgress`). `stale_steps` is an open item with a waitUntil over 24 h
 * past or a job that ended with no update (`staleSteps`, c44); an item counted in `finished_open` or `wait_met` is not counted again. A step's
 * record is counted once, by the first that applies: `job_end_silent`, `job_end_unrecorded`, `stale_steps`, `due_late`. `goals_to_fold` is an
 * open goal whose work runs as a duty or rides other goals' jobs (`goalsToFold`, c46); that goal is not counted again in `finished_open`,
 * `loose_goals`, `held_elsewhere` or `goal_gaps`. `one_session_load` is a goal and another session that owns too many of its open steps (`oneSessionLoad`, c51),
 * `redundant_heartbeats` an active heartbeat of the chat whose work the check-in or one of its duties already does (`redundantHeartbeats`, c51).
 * `goals_without_duty` is 1 for a chat with an open goal and no active duty (`goalsWithoutDuty`).
 * `met_open` is an open item whose target reads met with nothing left under it (`metOpenItems`), closed now because a duty keeps its metric (c110).
 */
export type ConvergenceMisses = { orphan_steps: number; due_late: number; stale_chase_24h: number; job_end_unrecorded: number; job_end_silent: number; scope_misses: number;
  idle_goals: number; stalled_steps: number; go_missing: number; requirements_missing: number; merges_without_go: number; goal_gaps: number; goals_off_pace: number; blocked_on_others: number; finished_open: number;
  loose_goals: number; extra_goals: number; open_under_closed: number; held_elsewhere: number; wait_met: number;
  no_progress: number; stale_steps: number; goals_to_fold: number; one_session_load: number; redundant_heartbeats: number; goals_without_duty: number; stuck_steps: number;
  no_done_line: number; plan_risks: number; met_open: number };
export const NO_MISSES: ConvergenceMisses = { orphan_steps: 0, due_late: 0, stale_chase_24h: 0, job_end_unrecorded: 0, job_end_silent: 0, scope_misses: 0, idle_goals: 0,
  stalled_steps: 0, go_missing: 0, requirements_missing: 0, merges_without_go: 0, goal_gaps: 0, goals_off_pace: 0, blocked_on_others: 0, finished_open: 0, loose_goals: 0, extra_goals: 0, open_under_closed: 0,
  held_elsewhere: 0, wait_met: 0, no_progress: 0, stale_steps: 0, goals_to_fold: 0, one_session_load: 0, redundant_heartbeats: 0, goals_without_duty: 0, stuck_steps: 0, no_done_line: 0, plan_risks: 0, met_open: 0 };
/** What the precheck found on the board besides the step classes: steps on another thread's work, broken hard gates, stalled waits, the plan's shape. */
export interface BoardFindings { scope: readonly ScopeMiss[]; gates: readonly GateFinding[]; stalled: readonly StalledStep[]; goals: readonly GoalPush[]; blocked: readonly BlockedStep[];
  done: readonly { item: PlanItem; reason: string }[]; loose: readonly PlanItem[]; extra: readonly ExtraGoal[]; underClosed: readonly { item: PlanItem; parent: PlanItem }[];
  held: readonly HeldGoal[]; waitsMet: readonly WaitMet[]; noProgress: NoProgress | null; stale: readonly StaleStep[]; fold: readonly FoldGoal[];
  load?: readonly SessionLoad[]; heartbeats?: readonly RedundantHeartbeat[]; noDuty?: readonly PlanItem[]; noDoneLine?: readonly PlanItem[]; risks?: readonly PlanItem[]; metOpen?: readonly MetOpen[];
  /** Each open leaf step's end state (`endState`): every stuck one counts in `stuck_steps`. */
  end?: readonly EndStateView[];
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
  noProgress: still, stale, fold, load = [], heartbeats = [], noDuty = [], noDoneLine = [], risks = [], metOpen = [], end = [], memory }: BoardFindings, told: Readonly<Record<string, ToldEnd>>, everyMs: number, now: number): PrecheckOutput & { metrics: ConvergenceMisses; flagged: FlaggedSlice[] } {
  const misses: ConvergenceMisses = { ...NO_MISSES };
  const flagged: FlaggedSlice[] = [];
  const flag = (kind: keyof ConvergenceMisses, item: string, excerpt: string) => { misses[kind]++; flagged.push({ chat, at: now, kind, excerpt, item }); };
  const counted = new Set([...done.map(found => found.item.id), ...over.map(met => met.view.item.id)]);
  // A step held on an offline box gets only its host_held line: no job of the chat can be started, steered or read there until the owner
  // brings the box back, so "start a job" or "read the job's last report" on it asks for what nobody can do (sep launch!! 10-23 10:12Z on).
  const onHost = new Set(end.filter(entry => entry.state === "host").map(entry => entry.view.item.id));
  const staleById = new Map(stale.filter(entry => !counted.has(entry.item.id) && !onHost.has(entry.item.id)).map(entry => [entry.item.id, entry]));
  for (const view of steps) {
    const id = view.item.id;
    if (onHost.has(id)) continue;
    const line = classLine(view, now) ?? `${id} ${view.cls}`;
    // An item that looks done or whose wait is over gets that finding's "close it" or "act on it"; "start a job" on it too was a second, wrong ask
    // (AI harness 10-13 23:07 KST: p1 had every step closed and read both finished_open and orphan_steps).
    if (view.cls === "orphan" && !counted.has(id)) flag("orphan_steps", id, line);
    if (view.cls === "stale-chase" && now - view.changedAt >= CHASE_ESCALATE_MS) flag("stale_chase_24h", id, line);
    const owner = view.owner;
    // A told end is silent until the job reports: a job that resumed after it and sent the chat a message cleared it (vent 10-21, p7's job "search
    // flows finish" ended on a provider error at 10-20 19:24Z, then reported at 08:32:59Z and 08:35Z, and read "with no report" for 14 h).
    // A told end the job worked past is not its end any more, whatever part of the transcript the server holds: on 10-23 at 03:55Z sep launch!!'s
    // "live fixes" read "stopped on a provider error ... 1223 min ago with no report" from its 429 at 10-22 07:32Z, though it sent the chat 17
    // reports after it and its last turn ended well at 03:06Z on a board.wake. The margin covers the idle unload after a failed turn, which moves
    // the job's activity 2.1 to 2.9 min past the end (`TOLD_END_MARGIN_MS`).
    const toldEnd = owner && owner.state !== "working" ? told[owner.key] : undefined;
    const current = toldEnd && !((owner!.activityAt ?? 0) - toldEnd.at > TOLD_END_MARGIN_MS) ? toldEnd : undefined;
    const silent = current && (owner!.lastMessage?.at ?? 0) <= current.at ? current : undefined;
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
  for (const idle of idleGoals(steps, new Set(done.map(found => found.item.id)))) { misses.idle_goals++; flagged.push({ chat, at: now, kind: "idle_goals", excerpt: idleGoalLine(idle), item: idle.goal.id }); }
  for (const stall of stalled) { misses.stalled_steps++; flagged.push({ chat, at: now, kind: "stalled_steps", excerpt: stalledLine(stall), item: stall.view.item.id }); }
  for (const gate of gates) {
    if (gate.kind === "go_waiting") continue;
    misses[gate.kind]++;
    flagged.push({ chat, at: now, kind: gate.kind, excerpt: gateLine(gate), item: gate.item.id });
  }
  // A goal the check-in folds into a duty gets the fold alone: the duty carries its target. goal_gaps' "push the next step" on it was a second
  // ask (slack green guy p48 at 10-13 00:11 KST, the duty d1 made at 23:58).
  const folded = new Set(fold.map(entry => entry.goal.id));
  for (const push of goals.filter(push => pushNeeded(push) && !folded.has(push.goal.id))) flag(goalGap(push) ? "goal_gaps" : "goals_off_pace", push.goal.id, goalLine(push));
  for (const block of blocked) { misses.blocked_on_others++; flagged.push({ chat, at: now, kind: "blocked_on_others", excerpt: blockedLine(block, now), item: block.view.item.id }); }
  for (const entry of fold) flag("goals_to_fold", entry.goal.id, foldLine(entry));
  for (const found of done.filter(found => !folded.has(found.item.id))) { misses.finished_open++; flagged.push({ chat, at: now, kind: "finished_open", excerpt: lookDoneLine(found), item: found.item.id }); }
  for (const goal of loose.filter(goal => !folded.has(goal.id))) { misses.loose_goals++; flagged.push({ chat, at: now, kind: "loose_goals", excerpt: looseGoalLine(goal), item: goal.id }); }
  for (const entry of extra) flag("extra_goals", entry.goal.id, extraGoalsLine(entry));
  for (const found of underClosed) { misses.open_under_closed++; flagged.push({ chat, at: now, kind: "open_under_closed", excerpt: underClosedLine(found), item: found.item.id }); }
  for (const goal of held.filter(goal => !folded.has(goal.goal.id))) { misses.held_elsewhere++; flagged.push({ chat, at: now, kind: "held_elsewhere", excerpt: heldLine(goal), item: goal.goal.id }); }
  if (still) { misses.no_progress = 1; flagged.push({ chat, at: now, kind: "no_progress", excerpt: noProgressLine(still) }); }
  for (const met of over) { misses.wait_met++; flagged.push({ chat, at: now, kind: "wait_met", excerpt: waitMetLine(met), item: met.view.item.id }); }
  for (const entry of load) { misses.one_session_load++; flagged.push({ chat, at: now, kind: "one_session_load", excerpt: sessionLoadLine(entry), item: entry.goal.id, sig: sessionLoadSig(entry) }); }
  for (const entry of heartbeats) { misses.redundant_heartbeats++; flagged.push({ chat, at: now, kind: "redundant_heartbeats", excerpt: heartbeatLine(entry) }); }
  if (noDuty.length) flag("goals_without_duty", noDuty[0]!.id, noDutyLine(noDuty));
  for (const goal of noDoneLine) flag("no_done_line", goal.id, noDoneLineLine([goal]));
  for (const step of risks) flag("plan_risks", step.id, riskStepsLine([step]));
  for (const found of metOpen.filter(found => !counted.has(found.item.id) && !folded.has(found.item.id))) flag("met_open", found.item.id, metOpenLine(found));
  for (const entry of end) if (!OK_STATES.has(entry.state)) flag("stuck_steps", entry.view.item.id, stuckLine(entry, now));
  for (const entry of end) {
    if (!entry.hold) continue;
    flagged.push({ chat, at: now, kind: "host_held", item: entry.view.item.id, host: entry.hold.host, todo: entry.hold.todo,
      excerpt: `${entry.view.item.id} ${quote(entry.view.item.text)} waits on the owner: ${entry.reason}. It counts as stuck again once the box is back and its job does not move` });
  }
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

/** The check for finished jobs runs on each job end and chat idle, and at least once per JOB_CLEANUP_EVERY_MS per chat. */
export const JOB_CLEANUP_EVERY_MS = 10 * 60_000;
/** How often the service looks for reported roots to end (`idleRoots`): each look reads the chat's board and one summary per reported root. */
export const ROOT_END_EVERY_MS = 60_000;
/** A job quiet this long whose only open work is a board wait is ended, with its state saved on the step (`waitingJobs`). */
export const PARK_IDLE_MS = 60 * 60_000;

/** A direct subagent that ended its task: done, not working, its final report sent (`repliedSinceTask`) and in the chat's transcript (`said`). */
function reported(child: ChildAgent, ids: ReadonlySet<string>, said: ReadonlyMap<string, JobMessage>): boolean {
  return ended(child, ids) && child.repliedSinceTask === true && said.has(childName(child));
}
/** A direct subagent that ended its task (done, not working), whether or not it replied to it. */
function ended(child: ChildAgent, ids: ReadonlySet<string>): boolean {
  return (child.parentId === undefined || !ids.has(child.parentId)) && child.status === "done" && !childWorking(child);
}
const openSteps = (board: ChatBoard | null): PlanItem[] => {
  const open: PlanItem[] = [];
  walk(board?.plan ?? [], item => { if (OPEN.has(item.status)) open.push(item); });
  return open;
};
const jobRef = (child: ChildAgent) => ({ id: child.id, names: [childName(child), child.label, child.sessionId] });

/**
 * The chat's finished jobs to delete now (each holds a Python kernel, and its session holds memory in the chat's worker, until it is deleted): a
 * job that ended its task with its final report in the chat's transcript and is owed no more work. A job is owed work while an open step names
 * it (`stepNamesJob`: its owner, or its id or name in the step's job, waitFor, note or text), or while its last reply to the chat (`said`, from
 * `lastJobMessages`) says it holds parked work (`parkedWork`). launch main bro 10-14 04:1xZ to 04:2xZ: the 04:11Z check-in moved 13 build
 * steps to the job "release driver" and named each build job in the step's note; the rule read only the owner and the waitFor, so instagram
 * access canary and watchlist all green (04:12Z) and fair crawl queue and collab lane self balance (04:24Z) were deleted with pushes parked
 * for 'released'.
 */
export function finishedJobs(children: readonly ChildAgent[], board: ChatBoard | null, said: ReadonlyMap<string, JobMessage> = new Map()): ChildAgent[] {
  const ids = new Set(children.map(child => child.id));
  const open = openSteps(board);
  return children.filter(child => reported(child, ids, said) && said.get(childName(child))?.parked === undefined &&
    !open.some(item => stepNamesJob(item, jobRef(child))));
}

/**
 * The chat's jobs that ended their task, have been quiet PARK_IDLE_MS, and that open steps still name (a wait, or a step left doing). Each comes
 * with those steps, so the chat can save the job's state on them and delete it; the step's class then asks the chat for a fresh job. On 10-14
 * at 12:07Z frontend bro's connections multiple accounts (quiet 417 min, p106 doing, p115 blocked on a todo) and email list funnel columns
 * (355 min, p118 doing) held their kernels only because a step named them, and neither step had a waitFor. A job owed work by its parked
 * words alone, with no step to hold it, is kept. A job that ended its last task with no reply to the chat is ended the same way: it handed
 * its result to a sibling or ended silently, so neither rule took it, and on 10-14 at 15:2xZ the 5 such jobs (Crawler VP's database explorer,
 * engage login redirect and api health snapshots, VP of CI's ci scope root paths, launch main bro's collab backfill) sat resident under open
 * steps, collab backfill quiet 628 min.
 */
export function waitingJobs(children: readonly ChildAgent[], board: ChatBoard | null, now: number, said: ReadonlyMap<string, JobMessage> = new Map()): { child: ChildAgent; steps: PlanItem[] }[] {
  const ids = new Set(children.map(child => child.id));
  const open = openSteps(board);
  return children.flatMap(child => {
    const done = reported(child, ids, said) || (ended(child, ids) && child.repliedSinceTask === false);
    if (!done || child.lastActivityAt === undefined || now - child.lastActivityAt < PARK_IDLE_MS) return [];
    const steps = open.filter(item => stepNamesJob(item, jobRef(child)));
    return steps.length ? [{ child, steps }] : [];
  });
}

const HANDED = "Handed back: ";
/** The note line a step gets when the server hands it back to the chat (`handBackSteps`); the open-steps notice skips a step that has it. */
export const handBackNote = (job: string, at: number): string => `${HANDED}job ${job} reported at ${clockTime(at)} with this step open, so the step is the chat's.`;
const handedBack = (item: PlanItem, job: string): boolean => (item.note ?? "").split("\n").some(line => line.startsWith(`${HANDED}job ${job} `));

/**
 * The open leaf steps with no wait that a job still owns after it ended its task with its final report in (`reported`). The cleanup hands
 * each to the chat (the step's job becomes the chat) with one turn (`handBackText`), so the chat closes or continues it while the report is
 * fresh. frontend bro 10-16: inbox tree lines reported at 02:18Z with p164 doing and email compose polish at 03:41Z with p168 doing; the
 * cleanup ended both jobs at 03:42Z and 04:02Z, and both steps read job_ended at the 04:04Z check-in.
 */
export function handBackSteps(children: readonly ChildAgent[], board: ChatBoard | null, said: ReadonlyMap<string, JobMessage>): { child: ChildAgent; steps: PlanItem[] }[] {
  const ids = new Set(children.map(child => child.id));
  const open = openSteps(board).filter(item => item.waitFor === undefined && item.waitUntil === undefined && !item.children.some(below => OPEN.has(below.status)));
  return children.flatMap(child => {
    if (!reported(child, ids, said)) return [];
    const names = [child.id, childName(child), child.label, child.sessionId];
    const steps = open.filter(item => { const owner = stepOwner(item); return owner !== undefined && names.includes(owner); });
    return steps.length ? [{ child, steps }] : [];
  });
}
/** The turn the chat gets for the steps `handBackSteps` handed it. */
export const handBackText = (child: ChildAgent, steps: readonly PlanItem[]): string =>
  `${childName(child)} reported, and ${steps.length === 1 ? "its open step is" : "its open steps are"} yours now: ${steps.map(step => `${step.id} ${quote(step.text)}`).join("; ")}. ` +
  `Close or continue ${steps.map(step => step.id).join(", ")}.`;

/**
 * The jobs whose turn just ended: at work in `before`, not at work in `after`, however it ended (done, cancelled or failed).
 */
export function endedJobs(before: readonly ChildAgent[], after: readonly ChildAgent[]): ChildAgent[] {
  const working = new Set(before.filter(childWorking).map(child => child.id));
  return after.filter(child => working.has(child.id) && !childWorking(child));
}

/**
 * The open steps a job leaves behind when its turn ends: each open step that names it (`stepNamesJob`), less a step whose owner is another job
 * of the chat that still works. Ops guy 10-15: job limits duty drops complete was cancelled at 09:45Z after a report that said its work was done,
 * and p233 stayed doing for 8 h; check in duty green ended at 10:42Z and left p247 waiting on a check-in no job watched. From 10-14 15:00Z to
 * 10-15 11:50Z, 45 of the 60 steps the check-ins of six chats found stuck named a job that was no longer at work: 34 waited on a land and 11
 * read job_ended.
 */
export function leftOpenSteps(child: ChildAgent, children: readonly ChildAgent[], board: ChatBoard | null): PlanItem[] {
  const others = children.filter(other => other.id !== child.id && childWorking(other));
  return openSteps(board).filter(item => {
    if (!stepNamesJob(item, jobRef(child)) || handedBack(item, childName(child))) return false;
    const owner = stepOwner(item);
    return owner === undefined || !others.some(other => owner === other.id || owner === childName(other) || owner === other.sessionId);
  });
}

/** Each open step a stopped job left (`leftOpenSteps`) as the open-steps notice names it: its id, text and wait. */
export const openStepLines = (steps: readonly PlanItem[]): string[] => steps.map(step => {
  const wait = [step.waitFor !== undefined ? `waits for ${quote(clip(step.waitFor, 80))}` : "", step.waitUntil !== undefined ? `waits until ${step.waitUntil}` : ""].filter(Boolean);
  return `${step.id} ${quote(step.text)} ${wait.length ? wait.join(" and ") : `is ${step.status}`}`;
});

/**
 * The line a chat gets when a job's turn ended and open steps still name it (`leftOpenSteps`): at most BRIEF_ITEMS steps with their waits,
 * the file that lists the rest (`detail`), and what to do now.
 */
export function openStepsNotice(child: ChildAgent, steps: readonly PlanItem[], detail?: string): string {
  const how = child.status === "cancelled" ? "was cancelled" : child.status === "error" ? "failed" : "ended its turn";
  const lines = openStepLines(steps);
  const rest = lines.length - BRIEF_ITEMS;
  const listed = [...lines.slice(0, BRIEF_ITEMS), ...rest > 0 ? [`and ${rest} more${detail ? `, all listed in ${detail}` : ""}`] : []];
  return `${childName(child)} ${how}, and ${steps.length === 1 ? "this open step names" : "these open steps name"} it: ${listed.join("; ")}. ` +
    "Read its last report now, then close each step whose work is done, steer the job, or start a fresh job for the rest, so no step waits on a job that stopped.";
}

/**
 * A create_session root of the chat that ended its turn with its report in: idle (not working, failed, or waiting on an answer from the chat)
 * and its last message is in the chat's transcript (`said`, by the name it sends with).
 */
export const reportedRoot = (agent: ChatAgent, said: ReadonlyMap<string, JobMessage>): boolean =>
  agent.link === "root" && agent.state === "idle" && agent.sessionId !== undefined && said.has(agent.sender);

/**
 * The chat's reported roots (`reportedRoot`) that no open step names (`stepNamesJob`), each its own worker to end as soon as its report is in.
 * At 06:0x KST on 10-16, 19 finished jobs were not deleted (slack green guy 6, the AI harness chat 3, launch main bro 2) while they waited out
 * the 60 min quiet this used to ask for, and the Mac had 12 harness minutes in the hour with the workers at 18.5 to 23.9 GB.
 */
export function idleRoots(agents: readonly ChatAgent[], board: ChatBoard | null, said: ReadonlyMap<string, JobMessage>): ChatAgent[] {
  const open = openSteps(board);
  return agents.filter(agent => reportedRoot(agent, said) &&
    !open.some(item => stepNamesJob(item, { id: agent.sessionId!, names: [agent.name, agent.sender] })));
}

/**
 * Words in a job's message that say it still holds work for later: a push at, on, for or after 'released' (any quotes; "When you relay
 * 'released', I'll push"), "still waiting for", "I'm waiting on",
 * an armed wait or timer, "once it's on prod", or "parked pushes". Each comes from the jobs launch main bro's cleanup deleted on 10-14 at
 * 04:12Z and 04:24Z (fair crawl queue: "It pushes with the land 35 set at "released""; collab lane self balance: "I'm still waiting for the r14
 * sha"; instagram access canary: "Once it's on prod, I'll write the 2000 arm") or their earlier messages ("wait armed", "The parked pushes are
 * ready"). A word alone such as "wait" or "holds" is not enough: final reports say "that path still holds", and one release path rule's final
 * report (AI harness 10-14) listed "'released'" among the words a waitFor can name.
 */
const PARKED_WORK = /\b(?:at|on|for|after|until|relay|forward)\s+(?:(?:your|Fable's|the release driver's)\s+)?["'\u2018\u201c]released["'\u2019\u201d]|\bstill (?:waiting|wait) (?:for|on)\b|\b(?:I'm|I am) waiting (?:for|on)\b|\bwait (?:is )?armed\b|\b(?:my|the) wait follows\b|\btimer (?:is )?(?:set|armed)\b|\bonce it(?:'s|\u2019s| is) (?:on prod|promoted|landed|live)\b|\bparked (?:pushes|items?|work)\b/i;
/** The words of a job's message that say it holds parked work (PARKED_WORK), or undefined. */
export const parkedWork = (text: string): string | undefined => PARKED_WORK.exec(text)?.[0];
/** Messages a job sends this close together are one reply (instagram access canary 10-14 01:49:41Z: one reply in two messages, 1 ms apart). */
export const REPLY_GAP_MS = 5_000;

/**
 * Each job's last agent message to the chat, by the name its header gives (`agentMessageHead`: `[agent-message from child:<name>]` with the
 * `child:` cut, or the cross-host line of a root on another box), with when the
 * job last sent one that carries a fact (`noteFacts` over the whole message), and the words of its last reply that say it holds parked work
 * (`parkedWork` over the whole message; messages within REPLY_GAP_MS of each other are one reply).
 */
export function lastJobMessages(messages: readonly { role: string; customType?: string; content?: unknown; timestamp?: number }[]): Map<string, JobMessage> {
  const last = new Map<string, JobMessage>();
  for (const message of messages) {
    const read = jobMessage(message);
    if (!read) continue;
    const before = last.get(read.name);
    const factsAt = read.facts ? read.at : before?.factsAt;
    const parked = read.parked ?? (before !== undefined && read.at - before.at <= REPLY_GAP_MS ? before.parked : undefined);
    last.set(read.name, { at: read.at, text: read.text, ...(factsAt !== undefined ? { factsAt } : {}), ...(parked !== undefined ? { parked } : {}) });
  }
  return last;
}
type ReadJobMessage = { name: string; at: number; text: string; facts: boolean; parked: string | undefined };
/**
 * One agent message as `lastJobMessages` reads it, kept per message object, since a chat's messages are the same objects on each call. Until
 * 10-20 every call ran the fact and parked-work patterns over every agent message of the chat again, and the check-in's job pass called it
 * for each chat on each round: 0.3 to 0.5 s of main thread at a time on a scratch serve on a copy of the live data dir with its chats.
 */
const readJobMessages = new WeakMap<object, ReadJobMessage | null>();
function jobMessage(message: { role: string; customType?: string; content?: unknown; timestamp?: number }): ReadJobMessage | null {
  if (message.role !== "custom" || message.customType !== "agent_message") return null;
  const kept = readJobMessages.get(message);
  if (kept !== undefined) return kept;
  const text = typeof message.content === "string" ? message.content
    : Array.isArray(message.content) ? message.content.map(part => typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : "").join("") : "";
  const head = agentMessageHead(text);
  const read: ReadJobMessage | null = head ? { name: head.name, at: message.timestamp ?? 0, text: head.body.split("\n").map(line => line.trim()).find(Boolean) ?? "",
    facts: noteFacts(head.body).length > 0, parked: parkedWork(head.body) } : null;
  readJobMessages.set(message, read);
  return read;
}
/** The whole body of the last agent message the job named `name` sent the chat, header cut, as `lastJobMessages` reads it; "" when none. */
export function jobReport(messages: readonly { role: string; customType?: string; content?: unknown }[], name: string): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "custom" || message.customType !== "agent_message") continue;
    const text = typeof message.content === "string" ? message.content
      : Array.isArray(message.content) ? message.content.map(part => typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : "").join("") : "";
    const head = agentMessageHead(text);
    if (head?.name === name) return head.body.trim();
  }
  return "";
}
/**
 * The `[job]` notice for a job that went quiet while the daemon says it did not reply to its task: one that messaged the chat at or after its
 * last wake asked something and waits for an answer, since that message; one whose last turn failed says how (`failure`, the agents panel's
 * cut line, "stopped on a provider error at 18:00 (rate limit 429, retries at 18:16), no report since"); any other ended at its last activity
 * with no report. A failed turn read "ended at ... with no report" before, the same words as a job that finished quietly.
 */
export function noReportNotice(name: string, message: JobMessage | undefined, wokeAt: number, end: number, failure?: string): string {
  if (message !== undefined && message.at >= wokeAt) return `${name} is waiting for you since ${clockTime(message.at)} (last message: "${clip(message.text, 140)}")`;
  return failure ? `${name} ${clip(failure, 240)}` : `${name} ended at ${clockTime(end)} with no report`;
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
/** The cause in plain words: a provider error with its cause (`turnErrorCause`), aborted, stopped mid-tool, the length limit. */
export function jobEndWords(end: Pick<JobEnd, "cause" | "error">): string {
  switch (end.cause) {
    case "error": return `stopped on a provider error (${turnErrorCause(end.error)})`;
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
export interface ToldEnd { at: number; cause: JobEndCause; error?: string }
/**
 * How far past a told end a job's last activity may be and the end still be its last one. After a failed turn the idle unload stops the job and
 * moves its activity: six 429 ends of sep launch!!'s "live fixes" on 10-22 were unloaded 2.1 to 2.9 min after the error.
 */
export const TOLD_END_MARGIN_MS = 5 * 60_000;
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
  const sent = isRecord(value.sent) ? Object.entries(value.sent).filter((entry): entry is [string, string] => typeof entry[1] === "string") : [];
  const goals = isRecord(value.goals) ? Object.entries(value.goals).filter((entry): entry is [string, GoalMemo] => isGoalMemo(entry[1])) : [];
  const jobs = isRecord(value.jobs) ? Object.entries(value.jobs).filter((entry): entry is [string, JobMemo] => isJobMemo(entry[1])) : [];
  return { at: value.at, steps: Object.fromEntries(steps), ...(typeof value.since === "number" ? { since: value.since } : {}),
    ...(flags.length ? { flags: Object.fromEntries(flags) } : {}), ...(sent.length ? { sent: Object.fromEntries(sent) } : {}), ...(goals.length ? { goals: Object.fromEntries(goals) } : {}),
    ...(jobs.length ? { jobs: Object.fromEntries(jobs) } : {}) };
}
/**
 * The goal and job memos survive every read of check-ins.json. Each write of one chat's memory parses the whole file, and the parse kept only
 * steps, since and flags, so every other chat lost its goal readings and job marks: from 10-16 to 10-18 frontend bro's p106 and p118 read
 * "first reading, no trend yet" in 14 check-ins in a row, and at 10-17 22:12Z only 1 of the 11 chats in the file, the one written last, held
 * goals or jobs.
 */
const isGoalMemo = (value: unknown): value is GoalMemo => isRecord(value) && typeof value.still === "number" && Array.isArray(value.readings) &&
  value.readings.every(reading => isRecord(reading) && typeof reading.value === "number" && typeof reading.at === "number");
const isJobMemo = (value: unknown): value is JobMemo => isRecord(value) && typeof value.mark === "number" && typeof value.since === "number" &&
  (value.pushed === undefined || typeof value.pushed === "number");
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
    // Read through the parse cache (`cachedJsonFile`): each check-in round read the 700 KB file once per chat. A caller gets its own copy.
    async get(id) { const memory = (await cachedJsonFile(file)).chats[id]; return memory && structuredClone(memory); },
    async set(id, memory) { await transactJsonFile(file, state => { state.chats[id] = memory; }); },
    async forget(id) { await transactJsonFile(file, state => { delete state.chats[id]; delete state.ends[id]; }); },
    async ends(id) { return { ...(await cachedJsonFile(file)).ends[id] }; },
    async told(id, key, end) {
      await transactJsonFile(file, state => {
        const told = state.ends[id] ??= {};
        for (const [other, entry] of Object.entries(told)) if (end.at - entry.at > TOLD_END_KEEP_MS) delete told[other];
        told[key] = end;
      });
    },
  };
}
