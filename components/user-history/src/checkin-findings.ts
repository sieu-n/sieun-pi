import type { HandoffRule } from "./chat-corrections.ts";
import { type DoneReason, pathLike, type PrState } from "./checkin-done.ts";
import { CHECK_IN_DUTY_ID, type Duty } from "./shared/chat-duties.ts";
import { areaWords, BOARD_LIMITS, buildGoal, coversStep, isBuildStep, mergedPrs, mergeStep, namesPr, needsGo, openGoals, planJob, prNumbers, requirementGaps, stepGo,
  walkItems } from "./shared/chat-board.ts";
import type { BoardOp, ChatBoard, OwnerTodo, PlanItem, SessionRow } from "./shared/types.ts";
import { ago, clip, CLOSED, type JobFact, OPEN, ownerLabel, ownerOf, ownerState, owns, parkedBy, plural, quote, type StepMemo, stepOwner, type StepView, waitTarget,
  walk } from "./checkin-steps.ts";
import type { CiRun, Train, TrainRun } from "./checkin-load.ts";
import { type Movers, outsideMover } from "./checkin-end-state.ts";
import { localTime } from "./checkin-settings.ts";
import type { FleetStop } from "./fleet-budget.ts";

/** The check-in's board findings: the plan's shape, goals to fold, held and stalled steps, scope misses and owner gates, each with the line the duty job reads (goals: src/checkin-goals.ts). */

/*
 * The plan's shape (c44, reopened 10-12: p253 sat as a top-level item with no steps, status doing, after its work shipped, and the owner had to
 * ask the chat to tidy the plan). The plan is a few area goals with their open steps under them.
 */
/** The open goals with no step under them: a step filed as a goal. */
export const looseGoals = (board: ChatBoard | null): PlanItem[] => openGoals(board?.plan ?? []).filter(goal => !goal.children.length);
/** The open goals when there are more than BOARD_LIMITS.openGoals; a board from before the limit can still hold more. */
export function extraGoals(board: ChatBoard | null): PlanItem[] {
  const open = openGoals(board?.plan ?? []);
  return open.length > BOARD_LIMITS.openGoals ? open : [];
}
/** The open items right under a closed (done or dropped) item, board order: a closed goal with open work is a lie. */
export function openUnderClosed(board: ChatBoard | null): { item: PlanItem; parent: PlanItem }[] {
  const found: { item: PlanItem; parent: PlanItem }[] = [];
  walkItems(board?.plan ?? [], item => { if (CLOSED.has(item.status)) for (const child of item.children) if (OPEN.has(child.status)) found.push({ item: child, parent: item }); });
  return found;
}
export const underClosedLine = ({ item, parent }: { item: PlanItem; parent: PlanItem }): string =>
  `${item.id} ${quote(item.text)} is open under closed ${parent.id}: close it, or reopen ${parent.id} if the work is real`;
export const lookDoneLine = ({ item, reason }: { item: PlanItem; reason: string }): string => `${item.id} ${quote(item.text)} ${item.status}, looks done: ${reason}; close it with a note that names this`;
/**
 * A goal with a target never moves under another item, since board-apply refuses a target below the top level (`GOAL_ONLY`): launch main bro
 * 10-15 14:08Z was told to move p125 and p126, its top-level d1 and d2 duty metric items, "with plan_update parent", and p126 carries d2's target.
 */
export const looseGoalLine = (goal: PlanItem): string => goal.target
  ? `${goal.id} ${quote(goal.text)} is a goal with a target and no steps: add a step under it (plan_add with parent ${goal.id}) whose job moves ` +
    "its number, or close it if its work shipped"
  : `${goal.id} ${quote(goal.text)} is a top-level item with no steps: move it under the goal it belongs to with plan_update parent, give it ` +
    "steps, or close it if its work shipped";
export const extraGoalsLine = (goals: readonly PlanItem[]): string => `${goals.length} open goals, the limit is ${BOARD_LIMITS.openGoals}: fold goals of one area under one ` +
  `area goal (${goals.map(goal => `${goal.id} ${quote(goal.text)}`).join(", ")})`;

/**
 * A goal held only by other threads (c45, owner 10-12 on chat bugfix temp: p1 "Old chats show in the sidebar again" stayed open after its fix
 * shipped, because its last step p3 waited for "next chat release with the fix", owned by the AI harness VP thread; that thread was busy with
 * other work, so p3 counted as live and no line named it). The goal has a closed step (its own work happened), no target it is short of, and
 * every open leaf step under it is held by another thread: its owner is a thread, or it has no owner of this chat and its waitFor names a
 * thread (`waitTarget`). A step of the chat, a subagent's step and a step with a For you todo keep the goal here, and so does a target gap: a
 * goal short of its number is still this chat's to push (Crawler VP 10-12: p19, 32 of 180 Mbps, waited on the release owner's ramp). The
 * check-in checks the wait against the real state and closes the goal on that evidence, or hands the leftover to the holding thread and
 * closes it here, or adds the step of its own that comes after the wait. A step whose own run, probe, land or push has not landed is never
 * closed for a hand-off (`unlandedClose`, AI harness 10-14 17:01 KST).
 *
 * A root the chat started with rlm.create_session is the chat's own job, never another thread (launch main bro 10-14 04:1xZ to 04:2xZ: a
 * check-in started "release driver", session 01a1389b, and moved p75 and p77 of p81 and p56, p57, p87 and p97 of p82 onto it; it is a
 * top-level row, so its steps read as a `thread:` owner and both goals were flagged). `jobs` holds the chat's roots from the job registry
 * (`rootsOf`, names or ids); a row whose name is one of them adds its session id. A step whose owner, or whose waitFor's thread
 * (`waitTarget`), is one of these keeps the goal here.
 */
export interface HeldGoal { goal: { id: string; text: string }; steps: { item: PlanItem; thread: { id: string; name: string } }[] }
export function heldElsewhere(views: readonly StepView[], board: ChatBoard | null, rows: readonly Pick<SessionRow, "id" | "name" | "archived">[], self: ReadonlySet<string>,
  jobs: readonly string[] = []): HeldGoal[] {
  const settled = (goal: PlanItem): boolean => goal.children.some(child => CLOSED.has(child.status)) &&
    (!goal.target || (goal.target.current !== undefined && goal.target.current >= goal.target.target));
  const tops = new Map((board?.plan ?? []).map(goal => [goal.id, goal]));
  const own = new Set([...jobs, ...rows.filter(row => jobs.includes(row.name)).map(row => row.id)]);
  const other = (thread: { id: string; name: string } | undefined) => thread && !own.has(thread.id) && !own.has(thread.name) ? thread : undefined;
  const holder = (view: StepView): { id: string; name: string } | undefined => {
    if (view.mine || view.cls === "foryou") return undefined;
    if (view.owner) return view.owner.key.startsWith("thread:") ? other({ id: view.owner.key.slice("thread:".length), name: view.owner.name }) : undefined;
    return other(waitTarget(view.item.waitFor, rows, self));
  };
  const goals = new Map<string, HeldGoal | null>();
  for (const view of views) {
    const goal = view.goal ?? { id: view.item.id, text: view.item.text };
    const thread = holder(view);
    const held = goals.get(goal.id);
    if (held === null) continue;
    goals.set(goal.id, thread ? { goal, steps: [...held?.steps ?? [], { item: view.item, thread }] } : null);
  }
  return [...goals.values()].filter((held): held is HeldGoal => held !== null && tops.get(held.goal.id) !== undefined && settled(tops.get(held.goal.id)!));
}
export const heldLine = ({ goal, steps }: HeldGoal): string => `${goal.id} ${quote(goal.text)} has no open work of its own: ` +
  steps.map(({ item, thread }) => `${item.id} ${quote(item.text)} is held by the ${clip(thread.name, 40)} thread (thread:${thread.id})` +
    (item.waitFor ? ` and waits for ${quote(item.waitFor)}` : "")).join("; ") +
  ". Check the wait against the real state now: if it is met, close the step and the goal on that evidence. If not, send that thread the " +
  "leftover in one message with what it must check. A step whose run, probe, land or push has not finished green and landed stays open with " +
  "its job, and board-apply refuses that close; close a step here with a note naming the thread only when what is left is that thread's own " +
  "work. Keep the goal while a step under it is open, or when more work of this chat comes after the wait, and add that step now";

