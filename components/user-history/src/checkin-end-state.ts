import { OWNER_WAIT } from "./shared/chat-board.ts";
import { type HostHold, holdWords } from "./shared/host-hold.ts";
import { heldByTodo } from "./shared/todo-hold.ts";
import type { OwnerTodo, PlanItem, SessionRow } from "./shared/types.ts";
import { landWaitCommits, type WakeWatch } from "./checkin-load.ts";
import { zTime } from "./checkin-goals.ts";
import { stallWords } from "./shared/stalled-calls.ts";
import { ago, capacityWait, clip, firstClause, type JobFact, OPEN, ownerLabel, poolWait, quote, STEP_STALE_MS, type StepView, stepOwner, waitCarrier, waitsOnOwner, waitTarget, walk } from "./checkin-steps.ts";

/**
 * The owner's end state for a board (owner 10-14: "all the PLAN list should clear or be stuck in FOR YOU right? check in duty should push forward
 * the agent swarm"): every open leaf step is moved by a live owner now, or held by an open For you todo, or parked by an owner correction in
 * force. Every other open step is stuck. A wait on CI, a release, another thread, an event or a time is stuck when nobody is moving it: no job of
 * this chat, no session asleep on a board.wake for that run, that land or that thread (`wakeMover`), and no turn of its owner waiting in
 * pi-pool's queue (`outsideMover`).
 * The stuck count and the share of open steps in the end state are the check-in's second KPI, after its goals (`goal_gaps`, src/checkin-goals.ts:
 * each open goal's number moves on pace with a live job that owns it), and the headline KPI of the Chat system duty.
 *
 * On 10-14 at 03:11Z the rules below (measured by the KPI job, session 1108-checkin-swarm-kpi) found 102 of 179 open leaf steps stuck: 84 on a
 * land, promote or release, and most of the rest on a CI run whose job had gone idle. The step classes (`stepClass`) counted most of them as
 * `waiting`, which broke no check-in target, so 159 of 298 check-ins that met every target in 48 h still had stuck steps.
 */
export type EndState = "moving" | "foryou" | "parked" | "host" | "owner_no_todo" | "release" | "ci" | "thread" | "event" | "time" | "job_ended" | "stalled_call" | "no_owner";
export const OK_STATES: ReadonlySet<EndState> = new Set(["moving", "foryou", "parked", "host"]);
export const STUCK_STATES: readonly EndState[] = ["owner_no_todo", "release", "ci", "thread", "event", "time", "job_ended", "stalled_call", "no_owner"];

const RELEASE = /\b(?:land|lands|landed|promote|release|released|deploys?|redeploys?|cut|train|fable|slot|cas)\b/i;
const CI = /\b(?:runs?|ci|checks?|green|probe|verify-dev|workflow|tests?|push(?:es|ed)?)\b|\bci\//i;

/**
 * The live owners that carry each plan item: every open leaf step whose owner works now (`views`), and every other open item whose own job
 * works now (`ownerOf`), each listed under its own id and under every item above it. A step that waits on one of these items waits on work
 * that moves (`stepCarrier`). chat-2572 10-24 07:52Z: its check-in moved p8 and p10, which wait on p6, under p6, so p6 was no leaf, and its
 * live release job 01a10810 carried nothing; the after-job measure read goal_gaps 1 and stuck_steps 2.
 */
export function stepCarriers(board: { plan: readonly PlanItem[] } | null, views: readonly Pick<StepView, "item" | "owner">[],
  ownerOf: (item: PlanItem) => JobFact | undefined = () => undefined): Map<string, JobFact[]> {
  const parents = new Map<string, string>();
  const visit = (items: readonly PlanItem[], parent?: string) => { for (const item of items) { if (parent) parents.set(item.id, parent); visit(item.children, item.id); } };
  visit(board?.plan ?? []);
  const carriers = new Map<string, JobFact[]>();
  const carry = (from: string, owner: JobFact) => { for (let id: string | undefined = from; id !== undefined; id = parents.get(id)) carriers.set(id, [...carriers.get(id) ?? [], owner]); };
  for (const view of views) if (view.owner?.state === "working") carry(view.item.id, view.owner);
  const leaves = new Set(views.map(view => view.item.id));
  walk(board?.plan ?? [], item => {
    if (!OPEN.has(item.status) || leaves.has(item.id)) return;
    const owner = ownerOf(item);
    if (owner?.state === "working") carry(item.id, owner);
  });
  return carriers;
}
/**
 * The plan item the first clause of a step's wait names, other than the step itself, whose work live owners carry (`stepCarriers`), with them.
 * AI harness 10-18 12:26 KST: p566 waited for "The chats move to us-metal02 (p565)", whose five steps had live jobs, and the check-in started a
 * push job on it; the 12:15 d7 run did the same with 'chats move to metal02'.
 */
