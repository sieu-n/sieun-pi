import { CHECK_IN_DUTY, type Duty, type DutyRunRecord, type FixLink, type FlaggedSlice } from "./chat-duties.ts";
import type { MetricStreak } from "./duty-streak.ts";
import type { BoardOp, ChatBoard, PlanItem, SessionRow } from "./types.ts";

/**
 * Fix steps: a plan step whose `duty` is `<dutyId>/<metricKey>` is the chat's fix for that duty metric. A duty run records them for its missed
 * metrics (`dutyFixes`, with `fixJobLive`), and a fix step that closes starts a verify run of its duty (`closedFixes`), whose reading goes into its note (`verifyNoteOps`). Pure and browser-safe.
 */

const DUTY_LINK = /^([a-z][a-z0-9_-]{0,39})\/([a-z][a-z0-9_]{0,39})$/;
export const DUTY_LINK_SHAPE = 'duty must be "<dutyId>/<metricKey>", like "d6/usable_pct_24h" or "checkin/stuck_steps"';

export function parseDutyLink(value: string): { duty: string; metric: string } | null {
  const match = DUTY_LINK.exec(value);
  return match ? { duty: match[1]!, metric: match[2]! } : null;
}
export const dutyLink = (duty: string, metric: string): string => `${duty}/${metric}`;

/** A chat's duties as a step's duty link can name them: each duty's name and its metric and reading keys, the check-in's included. */
export type DutyKeys = ReadonlyMap<string, { name: string; keys: readonly string[] }>;
type LinkedDuty = Pick<Duty, "id" | "name" | "metrics" | "readings">;
export function dutyKeys(duties: readonly LinkedDuty[]): DutyKeys {
  const all: readonly LinkedDuty[] = [CHECK_IN_DUTY, ...duties];
  return new Map(all.map(duty => [duty.id, { name: duty.name, keys: [...duty.metrics.map(metric => metric.key), ...(duty.readings ?? []).map(reading => reading.key)] }]));
}

/**
 * Why a duty link names nothing its chat's duties measure, with the real keys; null when the duty has that metric or reading. On 10-22 the AI
 * harness chat's p919 linked d5/tools_off, a metric d5 no longer had, so d9 read d5 red with no fix step.
 */
export function dutyLinkProblem(value: string, duties: DutyKeys): string | null {
  const link = parseDutyLink(value);
  if (!link) return `${DUTY_LINK_SHAPE}.`;
  const duty = duties.get(link.duty);
  const list = (keys: readonly string[]) => keys.length ? keys.join(", ") : "none";
  if (!duty) return `duty ${value} names ${link.duty}, which is no duty of this chat; its duties are ${[...duties].map(([id, { name, keys }]) => `${id} ${JSON.stringify(name)} (${list(keys)})`).join("; ")}.`;
  if (duty.keys.includes(link.metric)) return null;
  return `duty ${value} names ${link.metric}, which ${link.duty} ${JSON.stringify(duty.name)} does not measure; its metric keys are ${list(duty.keys)}.`;
}

const OPEN: ReadonlySet<PlanItem["status"]> = new Set(["todo", "doing", "blocked"]);
const stepNumber = (id: string): number => Number(/\d+$/.exec(id)?.[0] ?? 0);

interface Linked { item: PlanItem; path: readonly string[] }

function linked(board: ChatBoard | null, duty: string): Map<string, Linked[]> {
  const byMetric = new Map<string, Linked[]>();
  const visit = (items: readonly PlanItem[], above: readonly string[]) => {
    for (const item of items) {
      const path = [...above, item.id];
      const link = item.duty ? parseDutyLink(item.duty) : null;
      if (link?.duty === duty) byMetric.set(link.metric, [...byMetric.get(link.metric) ?? [], { item, path }]);
      visit(item.children, path);
    }
  };
  visit(board?.plan ?? [], []);
  return byMetric;
}

/**
 * The fix step for each of `metrics` on the board: the open step with a live job first, then any open step, then the newest closed one, so a
 * metric that still misses after its fix closed names that fix. `live` says whether a step's job is at work; a closed step never counts as live.
 * Steps at or under an item the run flagged for that metric (`flagged`, by kind) come first: Crawler VP's check-in at 21:21Z on 10-18 flagged
 * goal_gaps on p681, whose push step p696 has the job "tiktok shop products push", and recorded p671 "linkedin api fixes" under p670 instead.
 * The duty's own goal (`goal`, its `boardGoal`) is left out when given: a job that holds the goal watches the metric and fixes nothing, and on
 * 10-20 the job "wiki goal hold" on p200 (d4/wiki_problems) slept on a board.wake from 08:19Z, so it read as a live fix and no d4 push run
 * started until wiki_problems reached 26 at 09:36Z.
 * With no live step, an open step an open For you todo holds (`held`, the todo's name) comes next and carries `hold`: on 10-23 every d5 run
 * of the AI harness chat told its job to start a fix job on p919, which waited only on the owner's Apple sign-in, Railway Breach's t11.
 */
