import type { MetricFact } from "./checkin-done.ts";
import { keyNamesGoal } from "./goal-readings.ts";
import { heldByTodo, stepCarrier, stepCarriers } from "./checkin-end-state.ts";
import { GOAL_PUSH_LINK, openGoals, targetOp, targetStaleMs, walkGoal } from "./shared/chat-board.ts";
import type { ChatBoard, OwnerTodo, PlanItem } from "./shared/types.ts";
import { type JobFact, ownerLabel, quote, type StepView, walk } from "./checkin-steps.ts";

/**
 * The check-in's first job: push each open goal's number to its target (owner 10-15 on Crawler VP p71, Instagram Tier A indexed 14.9 of 100%
 * while the check-in reported only stuck steps: "are you pushing through on this? is it working?", then "Check in 이 일을 쭉쭉 밀어줘야되는데
 * it's deeply flawed. fix this"). Per open goal: its number (the goal's `target`, or a duty metric a step under it fixes), its trend since the
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
  basis?: string }
/** What the check-in keeps per goal across runs: its distinct readings, oldest first, and how many runs in a row the number did not move toward target. */
export interface GoalMemo { readings: GoalReading[]; still: number }

/** A goal's number: from its `target`, in its direction (`targetOp`), or from the last run of a duty metric a step under it fixes. */
export interface GoalNumber { metric: string; target: number; unit: string; op: ">=" | "<="; value?: number; measuredAt?: number; source: string; staleMs: number }

export type GoalTrend =
  | { kind: "unmeasured" }
  | { kind: "met" }
  | { kind: "first" }
  | { kind: "still"; runs: number }
  | { kind: "moving"; delta: number; since: number; etaMs: number | null };

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
  /** The live job that owns the number: its push step's job (`goalOwner`). */
  owner?: JobFact;
  /** The goal's open push step, live or not: a start sets a job on it instead of adding a second one. */
  pushStep?: string;
  /**
   * The job a start steers first, with its step: the push step's own job, else the job of the goal's open fix step (a step with a duty link),
   * else the job of any open step under the goal. chat-057a's check-ins on 10-18 added push steps p50, p58, p64 and p67 under p1 while its fix
   * step p60 (linked to checkin/goal_gaps) had the job "metal agent runtime".
   */
  stepJob?: { step: string; job: string };
  /** The items that wait on the owner's answer in For you (`ownerHeld`): the goal or its push step, or every open step under it. */
  asks?: string[];
  /** What a goal that waits holds on (`goalWait`): "until 10-18 20:00Z", or the owner's pause of the thread that owns its push step. */
  waits?: string;
  act: GoalAct;
  /** The owner's words for the goal: its open and unmet requirement lines. */
  words: string[];
}

/** The number of a goal: its target, else the newest measured run of a duty metric it or a step under it fixes; undefined for neither. */
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
      ...(Number.isFinite(at) ? { measuredAt: at } : {}), source: target.source ?? "the goal's target", staleMs: targetStaleMs(target, everyMs) };
  }
  let found: GoalNumber | undefined;
  // The goal itself first: slack green guy p151 is a top-level fix step of d1/signup_to_workspace_pct and read as having no number on 10-16.
  walkGoal(goal, item => {
    if (found || !item.duty || item.duty === GOAL_PUSH_LINK) return;
    const fact = metrics.get(item.duty);
    if (fact?.value === undefined || fact.target === undefined) return;
    found = { metric: item.duty, target: fact.target, unit: "", op: fact.op ?? ">=", value: fact.value, measuredAt: fact.at, source: `the last run of duty metric ${item.duty}`,
      staleMs: 24 * 60 * 60_000 };
  });
  return found;
}

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

