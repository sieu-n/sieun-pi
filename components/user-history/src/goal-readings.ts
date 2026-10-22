import { inferredDirection, openGoals, targetOp, walkGoal } from "./shared/chat-board.ts";
import { CHECK_IN_DUTY_ID, type MetricResult } from "./shared/chat-duties.ts";
import type { BoardOp, ChatBoard, GoalTarget, PlanItem } from "./shared/types.ts";

const words = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Whether a duty metric key can be a goal's number: some word of the key is in the goal's metric or unit. A target and direction that match by
 * chance are not enough: on 10-19 at 16:52Z Crawler VP's d9 wrote geonode_mbps 58.9 into p146 "Documented API routes that work on prod" (100%)
 * through its open fix step p844 (d9/geonode_mbps), because both targets were 100 and up.
 */
export const keyNamesGoal = (key: string, target: Pick<GoalTarget, "metric" | "unit">): boolean => {
  const goal = new Set([...words(target.metric), ...words(target.unit)]);
  return words(key.slice(key.indexOf("/") + 1)).some(word => goal.has(word));
};
const OPEN: ReadonlySet<PlanItem["status"]> = new Set(["todo", "doing", "blocked"]);
type Reading = { key: string; value: number; op: MetricResult["op"] };
const unitWords = (unit: string | undefined): string => words(unit ?? "").join(" ");
/**
 * Whether a duty metric's unit can be the goal's: both name one and they differ, and it cannot. On 10-20 at 04:08Z d2 wrote
 * mac_chat_reply_extra_rtt 4.6 round trips into p16 "Cold chat page load from the Mac ... median" (1.5 s) through its open fix step p93, because
 * both targets were 1.5 and down and the key shares "mac" and "chat" with the goal; the check-in then asked for a 4.6 s cold load that read 0.84 s.
 */
const unitFits = (unit: string | undefined, target: Pick<GoalTarget, "unit">): boolean => !unitWords(unit) || !unitWords(target.unit) || unitWords(unit) === unitWords(target.unit);

/**
 * The board ops that write a duty run's measures into the goals they measure: an open goal with a target at any depth (`openGoals`), where the
 * goal or an item under it that belongs to no goal below it (`walkGoal`) fixes `<dutyId>/<key>`, and that metric has the goal's target and direction, gets its target's current, measuredAt and source from the run when
 * the run is newer than the target's reading. On 10-18 the AI harness chat's p453 still read 25.7% from 10-16 06:27Z while the newest measure
 * said 29.7%, so the check-in pushed on a two-day-old number and the board showed it. A push step's link (`GOAL_PUSH_LINK`) names the job that
 * owns the number, not a measure of it, as in `goalNumber`: on 10-18 the check-in wrote its goal_gaps 3 into VP of CI's p75 over d3's 1.
 * No check-in metric measures a goal: its counts are of board steps, and a `checkin/<key>` link names a step that fixes that count. At 17:17Z on
 * 10-18 the check-in wrote its stuck_steps 2 into Crawler VP's p146, whose target reads d3's new unbacked limits (0 at 17:14Z), through the done
 * fix step p538 (checkin/stuck_steps), and the next check-in flagged p146 as a goal gap.
 * A link counts when its step is open and some word of its key is in the goal's metric or unit (`keyNamesGoal`), or when every word of its key is
 * in the goal's metric, and a named link wins over an open one. Two open
 * links that share the goal's target and direction cannot both be its number, so neither is written (f04bbeaa, which 15ac296a dropped).
 * A done step stays a measure only of the number it names: p146 (new unbacked limits) carries the done d2/supply_hold_minutes p700, which d2 runs wrote
 * into it, and the open d3/repo_unbacked_limits p506 (2 on 10-18) beside the done d3/new_unbacked_limits p504 that measures it, while VP of
 * CI's p75 (open repo design review problems) and AI harness p200 (wiki problems) read their duty only through done fix steps.
 * A metric whose unit (`units`, from the duty's definition) differs from the goal target's unit is never its number (`unitFits`).
 * A goal whose own duty field names `<dutyId>/<key>` reads only that metric, whatever its steps link: VP of CI's p1 (Mac job start wait p90)
 * names d1/air_work_start_wait_p90_min, and on 10-18 d1 wrote push_to_verdict 221 min into it through the open step p258.
 * A duty's readings (`DutyReading`) have no target, so each goes only into an open item with a target whose own duty field names it, at any
 * depth: slack green guy's p145 names d1/on_topic_visit_to_signup_pct, and the step p166 under p177 names d1/signup_to_paid_16d_pct.
 */
export function goalReadingOps(board: ChatBoard | null, dutyId: string, at: number, metrics: Readonly<Record<string, MetricResult>>,
  units: Readonly<Record<string, string | undefined>> = {}, readings: Readonly<Record<string, number>> = {}): BoardOp[] {
  const ops: BoardOp[] = [];
  if (dutyId === CHECK_IN_DUTY_ID) return ops;
  const write = (item: PlanItem, target: GoalTarget, key: string, value: number, direction: NonNullable<GoalTarget["direction"]>): void => {
    ops.push({ op: "plan_update", id: item.id, target: { ...target, direction, current: value, measuredAt: new Date(at).toISOString(),
      source: `duty ${dutyId} metric ${key}, its run at ${new Date(at).toISOString().slice(0, 16)}Z` } });
  };
  const newer = (target: GoalTarget): boolean => { const measured = Date.parse(target.measuredAt ?? ""); return !Number.isFinite(measured) || measured < at; };
  const visit = (items: readonly PlanItem[]): void => {
    for (const item of items) {
      visit(item.children);
      const key = item.duty?.startsWith(`${dutyId}/`) ? item.duty.slice(dutyId.length + 1) : undefined;
      const value = key === undefined ? undefined : readings[key];
      const target = item.target;
      if (value === undefined || !target || !OPEN.has(item.status) || !newer(target) || !unitFits(units[key!], target)) continue;
      write(item, target, key!, value, target.direction ?? inferredDirection(target) ?? (targetOp(target) === "<=" ? "down" : "up"));
    }
  };
  visit(board?.plan ?? []);
  for (const goal of openGoals(board?.plan ?? [])) {
    const target = goal.target;
    if (!target || !newer(target)) continue;
    // A target with no direction yet, unmeasured or at its target, takes the direction of the duty metric that measures it.
    const known = target.direction ?? inferredDirection(target);
    const goalWords = new Set(words(target.metric));
    const own = goal.duty?.startsWith(`${CHECK_IN_DUTY_ID}/`) ? undefined : goal.duty;
    let named: Reading | undefined;
    const open = new Map<string, MetricResult>();
    walkGoal(goal, item => {
      if (named || !item.duty?.startsWith(`${dutyId}/`) || (own && item.duty !== own)) return;
      const key = item.duty.slice(dutyId.length + 1);
      const result = metrics[key];
      if (!result || result.value < 0 || result.target !== target.target || (known && result.op !== targetOp(target)) || !unitFits(units[key], target)) return;
      if (own || words(key).every(word => goalWords.has(word))) named = { key, value: result.value, op: result.op };
      else if (item.status !== "done" && item.status !== "dropped" && keyNamesGoal(key, target)) open.set(key, result);
    });
    const only = open.size === 1 ? [...open][0] : undefined;
    const reading = named ?? (only && { key: only[0], value: only[1].value, op: only[1].op });
    if (reading) write(goal, target, reading.key, reading.value, known ?? (reading.op === "<=" ? "down" : "up"));
  }
  return ops;
}