export function stepCarrier(item: Pick<PlanItem, "id" | "waitFor">, carriers: ReadonlyMap<string, readonly JobFact[]>): { id: string; owners: readonly JobFact[] } | undefined {
  for (const id of firstClause(item.waitFor ?? "").match(/\bp\d+\b/g) ?? []) {
    const owners = id === item.id ? undefined : carriers.get(id);
    if (owners?.length) return { id, owners };
  }
  return undefined;
}
const carriedText = ({ id, owners }: { id: string; owners: readonly JobFact[] }): string =>
  `its wait is on ${id}, which ${owners.length === 1 ? `${ownerLabel(owners[0]!)} carries` : `${owners.length} live jobs carry`}`;

/** One open leaf step in the end state or stuck, with why. */
export interface EndStateView { view: StepView; state: EndState; reason: string;
  /** The offline box a `host` step's job runs on, with the todo that asks the owner to bring it back. */
  hold?: HostHold }

/**
 * The end state of one open leaf step, rules in order. A parked step (an owner correction in force), a step whose owner is a working job or a
 * working thread, and a step whose wait names a working job of this chat (`waitCarrier`, from `facts`) are fine; a step the chat owns is moving when it changed within STEP_STALE_MS and waits on nothing. Next an explicit For you
 * link (`heldByTodo`), then a job on a box that reads offline while an open For you todo asks the owner to bring it back (`hostHeld`). Every
 * other step is stuck, by what it waits on: the owner with no todo, a release, a CI run, another thread, an event,
 * a time; else its job ended or is gone, else it has no owner.
 */
export function endState(view: StepView, todos: Parameters<typeof heldByTodo>[1], rows: readonly (Pick<SessionRow, "id" | "name" | "archived"> & Partial<Pick<SessionRow, "host">>)[],
  self: ReadonlySet<string>, now: number, facts: readonly JobFact[] = [], movers: Movers = {}): EndStateView {
  const { item, owner, mine, cls } = view;
  const out = (state: EndState, reason: string): EndStateView => ({ view, state, reason });
  if (cls === "parked") return out("parked", `parked by ${view.parked ?? "an owner correction"}`);
  if (owner?.stalled) return out("stalled_call", `${ownerLabel(owner)} ${stallWords(owner.stalled, now)}`);
  if (owner?.state === "working") return out("moving", `${ownerLabel(owner)} ${capacityWait(owner) ?? (owner.wake ? `sleeps on ${owner.wake}` : "works on it")}`);
  if (poolWait(owner)) return out("moving", `${ownerLabel(owner!)} waits for its slot in the token pool`);
  if (owner?.state === "unstarted" && owner.unstarted) return out("job_ended", `${ownerLabel(owner)} never started: Prime admitted it at ${zTime(owner.unstarted.at)} and its ` +
    `session has no first prompt${owner.unstarted.sentAt !== undefined ? `, though the chat service sent its brief at ${zTime(owner.unstarted.sentAt)}` : ""}`);
  const wait = item.waitFor ?? "";
  const carrier = waitCarrier(wait, facts);
  if (carrier) return out("moving", `its wait is on ${ownerLabel(carrier)}, which ${carrier.wake ? `sleeps on ${carrier.wake}` : "works on it"}`);
  const carried = movers.steps ? stepCarrier(item, movers.steps) : undefined;
  if (carried) return out("moving", carriedText(carried));
  const mover = outsideMover(view, movers, rows, self);
  if (mover) return out("moving", mover);
  if (mine && !wait && !item.waitUntil && now - view.changedAt < STEP_STALE_MS) return out("moving", "the chat changed it within 2 h");
  if (heldByTodo(item, todos)) return out("foryou", "an open For you todo links it");
  const hold = hostHeld(view, rows, movers.hosts);
  if (hold) return { ...out("host", `${owner ? ownerLabel(owner) : `its job ${item.job}`} runs on ${holdWords(hold)}`), hold };
  if (wait ? OWNER_WAIT.test(firstClause(wait)) : waitsOnOwner(item)) return out("owner_no_todo", "waits on the owner and no open For you todo links it");
  const thread = owner?.key.startsWith("thread:") === true;
  if (wait || item.waitUntil || thread) {
    const head = firstClause(wait);
    const on = wait && RELEASE.test(head) ? "release" : wait && CI.test(head) ? "ci" : (wait && waitTarget(wait, rows, self)) || thread ? "thread" : wait ? "event" : "time";
    const what = { release: "a land, promote or release", ci: "a CI run", thread: thread && !wait ? `${ownerLabel(owner!)} (idle)` : "another thread", event: "an event", time: "a time" }[on];
    return out(on, `waits on ${what} and no live job of this chat watches it`);
  }
  if (owner) return out("job_ended", `${ownerLabel(owner)} ${owner.cancelled ? "was cancelled" : owner.state === "failed" ? "failed" : "ended"} and the step is open`);
  if (item.job && !mine) return out("job_ended", `its job ${item.job} is gone`);
  return out("no_owner", mine ? `the chat owns it and it has not moved for ${ago(now - view.changedAt)}` : "no job, todo or wait");
}

