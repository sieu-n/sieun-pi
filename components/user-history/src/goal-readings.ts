import { targetOp } from "./shared/chat-board.ts";
import { CHECK_IN_DUTY_ID, type MetricResult } from "./shared/chat-duties.ts";
import type { BoardOp, ChatBoard, PlanItem } from "./shared/types.ts";

const walk = (items: readonly PlanItem[], visit: (item: PlanItem) => void): void => { for (const item of items) { visit(item); walk(item.children, visit); } };

/**
 * The board ops that write a duty run's measures into the goals they measure: a top-level goal with a target, where the goal or an item under it
 * fixes `<dutyId>/<key>`, and that metric has the goal's target and direction, gets its target's current, measuredAt and source from the run when
 * the run is newer than the target's reading. On 10-18 the AI harness chat's p453 still read 25.7% from 10-16 06:27Z while the newest measure
 * said 29.7%, so the check-in pushed on a two-day-old number and the board showed it. A push step's link (`GOAL_PUSH_LINK`) names the job that
 * owns the number, not a measure of it, as in `goalNumber`: on 10-18 the check-in wrote its goal_gaps 3 into VP of CI's p75 over d3's 1.
 * No check-in metric measures a goal: its counts are of board steps, and a `checkin/<key>` link names a step that fixes that count. At 17:17Z on
 * 10-18 the check-in wrote its stuck_steps 2 into Crawler VP's p146, whose target reads d3's new unbacked limits (0 at 17:14Z), through the done
 * fix step p538 (checkin/stuck_steps), and the next check-in flagged p146 as a goal gap.
 */
export function goalReadingOps(board: ChatBoard | null, dutyId: string, at: number, metrics: Readonly<Record<string, MetricResult>>): BoardOp[] {
  const ops: BoardOp[] = [];
  if (dutyId === CHECK_IN_DUTY_ID) return ops;
  for (const goal of board?.plan ?? []) {
    const target = goal.target;
    if (!target || goal.status === "done" || goal.status === "dropped") continue;
    const measured = Date.parse(target.measuredAt ?? "");
    if (Number.isFinite(measured) && measured >= at) continue;
    // Two metrics that share the goal's target and direction cannot both be its number, so neither is written: VP of CI's p1 "m1-air job
    // start wait p90" (at most 10 min) has d1/push_to_verdict_p90_min and d1/run_time_p90_min under it, and on 10-18 read push to verdict's 221.5.
    const readings = new Map<string, number>();
    walk([goal], item => {
      if (!item.duty?.startsWith(`${dutyId}/`)) return;
      const key = item.duty.slice(dutyId.length + 1);
      const result = metrics[key];
      if (result && result.value >= 0 && result.target === target.target && result.op === targetOp(target)) readings.set(key, result.value);
    });
    if (readings.size !== 1) continue;
    const [key, value] = [...readings][0]!;
    const reading = { key, value };
    ops.push({ op: "plan_update", id: goal.id, target: { ...target, current: reading.value, measuredAt: new Date(at).toISOString(),
      source: `duty ${dutyId} metric ${reading.key}, its run at ${new Date(at).toISOString().slice(0, 16)}Z` } });
  }
  return ops;
}
