import { BOARD_LIMITS, nextIds, openGoals, sameAreaGoal, titleDetail } from "./chat-board.ts";
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
 * A step title with the internal detail the board refuses (c61, `titleDetail`) cut to its plain stem, so "land.yml runs that passed" reads
 * "land runs that passed" and a sha or run id goes. Each pass makes the text shorter, so it ends.
 */
export function plainStepTitle(text: string): string {
  let out = text;
  for (let detail = titleDetail(out); detail; detail = titleDetail(out)) {
    const stem = detail.split("/").filter(Boolean).at(-1)?.replace(/\.[\w-]+$/, "") ?? "";
    out = out.replace(detail, stem && stem !== detail && !titleDetail(stem) ? stem : "").replace(/\s{2,}/g, " ").trim();
  }
  return out;
}

type FixDutyShape = { id: string; name: string; goal?: string; boardGoal?: string; metrics: readonly { key: string; label: string; unit?: string }[] };

/** An item with the top-level goal above it, or the item itself when it is a goal. */
function located(plan: readonly PlanItem[], id: string): { item: PlanItem; path: PlanItem[] } | undefined {
  for (const goal of plan) {
    if (goal.id === id) return { item: goal, path: [goal] };
    const below = located(goal.children, id);
    if (below) return { item: below.item, path: [goal, ...below.path] };
  }
  return undefined;
}
const subtreeTop = (item: PlanItem): number => Math.max(stepNumber(item.id), ...item.children.map(subtreeTop));

/**
 * Where a duty's new fix steps go, so the add never trips the board's goal limit (`BOARD_LIMITS.openGoals`, c44): the duty's board goal when
 * adding under it opens no goal past the limit (a done goal reopens), else the open goal that holds the duty's newest linked step, else one new
 * goal for the duty while the limit has room, else the open goal of the same area, else the open goal with the newest step. On 10-15 from
 * 14:38Z the server's write was refused every 30 s for 01a115e2 d2, 01a11ba8 d2 (board goal done, 3 misses as 3 new goals past the limit)
 * and 01a11bd7's check-in (no board goal, 6 goals open), so those duties never got a fix job.
 */
function fixParent(board: ChatBoard, duty: FixDutyShape): { parent: string; ops: BoardOp[] } {
  const goals = openGoals(board.plan);
  const room = goals.length < BOARD_LIMITS.openGoals;
  const home = duty.boardGoal ? located(board.plan, duty.boardGoal) : undefined;
  if (home && home.path.every(item => item.status !== "dropped") && (OPEN.has(home.path[0]!.status) || room)) return { parent: home.item.id, ops: [] };
  const newest = [...linked(board, duty.id).values()].flat().sort((a, b) => stepNumber(b.id) - stepNumber(a.id))
    .map(item => located(board.plan, item.id)!.path[0]!).find(goal => OPEN.has(goal.status));
  if (newest) return { parent: newest.id, ops: [] };
  if (room) {
    const id = nextIds(board)("p");
    return { parent: id, ops: [{ op: "plan_add", text: plainStepTitle(`${duty.name} duty meets every target`).slice(0, BOARD_LIMITS.text), status: "doing" }] };
  }
  const area = sameAreaGoal(board.plan, `${duty.name} ${duty.goal ?? ""}`) ?? [...goals].sort((a, b) => subtreeTop(b) - subtreeTop(a))[0]!;
  return { parent: area.id, ops: [] };
}

/**
 * The board ops that make `job` the owner of each missed metric's fix step (`Duties.ownFixes`): an open step linked `<duty>/<metric>` gets the
 * job and its session when it has one, and a metric with no open step gets a new doing step with a plain title (`plainStepTitle`) under its
 * home (`fixParent`). Read from the board inside the write's lock, so a step the chat added meanwhile is reused rather than doubled.
 */