/**
 * The hold on a step whose job runs on a box that reads offline while an open For you todo asks the owner to bring it back (`hostHolds`): a
 * thread owner runs on its catalog row's box, and the chat's own jobs, named or gone, on the chat's box. A step with no job is not held.
 */
export function hostHeld(view: Pick<StepView, "item" | "owner">, rows: readonly Pick<SessionRow, "id" | "host">[], hosts: Movers["hosts"]): HostHold | undefined {
  if (!hosts?.held.size || (!view.owner && !view.item.job)) return undefined;
  const thread = view.owner?.key.startsWith("thread:") ? view.owner.key.slice("thread:".length) : undefined;
  const host = thread !== undefined ? rows.find(row => row.id === thread)?.host : hosts.chatHost;
  return host === undefined ? undefined : hosts.held.get(host);
}

/** "land 37", "promote 11", "train 12b", "run 38790378691": the work a wait names by number, lower case. */
const NAMED_WORK = /\b(land|promote|train)[\s-]*(\d+[a-z]?)\b|\b(\d{9,})\b/gi;
const SESSION_PREFIX = /\b[0-9a-f]{8}\b/g;
/**
 * Who moves a step from another session, by the pending board.wakes (`wakeWatches`): the session the step names as its owner sleeps on one, or
 * the first clause of its wait names a run or a land that a session sleeps on, or a land wait whose every named commit a land run some session
 * sleeps on carries (`landCarries`), or a thread asleep on one (by name, id, or an 8-character id).
 * Crawler VP 10-15 19:10Z, after a daemon restart left the chat's jobs unlisted: 117 steps were stuck, 77 of them owned by crawler ops train,
 * asleep on its run wakes, and 29 more waiting on land 37, whose run 38790378691 the release owner 01a10810 slept on.
 */