/**
 * An open step whose wait is over (c45): its waitFor names plan steps or For you todos of this board (`p67`, `t8`), and everything it names is
 * met. A named step is closed, a named todo answered, and a named PR (`prNumbers`) merged by a done merge step whose text names it. A step id in
 * a "see" reference is a pointer, not the wait (slack green guy 10-13: "#226 and #234 merged (see p74)" read as met when p74 merged only #226
 * and #234's merge, p124, was open). A PR the waiting step's own text names is its own merge, not its wait. The board cannot show a run or a
 * check ("then a green re-run of #229 on the Air"), so the step ids, todos and PRs are what is checked. A clause that names a hold or a land
 * ("hold11", "land 34"), or a lift, green run, land or deploy with no step id or PR of its own, is a wait the board cannot check, so the wait is
 * not over (Crawler VP 10-13: p144 waited for "hold11 lifts, then the ... runs rerun green for land 34"). A step id after another board's
 * possessive ("the API portal's own p8", "VP of CI's p134", "its p128") is that board's step: p144's "the API portal's own p8" read as this
 * board's done p8. A `t9` or `p9` right after a name word or inside a ref ("queue cuts t9", "ci/queue-cuts-t9") is a push or version name,
 * not a board id; an id counts standalone or after a small word ("todo t9", "For you t9", "on t18", "p8 and p9"). After a hyphenated name
 * with a number ("land-39 p3") it is a part of that land: Crawler VP 10-16 p535 waited for "land-39 p3 20880ecc10 green" and read done goal p3. VP of CI 10-14: p135 waited
 * for "run 38414179195 (queue cuts t9 on f0a8ed462f) green", and four check-ins read that t9 as answered todo t9. A clause that names a CI run
 * id and an awaited "green" stays open whatever ids it also names ("is green (run 38289995168)" is a run already seen). A waitFor that names
 * another thread is left out, since its ids may be that thread's. The step is due now, whatever its waitUntil.
 */
