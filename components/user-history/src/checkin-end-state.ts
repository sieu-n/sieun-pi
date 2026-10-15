import { bridgeHolds, ESCALATE_MS } from "./alert-bridge.ts";
import { coversStep } from "./shared/chat-board.ts";
import type { OwnerTodo, PlanItem, SessionRow } from "./shared/types.ts";
import { ago, clip, ownerLabel, quote, STEP_STALE_MS, type StepView, waitsOnOwner, waitTarget } from "./checkin-steps.ts";

/**
 * The owner's end state for a board (owner 10-14: "all the PLAN list should clear or be stuck in FOR YOU right? check in duty should push forward
 * the agent swarm"): every open leaf step is moved by a live owner now, or held by an open For you todo, or parked by an owner correction in
 * force. Every other open step is stuck. A wait on CI, a release, another thread, an event or a time is stuck: nobody of this chat is moving it.
 * The stuck count and the share of open steps in the end state are the headline KPI of the check-in and of the Chat system duty.
 *
 * On 10-14 at 03:11Z the rules below (measured by the KPI job, session 1108-checkin-swarm-kpi) found 102 of 179 open leaf steps stuck: 84 on a
 * land, promote or release, and most of the rest on a CI run whose job had gone idle. The step classes (`stepClass`) counted most of them as
 * `waiting`, which broke no check-in target, so 159 of 298 check-ins that met every target in 48 h still had stuck steps.
 */
export type EndState = "moving" | "foryou" | "parked" | "owner_no_todo" | "release" | "ci" | "thread" | "event" | "time" | "job_ended" | "no_owner";
export const OK_STATES: ReadonlySet<EndState> = new Set(["moving", "foryou", "parked"]);
export const STUCK_STATES: readonly EndState[] = ["owner_no_todo", "release", "ci", "thread", "event", "time", "job_ended", "no_owner"];

/** A wait on the owner: its first clause names his answer, go, ok, login, review or merge. */
const OWNER_WAIT = /\b(?:owner|sieun|you)(?:'s|r)?\b.*\b(?:go|ok|approval|answer|decision|choice|login|sign[ -]?in|review|reply|merge|says|decides|confirms|approves|picks)\b/i;
const RELEASE = /\b(?:land|lands|landed|promote|release|released|deploys?|redeploys?|cut|train|fable|slot|cas)\b/i;
const CI = /\b(?:runs?|ci|checks?|green|probe|verify-dev|workflow|tests?|push(?:es|ed)?)\b|\bci\//i;
/** The first clause of a wait: what it waits on before "then". */
const firstClause = (text: string): string => text.split(/;|,? then |\. /i)[0]!;

/**
 * Whether an open agent todo holds the step by an explicit link: it names the step's id, links it (`step`) or a PR it names (`coversStep`), or
 * the step's wait names the todo's id. A shared word is not a link: on 10-14 13 of the 17 steps the classes counted as For you matched only by a
 * word, and four of them waited on a release.
 */
export function heldByTodo(item: Pick<PlanItem, "id" | "text" | "waitFor" | "note">, todos: readonly Pick<OwnerTodo, "id" | "text" | "step" | "reply" | "done" | "from">[]): boolean {
  const id = new RegExp(`\\b${item.id}\\b`);
  const named = new Set(item.waitFor?.match(/\bt\d+\b/g) ?? []);
  return todos.some(todo => todo.from === "agent" && !todo.done && (id.test(todo.text) || coversStep(todo, item as PlanItem) || (todo.id !== undefined && named.has(todo.id))));
}

/** One open leaf step in the end state or stuck, with why. */
export interface EndStateView { view: StepView; state: EndState; reason: string }

/**
 * The end state of one open leaf step, rules in order. A parked step (an owner correction in force) and a step whose owner is a working job or a
 * working thread are fine; a step the chat owns is moving when it changed within STEP_STALE_MS and waits on nothing, and so is a step the alert
 * bridge just added (`bridgeHolds`). Next an explicit For you
 * link (`heldByTodo`). Every other step is stuck, by what it waits on: the owner with no todo, a release, a CI run, another thread, an event,
 * a time; else its job ended or is gone, else it has no owner.
 */
export function endState(view: StepView, todos: Parameters<typeof heldByTodo>[1], rows: readonly Pick<SessionRow, "id" | "name" | "archived">[],
  self: ReadonlySet<string>, now: number): EndStateView {
  const { item, owner, mine, cls } = view;
  const out = (state: EndState, reason: string): EndStateView => ({ view, state, reason });
  if (cls === "parked") return out("parked", `parked by ${view.parked ?? "an owner correction"}`);
  if (owner?.state === "working") return out("moving", `${ownerLabel(owner)} ${owner.wake ? `sleeps on ${owner.wake}` : "works on it"}`);
  const wait = item.waitFor ?? "";
  if (mine && !wait && !item.waitUntil && now - view.changedAt < STEP_STALE_MS) return out("moving", "the chat changed it within 2 h");
  if (bridgeHolds(item, view.changedAt, now)) return out("moving", `the alert bridge added it ${ago(now - view.changedAt)} ago and escalates it at ${ESCALATE_MS / 60_000} min`);
  if (heldByTodo(item, todos)) return out("foryou", "an open For you todo links it");
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
  return `End state: ${kpi.ok} of ${kpi.open} open steps (${kpi.pct}%) are moving, in For you or parked; ${kpi.stuck} stuck${split ? ` (${split})` : ""}.`;
}

/** What a stuck step needs, by its state: a live owner now, a For you todo when only the owner can unblock it, or a close. */
const NEXT: Record<EndState, string> = {
  moving: "", foryou: "", parked: "",
  owner_no_todo: "add the For you todo with the choice and links, or do it yourself if you can",
  release: "give it a live owner that drives the land (a job that watches the run and does the next step), or close it if this chat's part shipped",
  ci: "give it a live owner that watches the run and fixes a red one, or check the run now and do the next step",
  thread: "chase the thread with the exact ask, or move the work to a job of this chat",
  event: "check whether it happened and do the next step, or give it a live owner",
  time: "do it now if it can run now, or give it a live owner that wakes at that time",
  job_ended: "read the job's last report, then close the step, steer the job, or start a new one",
  no_owner: "start a job on it, do it yourself, or ask the owner in For you",
};
/** The precheck line of one stuck step: id, title, why it is stuck, how long it has not changed, and what it needs. */
export const stuckLine = ({ view, state, reason }: EndStateView, now: number): string =>
  `${view.item.id} ${quote(view.item.text)} is stuck (${state}): ${reason}${view.item.waitFor ? `; waits for ${quote(clip(view.item.waitFor, 80))}` : ""}, ` +
  `last change ${ago(now - view.changedAt)} ago: ${NEXT[state]}`;