export function wakeMover(item: Pick<PlanItem, "waitFor" | "sessionId" | "job" | "note">, watches: ReadonlyMap<string, WakeWatch>,
  rows: readonly Pick<SessionRow, "id" | "name" | "archived">[], self: ReadonlySet<string>): string | undefined {
  if (!watches.size) return undefined;
  const name = (session: string): string => rows.find(row => row.id === session)?.name ?? session.slice(0, 8);
  for (const session of new Set([item.sessionId, stepOwner(item as PlanItem)])) {
    const watch = session === undefined ? undefined : watches.get(session);
    if (watch) return `its owner ${rows.some(row => row.id === session) ? name(session!) : item.job ?? name(session!)} sleeps on ${watch.label}`;
  }
  const head = firstClause(item.waitFor ?? "");
  if (!head) return undefined;
  const works = [...head.matchAll(NAMED_WORK)].map(([, kind, n, run]) => run ? `run ${run}` : `${kind!.toLowerCase()} ${n!.toLowerCase()}`);
  for (const [session, watch] of watches) {
    const work = works.find(candidate => watch.works.has(candidate));
    if (work) return `its wait is on ${work}, which ${name(session)} sleeps on (${watch.label})`;
  }
  const commits = landWaitCommits(item.waitFor);
  for (const [session, watch] of commits.length ? watches : []) {
    if (watch.carries && commits.every(commit => watch.carries!.commits.has(commit))) {
      return `its wait is on ${commits.join(", ")}, which ${watch.carries.land} carries and ${name(session)} sleeps on ${watch.label}`;
    }
  }
  const thread = waitTarget(item.waitFor, rows, self)?.id;
  const prefixes = head.match(SESSION_PREFIX) ?? [];
  for (const [session, watch] of watches) {
    if (session === thread || prefixes.some(prefix => session.startsWith(prefix))) return `its wait is on ${name(session)}, which sleeps on ${watch.label}`;
  }
  return undefined;
}

/**
 * What moves steps from outside this chat's job facts: the pending board.wakes (`wakeWatches`) and pi-pool's queue places by session id
 * (queued turns). Absent: none.
 */
export interface Movers { watches?: ReadonlyMap<string, WakeWatch>; queued?: ReadonlyMap<string, unknown>;
  /** The live owners that carry each plan item (`stepCarriers`), for a step whose wait names another step (`stepCarrier`). Absent: none. */
  steps?: ReadonlyMap<string, readonly JobFact[]>;
  /** The box the chat runs on (absent: this box) and each offline box an open For you todo asks the owner to bring back (`hostHolds`). Absent: none. */
  hosts?: { chatHost?: string; held: ReadonlyMap<string, HostHold> } }

/**
 * Who moves a step that no working job of this chat holds: a session asleep on a board.wake (`wakeMover`), or a turn that waits for a working
 * slot in pi-pool's queue (its owner's, the session it stores, the chat's own for a step it owns, or the thread its wait names). Each of those
 * goes on by itself once its wake or slot comes. launch main bro 10-15 19:16Z read 18 of 19 steps stuck while the queue held its jobs' turns,
 * so the check-in asked for owners it could not start.
 */
export function outsideMover(view: Pick<StepView, "item" | "owner" | "mine">, movers: Movers, rows: readonly Pick<SessionRow, "id" | "name" | "archived">[],
  self: ReadonlySet<string>): string | undefined {
  const { item, owner, mine } = view;
  // A CI run moves the step only while a session sleeps on a board.wake for it: a queued run nobody watches lands on nobody. At 05:19Z on 10-18
  // d7 read 9 stuck steps that waited on runs, lands and threads no live job watched (VP of CI's p209 and p214 among them).
  const woke = wakeMover(item, movers.watches ?? new Map(), rows, self);
  if (woke) return woke;
  const queued = movers.queued ?? new Map<string, unknown>();
  const slot = "waits for a working slot in pi-pool's queue";
  if (owner?.queued !== undefined) return `its owner ${ownerLabel(owner)} ${slot}`;
  const session = [item.sessionId, stepOwner(item)].find(id => id !== undefined && queued.has(id));
  if (session) return `its owner ${item.job ?? session.slice(0, 8)} ${slot}`;
  if (mine && [...self].some(id => queued.has(id))) return `the chat's own turn ${slot}`;
  const target = queued.size ? waitTarget(item.waitFor, rows, self) : undefined;
  if (target && queued.has(target.id)) return `its wait is on ${target.name}, whose turn ${slot}`;
  return undefined;
}

/**
 * The steps whose wait names a step held on an offline box (`held`), each with the step it names and that step's hold, through chains of such
 * waits. Only a held step holds another: a wait on a step a live owner moves on a reachable box holds nothing. On 10-24 frontend bro's p333,
 * whose job ran on us-metal02, waited for p332 to push its commit from the Mac while Tailscale read the Mac offline and For you asked it back.
 */