/** The trend of a number against the goal's memo, and the memo to keep. */
export function goalTrend(number: GoalNumber, memo: GoalMemo | undefined): { trend: GoalTrend; memo: GoalMemo | undefined } {
  if (number.value === undefined || number.measuredAt === undefined) return { trend: { kind: "unmeasured" }, memo };
  const sign = number.op === "<=" ? -1 : 1;
  const reading = { value: number.value, at: number.measuredAt, basis: readingBasis(number) };
  const kept = comparable(memo?.readings ?? [], number, number.value);
  if (memo && kept.length !== memo.readings.length) memo = kept.length ? { readings: kept, still: 0 } : undefined;
  const last = memo?.readings.at(-1);
  const moved = last !== undefined && (reading.value - last.value) * sign > 0;
  // The same reading as last run is no new measure, so it keeps the trend it had: vent p1 (cadence daily) read 6% at 16:15Z, up from 3%, and
  // the 16:40Z check-in on 10-18 counted that same 16:15Z reading as "no move toward target in the last check-in".
  const same = last !== undefined && last.at === reading.at && last.value === reading.value;
  const readings = !last || !same ? [...memo?.readings ?? [], reading].slice(-GOAL_READINGS) : memo!.readings;
  const still = !last ? 0 : same ? memo!.still : moved ? 0 : memo!.still + 1;
  const next = { readings, still };
  if ((reading.value - number.target) * sign >= 0) return { trend: { kind: "met" }, memo: next };
  if (!last) return { trend: { kind: "first" }, memo: next };
  if (still > 0) return { trend: { kind: "still", runs: still }, memo: next };
  const first = readings[0]!;
  const gained = (reading.value - first.value) * sign;
  const span = reading.at - first.at;
  const etaMs = gained > 0 && span > 0 ? (number.target - reading.value) * sign / (gained / span) : null;
  return { trend: { kind: "moving", delta: reading.value - first.value, since: first.at, etaMs }, memo: next };
}

/**
 * Whether a goal's number is off pace: a goal is on pace only when it is measured, fresh, moved toward its target at its last new reading, and
 * reaches it within PACE_MS at its rate. Unmeasured, stale, new to the memo, still at its last new reading, or moving away are off pace.
 */
export const offPace = (trend: GoalTrend, stale: boolean): boolean =>
  trend.kind === "met" ? false : stale || trend.kind !== "moving" || trend.etaMs === null || trend.etaMs > PACE_MS;

/**
 * The live job that owns a goal's number, with the check-in's liveness (`JobFact.state`, a job asleep on a board.wake included): the job of
 * the goal's push step (`GOAL_PUSH_LINK`), which is also the fix step of `goal_gaps`, so the duty runner sees the goal owned, or the job of a
 * goal that is itself a duty fix step with no steps under it (slack green guy p151). A job at work on
 * some other step under the goal does not own the number: on 10-15 Crawler VP's crawler ops train slept on 17 CI runs for p71's steps while
 * p71 sat at 14.9% and no job worked on its biggest blocker.
 */
export function goalOwner(goal: PlanItem, views: readonly StepView[]): JobFact | undefined {
  return views.find(view => view.goal?.id === goal.id && view.item.duty === GOAL_PUSH_LINK && view.owner?.state === "working")?.owner ??
    views.find(view => view.item.id === goal.id && view.item.duty !== undefined && view.owner?.state === "working")?.owner;
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
    for (const match of (item.waitFor ?? "").matchAll(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+(t\d+)\b/g)) refs.set(`${match[1]} ${match[2]}`, { chat: match[1]!, id: match[2]! });
  });
  return [...refs.values()];
}

/**
 * The board with the open agent todos of other chats that its waits name (`linkedTodoRefs`), so a wait on one holds its goal like a todo of
 * its own. Each one keeps only its id: its text and step name the other chat's plan items, which would hold this chat's items of the same id.
 */
export function withLinkedTodos(board: ChatBoard, linked: readonly { chat: string; todo: OwnerTodo }[]): ChatBoard {
  const open = linked.filter(({ todo }) => todo.from === "agent" && !todo.done)
    .map(({ chat, todo }): OwnerTodo => ({ id: todo.id, text: `For you ${todo.id} of chat ${chat}`, done: false, from: "agent", at: todo.at }));
  return open.length ? { ...board, todos: [...board.todos, ...open] } : board;
}

