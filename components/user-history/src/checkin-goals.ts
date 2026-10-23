import type { MetricFact } from "./checkin-done.ts";
import { keyNamesGoal } from "./goal-readings.ts";
import { heldByTodo, type HoldingTodo, LINKED_TODO, stepCarrier, stepCarriers } from "./checkin-end-state.ts";
import { GOAL_PUSH_LINK, openGoals, targetOp, targetStaleMs, walkGoal } from "./shared/chat-board.ts";
import { CHECK_IN_DUTY_ID } from "./shared/chat-duties.ts";
import { parseDutyLink } from "./shared/duty-fixes.ts";
import type { ChatBoard, OwnerTodo, PlanItem } from "./shared/types.ts";
import { type JobFact, ownerLabel, poolWait, quote, type StepView, walk } from "./checkin-steps.ts";
import { poolSlot } from "./shared/chat-feed.ts";

/**
 * The check-in's first job: push each open goal's number to its target (owner 10-15 on Crawler VP p71, Instagram Tier A indexed 14.9 of 100%
 * while the check-in reported only stuck steps: "are you pushing through on this? is it working?", then "Check in 이 일을 쭉쭉 밀어줘야되는데
 * it's deeply flawed. fix this"). Per open goal: its number (the goal's `target`, or the duty metric the goal links), its trend since the
 * check-ins before (`GoalMemo`), its pace, and the live job that owns the number. Code measures; the check-in job steers or starts the owner.
 */

export { GOAL_PUSH_LINK };
/**
 * A goal reaches its target within this at its measured rate, or it is off pace. On 10-15 Crawler VP p71 rose from 10.17% at 06:42Z to 14.9%
 * at 19:35Z, about 10 days to 100% at that rate, and the owner asked whether it was working at all.
 */
export const PACE_MS = 7 * 24 * 60 * 60_000;
/** The readings a goal's memo keeps, oldest first. */
export const GOAL_READINGS = 6;

/** One measurement of a goal's number: its value and when it was measured (ms). */
export interface GoalReading { value: number; at: number;
  /** The metric, unit and direction the value was read in (`readingBasis`); absent on readings kept before 10-19. */
  basis?: string;
  /** The reading's source names a backfill (`GoalNumber.backfill`). */
  backfill?: true }
/** What the check-in keeps per goal across runs: its distinct readings, oldest first, and how many runs in a row the number did not move toward target. */
export interface GoalMemo { readings: GoalReading[]; still: number;
  /** When the check-in last steered or started the goal's owner, and the newest reading's time then (`quietPush`). */
  pushed?: { at: number; reading: number; value?: number; act?: GoalAct } }

/** A goal's number: from its `target`, in its direction (`targetOp`), or from the last run of the duty metric the goal links. */
export interface GoalNumber { metric: string; target: number; unit: string; op: ">=" | "<="; value?: number; measuredAt?: number; source: string; staleMs: number;
  /** The target's cadence: a daily number moves once a day, so its pace counts whole days (`goalTrend`). */
  cadence?: "daily";
  /** The source names a backfill, so the move into this reading is a one-time step, not a rate (`goalTrend`). */
  backfill?: true }

export type GoalTrend =
  | { kind: "unmeasured" }
  | { kind: "met" }
  | { kind: "first" }
  | { kind: "still"; runs: number }
  | { kind: "moving"; delta: number; since: number; etaMs: number | null }
  /** Every move since `since` came in a backfill, so there is no rate yet. */
  | { kind: "stepped"; delta: number; since: number };

/**
 * What the check-in does about a goal: steer its owner job, start one, nothing (on pace or met), wait on the owner's answer, wait for a time or
 * the owner's pause of the thread that owns it, or give it a number first.
 */
export type GoalAct = "steer" | "start" | "on_pace" | "owner" | "waiting" | "no_number";

export interface GoalPush {
  goal: PlanItem;
  number?: GoalNumber;
  trend?: GoalTrend;
  stale: boolean;
  /** The live job that owns the number: its push step's job, else a live job on an open item under the goal (`goalOwner`). */
  owner?: JobFact;
  /** The goal's open push step, live or not: a start sets a job on it instead of adding a second one. */
  pushStep?: string;
  /**
   * The job a start steers first, with its step: the push step's own job, else the job of the goal's open fix step (a step with a duty link),
   * else the job of any open step under the goal. chat-057a's check-ins on 10-18 added push steps p50, p58, p64 and p67 under p1 while its fix
   * step p60 (linked to checkin/goal_gaps) had the job "metal agent runtime". `duty` is that step's duty field.
   */
  stepJob?: { step: string; job: string; duty?: string };
  /** The items that wait on the owner's answer in For you (`ownerHeld`): the goal or its push step, or every open step under it. */
  asks?: string[];
  /** What a goal that waits holds on (`goalWait`): "until 10-18 20:00Z", or the owner's pause of the thread that owns its push step. */
  waits?: string;
  /** A goal at target: the open items under it (`openUnder`), which keep it open. */
  left?: string[];
  /** A push already sent with no new reading since: when, and when the next one is due (`quietPush`). The goal still counts in goal_gaps. */
  quiet?: { pushedAt: number; nextAt: number };
  act: GoalAct;
  /** The owner's words for the goal: its open and unmet requirement lines. */
  words: string[];
}