export interface WaitMet { view: StepView; over: string[]; run?: CiRun }
const SEE_IDS = /\bsee\s+(?:also\s+)?[pt]\d+(?:\s*(?:,|and)\s*[pt]\d+)*\b/gi;
const OTHER_BOARD_IDS = /(?<!\b(?:this(?:\s+(?:board|chat|thread))?|owner))(?:'s|\bits|\btheir)\s+(?:(?:own|board|plan|step|steps)\s+)*[pt]\d+(?:\s*(?:,|and)\s*[pt]\d+)*\b/gi;
const UNCHECKED_NAME = /\b(?:hold|land)[\s-]*\d+\b/i;
const UNCHECKED_EVENT = /\b(?:lifts?|lifted|green|re-?runs?|lands?|landed|deploy(?:s|ed)?|promote[sd]?)\b/i;
const CI_RUN_ID = /\b\d{9,}\b/;
const AWAITED_GREEN = /(?<!\b(?:is|was|are|were|went|turned|stayed)\s+)\bgreen\b/i;
const ID_WORDS = new Set(["a", "the", "on", "of", "for", "to", "at", "in", "by", "from", "after", "before", "until", "till", "with", "and", "or", "nor",
  "plus", "then", "see", "also", "via", "once", "when", "while", "both", "is", "are", "was", "were", "answer", "answers", "answered", "await", "awaits",
  "wait", "waits", "you", "todo", "todos", "step", "steps", "plan", "goal"]);
const boardIds = (text: string): string[] => [...new Set([...text.matchAll(/\b[pt]\d+\b/g)].filter(({ 0: id, index }) => {
  const word = /(\S+)\s+$/.exec(text.slice(0, index))?.[1] ?? "";
  return !/[-/_.]$/.test(text.slice(0, index)) && !/^(?:[-/_]|\.\w)/.test(text.slice(index + id.length)) &&
    !(/^[a-z]+$/i.test(word) && !ID_WORDS.has(word.toLowerCase())) && !/^[a-z]+-\d+[a-z]?$/i.test(word);
}).map(([id]) => id))];
export function waitsMet(views: readonly StepView[], board: ChatBoard | null, rows: readonly Pick<SessionRow, "id" | "name" | "archived">[], self: ReadonlySet<string>): WaitMet[] {
  const items = new Map<string, PlanItem>();
  walkItems(board?.plan ?? [], item => { items.set(item.id, item); });
  const merges = [...items.values()].filter(item => item.status === "done" && mergeStep(item.text));
  const todos = new Map((board?.todos ?? []).map(todo => [todo.id, todo]));
  return views.flatMap(view => {
    const { waitFor } = view.item;
    if (!boardIds(waitFor ?? "").some(id => id !== view.item.id) || /\bthreads?\b/i.test(waitFor!) || waitTarget(waitFor, rows, self)) return [];
    const scoped = waitFor!.replace(SEE_IDS, "").replace(OTHER_BOARD_IDS, "");
    const named = boardIds(scoped).filter(id => id !== view.item.id);
    const prs = prNumbers(scoped).filter(pr => !namesPr(view.item.text, pr));
    const unchecked = scoped.split(/[,;]|\bthen\b/).some(clause => UNCHECKED_NAME.test(clause) || CI_RUN_ID.test(clause) && AWAITED_GREEN.test(clause) ||
      UNCHECKED_EVENT.test(clause) && !boardIds(clause).some(id => id !== view.item.id) && !prNumbers(clause).length);
    if (unchecked) return [];
    const over = named.flatMap(id => {
      const item = items.get(id);
      if (item) return CLOSED.has(item.status) ? [`${id} is ${item.status}`] : [];
      const todo = todos.get(id);
      return todo && (todo.done || (todo.reply ?? "").trim() !== "") ? [`${id} is answered (read the answer: a hold is not a go)`] : [];
    });
    const merged = prs.flatMap(pr => { const by = merges.find(item => namesPr(item.text, pr)); return by ? [`#${pr} is merged (${by.id} is done)`] : []; });
    return over.length + merged.length > 0 && over.length === named.length && merged.length === prs.length ? [{ view, over: [...over, ...merged] }] : [];
  });
}
export const waitMetLine = ({ view, over, run }: WaitMet): string =>
  `${view.item.id} ${quote(view.item.text)} waits for ${quote(view.item.waitFor ?? "")}, and ${over.join(" and ")}: the wait is over, act on it now ` +
  (run ? "(a cancelled run never turns green: rerun it, or push fresh and put the new run in waitFor, or wait on the hold that cancelled it)"
    : "(start it, or close it if the wait made it moot)");
/**
 * An open step that waits for the owner to lift the fleet stop, once the stop is off (`readFleetStop`): every clause of its waitFor names the
 * stop, so nothing else is left to wait on. slack green guy 10-16: p150 and p151 waited for "The owner lifts the stop on background work", the
 * stop went off at 19:13:56Z on 10-15, and the 04:55 KST check-in still counted p150 stuck on an event for the second run in a row.
 */
const STOP_WAIT = /\b(?:lift(?:s|ed|ing)?|ends?|ended|clears?|cleared|turns?\s+off|turned\s+off)\s+(?:the\s+|his\s+|its\s+)?(?:fleet[\s-]+|owner['\u2019]?s\s+)?stop\b|\bstop\s+(?:switch\s+)?(?:lifts?|is\s+lifted|goes\s+off|is\s+off|ends?)\b|\bfleet[\s-]+stop\b/i;
export function stopWaits(views: readonly StepView[], stop: FleetStop | undefined): WaitMet[] {
  if (!stop || stop.on) return [];
  const lifted = stop.liftedAt !== undefined ? `the fleet stop lifted at ${localTime(stop.liftedAt)}` : "the fleet stop is off";
  return views.flatMap(view => {
    const clauses = (view.item.waitFor ?? "").split(/[,;]|\bthen\b|\band\b/).map(clause => clause.trim()).filter(Boolean);
    return clauses.length && clauses.every(clause => STOP_WAIT.test(clause)) ? [{ view, over: [lifted] }] : [];
  });
}

/**
 * How long a step may still name a cancelled run before the check-in flags it: the chat repoints the wait when the job reports the cancel (api
 * portal vp 10-13: Fable's land-34 loop cancelled p9's run 38408618643 at 13:55:56Z, the job reported it at 13:57Z, and the chat set p9 to wait
 * on the release at 14:10Z).
 */
export const DEAD_RUN_MS = 30 * 60_000;
/**
 * The steps whose wait ended with no green, as `wait_met`: the waitFor names a run the CI cache (`train`) shows cancelled over DEAD_RUN_MS ago
 * and no run it names is queued or running (`deadRun`). 10-13 23:07 KST counted five such steps as blocked_on_others: api portal vp p9, p12 and
 * p14 and launch main bro p75 and p84, whose runs Fable's land-34 loop and 14:05Z stop had cancelled.
 *
 * A step whose owner works on it, or sleeps on a board.wake the service still owes (`withWakes` makes that owner working), is the owner's to
 * rerun, as `endState` reads it moving. Ops guy 10-15: Fable's holds U to AA cancelled the ops train's runs, the job slept on a wake at each
 * hold's cap (05:02Z, 06:45Z, 08:40Z), and the 04:36Z, 06:36Z and 08:36Z check-ins still counted 22, 28 and 1 of its steps as wait_met.
 */
export function deadRunWaits(views: readonly StepView[], train: Train | undefined, now: number): WaitMet[] {
  return views.flatMap(view => {
    if (view.owner?.state === "working") return [];
    const green = greenLater(view.item, train);
    if (green) return [{ view, over: [green] }];
    const run = deadRun(view.item, train);
    return run && now - run.updatedAt > DEAD_RUN_MS ? [{ view, run, over: [`run ${run.id} was cancelled ${ago(now - run.updatedAt)} ago and nothing reruns it`] }] : [];
  });
}

const COMMIT = /\b[0-9a-f]{7,40}\b/g;
/**
 * Why a step that waits for a commit's run to go green is over, from the CI cache: each commit its waitFor names has a green run of the workflow
 * the waitFor names (every run of the commit when it names none) is green, or was cancelled while a later push run of the same workflow on the
 * same branch went green, which holds the commit since nobody force-pushes. Undefined while a run is going, a run failed, or a clause names something else.
 * VP of CI 10-15: p192 and p194 waited from 11:07Z for "origin 2d6cdcaec0's push verify-dev run green"; a newer push cancelled run 38725138542
 * at 13:35Z, run 38743107248 on a43b35a24b went green at 15:09Z, and the 15:00Z check-in still read p192 as stalled for 11 h.
 */
export function greenLater(item: Pick<PlanItem, "waitFor">, train: Train | undefined): string | undefined {
  const clauses = (item.waitFor ?? "").split(/[,;]|\bthen\b/).map(clause => clause.trim()).filter(Boolean);
  const runs = [...train?.all?.values() ?? []];
  if (!clauses.length || !runs.length) return undefined;
  const found: string[] = [];
  for (const clause of clauses) {
    const shas = clause.match(COMMIT) ?? [];
    if (!shas.length || !AWAITED_GREEN.test(clause)) return undefined;
    for (const sha of shas) {
      const own = runs.filter(run => run.sha?.startsWith(sha));
      const named = own.filter(run => run.workflow && new RegExp(`\\b${run.workflow.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(clause));
      const watched = named.length ? named : own;
      if (!watched.length) return undefined;
      for (const run of watched) {
        if (run.conclusion === "success") { found.push(`run ${run.id} on ${sha} is green`); continue; }
        const later = run.conclusion === "cancelled" && run.event === "push" ? runs.filter(other => other.workflow === run.workflow && other.ref === run.ref &&
          other.event === "push" && (other.createdAt ?? 0) > (run.createdAt ?? Infinity) && other.conclusion === "success").sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))[0] : undefined;
        if (!later) return undefined;
        found.push(`run ${run.id} on ${sha} was cancelled, and the later push run ${later.id} on ${later.ref} at ${later.sha?.slice(0, 10)}, which holds it, is green`);
      }
    }
  }
  return found.join(" and ");
}

/** The fields of a chat duty (`<data dir>/duties/<chat>.json`) the fold reads. */
export type DutyRef = Pick<Duty, "id" | "name" | "goal" | "status" | "boardGoal">;
/**
 * The active duty that runs a goal's work: the duty whose `boardGoal` is the goal, else the first whose name and goal share at least
 * FOLD_AREA_WORDS area words (`areaWords`) with the goal's text, and at least half of the goal's. On VP of CI's board p72 shares 6 of 11 with the
 * duty "Git rules" and p75 7 of 9 with "Repo design"; p10 "Staging promotes to prod on its own" shares 2 with "Git rules" and p60 4 of 9 with
 * "Repo design", and neither is that duty's work. The word match is only for a duty with no `boardGoal`: on frontend bro p102 took the open
 * steps of d2's goal p14 after p14 folded, and folding p102 into d2 by its words would fold each new holder again.
 */
export const FOLD_AREA_WORDS = 3;
export function dutyFor(goal: Pick<PlanItem, "id" | "text">, duties: readonly DutyRef[]): DutyRef | undefined {
  const active = duties.filter(duty => duty.status === "active");
  const words = areaWords(goal.text);
  const shared = (duty: DutyRef) => { const other = areaWords(`${duty.name} ${duty.goal}`); return [...words].filter(word => other.has(word)).length; };
  return active.find(duty => duty.boardGoal === goal.id) ??
    active.find(duty => duty.boardGoal === undefined && shared(duty) >= FOLD_AREA_WORDS && shared(duty) * 2 >= words.size);
}

/**
 * A goal to fold (c46, owner 10-12 via VP of CI: he asked whether p15 was done and whether every item was pushed through). p15, p72 and p75 stayed
 * open at the 14:07 check-in: their own work ran as the chat's duties and their open steps rode other goals' jobs. An open goal folds when an
 * active duty of the chat runs its work (`dutyFor`), or when every open step right under it has a home in another goal: an open item there with
 * the same job (not the chat itself, not a thread); for a step with no job of its own, the item its waitFor names by id or whose job its waitFor
 * names. A step with its own job that no other goal shares stays, whatever it waits for, and so does a step on its own goal's job. `moves` puts
 * each step with a home under the goal that holds that item, never under a step; `left` are a duty goal's open steps with no home, which the check-in places itself. A goal another fold
 * moves steps into does not fold, and a duty's goal is never a home. Board order.
 */
export interface FoldMove { item: PlanItem; home: PlanItem; why: string }
export interface FoldGoal { goal: PlanItem; duty?: DutyRef; moves: FoldMove[]; left: PlanItem[] }
export function goalsToFold(board: ChatBoard | null, facts: readonly JobFact[], self: ReadonlySet<string>, duties: readonly DutyRef[]): FoldGoal[] {
  const goals = (board?.plan ?? []).filter(goal => OPEN.has(goal.status));
  const byDuty = new Map(goals.flatMap(goal => { const duty = dutyFor(goal, duties); return duty ? [[goal.id, duty] as const] : []; }));
  /** A job that names work of this chat: not the chat itself and not another thread. */
  const workJob = (item: PlanItem): string | undefined => {
    const job = planJob(item.job);
    return job === undefined || self.has(job) || facts.some(fact => fact.key.startsWith("thread:") && owns(fact, job)) ? undefined : job;
  };
  const folds: FoldGoal[] = [];
  const homeGoals = new Set<string>();
  // A duty metric's fix step filed at the top level with its job at work is that job's work, not a goal the duty runs: the AI harness chat's
  // 10-15 14:02Z, 16:02Z and 16:45Z check-ins said to close p478 and p479 (d6 metrics) while their jobs (mac usable resident workers, then fix
  // mac stays usable 23:35) worked on them.
  const fixing = (goal: PlanItem): boolean => goal.duty !== undefined && ownerOf(goal, facts)?.state === "working";
  for (const goal of goals) {
    if (fixing(goal)) continue;
    const duty = byDuty.get(goal.id);
    if (!duty && homeGoals.has(goal.id)) continue;
    // A home is an open goal, never a step: on ops guy's board (10-16 01:08) p259 and p260 were to fold under p138 "Fix: the M1 Air's Docker
    // memory chart has gaps", a step of p45, because p138 had the job ops train. A goal that has the job itself comes first.
    const homes: { item: PlanItem; goal: PlanItem }[] = [];
    for (const other of goals) {
      if (other === goal || byDuty.has(other.id) || folds.some(fold => fold.goal === other)) continue;
      walkItems([other], item => { if (OPEN.has(item.status)) homes.push({ item, goal: other }); });
    }
    const first = (match: (item: PlanItem) => boolean) => homes.find(entry => entry.item === entry.goal && match(entry.item)) ?? homes.find(entry => match(entry.item));
    const where = (entry: { item: PlanItem; goal: PlanItem }) => entry.item === entry.goal ? entry.goal.id : `${entry.item.id} of ${entry.goal.id}`;
    const homeOf = (step: PlanItem): { home: PlanItem; why: string } | undefined => {
      const job = workJob(step);
      // A step with a job of its own rides another goal only on that job: p96 has its own job and waits for p97 of another goal, and stays.
      // A step on its own goal's job is home already: p192, the goal ops train lands, holds ops train's steps (ops guy 10-16).
      if (job !== undefined) {
        const same = job === workJob(goal) ? undefined : first(item => workJob(item) === job);
        return same ? { home: same.goal, why: `${where(same)} has its job ${job}` } : undefined;
      }
      for (const id of step.waitFor?.match(/\bp\d+\b/g) ?? []) {
        const home = homes.find(entry => entry.item.id === id);
        if (home) return { home: home.goal, why: `it waits for ${where(home)}` };
      }
      const named = step.waitFor ? first(item => { const other = workJob(item); return other !== undefined && phrasePattern(other)?.test(step.waitFor!) === true; }) : undefined;
      return named ? { home: named.goal, why: `it waits for the job ${workJob(named.item)} of ${where(named)}` } : undefined;
    };
    const moves: FoldMove[] = [];
    const left: PlanItem[] = [];
    const found = new Set<string>();
    for (const step of goal.children.filter(child => OPEN.has(child.status))) {
      const home = homeOf(step);
      if (home) { moves.push({ item: step, home: home.home, why: home.why }); found.add(home.home.id); }
      else left.push(step);
    }
    if (!duty && (!moves.length || left.length)) continue;
    folds.push({ goal, ...(duty ? { duty } : {}), moves, left });
    for (const id of found) homeGoals.add(id);
  }
  return folds;
}
/**
 * The open top-level goals of a chat that has no active duty, in board order; none when the chat has one (duty proposals 10-12: five chats
 * held open goals with no duty and no metric flagged them). The built-in check-in is no duty here.
 */
export function goalsWithoutDuty(board: ChatBoard | null, duties: readonly DutyRef[]): PlanItem[] {
  if (duties.some(duty => duty.status === "active" && duty.id !== CHECK_IN_DUTY_ID)) return [];
  return (board?.plan ?? []).filter(goal => OPEN.has(goal.status));
}
export const noDutyLine = (goals: readonly PlanItem[]): string =>
  `${plural(goals.length, "open goal")} (${goals.map(goal => `${goal.id} ${quote(goal.text)}`).join(", ")}) and no active duty: draft a duty for the chat's ` +
  "standing work (the owner's words, a goal, metrics and a precheck) and ask the owner on For you whether to add it, unless For you already asks";
/** The board ops of a fold, in order: each move, then the goal's close with a note naming where its work lives now. A step in `left` moves first, by the check-in's own op. */
export function foldOps({ goal, duty, moves }: FoldGoal): BoardOp[] {
  const where = duty ? `the duty ${duty.id} "${duty.name}" runs this goal's work` : "its open steps ride other goals' jobs";
  const moved = moves.length ? `; ${moves.map(move => `${move.item.id} moved under ${move.home.id}`).join(", ")}` : "";
  return [...moves.map(move => ({ op: "plan_update" as const, id: move.item.id, parent: move.home.id })),
    { op: "plan_update", id: goal.id, status: "done", note: `Folded (c46): ${where}${moved}.` }];
}
export const foldLine = (fold: FoldGoal): string => {
  const { goal, duty, moves, left } = fold;
  const ops = foldOps(fold).map(op => JSON.stringify(op));
  const close = ops.pop()!;
  return `${goal.id} ${quote(goal.text)}: ${duty ? `the duty ${duty.id} "${duty.name}" runs its work` : "every open step under it rides another goal's job"}. ` +
    (moves.length ? `Move ${moves.map(move => `${move.item.id} under ${move.home.id} (${move.why})`).join(", ")}: ${ops.join(", ")}. ` : "") +
    (left.length ? `${left.map(item => `${item.id} ${quote(item.text)}`).join(", ")} ${left.length > 1 ? "have" : "has"} no home on another goal: move ` +
      `${left.length > 1 ? "each" : "it"} under the goal its work belongs to with plan_update parent, or make it a goal of its own (parent null) after the close. ` : "") +
    `Then close the goal: ${close}`;
};

/** The no-progress check looks back this long. */
export const PROGRESS_MS = 60 * 60_000;
/**
 * No progress (owner 10-12: the check-in needs a code check that in the last hour either a checklist item turned
 * done or every open task is blocked, since work should keep moving). It passes when a plan item turned done
 * in the last PROGRESS_MS (its memo changed then and it is done now), or when every open step is held: blocked, waiting on an open For you todo,
 * waiting on purpose for a waitUntil still ahead, waiting on another thread (its owner, or a thread its waitFor names), or waiting on CI that
 * moves: a run its waitFor names is queued or running in the CI cache (`train`), or the release train it waits on moves (`trainMoves`). A
 * waitUntil that passed is not held. Launch main bro 10-13: from 10:50Z to 13:31Z every step the check-in listed as moving waited on its own
 * verify-dev run while the M1 Air runners slept (10:30Z to 13:35Z), such as p84 on 38378436903 and p75 on 38378422183. A goal moved when, in the last PROGRESS_MS, an open step's note under it gained a fact (`noteFacts`) or a step's job
 * sent the chat a message with a fact (`factsAt`, so an answer to a status ask with no fact is no move); its steps are not counted (launch main bro 10-12: p56's copy and p57's lane reads reported every 30 min with new page
 * and run counts, and three check-ins in a row flagged them). No verdict (null) until the chat's memory spans PROGRESS_MS. `moving` are the open
 * steps that are not held and whose goal did not move. A step whose work waits in the Mac-wide turn queue is held (`queueHolds`), and so is a
 * step whose owner sleeps on a board.wake for a run that is queued or running (`JobFact.wake`), as a waitFor naming that run is. Frontend bro
 * 10-15: the 20:31, 20:46 and 21:02 KST check-ins read no_progress 1 for p145 alone, whose job slept on a wake for verify-dev run 38724412490
 * from 20:01 KST while the run's jobs waited for pool-light and m1-air runners; the step's waitFor named no run.
 * Finished work is progress before anyone closes its step (`finished`): an open item that looks done by a fact of the last PROGRESS_MS (its
 * duty metric met, its PRs merged), or a PR an open item names in its text or note that merged in that hour. Slack green guy 10-15: job email
 * confirm loss merged #258 at 10:57Z and its deploy was READY, p144 stayed doing until the check-in closed it at about 11:58Z, and the 11:18Z
 * check-in read no_progress 1.
 */
export interface NoProgress { moving: StepView[] }
export function noProgress(board: ChatBoard | null, views: readonly StepView[], memos: Readonly<Record<string, StepMemo>>, since: number,
  rows: readonly Pick<SessionRow, "id" | "name" | "archived">[], self: ReadonlySet<string>, now: number, train?: Train,
  queued: ReadonlyMap<string, unknown> = new Map(),
  finished: { done: readonly DoneReason[]; prs: ReadonlyMap<string, PrState> } = { done: [], prs: new Map() }): NoProgress | null {
  if (now - since < PROGRESS_MS) return null;
  const recentMs = (at: number | undefined): boolean => (at ?? 0) >= now - PROGRESS_MS;
  let done = finished.done.some(found => recentMs(found.at));
  walkItems(board?.plan ?? [], item => {
    if (item.status === "done" && recentMs(memos[item.id]?.doneAt)) done = true;
    if (OPEN.has(item.status) && prNumbers(`${item.text}\n${item.note ?? ""}`).some(pr => recentMs(finished.prs.get(pr)?.mergedAt))) done = true;
  });
  if (done) return null;
  const held = (view: StepView): boolean => view.item.status === "blocked" || view.cls === "foryou" || Date.parse(view.item.waitUntil ?? "") > now ||
    (!view.mine && view.owner?.key.startsWith("thread:") === true) || waitTarget(view.item.waitFor, rows, self) !== undefined ||
    [...namedRuns(view.item, train), ...namedRuns({ waitFor: view.owner?.wake ?? "" }, train)].some(run => run.running) ||
    (train !== undefined && trainMoves(view.item, train, now)) || queueHolds(view, queued, rows, self);
  const recent = (at: number | undefined): boolean => (at ?? 0) >= now - PROGRESS_MS;
  const goalOf = (view: StepView): string => view.goal?.id ?? view.item.id;
  const moved = new Set(views.filter(view => recent(memos[view.item.id]?.factsAt) || recent(view.owner?.lastMessage?.factsAt)).map(goalOf));
  const moving = views.filter(view => !held(view) && !moved.has(goalOf(view)));
  return moving.length ? { moving } : null;
}
export const noProgressLine = ({ moving }: NoProgress): string => `No plan item was done in the last hour and ${plural(moving.length, "open step")} ` +
  `${moving.length === 1 ? "is" : "are"} not blocked (${moving.slice(0, 8).map(view => `${view.item.id} ${quote(view.item.text)} ${view.cls}`).join(", ")}` +
  `${moving.length > 8 ? `, and ${moving.length - 8} more` : ""}): move one in this run (finish or close a step on evidence, start or chase its job), ` +
  "or block it with the exact thing that unblocks it; waiting is not progress";

/** A waitUntil that passed this long ago is a stale step (c44: steps still waiting 30 h after a fleet outage ended their slots). */
export const STALE_STEP_MS = 24 * 60 * 60_000;
/**
 * An open plan item whose record is stale (c44): its waitUntil passed more than STALE_STEP_MS ago, or the job its `job` names (a subagent, not a
 * thread) ended more than one check-in interval (`everyMs`) ago and the item has not changed since (`changedAt`, which the precheck takes from
 * `recordedAt`: a note that gained a fact is a change, a restamped clock is not). A waitUntil still ahead is a planned wait, so
 * a job that idles under one is not stale. Nor is a job that ended under a wait on a release path that moves (`movesOnPath`, with `rows`
 * and the release `train`). VP of CI 10-14, p25, p26, p30, p110 and p134 wait for "Fable's 'released'; then promote gates rework pushes ...
 * fresh and lands it", and their job went idle at 20:07Z on purpose while Fable held every runner for the land 34 critical set. A job that
 * ended under its own planned clock still owes the step a record (c44, p51's "promote 7 rerun at 04:50Z, read-back about 05:35Z"). Nor is a
 * job whose next turn waits in the Mac-wide turn queue (`JobFact.queued`): it runs once a slot frees. Any open item counts, a goal or a step
 * with open steps under it too. Board order.
 */
export interface StaleStep { item: PlanItem; why: string }
export function staleSteps(board: ChatBoard | null, facts: readonly JobFact[], changedAt: (item: PlanItem) => number, self: ReadonlySet<string>,
  everyMs: number, now: number, rows: readonly Pick<SessionRow, "id" | "name" | "archived">[] = [], train?: Train): StaleStep[] {
  const stale: StaleStep[] = [];
  walk(board?.plan ?? [], item => {
    if (!OPEN.has(item.status)) return;
    const until = Date.parse(item.waitUntil ?? "");
    if (Number.isFinite(until) && now - until > STALE_STEP_MS) {
      stale.push({ item, why: `its waitUntil ${localTime(until)} passed ${ago(now - until)} ago` });
      return;
    }
    const job = planJob(item.job);
    const owner = job === undefined || self.has(job) ? undefined : facts.find(fact => owns(fact, job));
    if (!owner || owner.key.startsWith("thread:") || owner.state === "working" || owner.activityAt === undefined || until > now || owner.queued) return;
    if (movesOnPath(item, train, rows, self, now)) return;
    const end = owner.activityAt;
    if (end > changedAt(item) && now - end > everyMs) {
      stale.push({ item, why: `job ${owner.name} ${owner.cancelled ? "was cancelled" : owner.state === "failed" ? "failed" : "ended"} ${ago(now - end)} ago and the step has not changed since` });
    }
  });
  return stale;
}
export const staleLine = ({ item, why }: StaleStep): string => `${item.id} ${quote(item.text)} ${item.status}: ${why}; update it or close it in this run`;

/** The whole-word, case-insensitive pattern of a phrase: its words joined by spaces or hyphens, a plural `s` allowed at the end. */
const phrasePattern = (phrase: string): RegExp | null => {
  const words = phrase.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return words ? new RegExp(`(?<![\\p{L}\\p{N}])${words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s-]+")}s?(?![\\p{L}\\p{N}])`, "iu") : null;
};
/** The first topic the text names as whole words, or undefined. */
export function matchTopic(text: string, topics: readonly string[]): string | undefined {
  return topics.find(topic => phrasePattern(topic)?.test(text) === true);
}
/**
 * The names a handoff's `to` goes by: each comma-separated name in it, with and without its parenthesis ("ops guy (+observability)" is also
 * "ops guy"); session ids and `thread:` links are left to `namesTarget`.
 */
const targetNames = (to: string): string[] => {
  const bare = to.replace(/\bthread:\S+|[0-9a-f]{8}-[0-9a-f-]{20,}/gi, " ");
  return [...new Set([...bare.split(","), ...bare.replace(/\([^)]*\)/g, " ").split(",")].map(name => name.replace(/\s+/g, " ").trim()).filter(name => name.length >= 3))];
};
/** Whether a text names a handoff's target: one of its names as whole words, or a session id that `to` holds. */
export function namesTarget(text: string | undefined, to: string): boolean {
  if (!text) return false;
  const ids = to.match(/[0-9a-f]{8}-[0-9a-f-]{20,}/gi) ?? [];
  return ids.some(id => text.includes(id)) || targetNames(to).some(name => phrasePattern(name)?.test(text) === true);
}
/** Whether the chat (its session id and name, `self`) is a handoff's target, so the work is its own: `to` holds its id, or they share a name. */
export function isHandoffTarget(to: string, self: readonly string[]): boolean {
  const names = new Set(targetNames(to).map(name => name.toLowerCase()));
  return self.some(own => own.trim() !== "" && (to.includes(own.trim()) && /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(own.trim()) ||
    targetNames(own).some(name => names.has(name.toLowerCase()))));
}
/** A step that says its work was already handed off ("handed off to ops guy", "handed over"). */
const HANDED_OFF = /\bhanded[\s-]*(?:it\s+|this\s+)?(?:off|over)\b|\bhanded\s+to\b/i;

/**
 * CI work, named as the capital word CI in a step's text or in the text of an item above it. A handoff whose topics do not name CI never
 * takes it: c13 gives CI to the VP of CI, and c36's "health check" (local uptime of the wiki, the frontend app, Convex and the crawler API)
 * flagged its CI health check steps p37, p69 and p70 on every run from 10-10 to 10-12. 95bed8a's `with` words were meant to stop that,
 * but the ledger entry never got them.
 */
const CI_WORK = /\bCI\b/;
/**
 * A topic named only as the place where checks run: "the M1 Air checks pass", "the M1 Air runner", "CI on the M1 Air". slack green's p113
 * ("Owner-approved PRs merge once the M1 Air checks pass, ...") gates merges on the PR checks that run on the Air, and c7 flagged it in 3
 * check-ins in a row (10-13). A step that also names machine work (an install, a restart, a cleanup, memory, disk or a service) keeps it.
 */
const RUNS_ON = "\\b(?:CI|checks?|tests?|probes?|jobs?|runs?|builds?)(?:\\s+(?:pass(?:es)?|runs?|green|queued))?\\s+on\\s+(?:the\\s+)?";
const RUN_BY = "(?:'s)?\\s+(?:CI|PR\\s+checks?|checks?|runners?|probes?|tests?)\\b";
const MACHINE_WORK = /\b(?:install|uninstall|restart|reboot|clean|free|kill|upgrade|disk|memory|swap|service|launchd)/i;
/** A topic that names a machine ("M1 Air", "this Mac"), not a kind of work ("uptime" in "uptime checks" is the work). */
const MACHINE = /\b(?:air|mac)$/i;
const withoutCheckHosts = (text: string, topics: readonly string[]): string => MACHINE_WORK.test(text) ? text : topics.reduce((rest, topic) => {
  const pattern = MACHINE.test(topic) ? phrasePattern(topic)?.source : undefined;
  return pattern ? rest.replace(new RegExp(`${RUNS_ON}${pattern}|${pattern}${RUN_BY}`, "giu"), " ") : rest;
}, text);
/**
 * A one-word resource topic ("swap", "memory", "load", "disk", "CPU") that also has a plain meaning: launch main bro's p93 "Swap the 196
 * renamed Watchlist usernames to their new Instagram usernames" swaps data, and c7's "swap" flagged it in 3 check-ins in a row (10-14). It is
 * machine work only when the step also names a machine (a machine topic of the rule, this Mac, a MacBook) or pairs the word with what it
 * measures ("swap usage", "memory pressure", "load average", "disk space").
 */
const RESOURCE = /^(?:swap|memory|load|disk|cpu)$/i;
const MAC = /\b(?:this|the)\s+Mac\b|\bMacBook|\bMac\s+mini\b/i;
const machineTopics = (text: string, topics: readonly string[]): readonly string[] =>
  MAC.test(text) || matchTopic(text, topics.filter(topic => MACHINE.test(topic))) !== undefined ? topics : topics.filter(topic => !RESOURCE.test(topic.trim()) ||
    new RegExp(`(?<![\\p{L}\\p{N}])${topic.trim()}[\\s-]+(?:usage|use|used|pressure|average|space|files?|memory|full)(?![\\p{L}\\p{N}])`, "iu").test(text));
/**
 * A step that changes code is its chat's own work: its text, note or waitFor names a CI run id, a probe, a land, a migration or a commit, or
 * its text opens with Fix, Build or Ship and names a code target. Crawler VP's p139 "Fix the crawler API health check stalling on slow internal
 * queries" (10-13, waits on CI runs and land 34) fixes the code behind /health, and c36's "health check" flagged it. A hand-off topic still takes
 * such a step when its text is about operating or watching that thing (run, watch, monitor, measure, page, restart, clean up).
 */
const CODE_MARK = /\b\d{9,}\b|\bprobes?\b|\bland(?:s|ed|ing)?\b|\bmigrations?\b|\bcommits?\b|\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/i;
const CODE_FIX = /^\s*(?:fix|build|ship)\b/i;
const CODE_TARGET = /\b(?:handlers?|quer(?:y|ies)|endpoints?|routes?|functions?|code|schema|modules?|workers?)\b/i;
const OPERATES = /\b(?:runs?|running|restart|reboot|(?:un)?install|clean|free|kill|upgrade|reruns?|watch(?:es|ing)?|monitor(?:s|ing)?|measur(?:e|es|ed|ing)|operat(?:e|es|ing)|ping(?:s|ing)?|pag(?:e|es|ing)|on[\s-]call|keep\s+\S+(?:\s+\S+)?\s+up)\b/i;
const codeWork = (item: PlanItem): boolean => !OPERATES.test(item.text) &&
  ((CODE_FIX.test(item.text) && CODE_TARGET.test(item.text)) || CODE_MARK.test(`${item.text}\n${item.note ?? ""}\n${item.waitFor ?? ""}`));
/** An open plan item whose work belongs to another thread by a ledger handoff: the rule, and the topic its text or note names. */
export interface ScopeMiss { item: PlanItem; rule: HandoffRule; topic: string }
/**
 * The open plan items of a chat (session id and name in `self`) that belong to another thread (correction c7, owner 10-09: machine management goes to
 * ops guy and never runs in another chat): the text or note names a handoff topic as whole words. Not in the target chat itself, and not an item
 * that says it was handed off, or whose owner or `waitFor` names the target. An item that matches covers the items under it. Board order.
 */
export function scopeMisses(board: ChatBoard | null, rules: readonly HandoffRule[], self: readonly string[]): ScopeMiss[] {
  const mine = rules.filter(rule => !isHandoffTarget(rule.to, self));
  const misses: ScopeMiss[] = [];
  const visit = (item: PlanItem, underCi: boolean) => {
    const ci = underCi || CI_WORK.test(item.text);
    if (OPEN.has(item.status) && !codeWork(item)) {
      const text = `${item.text}\n${item.note ?? ""}`;
      for (const rule of mine) {
        // Only the step's own text says what the work is; a note names machines as context (VP of CI 10-09: p56 "CI dashboard" flagged for
        // "swap" in its note; a crawler thread 10-10: five crawler builds flagged for "runner-a", the CI runner their land queued on).
        const topic = matchTopic(withoutCheckHosts(item.text, rule.topics), machineTopics(item.text, rule.topics));
        if (topic === undefined) continue;
        if (rule.with?.length && matchTopic(item.text, rule.with) === undefined) continue;
        if (ci && !rule.topics.some(topic => CI_WORK.test(topic.toUpperCase()))) continue;
        if (HANDED_OFF.test(text) || namesTarget(item.waitFor, rule.to) || namesTarget(stepOwner(item), rule.to)) return;
        misses.push({ item, rule, topic });
        return;
      }
    }
    item.children.forEach(child => visit(child, ci));
  };
  (board?.plan ?? []).forEach(goal => visit(goal, false));
  return misses;
}
/** The line for a step that belongs to another thread. */
export const scopeLine = ({ item, rule }: ScopeMiss): string =>
  `${item.id} ${quote(item.text)} belongs to ${rule.to} (correction ${rule.correction}): hand it off with a message to that thread and remove it from this plan`;
/** A wait that stays the same this long is stalled. */
export const STALL_MS = 2 * 60 * 60_000;
/**
 * An open step that sits on a passive wait (c23 reopened, owner 10-09 via stripe and payments: duties should push these): it waits
 * (a waitFor, a waitUntil, or a thread owner), nobody is on it now (not live, not For you), and its wait has stayed the same for STALL_MS, or its
 * waitUntil was pushed later more than once. `why` says which. A waitUntil still ahead and never moved is a planned wait unless the step also
 * waits on a thread or on CI, a land, a release or a pin; `rows` and `self` find a thread its waitFor names (`waitTarget`). A step that waits on a
 * release `train` that moves (`trainMoves`, no thread named) is not stalled, as it is not blocked_on_others (Crawler VP 10-13, p47 "land 34 on
 * staging ..." read "act on it in this run" at 19:38, 20:12 and 20:59 while land 33 and promote 9 ran). The check-in precheck also drops each
 * step `blockedOnOthers` flags: that line names the blocker and the action, and one step gets one finding. A step that someone moves from
 * outside the chat's jobs (`outsideMover`: a board.wake, a turn in pi-pool's queue, a start in the fleet budget) is not stalled either.
 */
export interface StalledStep { view: StepView; why: string }
/**
 * A step whose waitFor names a CI run id and whose note says another thread holds, orders or cancelled that run (api portal vp 10-13, p4:
 * "Fable's land-33 hold keeps runs outside land 33 off CI", "Fable's land-34 order reruns ... this run second"). Its waitUntil moves when that
 * thread's plan moves, so `blockedOnOthers` counts it and `stalledSteps` does not; a step that pushes its own waitUntil with no hold named still stalls.
 */
const RUN_ID = /\b\d{9,}\b/;
const HOLD = /\b(?:hold|holds|held|holding|queued\s+behind|cancell?ed\s+by)\b|(?<!\bin\s)\border\b/i;
const heldRun = (item: PlanItem): boolean => RUN_ID.test(item.waitFor ?? "") && HOLD.test(item.note ?? "");
export function stalledSteps(views: readonly StepView[], memos: Readonly<Record<string, StepMemo>>, rows: readonly Pick<SessionRow, "id" | "name" | "archived">[],
  self: ReadonlySet<string>, now: number, train?: Train, movers: Movers = {}): StalledStep[] {
  return views.flatMap(view => {
    const { item } = view;
    const waits = item.waitFor !== undefined || item.waitUntil !== undefined || view.owner?.key.startsWith("thread:") === true;
    // A wait the CI cache shows over (`greenLater`) is wait_met's to act on, so the step gets one finding.
    if (!waits || view.cls === "live" || view.cls === "foryou" || view.cls === "parked" || heldRun(item) || greenLater(item, train)) return [];
    if (movesOnPath(item, train, rows, self, now) || outsideMover(view, movers, rows, self)) return [];
    const memo = memos[item.id];
    const untils = memo?.untils ?? [];
    const pushes = untils.filter((until, index) => index > 0 && Date.parse(until) > Date.parse(untils[index - 1]!)).length;
    const since = memo?.waitAt ?? view.changedAt;
    if (pushes >= 2) return [{ view, why: `its waitUntil was pushed later ${pushes} times` }];
    // A fixed date still ahead, never moved, is a planned wait, not a stall (10-10, p168: a 2-day audit window), unless the step also waits on
    // someone to chase: a thread owner, or a waitFor naming CI, a land, a release, a pin or a thread. The 2 h rule is for waits with no date,
    // a passed date, and those.
    const chase = view.owner?.key.startsWith("thread:") === true || othersWord(item.waitFor) !== undefined || waitTarget(item.waitFor, rows, self) !== undefined;
    if (!chase && pushes === 0 && Date.parse(item.waitUntil ?? "") > now) return [];
    return now - since > STALL_MS ? [{ view, why: `it has waited on the same thing for ${ago(now - since)}` }] : [];
  });
}
export const stalledLine = ({ view, why }: StalledStep): string => {
  const on = view.item.waitFor !== undefined ? `waits for ${quote(view.item.waitFor)}` : view.item.waitUntil !== undefined ? `waits until ${localTime(Date.parse(view.item.waitUntil))}`
    : `waits on ${view.owner ? ownerLabel(view.owner) : "its owner"}`;
  return `${view.item.id} ${quote(view.item.text)} ${on} and ${why}: act on it in this run`;
};

/** A step blocked on others this long with no live job needs a fix job (W56). */
export const BLOCKED_MS = 60 * 60_000;
/** Words in a step's waitFor or note that name a blocker outside the chat: CI, a land, promote or release, a pin, or another thread. */
const OTHERS = /\b(?:ci|github actions|land(?:\.yml)?|promote(?:\.yml)?|release(?: queue| train| owner)?|pin(?:ned)?|threads?)\b/i;
/** The OTHERS word in a waitFor or note, read with its paths and dated folder names left out; undefined when there is none. */
const othersWord = (text: string | undefined): string | undefined =>
  text ? OTHERS.exec(text.split(/\s+/).filter(token => !pathLike(token)).join(" "))?.[0] : undefined;
/**
 * An open step blocked on CI, the release queue or another thread with nobody fixing it (W56, owner 10-10: when CI or the like blocks
 * a step, work out how to fix it and get involved): it waits (a waitFor, or blocked), its waitFor or note names such a blocker or
 * its waitFor names another thread, it has not changed for BLOCKED_MS, and no job of it is working (an owner thread whose heartbeats keep it
 * live works, `liveThreads`). The step's own owner thread is never its blocker; a CI run id its waitFor names is named as the blocker. A step an open For you todo covers
 * waits on the owner, not on others (AI harness 10-12: p288 on t41 and p277 on t42 read as blocked on a release and on SEO guy). A step parked on
 * schedule or on a release train that moves (`parkedWait`) is not blocked yet, and neither is a step whose owner or blocker thread sleeps on a
 * board.wake the service still owes (`asleep`; launch main bro 10-14: "release driver thread is idle" on p53 and p75 while the release driver
 * waited on its 14:40Z wake). `on` names the blocker.
 */
export interface BlockedStep { view: StepView; on: string }
/** How long past its planned end a parked-on-schedule wait may sit before it counts as blocked (owner's brief 10-13 for frontend bro p100). */
export const PLANNED_END_GRACE_MS = 30 * 60_000;
const CLOCK_Z = /\b([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?Z\b/g;
/**
 * A clock a note names as an end: "until about 00:15Z", "03:15Z at the latest", or an ETA, "ETA 23:30Z to 00:30Z" or "ETA ~22:00Z", whose
 * later clock counts.
 */
const END_CLOCK = /\buntil\s+(?:about\s+|around\s+|roughly\s+)?(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?Z\b|\b(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?Z\b\s+at\s+the\s+latest\b|\bETA\b[^.\d]{0,24}(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?Z\b(?:\s*(?:to|-)\s*~?\s*(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?Z\b)?/gi;
/** Each HH:MMZ in `text` as the instant nearest `at` (within 12 h either side). */
const clocksNear = (text: string, at: number): number[] => [...text.matchAll(CLOCK_Z)].map(([, hours, minutes]) => {
  const day = new Date(at);
  const same = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), Number(hours), Number(minutes));
  return [same - 86_400_000, same, same + 86_400_000].reduce((best, time) => Math.abs(time - at) < Math.abs(best - at) ? time : best);
});
/**
 * When a step's wait is planned to end (frontend bro 10-13, p100: "Fable's land-33 hold until about 00:15Z, then reruns of r12 and r13"): the
 * latest HH:MMZ its waitFor names, or an "until HH:MMZ", "HH:MMZ at the latest" or "ETA HH:MMZ to HH:MMZ" (frontend bro 10-13, p86 and p101:
 * "After Fable's 'released' (ETA 23:30Z to 00:30Z)") in its note, read near the step's last change; else its waitUntil. A note's other clock
 * times are when it was written or something was seen ("At 23:00Z, 7 of 10 jobs ... were green"), not an end. Undefined when the step names no
 * end.
 */
export function plannedEnd(item: PlanItem, changedAt: number): number | undefined {
  const ends = [...(item.note ?? "").matchAll(END_CLOCK)].flatMap(([end]) => clocksNear(end, changedAt));
  const named = [...clocksNear(item.waitFor ?? "", changedAt), ...ends];
  if (named.length) return Math.max(...named);
  const until = Date.parse(item.waitUntil ?? "");
  return Number.isFinite(until) ? until : undefined;
}
/**
 * How long the release path may show no run in progress and none ending before a step that waits on it counts as blocked (`trainMoves`):
 * the longest gap between two runs of one land in the CI cache, land 33's cancelled run 38333450774 (ended 10-13 02:10:04Z) to its next run
 * 38344244507 (03:58:53Z), 1 h 49 min, rounded up.
 */
export const TRAIN_IDLE_MS = 110 * 60_000;
const LAND_REF = /\bland[\s-]+(\d+[a-z]?)\b/gi;
const RUN_IDS = /\b\d{9,}\b/g;
const FAILED = new Set(["failure", "timed_out", "startup_failure"]);
/**
 * What a wait names on the release path: a CI run id, a ci/ ref, a probe, a land or promote by number, the go push, or the release owner's hold
 * or release word ("Hold11", "land 34's hold B", "the land-34 critical loop", "the critical set", "Fable's 'released'", "Fable's release of the
 * land 34 loop"). Crawler VP 10-14, p18: "PROBE B r14 green and in land 35 (p82), then the native host checks, a new R0 manifest and a lane
 * window" names a probe and a land with no run yet.
 */
const RELEASE_PATH = new RegExp([/\b\d{9,}\b/, /\bci\/[\w.-]/, /\bprobes?\b/, /\b(?:land|promote)[\s-]+\d+[a-z]?\b/, /\bgo\s+push\b/, /\bhold\s*\d*\b/,
  /\bloop\b/, /\bcritical\s+(?:set|famil(?:y|ies))\b/, /['"\u2018\u2019\u201c\u201d]released['"\u2018\u2019\u201c\u201d]/,
  /\brelease\s+of\s+the\b[^.;]{0,40}?\b(?:loop|hold|critical\s+set)\b/].map(part => part.source).join("|"), "i");
/** Whether a step's waitFor (its note when it has none) names the release path (`RELEASE_PATH`). */
const onReleasePath = (item: Pick<PlanItem, "waitFor" | "note">): boolean => RELEASE_PATH.test(item.waitFor ?? item.note ?? "");
/**
 * Whether a release-path run the step names failed: the newest run of a land (or of promote) its waitFor or note names (by "land 33" or by a
 * land run id), or a run its waitFor names that the CI cache has, while none of the runs it names is queued or running.
 */
function namedRunFailed(item: PlanItem, train: Train): boolean {
  const text = `${item.waitFor ?? ""} ${item.note ?? ""}`;
  const keys = new Set([...[...text.matchAll(LAND_REF)].map(([, land]) => land!.toLowerCase()),
    ...[...text.matchAll(RUN_IDS)].flatMap(([id]) => train.runs.filter(run => run.id === id).map(run => run.key))]);
  for (const key of keys) {
    const newest = train.runs.filter(run => run.key === key).reduce<TrainRun | undefined>((best, run) => !best || run.createdAt > best.createdAt ? run : best, undefined);
    if (newest && !newest.running && FAILED.has(newest.conclusion ?? "")) return true;
  }
  const runs = namedRuns(item, train);
  return runs.length > 0 && !runs.some(run => run.running) && runs.some(run => FAILED.has(run.conclusion ?? ""));
}
/**
 * Whether a step waits on a release path that moves. One rule since 10-14, in place of eight special cases from 10-13 and 10-14 (a land wait
 * rode only land and promote runs, a hold wait also the critical set's ci/ runs, a 'released' wait had no land number, and so on): the step's
 * waitFor (its note when it has none) names the release path (`onReleasePath`), no run it names failed (`namedRunFailed`), and a release run
 * is in progress or ended within TRAIN_IDLE_MS. A release run is a land or promote run, a run on a land branch (`parseTrain`), or a run on any
 * ci/ branch, where the release owner's loop runs the next land's critical set as verify-dev probes and cancels every other run that wants a
 * runner. A running land or promote run counts as moving when the cache last read it; a ci/ run counts by its own update time and only when
 * it was not cancelled, so a run the cache still lists as queued from hours before does not keep a stalled path moving. A move after `now`
 * (a cache read later than the check-in, as in a replay) is no move yet.
 *
 * Crawler VP 10-14, p18 waits for "PROBE B r14 green and in land 35 (p82), ...": land 35 had no run, the last land or promote run had ended
 * at 10:16:45Z, and the check-ins at 22:21Z, 22:36Z and 22:51Z flagged it blocked_on_others while the land-34 critical loop's ci/ runs went
 * green (ci/queue-cuts-t10 at 21:54Z, ci/census-nullroot-20261013-r6 at 21:44Z). A note that only mentions a land (VP of CI's p120: "checks
 * moved into checks.yml in land 33") does not put a waitFor on the path.
 */
export function trainMoves(item: PlanItem, train: Train, now: number): boolean {
  if (!onReleasePath(item) || namedRunFailed(item, train)) return false;
  const probes = [...train.all?.values() ?? []].filter(run => run.ref?.startsWith("ci/") && run.conclusion !== "cancelled");
  const moves = [...train.runs.map(run => run.running ? train.readAt : run.updatedAt), ...probes.map(run => run.updatedAt)];
  return moves.some(at => at <= now && now - at <= TRAIN_IDLE_MS);
}
/**
 * Whether a step's wait is parked, so it is not blocked_on_others: its `plannedEnd` plus PLANNED_END_GRACE_MS is still ahead, or it names no thread and waits on a release path that moves (`movesOnPath`).
 */
export function parkedWait(item: PlanItem, changedAt: number, now: number, train: Train | undefined,
  rows: readonly Pick<SessionRow, "id" | "name" | "archived">[], self: ReadonlySet<string>): boolean {
  return now <= (plannedEnd(item, changedAt) ?? -Infinity) + PLANNED_END_GRACE_MS || movesOnPath(item, train, rows, self, now);
}
/** Whether a step that names no thread waits on a release path that moves (`trainMoves`): not blocked_on_others, stalled or stale. */
export const movesOnPath = (item: PlanItem, train: Train | undefined, rows: readonly Pick<SessionRow, "id" | "name" | "archived">[], self: ReadonlySet<string>,
  now: number): boolean => train !== undefined && waitTarget(item.waitFor, rows, self) === undefined && trainMoves(item, train, now);
/** A run id after these words names an older run a newer one replaced ("run 38414020573 (sup 38408618643)"), not the wait. */
const REPLACED_RUN = /\b(?:sup|supersedes|superseded|replaces|replaced)\s+(?:run\s+)?\d{9,}\b/gi;
/** The runs a step's waitFor names that the CI cache knows (`Train.all`), in the order it names them. */
export function namedRuns(item: Pick<PlanItem, "waitFor">, train: Train | undefined): CiRun[] {
  const text = (item.waitFor ?? "").replace(REPLACED_RUN, " ");
  return [...text.matchAll(RUN_IDS)].flatMap(([id]) => { const run = train?.all?.get(id!); return run ? [run] : []; });
}
/**
 * The cancelled run a step waits on, when no run its waitFor names is queued or running. A cancelled run never turns green, so nothing outside
 * the chat moves the step: it must rerun the run, push fresh and name the new run, or wait on the hold that cancelled it.
 */
export function deadRun(item: Pick<PlanItem, "waitFor">, train: Train | undefined): CiRun | undefined {
  const runs = namedRuns(item, train);
  return runs.some(run => run.running) ? undefined : runs.find(run => run.conclusion === "cancelled");
}
/**
 * Whether the Mac-wide turn queue holds a step's work (`pi-pool queue --json`): its owner's turn waits for a working slot, the chat's own turn
 * does for a step the chat owns, or the turn of the thread its waitFor names does. That work starts once a slot frees, as a turn the pool holds
 * until its account slot does (`poolHolds` in chat-recovery.ts), so the step is neither blocked_on_others, a stale step nor no progress.
 */
export function queueHolds(view: Pick<StepView, "item" | "owner" | "mine">, queued: ReadonlyMap<string, unknown>,
  rows: readonly Pick<SessionRow, "id" | "name" | "archived">[], self: ReadonlySet<string>): boolean {
  if (view.owner?.queued !== undefined || (view.mine && [...self].some(id => queued.has(id)))) return true;
  const target = queued.size ? waitTarget(view.item.waitFor, rows, self) : undefined;
  return target !== undefined && queued.has(target.id);
}
export function blockedOnOthers(views: readonly StepView[], rows: readonly Pick<SessionRow, "id" | "name" | "archived">[], self: ReadonlySet<string>, now: number,
  train?: Train, queued: ReadonlyMap<string, unknown> = new Map(), asleep: ReadonlySet<string> = new Set()): BlockedStep[] {
  return views.flatMap(view => {
    const { item, owner } = view;
    if ((item.waitFor === undefined && item.status !== "blocked") || owner?.state === "working" || view.cls === "parked" || view.cls === "foryou" ||
      now - view.changedAt <= BLOCKED_MS || parkedWait(item, view.changedAt, now, train, rows, self) || queueHolds(view, queued, rows, self)) return [];
    // The step's own owner thread is never its blocker (Crawler VP 10-13, p147 read "blocked on the meta ads thread", its owner); a thread its
    // waitFor names is.
    const thread = waitTarget(item.waitFor, rows, self);
    // A blocker thread asleep on a board.wake the service still owes (`asleep`, session ids) is on it until the wake is due, as an owner is.
    if (thread && asleep.has(thread.id)) return [];
    // A step on a cancelled run waits on nobody (api portal vp 10-13, p9, p12 and p14 read "blocked on CI run ..." at 23:07 KST for runs Fable's
    // land-34 loop cancelled at 13:55Z); `deadRunWaits` flags it.
    if (!thread && deadRun(item, train)) return [];
    const run = RUN_ID.exec(item.waitFor ?? "")?.[0];
    const word = othersWord(item.waitFor) ?? othersWord(item.note) ?? (heldRun(item) ? "a CI run another thread holds" : undefined);
    const on = thread ? `the ${clip(thread.name, 40)} thread` : word && run ? `CI run ${run}${heldRun(item) ? ", which another thread holds" : ""}` : word;
    return on ? [{ view, on }] : [];
  });
}
export const blockedLine = ({ view, on }: BlockedStep, now: number): string => {
  const { item, owner } = view;
  const job = owner ? `${ownerLabel(owner)} is ${ownerState(owner)}` : "no job works on it";
  return `${item.id} ${quote(item.text)} is blocked on ${on} for ${ago(now - view.changedAt)} and ${job}: find out why and start a job that fixes the ` +
    "blocker, or send the blocker's owner a concrete patch";
};

/**
 * The two hard gates as the check-in sees them (W50): `go_waiting` a go-needed step that has not started and has no owner go (`todo` the open
 * todo that asks for it, if any); `go_missing` a go-needed step at work (doing, or its job working) with no owner go; `requirements_missing` a
 * goal with a Build step doing whose requirements check fails (`reason`); `merges_without_go` a merge or default-branch push step done with no
 * owner go that names its PR or push (c49), a repo rule breach. The board refuses these moves for the agent; an older board, a go flag set on a step already at work, or an owner
 * answer that later took the go back can still hold them. The board is the record: no GitHub call.
 */
export type GateFinding =
  | { kind: "go_waiting"; item: PlanItem; todo?: OwnerTodo }
  | { kind: "go_missing"; item: PlanItem }
  | { kind: "requirements_missing"; item: PlanItem; step: PlanItem; reason: string }
  | { kind: "merges_without_go"; item: PlanItem };
export function gateFindings(board: ChatBoard | null, facts: readonly JobFact[], active?: ReadonlySet<string>): GateFinding[] {
  if (!board) return [];
  const found: GateFinding[] = [];
  const failing = new Set<string>();
  const visit = (items: readonly PlanItem[], above: PlanItem[]) => {
    for (const item of items) {
      if (item.status === "done" && mergeStep(item.text) && needsGo(item) && !stepGo(board, item)) found.push({ kind: "merges_without_go", item });
      if (needsGo(item) && OPEN.has(item.status) && !stepGo(board, item)) {
        if (item.status === "doing" || ownerOf(item, facts)?.state === "working") found.push({ kind: "go_missing", item });
        else if (parkedBy(item, active) === undefined) {
          const todo = board.todos.find(entry => !entry.done && coversStep(entry, item));
          found.push({ kind: "go_waiting", item, ...(todo ? { todo } : {}) });
        }
      }
      if (item.status === "doing" && isBuildStep(item)) {
        const goal = buildGoal(item, above);
        const reason = requirementGaps(goal);
        if (reason && !failing.has(goal.id)) { failing.add(goal.id); found.push({ kind: "requirements_missing", item: goal, step: item, reason }); }
      }
      visit(item.children, [...above, item]);
    }
  };
  visit(board.plan, []);
  return found;
}
export function gateLine(gate: GateFinding): string {
  const head = `${gate.item.id} ${quote(gate.item.text)}`;
  switch (gate.kind) {
    case "go_waiting": return gate.todo ? `${head} needs the owner's go and waits for the answer on ${gate.todo.id}` :
      `${head} needs the owner's go and For you has no question for it: add one todo with step "${gate.item.id}" and choices, the go first`;
    case "go_missing": return `${head} is at work without the owner's go: stop its job and ask the owner in For you with step "${gate.item.id}"`;
    case "requirements_missing": return `${head} has Build step ${gate.step.id} doing and ${gate.reason}: have the plan or design job ` +
      "quote each line of the owner's request and check it against the design";
    case "merges_without_go": {
      const prs = mergedPrs(gate.item.text).map(pr => `PR #${pr}`).join(" and ") || "the merge or push";
      return `${head} is done, and the board shows no owner go that names ${prs}: a repo rule breach. Tell the owner in this run, and add one ` +
        `For you todo with step "${gate.item.id}" naming ${prs}, choices like "Yes, keep it" and "No, revert it"`;
    }
  }
}

/**
 * The open goals nobody works on (correction c11, Crawler VP 10-09: split work into subagents and jobs actively): a goal none of whose open steps
 * is live (no job at work on it, no thread moving it, the chat not on it) and at least one of whose open steps is an orphan (no live owner, no
 * For you todo, no wait) that does not look done (that one needs a check and a close, not a job). A goal with a live job, or with only waiting
 * and For you steps, is not idle. Board order, with its orphan steps.
 */
export function idleGoals(steps: readonly StepView[], done: ReadonlySet<string> = new Set()): { goal: { id: string; text: string }; steps: StepView[] }[] {
  const goals = new Map<string, { goal: { id: string; text: string }; views: StepView[] }>();
  for (const view of steps) {
    const goal = view.goal ?? { id: view.item.id, text: view.item.text };
    const entry = goals.get(goal.id) ?? { goal, views: [] };
    entry.views.push(view);
    goals.set(goal.id, entry);
  }
  const unowned = (view: StepView) => view.cls === "orphan" && !done.has(view.item.id);
  return [...goals.values()].filter(({ views }) => !views.some(view => view.cls === "live") && views.some(unowned))
    .map(({ goal, views }) => ({ goal, steps: views.filter(unowned) }));
}
/** The finding for an idle goal: its open steps with no owner, and the ask to start jobs. */
export const idleGoalLine = ({ goal, steps }: ReturnType<typeof idleGoals>[number]): string =>
  `${goal.id} ${quote(goal.text)} has no live job and ${plural(steps.length, "open step")} nobody owns (${steps.map(view => view.item.id).join(" ")}): ` +
  "start jobs for its independent work now, in parallel";