export function fixStepOps(board: ChatBoard, duty: FixDutyShape, misses: readonly { key: string; value: number; target: number; op: "<=" | ">=" }[],
  job: { id?: string; name: string }): BoardOp[] {
  const steps = linked(board, duty.id);
  const session = job.id ? { sessionId: job.id } : {};
  const updates: BoardOp[] = [];
  const fresh: typeof misses[number][] = [];
  for (const miss of misses) {
    const open = (steps.get(miss.key) ?? []).find(item => OPEN.has(item.status));
    if (open) updates.push({ op: "plan_update", id: open.id, job: job.name, sessionId: job.id ?? null });
    else fresh.push(miss);
  }
  if (!fresh.length) return updates;
  const home = fixParent(board, duty);
  return [...updates, ...home.ops, ...fresh.map((miss): BoardOp => {
    const metric = duty.metrics.find(entry => entry.key === miss.key);
    const unit = metric?.unit ?? "";
    const text = plainStepTitle(`${metric?.label ?? miss.key} in the ${duty.name} duty reaches ${miss.op === "<=" ? "at most" : "at least"} ${miss.target}${unit}, from ${miss.value}${unit} on the last run`);
    return { op: "plan_add", parent: home.parent, text: text.slice(0, BOARD_LIMITS.text), status: "doing", job: job.name, ...session, duty: dutyLink(duty.id, miss.key) };
  })];
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
 * How long a fix job's session counts as live while the catalog does not list it yet. The catalog's full daemon list answered in 77 s at p99
 * and 1,249 s at most over 2,995 lists on 10-15 (service.log), so a job the server just created can be missing from the rows for minutes.
 */
export const UNLISTED_LIVE_MS = 1_250_000;

/** When a UUIDv7 session id was made (its first 48 bits are Unix ms); null for any other id. */
export function sessionBornAt(id: string): number | null {
  const hex = id.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex) || hex[12] !== "7") return null;
  return parseInt(hex.slice(0, 12), 16);
}

/**
 * Whether a fix step's job is at work, from the catalog rows: the chat's agent that owns the step (or carries its job's name or session) is
 * working or waits in the Mac-wide turn queue (`queued`), its session row works, it sleeps on a pending board.wake (`asleep`, session ids), its
 * session has a place or a slot in pi-pool's queue (`waiting`, session ids), or the catalog does not list its session yet and the session is
 * under UNLISTED_LIVE_MS old. A job that ended its turn and waits for nothing is not live. A queued job reads idle everywhere else: after the
 * 10-15 13:49Z restart the server opened "fix portal matches crawler api portal vp" 7 times in 39 min, each while the one before waited for a
 * slot. A fix job is a root, not an agent of the chat, so its queue place shows only in pi-pool: after 8e2d2db the server still opened "fix
 * check-in launch main bro" at 16:09:25Z and again at 16:09:46Z, and "fix portal stays up api portal vp" at 15:28Z, 15:32Z and 16:08Z.
 */
export function fixJobLive(item: Pick<PlanItem, "id" | "job" | "sessionId">, chatId: string, rows: readonly SessionRow[], asleep: ReadonlySet<string>,
  waiting: ReadonlySet<string> = new Set(), now: number = Date.now()): boolean {
  const agents = rows.find(row => row.id === chatId)?.agents ?? [];
  const agent = agents.find(entry => entry.steps.includes(item.id)) ??
    agents.find(entry => (item.sessionId !== undefined && entry.sessionId === item.sessionId) || (item.job !== undefined && (entry.sender === item.job || entry.name === item.job)));
  if (agent?.state === "working" || agent?.queued !== undefined) return true;
  const session = agent?.sessionId ?? item.sessionId ?? rows.find(row => row.name === item.job && !row.archived)?.id;
  if (session === undefined) return false;
  if (asleep.has(session) || waiting.has(session)) return true;
  const row = rows.find(candidate => candidate.id === session);
  if (row === undefined) {
    const born = sessionBornAt(session);
    return born !== null && now - born < UNLISTED_LIVE_MS;
  }
  return !row.archived && row.working;
}