/** Whether a thread's chat is paused by the owner: the thread is in `paused`, by the `thread:` key of its owner or by the step's session id. */
export const threadPaused = (owner: Pick<JobFact, "key"> | undefined, item: Pick<PlanItem, "sessionId">, paused: ReadonlySet<string>): boolean =>
  (owner?.key.startsWith("thread:") === true && paused.has(owner.key.slice("thread:".length))) || (item.sessionId !== undefined && paused.has(item.sessionId));

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
    const stepJob = holder?.item.job ? { step: holder.item.id, job: holder.owner?.name ?? holder.item.job } : undefined;
    const base = { goal, words, ...(owner ? { owner } : {}), ...(step ? { pushStep: step } : {}), ...(stepJob ? { stepJob } : {}) };
    const number = goalNumber(goal, everyMs, metrics);
    if (!number) return [{ ...base, stale: false, act: "no_number" }];
    const { trend, memo } = goalTrend(number, memos?.[goal.id]);
    if (memo) kept[goal.id] = memo;
    const stale = number.measuredAt === undefined || now - number.measuredAt > number.staleMs;
    const asks = trend.kind === "met" ? undefined : ownerHeld(goal, views, todos);
    const waits = trend.kind === "met" || asks ? undefined : goalWait(goal, pushView, now, paused, views, board);
    const act: GoalAct = trend.kind === "met" ? "on_pace" : asks ? "owner" : waits ? "waiting" : !owner ? "start" : offPace(trend, stale) ? "steer" : "on_pace";
    return [{ ...base, number, trend, stale: trend.kind !== "met" && stale, ...(asks ? { asks } : {}), ...(waits ? { waits } : {}), act }];
  });
  const rank: Record<GoalAct, number> = { start: 0, steer: 1, no_number: 2, owner: 3, waiting: 4, on_pace: 5 };
  const short = (push: GoalPush): number => !push.number || push.number.value === undefined ? 1
    : Math.max(0, (push.number.target - push.number.value) * (push.number.op === "<=" ? -1 : 1) / Math.abs(push.number.target || 1));
  return { pushes: pushes.sort((a, b) => rank[a.act] - rank[b.act] || short(b) - short(a)), memos: kept };
}

/** Whether a goal counts in the check-in's headline, `goal_gaps`: its number is off pace or no live job owns it. */
export const pushNeeded = (push: GoalPush): boolean => push.act === "start" || push.act === "steer";

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
      return `${delta}, ${trend.etaMs === null ? "moving away from target" : `${span(trend.etaMs)} to target at this rate`}${old}`;
    }
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
  const none = pushes.length - numbered.length;
  return `Goals: ${behind} of ${pushes.length} open goals are off pace or have no live owner` +
    `${none ? `, and ${none} ${none === 1 ? "has" : "have"} no number` : ""}.`;
}

/** The detail file's Goals section: each goal's line, then for each one to steer or start, its steer message. */
export function goalsDetail(pushes: readonly GoalPush[]): string {
  if (!pushes.length) return "";
  const parts = pushes.map(push => {
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
  if (trend.kind === "met") return "at target";
  const pace = push.act === "owner" ? `waits on the owner's word on ${ownerAsks(push)}` : push.act === "waiting" ? `waits ${push.waits}`
    : pushNeeded(push) ? "off pace" : "on pace";
  return `${trendText(push.number!, trend, push.stale)}, ${pace}`;
};

/** A goal as the check-in prompt shows it, one plain sentence: its title, number, gap, trend, days to target, pace, and who owns it. */
export function goalPromptLine(push: GoalPush): string {
  const title = `${quote(push.goal.text)} (${push.goal.id})`;
  if (!push.number) return `${title} has no number yet: no target and no duty metric.`;
  const gap = gapText(push.number);
  const owner = push.owner ? `${ownerLabel(push.owner)} owns it` : "no live job owns it";
  return `${title}: ${numberText(push.number)}${gap ? `, ${gap}` : ""}; ${paceText(push)}; ${owner}.`;
}

/** The action a goal needs this run, with the message to send or brief to open with; null for a goal on pace. */
export function goalDueLine(push: GoalPush): string | null {
  const title = quote(push.goal.text);
  if (push.act === "no_number") return `Give ${title} a target from the owner's words, with plan_update target.`;
  if (!pushNeeded(push)) return null;
  // A start steers the job that already holds the goal's work before it adds anything: a new step only for an output no open step owns.
  const ask = push.act === "steer" ? `Steer ${ownerLabel(push.owner!)} on ${title} with this message, and add no step`
    : push.stepJob ? `Steer the job ${push.stepJob.job} on ${push.stepJob.step}${push.stepJob.step === push.pushStep ? `, the push step of ${title}` : ` of ${title}`} with this message, ` +
      `restarting it if it ended${push.stepJob.step === push.pushStep ? "" : `, and set the duty of ${push.stepJob.step} to "${GOAL_PUSH_LINK}"`}. Add no new step: add one only when the ` +
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