export async function dutyFixes(board: ChatBoard | null, duty: string, metrics: readonly string[], live: (item: PlanItem) => Promise<boolean>,
  flagged: readonly FlaggedSlice[] = [], goal?: string, held: (item: PlanItem) => string | undefined = () => undefined): Promise<Record<string, FixLink>> {
  const steps = linked(board, duty);
  const fixes: Record<string, FixLink> = {};
  for (const metric of metrics) {
    const items = new Set(flagged.flatMap(slice => slice.kind === metric && slice.item ? [slice.item] : []));
    const under = (step: Linked) => step.path.some(id => items.has(id));
    const ranked = (steps.get(metric) ?? []).filter(step => step.item.id !== goal);
    const found = [...ranked.filter(under), ...ranked.filter(step => !under(step))].map(step => step.item);
    const open = found.filter(item => OPEN.has(item.status));
    let pick: { item: PlanItem; live: boolean; hold?: string } | undefined;
    let first: PlanItem | undefined;
    for (const item of open) {
      if (item.job && await live(item)) { pick = { item, live: true }; break; }
      const hold = held(item);
      if (hold !== undefined) pick ??= { item, live: false, hold };
      first ??= item;
    }
    if (!pick && first) pick = { item: first, live: false };
    if (!pick) {
      const newest = [...found].sort((a, b) => stepNumber(b.id) - stepNumber(a.id))[0];
      if (newest) pick = { item: newest, live: false };
    }
    if (pick) fixes[metric] = { step: pick.item.id, ...(pick.item.job ? { job: pick.item.job } : {}), live: pick.live, ...(pick.hold ? { hold: pick.hold } : {}) };
  }
  return fixes;
}

export const missedKeys = (run: Pick<DutyRunRecord, "metrics">): string[] => Object.entries(run.metrics).filter(([, result]) => !result.met).map(([key]) => key);

/**
 * The ops that write a verify run's reading into the note of each fix step it finds closed while its metric still misses. The step stays done:
 * the duty's push owns the number, through a live fix job or a new fix job on a new step for a new cause. Until 10-22 a verify run reopened
 * such a step as todo with no job, and closing it again started the next verify run: AI harness closed p804 and p818 at 06:34Z on 10-22, the
 * verify runs read stuck_steps_all 1 and stuck_duties 4, reopened both, and they reopened again at 06:36Z, so the plan showed four todo steps
 * nobody worked (owner 10-22: "are they real items? are agents working on all of them actively?").
 */
export function verifyNoteOps(board: ChatBoard | null, streaks: readonly MetricStreak[], at: number): BoardOp[] {
  const steps = new Map<string, PlanItem>();
  const visit = (items: readonly PlanItem[]) => { for (const item of items) { steps.set(item.id, item); visit(item.children); } };
  visit(board?.plan ?? []);
  const notes = new Map<string, string>();
  for (const streak of streaks) {
    const step = streak.fix && steps.get(streak.fix.step);
    if (!step || step.status !== "done") continue;
    const words = `The ${new Date(at).toISOString().slice(11, 16)}Z verify run read ${streak.key} ${streak.value}, target ${streak.op} ${streak.target}.`;
    const note = notes.get(step.id) ?? step.note ?? "";
    if (!note.includes(words)) notes.set(step.id, note ? `${note} ${words}` : words);
  }
  return [...notes].map(([id, note]) => ({ op: "plan_update", id, note }));
}

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

/** Where `fixLiveReader` reads a fix job's state: the catalog rows, the sessions asleep on a board.wake, in pi-pool's queue, and held by pi-pool after a cut. */
export interface FixLiveSources {
  rows: () => Promise<readonly SessionRow[]>;
  asleep: (now: number) => Promise<Iterable<string>>;
  pool: () => Promise<Iterable<string>>;
  held: () => Iterable<string>;
}

/**
 * The duty runner's `fixLive`: `fixJobLive` with every wait a live job can be in. A job pi-pool holds after a cut waits for its pool time and is
 * in no queue place: on 10-19 api portal vp's d2 runs from 14:09Z to 14:40Z recorded its three parity jobs as not live while pi-pool held them.
 */
export function fixLiveReader(sources: FixLiveSources, clock: () => number = Date.now): (chatId: string, item: Pick<PlanItem, "id" | "job" | "sessionId">) => Promise<boolean> {
  return async (chatId, item) => {
    const now = clock();
    const [rows, asleep, pool] = await Promise.all([sources.rows(), sources.asleep(now).catch(() => []), sources.pool().catch(() => [])]);
    return fixJobLive(item, chatId, rows, new Set(asleep), new Set([...pool, ...sources.held()]), now);
  };
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
 * Every agent the step names counts, by its steps, its session id or its job's name: at 07:13Z on 10-18 Crawler VP's p364 kept the session id of
 * the stopped pre-move copy (renamed "census canary run before move") while the job "census canary run" it names slept on a board.wake, and
 * the old first-match test read only the stopped copy and recorded no live fix.
 */
export function fixJobLive(item: Pick<PlanItem, "id" | "job" | "sessionId">, chatId: string, rows: readonly SessionRow[], asleep: ReadonlySet<string>,
  waiting: ReadonlySet<string> = new Set(), now: number = Date.now()): boolean {
  const agents = rows.find(row => row.id === chatId)?.agents ?? [];
  const owners = agents.filter(entry => entry.steps.includes(item.id) || (item.sessionId !== undefined && entry.sessionId === item.sessionId) ||
    (item.job !== undefined && (entry.sender === item.job || entry.name === item.job)));
  if (owners.some(agent => agent.state === "working" || agent.queued !== undefined)) return true;
  const sessions = new Set([...owners.flatMap(agent => agent.sessionId ? [agent.sessionId] : []), ...item.sessionId ? [item.sessionId] : []]);
  const named = sessions.size ? undefined : rows.find(row => row.name === item.job && !row.archived)?.id;
  if (named) sessions.add(named);
  return [...sessions].some(session => {
    if (asleep.has(session) || waiting.has(session)) return true;
    const row = rows.find(candidate => candidate.id === session);
    if (row === undefined) {
      const born = sessionBornAt(session);
      return born !== null && now - born < UNLISTED_LIVE_MS;
    }
    return !row.archived && row.working;
  });
}
