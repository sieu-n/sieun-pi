import type { DutyRunRecord, FixLink } from "./chat-duties.ts";
import type { BoardOp, ChatBoard, PlanItem, SessionRow } from "./types.ts";

/**
 * Fix steps: a plan step whose `duty` is `<dutyId>/<metricKey>` is the chat's fix for that duty metric. A duty run reads them for its missed
 * metrics (`dutyFixes`), the runner sends a duty job back while a miss has no fix with a live job (`fixJobLive`), and a fix step that closes
 * starts a verify run of its duty (`closedFixes`). Pure and browser-safe.
 */

const DUTY_LINK = /^([a-z][a-z0-9_-]{0,39})\/([a-z][a-z0-9_]{0,39})$/;
export const DUTY_LINK_SHAPE = 'duty must be "<dutyId>/<metricKey>", like "d6/usable_pct_24h" or "checkin/stuck_steps"';

export function parseDutyLink(value: string): { duty: string; metric: string } | null {
  const match = DUTY_LINK.exec(value);
  return match ? { duty: match[1]!, metric: match[2]! } : null;
}
export const dutyLink = (duty: string, metric: string): string => `${duty}/${metric}`;

const OPEN: ReadonlySet<PlanItem["status"]> = new Set(["todo", "doing", "blocked"]);
const stepNumber = (id: string): number => Number(/\d+$/.exec(id)?.[0] ?? 0);

function linked(board: ChatBoard | null, duty: string): Map<string, PlanItem[]> {
  const byMetric = new Map<string, PlanItem[]>();
  const visit = (items: readonly PlanItem[]) => {
    for (const item of items) {
      const link = item.duty ? parseDutyLink(item.duty) : null;
      if (link?.duty === duty) byMetric.set(link.metric, [...byMetric.get(link.metric) ?? [], item]);
      visit(item.children);
    }
  };
  visit(board?.plan ?? []);
  return byMetric;
}

/**
 * The fix step for each of `metrics` on the board: the open step with a live job first, then any open step, then the newest closed one, so a
 * metric that still misses after its fix closed names that fix. `live` says whether a step's job is at work; a closed step never counts as live.
 */
export async function dutyFixes(board: ChatBoard | null, duty: string, metrics: readonly string[], live: (item: PlanItem) => Promise<boolean>): Promise<Record<string, FixLink>> {
  const steps = linked(board, duty);
  const fixes: Record<string, FixLink> = {};
  for (const metric of metrics) {
    const found = steps.get(metric) ?? [];
    const open = found.filter(item => OPEN.has(item.status));
    let pick: { item: PlanItem; live: boolean } | undefined;
    for (const item of open) {
      if (item.job && await live(item)) { pick = { item, live: true }; break; }
      pick ??= { item, live: false };
    }
    if (!pick) {
      const newest = [...found].sort((a, b) => stepNumber(b.id) - stepNumber(a.id))[0];
      if (newest) pick = { item: newest, live: false };
    }
    if (pick) fixes[metric] = { step: pick.item.id, ...(pick.item.job ? { job: pick.item.job } : {}), live: pick.live };
  }
  return fixes;
}

/**
 * The board ops that make `job` the owner of each missed metric's fix step (`Duties.ownFixes`): an open step linked `<duty>/<metric>` gets the
 * job and its session when it has one, and a metric with no open step gets a new doing step under the duty's board goal when that goal is open. Read from the
 * board inside the write's lock, so a step the chat added meanwhile is reused rather than doubled.
 */
export function fixStepOps(board: ChatBoard, duty: { id: string; name: string; boardGoal?: string; metrics: readonly { key: string; label: string; unit?: string }[] },
  misses: readonly { key: string; value: number; target: number; op: "<=" | ">=" }[], job: { id?: string; name: string }): BoardOp[] {
  const steps = linked(board, duty.id);
  let goal: PlanItem | undefined;
  const visit = (items: readonly PlanItem[]) => { for (const item of items) { if (item.id === duty.boardGoal) goal = item; visit(item.children); } };
  visit(board.plan);
  const parent = goal && OPEN.has(goal.status) ? { parent: goal.id } : {};
  return misses.map((miss): BoardOp => {
    const open = (steps.get(miss.key) ?? []).find(item => OPEN.has(item.status));
    const session = job.id ? { sessionId: job.id } : {};
    if (open) return { op: "plan_update", id: open.id, job: job.name, sessionId: job.id ?? null };
    const metric = duty.metrics.find(entry => entry.key === miss.key);
    const unit = metric?.unit ?? "";
    const text = `${metric?.label ?? miss.key} in the ${duty.name} duty reaches ${miss.op === "<=" ? "at most" : "at least"} ${miss.target}${unit}, from ${miss.value}${unit} on the last run`;
    return { op: "plan_add", ...parent, text: text.slice(0, 500), status: "doing", job: job.name, ...session, duty: dutyLink(duty.id, miss.key) };
  });
}

export const missedKeys = (run: Pick<DutyRunRecord, "metrics">): string[] => Object.entries(run.metrics).filter(([, result]) => !result.met).map(([key]) => key);

/** The steps with a duty link that were open or absent before and are done after: each starts one verify run of its duty. */
export function closedFixes(before: ChatBoard | null, after: ChatBoard): { step: string; duty: string; metric: string }[] {
  const was = new Map<string, PlanItem["status"]>();
  const seen = (items: readonly PlanItem[]) => { for (const item of items) { was.set(item.id, item.status); seen(item.children); } };
  seen(before?.plan ?? []);
  const closed: { step: string; duty: string; metric: string }[] = [];
  const visit = (items: readonly PlanItem[]) => {
    for (const item of items) {
      const link = item.duty ? parseDutyLink(item.duty) : null;
      if (link && item.status === "done" && was.get(item.id) !== "done") closed.push({ step: item.id, ...link });
      visit(item.children);
    }
  };
  visit(after.plan);
  return closed;
}

/**
 * Whether a fix step's job is at work, from the catalog rows: the chat's agent that owns the step (or carries its job's name or session) is
 * working, its session row works, or it sleeps on a pending board.wake (`asleep`, session ids). A job that ended its turn and waits for nothing is not live.
 */
export function fixJobLive(item: Pick<PlanItem, "id" | "job" | "sessionId">, chatId: string, rows: readonly SessionRow[], asleep: ReadonlySet<string>): boolean {
  const agents = rows.find(row => row.id === chatId)?.agents ?? [];
  const agent = agents.find(entry => entry.steps.includes(item.id)) ??
    agents.find(entry => (item.sessionId !== undefined && entry.sessionId === item.sessionId) || (item.job !== undefined && (entry.sender === item.job || entry.name === item.job)));
  if (agent?.state === "working") return true;
  const session = agent?.sessionId ?? item.sessionId ?? rows.find(row => row.name === item.job && !row.archived)?.id;
  if (session === undefined) return false;
  const row = rows.find(candidate => candidate.id === session);
  return (row !== undefined && !row.archived && row.working) || asleep.has(session);
}
