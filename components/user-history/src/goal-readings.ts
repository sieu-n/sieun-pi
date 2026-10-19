import { inferredDirection, targetOp } from "./shared/chat-board.ts";
import { CHECK_IN_DUTY_ID, type MetricResult } from "./shared/chat-duties.ts";
import type { BoardOp, ChatBoard, GoalTarget, PlanItem } from "./shared/types.ts";

const walk = (items: readonly PlanItem[], visit: (item: PlanItem) => void): void => { for (const item of items) { visit(item); walk(item.children, visit); } };
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
type Reading = { key: string; value: number; op: MetricResult["op"] };

/**
 * The board ops that write a duty run's measures into the goals they measure: a top-level goal with a target, where the goal or an item under it
 * fixes `<dutyId>/<key>`, and that metric has the goal's target and direction, gets its target's current, measuredAt and source from the run when
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
 * A goal whose own duty field names `<dutyId>/<key>` reads only that metric, whatever its steps link: VP of CI's p1 (Mac job start wait p90)
 * names d1/air_work_start_wait_p90_min, and on 10-18 d1 wrote push_to_verdict 221 min into it through the open step p258.
 */
export function goalReadingOps(board: ChatBoard | null, dutyId: string, at: number, metrics: Readonly<Record<string, MetricResult>>): BoardOp[] {
  const ops: BoardOp[] = [];
  if (dutyId === CHECK_IN_DUTY_ID) return ops;
  for (const goal of board?.plan ?? []) {
    const target = goal.target;
    if (!target || goal.status === "done" || goal.status === "dropped") continue;
    const measured = Date.parse(target.measuredAt ?? "");
    if (Number.isFinite(measured) && measured >= at) continue;
    // A target with no direction yet, unmeasured or at its target, takes the direction of the duty metric that measures it.
    const known = target.direction ?? inferredDirection(target);
    const goalWords = new Set(words(target.metric));
    const own = goal.duty?.startsWith(`${CHECK_IN_DUTY_ID}/`) ? undefined : goal.duty;
    let named: Reading | undefined;
    const open = new Map<string, MetricResult>();
    walk([goal], item => {
      if (named || !item.duty?.startsWith(`${dutyId}/`) || (own && item.duty !== own)) return;
      const key = item.duty.slice(dutyId.length + 1);
      const result = metrics[key];
      if (!result || result.value < 0 || result.target !== target.target || (known && result.op !== targetOp(target))) return;
      if (own || words(key).every(word => goalWords.has(word))) named = { key, value: result.value, op: result.op };
      else if (item.status !== "done" && item.status !== "dropped" && keyNamesGoal(key, target)) open.set(key, result);
    });
    const only = open.size === 1 ? [...open][0] : undefined;
    const reading = named ?? (only && { key: only[0], value: only[1].value, op: only[1].op });
    if (!reading) continue;
    ops.push({ op: "plan_update", id: goal.id, target: { ...target, direction: known ?? (reading.op === "<=" ? "down" : "up"), current: reading.value, measuredAt: new Date(at).toISOString(),
      source: `duty ${dutyId} metric ${reading.key}, its run at ${new Date(at).toISOString().slice(0, 16)}Z` } });
  }
  return ops;
}