/** The number of a goal: its target, else the newest measured run of the duty metric the goal links; undefined for neither. */
export function goalNumber(goal: PlanItem, everyMs: number, metrics: ReadonlyMap<string, MetricFact>): GoalNumber | undefined {
  const target = goal.target;
  if (target) {
    const at = Date.parse(target.measuredAt ?? "");
    const op = targetOp(target);
    // A duty metric that the goal or a step under it fixes, with the goal's target and direction, read after the target's own reading, is the
    // newer measure of the same number: on 10-18 the AI harness chat's check-in read p453 "duties green" at 25.7% from 10-16 06:27Z while the
    // newest measure said 29.7%.
    // Only one such metric can be that number: VP of CI p1 "m1-air job start wait p90" (at most 10 min) has p258 on d1/push_to_verdict_p90_min
    // and p275 on d1/run_time_p90_min under it, both at most 10 min, and the 17:11Z check-in on 10-18 read p1 at push to verdict's 221.5.
    // A goal whose own duty field names a metric reads only that one, as in `goalReadingOps`: VP of CI p1 names d1/air_work_start_wait_p90_min.
    // Any other metric must share a word with the goal's metric or unit (`keyNamesGoal`): Crawler VP p146 (API routes, 100%) is not geonode_mbps.
    const own = goal.duty === GOAL_PUSH_LINK ? undefined : goal.duty;
    const same = new Set<string>();
    let newer: { key: string; fact: MetricFact & { value: number } } | undefined;
    // A goal with a target under this one owns its own steps' metrics (`walkGoal`).
    walkGoal(goal, item => {
      if (!item.duty || item.duty === GOAL_PUSH_LINK || (own && item.duty !== own)) return;
      const fact = metrics.get(item.duty);
      if (fact?.value === undefined || fact.target !== target.target || (fact.op ?? ">=") !== op || (!own && !keyNamesGoal(item.duty, target))) return;
      same.add(item.duty);
      if ((Number.isFinite(at) && fact.at <= at) || (newer && newer.fact.at >= fact.at)) return;
      newer = { key: item.duty, fact: fact as MetricFact & { value: number } };
    });
    if (newer && same.size === 1) return { metric: target.metric, target: target.target, unit: target.unit, op, value: newer.fact.value, measuredAt: newer.fact.at,
      source: `the last run of duty metric ${newer.key}`, staleMs: targetStaleMs(target, everyMs) };
    return { metric: target.metric, target: target.target, unit: target.unit, op, ...(target.current !== undefined ? { value: target.current } : {}),
      ...(Number.isFinite(at) ? { measuredAt: at } : {}), source: target.source ?? "the goal's target", staleMs: targetStaleMs(target, everyMs),
      ...(target.cadence ? { cadence: target.cadence } : {}), ...(/backfill/i.test(target.source ?? "") ? { backfill: true as const } : {}) };
  }
  // A goal with no target reads only the duty metric it links itself: slack green guy p151 is a top-level fix step of
  // d1/signup_to_workspace_pct. A step's link under it is that step's fix, not the goal's number: frontend bro p62 read 0 of at most 0 on
  // d1/ssr_timeouts_24h from p143, a done step under its dropped p142, and check-ins on 10-20 told the chat to close p62 while p52 and p31
  // waited on the owner's word on 5180.
  const fact = goal.duty && goal.duty !== GOAL_PUSH_LINK ? metrics.get(goal.duty) : undefined;
  if (fact?.value === undefined || fact.target === undefined) return undefined;
  return { metric: goal.duty!, target: fact.target, unit: "", op: fact.op ?? ">=", value: fact.value, measuredAt: fact.at, source: `the last run of duty metric ${goal.duty}`,
    staleMs: 24 * 60 * 60_000 };
}

/**
 * The open items under a goal, its push steps left out: a goal at target stays open while one is left, so the check-in does not ask to close it.
 * frontend bro 10-20: p208 (5 of 5 pages) and p272 (4 of 4 parts) met their targets while p286 and p297 waited on the owner's check on For you
 * t39 and t40, his answer being their done condition, and every check-in asked the chat to close both.
 */
export function openUnder(goal: PlanItem): PlanItem[] {
  const open: PlanItem[] = [];
  const down = (item: PlanItem): void => {
    for (const child of item.children) {
      if (OPEN_ITEM.has(child.status) && child.duty !== GOAL_PUSH_LINK) open.push(child);
      down(child);
    }
  };
  down(goal);
  return open;
}
const OPEN_ITEM: ReadonlySet<PlanItem["status"]> = new Set(["todo", "doing", "blocked"]);

/** What a reading's value is in: its metric, unit and direction. A new target in the same unit keeps readings comparable. */
export const readingBasis = (number: Pick<GoalNumber, "metric" | "unit" | "op">): string => `${number.metric}|${number.unit}|${number.op}`;
/**
 * The memo's readings that compare with a new one: those read in the same basis, and an older reading with no basis only when its value is
 * within 10 times the scale of the target and the new value. VP of CI p289 "codebase shrinks by 70%" kept raw line counts (1,429,605 at 10-19
 * 11:25Z) from before its target moved to percent, and goal_gaps read 3.2 of 70% as "-1,429,601.8 points since 10-19 11:25Z".
 */