export function waitHolds(steps: readonly Pick<PlanItem, "id" | "waitFor">[], held: ReadonlyMap<string, HostHold>): Map<string, { on: string; hold: HostHold }> {
  const out = new Map<string, { on: string; hold: HostHold }>();
  const holds = new Map(held);
  for (let grew = true; grew;) {
    grew = false;
    for (const step of steps) {
      const on = holds.has(step.id) ? undefined : (step.waitFor?.match(/\bp\d+\b/g) ?? []).find(id => id !== step.id && holds.has(id));
      if (on === undefined) continue;
      holds.set(step.id, holds.get(on)!);
      out.set(step.id, { on, hold: holds.get(on)! });
      grew = true;
    }
  }
  return out;
}

/** End states with each stuck step whose wait names a `host` step (`waitHolds`) moved to `host` under that step's hold. */
export function withWaitHolds(states: readonly EndStateView[]): EndStateView[] {
  const held = new Map(states.flatMap(entry => entry.state === "host" && entry.hold ? [[entry.view.item.id, entry.hold] as const] : []));
  const waits = waitHolds(states.filter(entry => !OK_STATES.has(entry.state)).map(entry => entry.view.item), held);
  return states.map(entry => {
    const wait = waits.get(entry.view.item.id);
    return wait ? { view: entry.view, state: "host", reason: `its wait is on ${wait.on}, whose job runs on ${holdWords(wait.hold)}`, hold: wait.hold } : entry;
  });
}

/** The KPI of a set of end states: open steps, how many are in the end state, how many are stuck and by what, and the share in the end state. */
export interface EndStateKpi { open: number; ok: number; stuck: number; pct: number; byState: Partial<Record<EndState, number>> }
export function endStateKpi(states: readonly Pick<EndStateView, "state">[]): EndStateKpi {
  const byState: Partial<Record<EndState, number>> = {};
  for (const { state } of states) byState[state] = (byState[state] ?? 0) + 1;
  const ok = states.filter(entry => OK_STATES.has(entry.state)).length;
  return { open: states.length, ok, stuck: states.length - ok, pct: states.length ? Math.round(1000 * ok / states.length) / 10 : 100, byState };
}

/** "End state: 77 of 179 open steps (43%) are moving, in For you or parked; 102 stuck (release 84, ci 10, ...)." */
export function endStateLine(kpi: EndStateKpi): string {
  const split = STUCK_STATES.filter(state => kpi.byState[state]).map(state => `${state} ${kpi.byState[state]}`).join(", ");
  const onHost = kpi.byState.host ? `, ${kpi.byState.host} of them on a box the owner is asked to bring back` : "";
  return `End state: ${kpi.ok} of ${kpi.open} open steps (${kpi.pct}%) are moving, in For you or parked${onHost}; ${kpi.stuck} stuck${split ? ` (${split})` : ""}.`;
}

/** What a stuck step needs, by its state: a live owner now, a For you todo when only the owner can unblock it, or a close. */
const NEXT: Record<EndState, string> = {
  moving: "", foryou: "", parked: "", host: "",
  owner_no_todo: "add the For you todo with the choice and links, or do it yourself if you can",
  release: "give it a live owner that drives the land (a job that watches the run and does the next step), or close it if this chat's part shipped",
  ci: "give it a live owner that watches the run and fixes a red one, or check the run now and do the next step",
  thread: "chase the thread with the exact ask, or move the work to a job of this chat",
  event: "check whether it happened and do the next step, or give it a live owner",
  time: "do it now if it can run now, or give it a live owner that wakes at that time",
  job_ended: "read the job's last report, then close the step, steer the job, or start a new one",
  stalled_call: "stop the process it names, then steer the job with the call you stopped and the step's next action, or start a new job if it does not write again",
  no_owner: "start a job on it, do it yourself, or ask the owner in For you",
};
/** The precheck line of one stuck step: id, title, why it is stuck, how long it has not changed, and what it needs. */
export const stuckLine = ({ view, state, reason }: EndStateView, now: number): string =>
  `${view.item.id} ${quote(view.item.text)} is stuck (${state}): ${reason}${view.item.waitFor ? `; waits for ${quote(clip(view.item.waitFor, 80))}` : ""}, ` +
  `last change ${ago(now - view.changedAt)} ago: ${NEXT[state]}`;