export function comparable(readings: readonly GoalReading[], number: GoalNumber, value: number): GoalReading[] {
  const basis = readingBasis(number);
  const scale = 10 * Math.max(Math.abs(number.target), Math.abs(value), 1);
  const kept = readings.filter(reading => reading.basis !== undefined ? reading.basis === basis : Math.abs(reading.value - value) <= scale);
  // A basis change drops what came before it, so a kept reading is never older than one the change dropped.
  const dropped = readings.findLastIndex(reading => !kept.includes(reading));
  return kept.filter(reading => readings.indexOf(reading) > dropped);
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * The trend of a number against the goal's memo, and the memo to keep. The rate leaves out each move into the first reading whose source names a
 * backfill: spec and monitoring system's p12 (days of the last 7 with test and CI numbers, cadence daily) read 1 at 15:15Z and 3 at 16:19Z on
 * 10-19 after a one-time backfill of 10-16, and the check-ins on 10-20 read "about 2 h to target at this rate" for a number that gains at most
 * one a day. A daily number's time to target is whole days, at least one. A pair of readings less than a day apart is still a rate: on 10-20
 * Crawler VP's p680 (Meta advertisers, cadence daily) read 1,826,417 at 03:21Z and 1,960,477 at 10:37Z, and 13 open daily goals moved within a day.
 */
export function goalTrend(number: GoalNumber, memo: GoalMemo | undefined): { trend: GoalTrend; memo: GoalMemo | undefined } {
  if (number.value === undefined || number.measuredAt === undefined) return { trend: { kind: "unmeasured" }, memo };
  const sign = number.op === "<=" ? -1 : 1;
  const reading: GoalReading = { value: number.value, at: number.measuredAt, basis: readingBasis(number), ...(number.backfill ? { backfill: true } : {}) };
  const kept = comparable(memo?.readings ?? [], number, number.value);
  if (memo && kept.length !== memo.readings.length) memo = kept.length ? { readings: kept, still: 0 } : undefined;
  const last = memo?.readings.at(-1);
  const moved = last !== undefined && (reading.value - last.value) * sign > 0;
  // The same reading as last run is no new measure, so it keeps the trend it had: vent p1 (cadence daily) read 6% at 16:15Z, up from 3%, and
  // the 16:40Z check-in on 10-18 counted that same 16:15Z reading as "no move toward target in the last check-in".
  const same = last !== undefined && last.at === reading.at && last.value === reading.value;
  const readings = !last || !same ? [...memo?.readings ?? [], reading].slice(-GOAL_READINGS) : [...memo!.readings.slice(0, -1), { ...last, ...reading }];
  const still = !last ? 0 : same ? memo!.still : moved ? 0 : memo!.still + 1;
  const next = { readings, still };
  if ((reading.value - number.target) * sign >= 0) return { trend: { kind: "met" }, memo: next };
  if (!last) return { trend: { kind: "first" }, memo: next };
  if (still > 0) return { trend: { kind: "still", runs: still }, memo: next };
  const first = readings[0]!;
  const delta = reading.value - first.value;
  const rated = readings.slice(1).map((to, index) => ({ from: readings[index]!, to })).filter(({ from, to }) => !to.backfill || from.backfill);
  if (!rated.length) return { trend: { kind: "stepped", delta, since: first.at }, memo: next };
  const gained = rated.reduce((sum, { from, to }) => sum + (to.value - from.value) * sign, 0);
  const span = rated.reduce((sum, { from, to }) => sum + to.at - from.at, 0);
  const rawMs = gained > 0 && span > 0 ? (number.target - reading.value) * sign / (gained / span) : null;
  const etaMs = rawMs !== null && number.cadence === "daily" ? Math.max(1, Math.ceil(rawMs / DAY_MS)) * DAY_MS : rawMs;
  return { trend: { kind: "moving", delta, since: first.at, etaMs }, memo: next };
}

/**
 * Whether a goal's number is off pace: a goal is on pace only when it is measured, fresh, moved toward its target at its last new reading, and
 * reaches it within PACE_MS at its rate. Unmeasured, stale, new to the memo, still at its last new reading, or moving away are off pace.
 */
export const offPace = (trend: GoalTrend, stale: boolean): boolean =>
  trend.kind === "met" ? false : stale || trend.kind !== "moving" || trend.etaMs === null || trend.etaMs > PACE_MS;

/**
 * The live job that owns a goal's number, with the check-in's liveness (`JobFact.state`, a job asleep on a board.wake included), first found of:
 * the job of the goal's push step (`GOAL_PUSH_LINK`), the job of the goal itself when it is a leaf (slack green guy p151), a live job on a step
 * under it linked to the goal's own duty metric, a live job on another of its own steps, and a live job on any open step under a goal below it.
 * AI harness 10-20 02:19Z: p717 (d7/quiet_agent_gb) read "no live job owns it" while p779's thread worked on that same metric under it, and the
 * check-in told the chat to steer p769's job, asleep on another metric. An off-pace goal with such an owner is steered through it (`pushNeeded`).
 */
export function goalOwner(goal: PlanItem, views: readonly StepView[]): JobFact | undefined {
  const under = new Set([goal.id]);
  walk(goal.children, item => under.add(item.id));
  const live = views.filter(view => under.has(view.item.id) && view.owner?.state === "working");
  const own = goal.duty === GOAL_PUSH_LINK ? undefined : goal.duty;
  return (live.find(view => view.goal?.id === goal.id && view.item.duty === GOAL_PUSH_LINK) ?? live.find(view => view.item.id === goal.id) ??
    live.find(view => own !== undefined && view.item.duty === own) ?? live.find(view => view.goal?.id === goal.id) ?? live[0])?.owner;
}

/**
 * The items that hold a goal on the owner's answer, or undefined. The goal is held when its own wait or its push step is held by an open For you
 * todo (`heldByTodo`), whatever its other steps do: AI harness p453 "duties green" waited on t51 through its push step p530 from 10-17 23:10Z,
 * while p523 and p528 under it were live, and goal_gaps flagged it 27 times in a row. It is also held when every open step under it besides its
 * push step is For you or parked by his correction, with at least one For you. frontend bro 10-16 to 10-18: p106 "Connections parts the owner
 * accepts" 0 of 5 and p118 "Email parts the owner accepts" 0 of 3 waited on For you t28 and t25, with every part built and walked on Staging,
 * and goal_gaps counted both in 14 check-ins in a row, each one steering the push jobs again. A goal whose open steps are all parked by his
 * correction is held the same way: frontend bro p62 kept no number on purpose, because with one its c40-parked p52 and p31 read as no live job.
 */
export function ownerHeld(goal: PlanItem, views: readonly StepView[], todos: Parameters<typeof heldByTodo>[1] = []): string[] | undefined {
  const named = new Set(goal.waitFor?.match(/\bt\d+\b/g) ?? []);
  if (todos.some(todo => todo.from === "agent" && !todo.done && (todo.step === goal.id || (todo.id !== undefined && named.has(todo.id))))) return [goal.id];
  const push = views.find(view => view.goal?.id === goal.id && view.item.duty === GOAL_PUSH_LINK);
  if (push && heldByTodo(push.item, todos)) return [push.item.id];
  const open = views.filter(view => view.goal?.id === goal.id && view.item.duty !== GOAL_PUSH_LINK);
  const held = open.filter(view => view.cls === "foryou" || view.cls === "parked");
  return held.length && held.length === open.length ? held.map(view => view.cls === "parked" ? `${view.item.id} (parked by ${view.parked})` : view.item.id) : undefined;
}

/**
 * The For you todos of other chats that this board's waits name: a wait with a chat's session id and then a todo id, like "chat-057a's For you
 * (01a14210-4e7d-72c3-aa67-e3d476f4e728 t6)". mac-management 10-19: p5 "Token usage reaches LGTM" waited on chat-057a's t6, the owner's choice on
 * a one-time update window, and goal_gaps flagged it in every check-in, because `ownerHeld` read only the chat's own todos.
 */
export function linkedTodoRefs(plan: readonly PlanItem[]): { chat: string; id: string }[] {
  const refs = new Map<string, { chat: string; id: string }>();
  walk(plan, item => {
    for (const match of (item.waitFor ?? "").matchAll(LINKED_TODO)) refs.set(`${match[1]} ${match[2]}`, { chat: match[1]!, id: match[2]! });
  });
  return [...refs.values()];
}

/**
 * The board with the open agent todos of other chats that its waits name (`linkedTodoRefs`), so a wait on one holds its goal like a todo of
 * its own. Each one keeps only its id and its chat (`HoldingTodo`): its text and step name the other chat's plan items, and its id another
 * chat's numbering, which would hold this chat's items and waits of the same id.
 */
export function withLinkedTodos(board: ChatBoard, linked: readonly { chat: string; todo: OwnerTodo }[]): ChatBoard {
  const open = linked.filter(({ todo }) => todo.from === "agent" && !todo.done)
    .map(({ chat, todo }): OwnerTodo & HoldingTodo => ({ id: todo.id, text: `For you ${todo.id} of chat ${chat}`, done: false, from: "agent", at: todo.at, chat }));
  return open.length ? { ...board, todos: [...board.todos, ...open] } : board;
}

/** Whether a thread's chat is paused by the owner: the thread is in `paused`, by the `thread:` key of its owner or by the step's session id. */
export const threadPaused = (owner: Pick<JobFact, "key"> | undefined, item: Pick<PlanItem, "sessionId">, paused: ReadonlySet<string>): boolean =>
  (owner?.key.startsWith("thread:") === true && paused.has(owner.key.slice("thread:".length))) || (item.sessionId !== undefined && paused.has(item.sessionId));

/**
 * The wait of a goal whose job waits for an account slot still ahead, or undefined. The resume pass gives that job its turn at the slot
 * (PoolHeldJobs), and a steer or restart before then starts a turn the pool refuses again. Past the slot the goal is pushed as before. From 00:45Z to 05:16Z on 10-22, 4 of 40 check-in goal steers went to sessions
 * waiting for a slot: VP of CI at 04:20Z (slot 05:14Z), the AI harness chat at 04:35Z (05:28Z), metal-management at 04:41Z (05:38Z) and the
 * metal box owner at 04:04Z (05:30Z).
 */
export function slotWait(owner: JobFact | undefined, now: number): string | undefined {
  if (!owner || !poolWait(owner)) return undefined;
  const slot = poolSlot(owner.error ?? "");
  return slot !== null && slot > now ? `on ${ownerLabel(owner)}, which waits for its account slot until ${zTime(slot)}` : undefined;
}

/**
 * What a goal waits on, so no job can push its number now, or undefined: a waitUntil still ahead on the goal or its push step, or the owner's
 * pause of the thread that owns its push step (`paused`, the chats whose check-in he paused). The owner's focus pause at 23:03Z on 10-17 stopped
 * every chat but frontend bro, and the check-ins went on asking for jobs on goals whose owners he had stopped.
 */
export function goalWait(goal: PlanItem, push: StepView | undefined, now: number, paused: ReadonlySet<string> = new Set(), views: readonly StepView[] = [],
  board: ChatBoard | null = null): string | undefined {
  for (const item of [goal, push?.item]) {
    const until = Date.parse(item?.waitUntil ?? "");
    if (Number.isFinite(until) && until > now) return `until ${zTime(until)}`;
  }
  if (push && threadPaused(push.owner, push.item, paused)) return `on the owner's pause of ${push.owner?.name ?? push.item.sessionId}`;
  // A goal whose open steps besides its push step all move, live or carried, with at least one waiting on another step that live jobs carry,
  // moves when that step's work lands: AI harness p453 on 10-18 had p566 blocked on p565 (five live jobs) and its other steps live, and the
  // 12:26 KST check-in started a push job on p563 and p566.
  const carriers = stepCarriers(board, views);
  const others = views.filter(view => view.goal?.id === goal.id && view.item.id !== goal.id && view.item.id !== push?.item.id);
  const carried = others.map(view => stepCarrier(view.item, carriers));
  if (others.length && carried.some(Boolean) && others.every((view, index) => carried[index] || view.owner?.state === "working" || view.cls === "foryou" || view.cls === "parked")) {
    const first = carried.find(Boolean)!;
    return `on ${first.id}, which ${first.owners.length === 1 ? `${first.owners[0]!.name} carries` : `${first.owners.length} live jobs carry`}`;
  }
  if (!push) {
    // A goal with no push step whose every open step waits on its owner's board.wake or a time still ahead moves when that wait ends; a job
    // to push it now would wake the sleeper early (clean room 10-18 02:49Z: "disk free check" slept until 03:01Z for its second reading, and
    // goal_gaps read p1 "no live job owns it", so the check-in steered the job 12 min early).
    const open = views.filter(view => view.goal?.id === goal.id && view.item.id !== goal.id);
    const asleep = (view: StepView): string | undefined => view.owner?.wake !== undefined ? `on ${view.owner.name}'s ${view.owner.wake.replace(/^a /, "")}`
      : Date.parse(view.item.waitUntil ?? "") > now ? `until ${zTime(Date.parse(view.item.waitUntil!))}` : undefined;
    const waits = open.map(asleep);
    if (open.length && waits.every(Boolean) && open.some(view => view.owner?.wake !== undefined)) return [...new Set(waits)].join(" and ");
  }
  return undefined;
}

/** The owner's words for a goal: its requirement lines still open or unmet, else the goal's own text. */
export const goalWords = (goal: PlanItem): string[] => {
  const open = (goal.requirements ?? []).filter(line => line.status !== "met").map(line => line.text.trim());
  return open.length ? open : [goal.text];
};

/** A metric of time held, like "hours metal held 70 to 80% CPU" or "days in a row with no failed run": only the clock moves it. */
const HELD_UNIT_MS: Record<string, number> = { minute: 60_000, minutes: 60_000, min: 60_000, hour: 3_600_000, hours: 3_600_000, h: 3_600_000, day: 86_400_000, days: 86_400_000 };
export function heldTimeMs(number: Pick<GoalNumber, "metric" | "unit" | "op">): number | undefined {
  const unit = HELD_UNIT_MS[number.unit.trim().toLowerCase()];
  return unit !== undefined && number.op === ">=" && /\b(?:held|hold|holds|in a row|straight|streak|without|with no|uptime|stayed|stays|clean)\b/i.test(number.metric) ? unit : undefined;
}
/** The goal memos with each push made at `at` set back to the push before it: a check-in that did not start sent none. */
export function unpushed(memos: Readonly<Record<string, GoalMemo>> | undefined, before: Readonly<Record<string, GoalMemo>> | undefined, at: number): Record<string, GoalMemo> {
  return Object.fromEntries(Object.entries(memos ?? {}).map(([id, memo]) => {
    if (memo.pushed?.at !== at) return [id, memo];
    const { pushed: _, ...rest } = memo;
    const prior = before?.[id]?.pushed;
    return [id, prior ? { ...rest, pushed: prior } : rest];
  }));
}
/**
 * A push the check-in already sent is an empty steer the next run until there is news. From 10-19 21:00Z to 10-20 21:00Z the check-ins sent 437
 * repeats to goals that did not move, 43 of them to 01a15427 p22 "hours metal held 70 to 80% CPU", which only the clock can move.
 * News is one of these:
 * - a new reading worse than the pushed value, a regression, which gets one push, and the pushed value then follows it; a move toward the
 *   target is the job at work, and a backfill or an unchanged value is no news. From 10-22 00:45Z to 10-23 00:45Z, 27 of the 68 repeats on goals
 *   that did not move came from a value that changed either way, such as VP of CI p1 "push to verdict p90" swinging between 249 and 298 min;
 * - a change of act, such as the owner job ending, so a steer becomes a start;
 * - for a held-time metric, one unit of time, since only the clock moves it.
 * With no news the next push waits a day, the cadence of the daily goals. Crawler VP p892 "Instagram queues growing over 6 h" (2 queues, last
 * read 10-21 14:32Z) and p670 "LinkedIn index gaps" (6 of 7, last read 14:23Z) got a steer every hour from 15:00Z to 00:18Z, each time their
 * hour-long stale time ran out with no new reading.
 */
export function quietPush(memo: GoalMemo | undefined, number: GoalNumber, now: number, act?: GoalAct): { pushedAt: number; nextAt: number } | undefined {
  const pushed = memo?.pushed;
  if (!pushed) return undefined;
  if (act && pushed.act && act !== pushed.act) return undefined;
  const newest = Math.max(...(memo!.readings.map(reading => reading.at)), number.measuredAt ?? 0);
  const worse = number.value !== undefined && (pushed.value === undefined || (number.value - pushed.value) * (number.op === "<=" ? 1 : -1) > 0);
  if (newest > pushed.reading && worse && !number.backfill) return undefined;
  const nextAt = pushed.at + (heldTimeMs(number) ?? Math.max(number.staleMs, DAY_MS));
  return now < nextAt ? { pushedAt: pushed.at, nextAt } : undefined;
}

/**
 * Each open goal's push for this run (`openGoals`: a goal with a target under an area goal gets its own), and the memos to keep. Goals the
 * check-in folds into a duty (`folded`) are left out, because the duty carries their number. Order: goals to start a job for, then to steer,
 * then without a number, then on pace; the largest gap first in each. Crawler VP 10-19: its 13 open goals each carried a live number, and the
 * extra_goals ask to fold them under area goals would have dropped each folded goal's number, trend, pace and owner job.
 */
export function goalPushes(board: ChatBoard | null, views: readonly StepView[], memos: Readonly<Record<string, GoalMemo>> | undefined,
  everyMs: number, now: number, metrics: ReadonlyMap<string, MetricFact> = new Map(),
  folded: ReadonlySet<string> = new Set(), paused: ReadonlySet<string> = new Set()): { pushes: GoalPush[]; memos: Record<string, GoalMemo> } {
  const todos: readonly OwnerTodo[] = board?.todos ?? [];
  const kept: Record<string, GoalMemo> = {};
  const pushes = openGoals(board?.plan ?? []).flatMap((goal): GoalPush[] => {
    if (folded.has(goal.id)) return [];
    const words = goalWords(goal);
    const owner = goalOwner(goal, views);
    const pushView = views.find(view => view.goal?.id === goal.id && view.item.duty === GOAL_PUSH_LINK);
    const step = pushView?.item.id;
    const under = views.filter(view => view.goal?.id === goal.id && view.item.id !== goal.id && view.item.job);
    const holder = (pushView?.item.job ? pushView : undefined) ?? under.find(view => view.item.duty !== undefined) ?? under[0];
    const stepJob = holder?.item.job ? { step: holder.item.id, job: holder.owner?.name ?? holder.item.job, ...holder.item.duty ? { duty: holder.item.duty } : {} } : undefined;
    const base = { goal, words, ...(owner ? { owner } : {}), ...(step ? { pushStep: step } : {}), ...(stepJob ? { stepJob } : {}) };
    const number = goalNumber(goal, everyMs, metrics);
    const held = ownerHeld(goal, views, todos);
    // A goal with no number that waits on the owner's word needs his answer, not a target (frontend bro p62, its p52 and p31 parked by c40).
    if (!number) return [{ ...base, stale: false, ...(held ? { asks: held, act: "owner" } : { act: "no_number" }) }];
    const { trend, memo } = goalTrend(number, memos?.[goal.id]);
    if (memo) kept[goal.id] = memo;
    const stale = number.measuredAt === undefined || now - number.measuredAt > number.staleMs;
    const left = trend.kind === "met" ? openUnder(goal).map(item => item.id) : [];
    const asks = trend.kind !== "met" || left.length ? held : undefined;
    const waits = trend.kind === "met" || asks ? undefined : goalWait(goal, pushView, now, paused, views, board) ?? slotWait(owner ?? holder?.owner, now);
    const act: GoalAct = trend.kind === "met" ? "on_pace" : asks ? "owner" : waits ? "waiting" : !owner ? "start" : offPace(trend, stale) ? "steer" : "on_pace";
    // goalTrend's memo is a new object, so the push time carries over from the saved one.
    const before = memos?.[goal.id]?.pushed;
    const quiet = pushNeeded({ act } as GoalPush) && memo ? quietPush({ ...memo, ...before ? { pushed: before } : {} }, number, now, act) : undefined;
    if (memo && quiet && before) memo.pushed = before;
    else if (memo && pushNeeded({ act } as GoalPush)) memo.pushed = { at: now, reading: Math.max(...memo.readings.map(reading => reading.at), number.measuredAt ?? 0),
      ...number.value === undefined ? {} : { value: number.value }, act };
    return [{ ...base, number, trend, stale: trend.kind !== "met" && stale, ...(asks ? { asks } : {}), ...(waits ? { waits } : {}), ...(left.length ? { left } : {}),
      ...(quiet ? { quiet } : {}), act }];
  });
  const rank: Record<GoalAct, number> = { start: 0, steer: 1, no_number: 2, owner: 3, waiting: 4, on_pace: 5 };
  const short = (push: GoalPush): number => !push.number || push.number.value === undefined ? 1
    : Math.max(0, (push.number.target - push.number.value) * (push.number.op === "<=" ? -1 : 1) / Math.abs(push.number.target || 1));
  return { pushes: pushes.sort((a, b) => rank[a.act] - rank[b.act] || short(b) - short(a)), memos: kept };
}

/** Whether the check-in steers or starts a goal's owner job this run: its number is off pace or no live job owns it. */
export const pushNeeded = (push: GoalPush): boolean => push.act === "start" || push.act === "steer";

/**
 * Whether a goal counts in the check-in's headline, `goal_gaps`: no live job works on it or on any open item under it (`goalOwner`), so the
 * check-in has to start or restart one. An off-pace goal with a live job is still steered (`pushNeeded`) and counted in `goals_off_pace`, but
 * it is no gap: a goal is plan work that finishes, and its pace is its own number on the board. On 10-20 at 00:29Z the Chat system duty (d9)
 * read 11 of 12 check-ins red, for up to 75 runs in a row, on goals such as Crawler VP p828 (200M creators, about 48 days to target at its
 * rate), which no job can bring within 7 days, and on goals whose working job held a step under them but not their push step.
 */
export const goalGap = (push: GoalPush): boolean => push.act === "start";

const amount = (value: number): string => value.toLocaleString("en-US", { maximumFractionDigits: 2 });
const unitText = (unit: string): string => !unit ? "" : unit === "%" ? "%" : ` ${unit}`;
/** "10-15 19:35Z". */
export const zTime = (at: number): string => new Date(at).toISOString().slice(5, 16).replace("T", " ") + "Z";
const span = (ms: number): string => ms >= 48 * 60 * 60_000 ? `about ${Math.round(ms / (24 * 60 * 60_000))} days` : `about ${Math.max(1, Math.round(ms / (60 * 60_000)))} h`;

/** "Instagram Tier A indexed 14.9 of 100%", "d3/new_unbacked_limits 738, target at most 0", or "... has target 100% and no measurement yet". */
export function numberText(number: GoalNumber): string {
  const unit = unitText(number.unit);
  if (number.value === undefined) return `${number.metric} has target ${amount(number.target)}${unit} and no measurement yet`;
  return number.op === "<=" ? `${number.metric} ${amount(number.value)}${unit}, target at most ${amount(number.target)}${unit}`
    : `${number.metric} ${amount(number.value)} of ${amount(number.target)}${unit}`;
}
/** The trend in words: "+4.73 points since 10-15 06:42Z, about 10 days to target at this rate". */
export function trendText(number: GoalNumber, trend: GoalTrend, stale: boolean): string {
  const old = stale && number.measuredAt !== undefined ? `, and its last measurement is from ${zTime(number.measuredAt)}` : "";
  const unit = number.unit === "%" ? " points" : unitText(number.unit);
  switch (trend.kind) {
    case "unmeasured": return "not measured yet";
    case "met": return "at target";
    case "first": return `first reading, no trend yet${old}`;
    case "still": return `no move toward target in the last ${trend.runs === 1 ? "check-in" : `${trend.runs} check-ins`}${old}`;
    case "moving": {
      const delta = `${trend.delta >= 0 ? "+" : ""}${amount(trend.delta)}${unit} since ${zTime(trend.since)}`;
      const day = trend.etaMs !== null && number.cadence === "daily" && number.measuredAt !== undefined ? `, about ${zTime(number.measuredAt + trend.etaMs).slice(0, 5)}` : "";
      return `${delta}, ${trend.etaMs === null ? "moving away from target" : `${span(trend.etaMs)} to target at this rate${day}`}${old}`;
    }
    case "stepped": return `${trend.delta >= 0 ? "+" : ""}${amount(trend.delta)}${unit} since ${zTime(trend.since)} in a backfill, no rate yet${old}`;
  }
}

/** The steps a goal held by the owner waits on: "p115", or "p115 and 1 more step". */
const ownerAsks = (push: GoalPush): string => {
  const [first, ...rest] = push.asks ?? [];
  return `${first}${rest.length ? ` and ${rest.length} more ${rest.length === 1 ? "step" : "steps"}` : ""}`;
};

/** The ask for a goal's push, in one sentence. */
function askText(push: GoalPush): string {
  const { goal, owner } = push;
  if (push.act === "start" && push.stepJob) return `no live job owns it, and ${push.stepJob.job} holds ${push.stepJob.step}: steer that job with the gap first, and add a step only for work no open step owns`;
  if (push.act === "start") return push.pushStep ? `its push step ${push.pushStep} has no live job: set one job on it that names and attacks the biggest blocker`
    : `no live job owns it: add a push step under ${goal.id} for one job that names and attacks the biggest blocker`;
  if (push.act === "steer") return `${ownerLabel(owner!)} owns it and it is off pace: steer it to name and attack the biggest blocker now`;
  if (push.act === "no_number") return "it has no target and no linked duty metric: set a target from the owner's words in this run";
  if (push.act === "owner") return `it moves on the owner's word on ${ownerAsks(push)}`;
  if (push.act === "waiting") return `it waits ${push.waits}`;
  return `${owner ? ownerLabel(owner) : "its owner"} moves it on pace`;
}

/** A goal's line for the brief and the chat: number, trend, owner and ask, one sentence of at most about 240 characters (`plainItem`). */
export function goalLine(push: GoalPush): string {
  if (!push.number) return `${push.goal.id} ${quote(push.goal.text)}: ${askText(push)}`;
  return `${push.goal.id} ${numberText(push.number)}, ${trendText(push.number, push.trend!, push.stale)}; ${askText(push)}`;
}

/** The message to steer a goal's owner, or the opening of a new owner job's brief: the owner's words, the measured gap and the ask. */
export function goalSteer(push: GoalPush): string {
  const words = push.words.map(line => `> ${line}`).join("\n");
  const gap = push.number ? `${numberText(push.number)}, ${trendText(push.number, push.trend!, push.stale)}.` : "";
  return `Owner's words for ${push.goal.id} ${quote(push.goal.text)} (verbatim):\n\n${words}\n\n${gap} Name the biggest blocker on this number and attack it now. ` +
    "Measure the number again when you have moved it, write it in the goal's target, and report it to the chat.";
}

/** The goals' headline line: how many open goals are off pace or have no live owner, and how many have no number. */
export function goalsHeadline(pushes: readonly GoalPush[]): string {
  const numbered = pushes.filter(push => push.number);
  const behind = pushes.filter(pushNeeded).length;
  const quiet = pushes.filter(push => push.quiet).length;
  const none = pushes.length - numbered.length;
  return `Goals: ${behind} of ${pushes.length} open goals are off pace or have no live owner` +
    `${none ? `, and ${none} ${none === 1 ? "has" : "have"} no number` : ""}${quiet ? `; ${quiet} of them ${quiet === 1 ? "was" : "were"} pushed already and wait for news` : ""}.`;
}

/** The detail file's Goals section: each goal's line, then for each one to steer or start, its steer message. */
export function goalsDetail(pushes: readonly GoalPush[]): string {
  if (!pushes.length) return "";
  const parts = pushes.map(push => {
    // A quiet push shows its due line in place of the steer: on 10-21 this section still carried p22's full steer while the due line said to
    // send nothing.
    if (push.quiet) return `- ${goalLine(push)}\n\n  ${goalDueLine(push)}`;
    const steer = pushNeeded(push) ? `\n\n${goalSteer(push).split("\n").map(line => line ? `  ${line}` : "").join("\n")}` : "";
    return `- ${goalLine(push)}${steer}`;
  });
  return `### Goals, the check-in's first job (steer or start one owner job per goal; the message for each is under it)\n${parts.join("\n")}`;
}

/** How far a number is from its target in words: "85.1 points short", "26 Mbps short", "738 over"; "" when unmeasured or met. */
export function gapText(number: GoalNumber): string {
  if (number.value === undefined) return "";
  const gap = number.op === "<=" ? number.value - number.target : number.target - number.value;
  if (gap <= 0) return "";
  const unit = number.unit === "%" ? " points" : unitText(number.unit);
  return `${amount(gap)}${unit} ${number.op === "<=" ? "over" : "short"}`;
}

/** Days to target in words: "about 10 days to target at this rate", "no rate yet", or "moving away from target". */
const paceText = (push: GoalPush): string => {
  const trend = push.trend;
  if (!trend || trend.kind === "unmeasured") return "not measured yet";
  if (trend.kind === "met") return !push.left?.length ? "at target"
    : `at target, and it stays open for ${push.left[0]}${push.left.length > 1 ? ` and ${push.left.length - 1} more` : ""}${push.asks ? `, which ${push.left.length > 1 ? "wait" : "waits"} on the owner's word` : ""}`;
  const pace = push.act === "owner" ? `waits on the owner's word on ${ownerAsks(push)}` : push.act === "waiting" ? `waits ${push.waits}`
    : pushNeeded(push) ? "off pace" : "on pace";
  return `${trendText(push.number!, trend, push.stale)}, ${pace}`;
};

/** A goal as the check-in prompt shows it, one plain sentence: its title, number, gap, trend, days to target, pace, and who owns it. */
export function goalPromptLine(push: GoalPush): string {
  const title = `${quote(push.goal.text)} (${push.goal.id})`;
  if (!push.number) return `${title} has no number yet: no target and no duty metric${push.act === "owner" ? `, and it waits on the owner's word on ${ownerAsks(push)}` : ""}.`;
  const gap = gapText(push.number);
  const owner = push.owner ? `${ownerLabel(push.owner)} owns it` : "no live job owns it";
  return `${title}: ${numberText(push.number)}${gap ? `, ${gap}` : ""}; ${paceText(push)}; ${owner}.`;
}

/**
 * Whether a step's duty field links it to a standing duty's metric, which reads it as that metric's fix (`liveFix`, `dutyFixes`). The check-in
 * never moves such a step to the goal's push link: between 16:19Z and 18:19Z on 10-19 a check-in set CI and RepoOps' p258 from
 * d1/push_to_verdict_p90_min to "checkin/goal_gaps", and the CI system duty read off target with no linked step in every d9 run after it.
 */
const dutyFixLink = (duty: string | undefined): boolean => { const link = duty ? parseDutyLink(duty) : null; return !!link && link.duty !== CHECK_IN_DUTY_ID; };

/** The action a goal needs this run, with the message to send or brief to open with; null for a goal on pace. */
export function goalDueLine(push: GoalPush): string | null {
  const title = quote(push.goal.text);
  if (push.act === "no_number") return `Give ${title} a target from the owner's words, with plan_update target.`;
  if (!pushNeeded(push)) return null;
  if (push.quiet) return `${title} was pushed at ${zTime(push.quiet.pushedAt)} and has no new reading since, so send nothing about it this run; ` +
    `its next push is due at a new reading or at ${zTime(push.quiet.nextAt)}.`;
  // A start steers the job that already holds the goal's work before it adds anything: a new step only for an output no open step owns.
  const held = push.stepJob;
  const ask = push.act === "steer" ? `Steer ${ownerLabel(push.owner!)} on ${title} with this message, and add no step`
    : held && held.step !== push.pushStep && dutyFixLink(held.duty) ? `Steer the job ${held.job} on ${held.step} of ${title} with this message, restarting it if it ended. ` +
      `Keep ${held.step} linked to "${held.duty}", the fix its duty reads, and add a push step under ${push.goal.id} with duty "${GOAL_PUSH_LINK}", the job ${held.job} and a Done when line`
    : held ? `Steer the job ${held.job} on ${held.step}${held.step === push.pushStep ? `, the push step of ${title}` : ` of ${title}`} with this message, ` +
      `restarting it if it ended${held.step === push.pushStep ? "" : `, and set the duty of ${held.step} to "${GOAL_PUSH_LINK}"`}. Add no new step: add one only when the ` +
      "work needs an output that no open step owns"
    : push.pushStep ? `Set one job on the push step ${push.pushStep} of ${title}, a live job of the goal or a new one, and send it this message`
    : `Add a push step under ${push.goal.id} with duty "${GOAL_PUSH_LINK}" for ${title}, set its job to a live job of the goal or a new one, and send it this message`;
  // From 10-18 17:00Z to 10-19 17:00Z check-ins pushed 31 goals 451 times and 7 of them moved: VP of CI p1 was steered 85 times and Vent p1 76
  // times with the same message while the number stood still. A goal still after a steer gets its blocker acted on, not the same steer again.
  const stuck = push.trend?.kind === "still" && push.trend.runs >= 2 && (push.owner || push.stepJob)
    ? `\n\nThe number did not move in the last ${push.trend.runs} check-ins, so this message alone has not moved it. Read the job's last report ` +
      "first. When it names a blocker, act on that blocker in this run: start a job on it, or add the For you todo when only the owner can move it. " +
      "Send the job only what is new, and tell the chat in one line what holds the number." : "";
  return `${ask}:\n\n${goalSteer(push).split("\n").map(line => line ? `   ${line}` : "").join("\n")}${stuck}`;
}
