/**
 * Duty precheck: every open step on every sw factory agent's board is moved or held on the owner, by the owner's rule (#sw-factory-build
 * p205, 11-24, msg mwtu5kfz: "all board items should be either user-bottlenecked or actively being worked on"). It reads each agent's
 * `GET /api/agents/:id/steps`, which counts by the same rule as the check-in (server/check-in-job.ts `checkInPrecheck`): a step is moved
 * while its own job is at work, a subagent of it works or it sleeps on a board.wake, and held while an open For you todo links it or it waits
 * on the owner's go. It also reads each agent's check-in runs (`GET /api/agents/:id/check-in`), and a check-in that is not paused and has no
 * run in 1.5 of its intervals is late, as Prime's d9 reads a late check-in (legacy/prime/user-history/src/checkin-schedule.ts). Until 11-24
 * nothing counted this for sw factory: d9 leaves sw factory boards off `stuck_steps_all`, and by the owner's rule 7 of 44 open steps had
 * neither a live owner nor an open For you todo (~/work/duty-and-nudge/part3-lazy.md).
 *
 * It also counts the agents that keep no live duty over their areas, by the owner's ask (#dev-api-portal p27, msg mwwk9n6k, 11-26: "make sure
 * all other agents are well behaved in terms of keeping their responsibilities"; p25: "think of duty as copy pasting this prompt every day").
 * A duty is live when it is not paused and has at least one run that measured something; a paused or never-run duty counts as none. An agent
 * with no live duty is uncovered. An areas file (AREAS_FILE, default ~/work/agent-duties/areas.json, `[{agent, areas: [{area, source, duty?}]}]`,
 * agent by id or name, duty by id or name) lists the areas the owner gave each agent, and an area is uncovered while it names no duty or its
 * duty is not live. A duty also stops being live when its runs stop for over 2 of its intervals, and each paused or overdue duty is a
 * flagged item of its own (duties_paused, duties_overdue), as fable auditor's d2 counted them on 11-26. An agent with no brief and no area in the file has no area, so it is left out and listed apart: on 11-26 feature probe
 * had no brief, steps, jobs or owner post, and said it owns nothing. On 11-26 at 05:13 KST, 6 of 17 agents had no duty at all.
 *
 * Usage: OUTPUT_FILE=<file> node --import tsx scripts/duties/agent-boards.ts [--part boards|duties] [--server http://127.0.0.1:5184] [--areas <file>]
 * `--part duties` is the precheck of agent factory's duty "Agents keep their duties" (agent-duties.duty.json, d7); the default is d5's. Since
 * c249 (#sw-factory-build p234, msg mwwklmfk, 11-26) d7 also checks each agent's two common duties (`agentPattern`) and its output carries
 * `messages`, one nudge per agent off the pattern in the shape of ~/work/agent-duties/messages.json, which the work thread relays. Since
 * the owner's p237 (msg mwwksq7v) it also counts wiki clutter (`wikiClutter`), read from the wiki config's content root and agents mount.
 * Without OUTPUT_FILE the result prints to stdout.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import { parseArgs } from "node:util";

interface Agent { id: string; name: string; archived?: boolean; hostState?: string; thread?: string }
interface Step { id: string; text: string; status: string; job?: string; waitFor?: string; waitUntil?: string }
interface Steps { open: number; stuck: Step[]; gaps: { id: string; text: string }[] }
interface CheckIn { everyMs: number; paused: boolean; lastAt: number | null; runs?: { at: number; verdict: string; summary: string }[] }
/** A row of `GET /api/agents/:id/duties`, the fields this check reads. */
export interface DutyRow {
  duty: { id: string; name: string; status?: string; ownerWords?: string; goal?: string }; paused: boolean;
  runs: { verdict: string; at?: number; job?: { id: string }; readings?: Record<string, number>; metrics?: Record<string, { value?: number }>; detail?: string }[];
  schedule?: { kind: string; at?: string; minutes?: number }; nextAt?: number | null;
}
/** One entry of the areas file: the areas the owner made an agent responsible for, each with the duty that watches it, if any. */
export interface AgentAreas { agent: string; areas: { area: string; source?: string; duty?: string | null }[] }

const DAY_MS = 86_400_000;

/** A paused duty; it watches nothing. */
export function pausedDuty(row: DutyRow): boolean {
  return row.paused || row.duty.status === "paused";
}

/**
 * A duty whose runs stopped: not paused, and its next run (`nextAt`, one interval after its last run, or after its creation when it never
 * ran) is more than one more interval past, so nothing ran for over 2 of its intervals. fable auditor's d2 reads stopped runs the same way
 * (~/.pi/agent/agents/fable-auditor/duties/keep-responsibilities.py, 11-26).
 */
export function overdueDuty(row: DutyRow, now: number): boolean {
  const every = row.schedule?.kind === "every" && row.schedule.minutes ? row.schedule.minutes * 60_000 : DAY_MS;
  return !pausedDuty(row) && typeof row.nextAt === "number" && now - row.nextAt > every;
}

/** A duty watches its area only while it is not paused, has a run that measured something (a skipped run measured nothing) and still runs. */
export function liveDuty(row: DutyRow, now = Date.now()): boolean {
  return !pausedDuty(row) && row.runs.some(run => run.verdict !== "skipped") && !overdueDuty(row, now);
}

/**
 * The agents that keep no live duty over their responsibilities: an agent with no live duty, and each area of the areas file whose duty is
 * missing or not live. Each uncovered agent gets one `uncovered_agent` flag that names it and its uncovered areas, so the duty job can tell it.
 */
export function dutyCoverage(agents: readonly { agent: Agent; duties: readonly DutyRow[]; brief?: string; asks?: readonly Ask[] }[], areas: readonly AgentAreas[] = [], now = Date.now()): { metrics: Record<string, number>; flagged: Flag[] } {
  const flagged: Flag[] = [];
  let uncoveredAgents = 0;
  let uncoveredAreas = 0;
  let noArea = 0;
  let paused = 0;
  let overdue = 0;
  for (const { agent, duties, brief, asks = [] } of agents) {
    for (const row of duties) {
      if (pausedDuty(row)) {
        paused += 1;
        flagged.push({ kind: "duty_paused", sig: `${agent.id}/${row.duty.id}/paused`, item: agent.id, excerpt: `${agent.name} ${row.duty.id} "${row.duty.name}" is paused` });
      } else if (overdueDuty(row, now)) {
        overdue += 1;
        const last = row.runs.find(run => run.verdict !== "skipped")?.at;
        const since = last ? `no run for ${Math.round((now - last) / 3_600_000)} h` : "no run since it was made";
        flagged.push({ kind: "duty_overdue", sig: `${agent.id}/${row.duty.id}/overdue`, item: agent.id, excerpt: `${agent.name} ${row.duty.id} "${row.duty.name}" has ${since}, due ${Math.round((now - row.nextAt!) / 3_600_000)} h ago` });
      }
    }
    const live = duties.filter(row => liveDuty(row, now));
    // An area whose source is "none found" is the file's placeholder for an agent no owner post gave an area, not an ask of his.
    const given = areas.filter(entry => entry.agent === agent.id || entry.agent === agent.name).flatMap(entry => entry.areas).filter(area => area.source?.trim().toLowerCase() !== "none found");
    if (live.length === 0 && given.length === 0 && !brief?.trim() && asks.length === 0) {
      noArea += 1;
      flagged.push({ kind: "no_area", sig: `${agent.id}/no-area`, item: agent.id, excerpt: `${agent.name} (${agent.id}) has no brief and no area from the owner, so it owns nothing to watch` });
      continue;
    }
    const missed = given.filter(area => !area.duty || !live.some(row => row.duty.id === area.duty || row.duty.name === area.duty));
    uncoveredAreas += missed.length;
    if (live.length > 0 && missed.length === 0) continue;
    uncoveredAgents += 1;
    const notLive = duties.filter(row => !liveDuty(row, now)).map(row => `${row.duty.id} ${pausedDuty(row) ? "paused" : overdueDuty(row, now) ? "overdue" : "never ran"}`);
    const why = [
      ...live.length === 0 ? [duties.length === 0 ? "no duty" : `no live duty (${notLive.join(", ")})`] : [],
      ...missed.map(area => `area "${area.area.slice(0, 100)}"${area.source ? ` (${area.source})` : ""} ${area.duty ? `has duty ${area.duty}, not live` : "has no duty"}`),
    ];
    flagged.push({ kind: "uncovered_agent", sig: `${agent.id}/duties`, item: agent.id, excerpt: `${agent.name} (${agent.id}): ${why.join("; ")}` });
  }
  return { metrics: { agents_uncovered: uncoveredAgents, areas_uncovered: uncoveredAreas, agents_without_area: noArea, duties_paused: paused, duties_overdue: overdue }, flagged };
}

/** The daily area review every agent keeps by the owner's c249 (#sw-factory-build p234, msg mwwklmfk); duty-rule seeds it by this name. */
export const AREA_REVIEW = "Area review";
/** c249's board push runs every 3 hours: the agent's check-in at 180 min or less. */
export const PUSH_MAX_MS = 180 * 60_000;
/** The readings area-review.ts writes for the agent's own wiki pages and memory changed in the last 24 h. */
export const REVIEW_READINGS = ["wiki_pages_touched_24h", "memory_changed_24h"] as const;

/** An agent's check-in: `everyMs` is its interval now (daily while its plan is empty), `planEveryMs` the interval it keeps for a plan. */
export interface PushRead { everyMs: number; planEveryMs?: number; paused: boolean; lastAt: number | null; runs?: { at: number }[] }
export interface AgentRead {
  agent: Agent; duties: readonly DutyRow[]; brief?: string; checkIn?: PushRead; stuck?: number; boardAt?: number | null;
  /** The owner's ongoing asks to the agent since its brief (`ongoingAsk`). */
  asks?: readonly Ask[];
  /** Per paused duty id, since when it is paused (the duty's `updatedAt` in its duties file) and the sentence that gives its reason, if any. */
  pauses?: Readonly<Record<string, { since: number; reason?: string }>>;
  /** Per duty id, the sample size its newest measured run's detail file names (`sampleSize`), or null when the file names none. */
  samples?: Readonly<Record<string, number | null>>;
}
/** An owner post to an agent: `ref` is "#room pN", `ids` the Prime message ids its inputs carried, which an agent quotes as "msg <id>". */
export interface Ask { ref: string; ids: readonly string[]; at: number; text: string }

/**
 * Words of an owner post that ask for ongoing care rather than one task (fable auditor's 11-26 audit; the owner's p25 "keep watching").
 * A bare "keep" or "monitor" read 18 asks on 11-26, among them "keep it this way" and "cosmetics monitor 가 200$/m", so each word needs
 * the verb form around it.
 */
export const ONGOING = new RegExp([
  "\\bkeep (watching|monitoring|checking|tracking|advising|reviewing|an eye)\\b", "\\b(daily|every ?day|each day|every morning|every week|weekly)\\b",
  "\\b(watch|monitor|review|track)(ing)? (this|it|that|the|them|our|all|every|each|for|over)\\b", "\\b(should|must) always\\b|\\balways be\\b",
  "계속 ?(확인|관찰|감시|모니터|봐|지켜)", "매일", "관찰", "감시", "항상",
].join("|"), "i");
export const ongoingAsk = (text: string): boolean => ONGOING.test(text);
const squash = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();

/** Whether a duty names the ask: its message id, its "#room pN" ref or its first 40 characters, in the duty's name, owner words or goal. */
export function askHeld(ask: Ask, duties: readonly DutyRow[]): boolean {
  const [room, post] = ask.ref.replace(/^#/, "").split(" ");
  const ref = new RegExp(`${room!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\W+${post}\\b`, "i");
  const quote = squash(ask.text).slice(0, 40);
  return duties.some(row => {
    const text = [row.duty.name, row.duty.ownerWords ?? "", row.duty.goal ?? ""].join("\n");
    return ask.ids.some(id => text.includes(id)) || ref.test(text) || (quote.length >= 20 && squash(text).includes(quote));
  });
}

/** A pause reason that names a condition a run can recheck, such as "until the paid proxy is back". */
export const PAUSE_CONDITION = /\b(until|till|while|once|when|after|unless)\b|까지/i;
/**
 * A pause to recheck: one older than a day whose reason names a condition, since the condition may hold by now (Crawler guy's d6, d8 and
 * d9 stayed paused about 45 h after the paid proxy came back, fable auditor 11-26), else one older than 7 days.
 */
export function stalePause(pause: { since: number; reason?: string }, now: number): boolean {
  return now - pause.since > (pause.reason && PAUSE_CONDITION.test(pause.reason) ? DAY_MS : 7 * DAY_MS);
}

/**
 * The sample size a run's detail file names: its `n`, or the smallest value of an `n` object per metric. A met run on 0 samples measured
 * nothing, as mcp's d1 read 100% success on 6 of 7 days with no customer call (fable auditor 11-26). Null when the detail names no `n`.
 */
export function sampleSize(detail: unknown): number | null {
  const n = (detail as { n?: unknown } | null)?.n;
  if (typeof n === "number" && Number.isFinite(n)) return n;
  if (n && typeof n === "object") {
    const values = Object.values(n).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (values.length) return Math.min(...values);
  }
  return null;
}

/**
 * The misses of earlier d7 runs at least a day old that the current run still flags, with no job of their agent at work since: the sig of
 * each, so a miss counts once however many runs flagged it. `jobsAt` holds, per agent, the times its jobs and duty jobs last worked.
 */
export function unfixedMisses(earlier: readonly { at: number; flagged: readonly Flag[] }[], current: readonly Flag[], jobsAt: ReadonlyMap<string, readonly number[]>, now: number): Flag[] {
  const firstSeen = new Map<string, number>();
  for (const run of earlier) {
    if (now - run.at < DAY_MS) continue;
    for (const flag of run.flagged) if (flag.item?.startsWith("ag_") && (firstSeen.get(flag.sig) ?? Infinity) > run.at) firstSeen.set(flag.sig, run.at);
  }
  return current.filter(flag => {
    const since = firstSeen.get(flag.sig);
    return since !== undefined && !(jobsAt.get(flag.item!) ?? []).some(at => at > since);
  });
}
/** A nudge for the work thread's relay, in the shape of ~/work/agent-duties/messages.json. */
export interface Nudge { agent: string; name: string; workThreadId: string | null; text: string }

/** Flag kinds that mean the agent itself has to act, each named in its nudge. */
const NUDGE_KINDS = new Set(["uncovered_agent", "duty_paused", "duty_overdue", "common_missing", "common_late", "empty_run", "ask_unheld", "pause_stale", "met_on_zero", "no_sample_size"]);

/**
 * Agent factory's meta check of c249: every live agent with an area keeps a 3-hourly board push (its check-in) and a daily "Area review"
 * duty, both run on time and produce work, no duty is paused or overdue, and a live duty covers each area it was given (`dutyCoverage`).
 * A board push is empty when the board has stuck steps and has not changed in 24 h. An area review run is empty when it started no job
 * and its readings (`REVIEW_READINGS`) are 0. Each agent off the pattern gets one nudge listing its misses.
 */
export function agentPattern(agents: readonly AgentRead[], areas: readonly AgentAreas[] = [], now = Date.now()): { metrics: Record<string, number>; flagged: Flag[]; messages: Nudge[] } {
  const coverage = dutyCoverage(agents, areas, now);
  const flagged = [...coverage.flagged];
  const noArea = new Set(coverage.flagged.filter(flag => flag.kind === "no_area").map(flag => flag.item));
  let missing = 0;
  let late = 0;
  let empty = 0;
  let unheld = 0;
  let stale = 0;
  let zero = 0;
  let noN = 0;
  for (const { agent, duties, checkIn, stuck = 0, boardAt, asks = [], pauses = {}, samples = {} } of agents) {
    if (noArea.has(agent.id)) continue;
    const flag = (kind: string, key: string, excerpt: string) => flagged.push({ kind, sig: `${agent.id}/${key}`, item: agent.id, excerpt: `${agent.name}: ${excerpt}` });
    for (const ask of asks) {
      if (askHeld(ask, duties)) continue;
      unheld += 1;
      flag("ask_unheld", `ask/${ask.ref}`, `the owner's ongoing ask ${ask.ref}${ask.ids[0] ? ` (msg ${ask.ids.at(-1)})` : ""}, "${squash(ask.text).slice(0, 140)}", is named by no duty`);
    }
    for (const row of duties) {
      const pause = pauses[row.duty.id];
      if (pausedDuty(row) && pause && stalePause(pause, now)) {
        stale += 1;
        flag("pause_stale", `${row.duty.id}/pause`, `${row.duty.id} "${row.duty.name}" has been paused ${Math.round((now - pause.since) / 3_600_000)} h${pause.reason ? ` for "${pause.reason.slice(0, 120)}"; check whether that still holds` : " with no reason on record; recheck it"}`);
      }
      if (pausedDuty(row) || !(row.duty.id in samples)) continue;
      const n = samples[row.duty.id];
      if (n === null) {
        noN += 1;
        flag("no_sample_size", `${row.duty.id}/n`, `${row.duty.id} "${row.duty.name}" writes no sample size n in its precheck output, so a met run on no input looks green`);
      } else if (n === 0 && row.runs.find(run => run.verdict !== "skipped")?.verdict === "met") {
        zero += 1;
        flag("met_on_zero", `${row.duty.id}/n0`, `${row.duty.id} "${row.duty.name}" read met on n = 0, so it measured nothing`);
      }
    }
    if (!checkIn) continue;
    const pushMs = checkIn.planEveryMs ?? checkIn.everyMs;
    if (checkIn.paused || pushMs > PUSH_MAX_MS) {
      missing += 1;
      flag("common_missing", "push", checkIn.paused ? "its check-in, the 3-hourly board push, is paused" : `its check-in, the board push, runs every ${Math.round(pushMs / 60_000)} min, not every 180 min or less`);
    } else {
      const newest = checkIn.runs?.[0]?.at ?? checkIn.lastAt;
      if (newest === null || now - newest > 2 * checkIn.everyMs) {
        late += 1;
        flag("common_late", "push/late", newest === null ? "its check-in has never run" : `its check-in last ran ${Math.round((now - newest) / 3_600_000)} h ago on a ${Math.round(checkIn.everyMs / 60_000)} min interval`);
      }
      if (stuck > 0 && (boardAt === null || boardAt === undefined || now - boardAt > DAY_MS)) {
        empty += 1;
        flag("empty_run", "push/empty", `its board push left ${stuck} stuck steps and the board has not changed in 24 h`);
      }
    }
    const review = duties.find(row => row.duty.name.trim().toLowerCase() === AREA_REVIEW.toLowerCase());
    if (!review) {
      missing += 1;
      flag("common_missing", "review", `it has no daily "${AREA_REVIEW}" duty`);
      continue;
    }
    if (pausedDuty(review) || overdueDuty(review, now)) continue; // flagged as duty_paused or duty_overdue
    const run = review.runs.find(item => item.verdict !== "skipped");
    if (!run) continue; // a review that never ran is new, and turns overdue after 2 days
    const readings = REVIEW_READINGS.reduce((sum, key) => sum + (run.readings?.[key] ?? run.metrics?.[key]?.value ?? 0), 0);
    if (!run.job && readings === 0) {
      empty += 1;
      flag("empty_run", `review/${review.duty.id}/empty`, `its ${review.duty.id} "${review.duty.name}" ran with no job, no wiki page and no memory change`);
    }
  }
  const messages: Nudge[] = [];
  for (const { agent } of agents) {
    const misses = flagged.filter(flag => flag.item === agent.id && NUDGE_KINDS.has(flag.kind)).map(flag => flag.excerpt.replace(/^[^:]*:\s*/, ""));
    if (!misses.length) continue;
    messages.push({
      agent: agent.id, name: agent.name, workThreadId: agent.thread ?? null,
      text: [`${agent.name}, the owner wants every agent to keep two common duties (#sw-factory-build p234, c249): a board push every 3 hours that moves the open steps on your board, which is your check-in at 180 min, and a daily "${AREA_REVIEW}" that watches your area, acts on issues, cleans up and updates your llm-wiki pages and agent files. Each has to run on time and produce work, no duty stays paused or overdue, and a duty covers each area he gave you. Today's check found:`,
        ...misses.map((miss, at) => `${at + 1}. ${miss}`), "Please fix each one yourself, then reply with what you changed and the duty ids."].join("\n"),
    });
  }
  return {
    metrics: {
      agents_off_pattern: messages.length, common_duties_missing: missing, common_duties_late: late, empty_runs: empty, ...coverage.metrics,
      asks_unheld: unheld, pauses_stale: stale, met_on_zero: zero, runs_without_n: noN,
      duties_stopped: coverage.metrics.duties_paused! + coverage.metrics.duties_overdue!,
    },
    flagged, messages,
  };
}

/** A path segment that carries a date or a session, job or run stamp, such as `queue-waits-2026-10-15.html` or `d7-261126-052811`. */
export const DATED = /20\d\d-\d\d-\d\d|^20\d\d[-_]?\d\d[-_]?\d\d|\d{6}[-_]\d{4,6}|(?:session|job|run)[-_]?\d{3,}/i;
/**
 * Folders under the wiki's agents/ mount that belong to no sw factory agent and are no clutter: the template new agents copy, and
 * harness-keeper, a Prime standing agent that keeps its folder here and is not in GET /api/agents.
 */
export const AGENT_FOLDERS_KEPT = new Set(["TEMPLATE", "harness-keeper"]);
/** A moved page's redirect stub (apps/wiki movePage): the page left, and the tree shows no row for it. */
const REDIRECT_STUB = /^<!--wiki\s*\{[^\n]*"moved_to"\s*:/;
/** The curated wiki folders read for dated pages; experiments/ is left out, because its folders start with a date by design. */
export const CURATED_FOLDERS = ["apps", "domains", "projects"] as const;

/**
 * Wiki clutter by the owner's #sw-factory-build p237 (msg mwwksq7v, 11-26): "agents folder full of slop clean up". It counts the folders
 * under agents/ that belong to no live agent (test, deleted and throwaway blind agents), and the dated one-off pages in the curated folders
 * that no curated page links to. A dated unit is a page path cut after its first dated segment, so a dated folder counts once; it is linked
 * when a page that is not itself dated and lies outside the unit names the unit's last segment, as an href or a wiki: link does.
 */
export function wikiClutter(agentFolders: readonly string[], liveSlugs: ReadonlySet<string>, pages: readonly { path: string; text: string }[]): { metrics: Record<string, number>; flagged: Flag[] } {
  const flagged: Flag[] = [];
  const orphans = agentFolders.filter(name => !name.startsWith(".") && !AGENT_FOLDERS_KEPT.has(name) && !liveSlugs.has(name)).sort();
  for (const name of orphans) flagged.push({ kind: "orphan_agent_folder", sig: `agents/${name}`, item: `agents/${name}`, excerpt: `agents/${name}/ belongs to no live agent` });
  const unitOf = (path: string): string | null => {
    const parts = path.split("/");
    const at = parts.findIndex((part, index) => index > 0 && DATED.test(part));
    return at < 0 ? null : parts.slice(0, at + 1).join("/");
  };
  const units = new Map<string, string[]>();
  for (const page of pages) {
    const unit = unitOf(page.path);
    if (unit && !REDIRECT_STUB.test(page.text)) units.set(unit, [...units.get(unit) ?? [], page.path]);
  }
  const curated = pages.filter(page => !unitOf(page.path));
  let dated = 0;
  for (const [unit, inside] of [...units].sort(([a], [b]) => a.localeCompare(b))) {
    const name = unit.split("/").at(-1)!.replace(/\.(html|md)$/, "");
    const named = new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);
    if (curated.some(page => named.test(page.text))) continue;
    dated += 1;
    flagged.push({ kind: "dated_page", sig: unit, item: unit, excerpt: `${unit}${inside.length > 1 ? ` (${inside.length} pages)` : ""} is a dated one-off page that no curated page links to` });
  }
  return { metrics: { wiki_clutter: orphans.length + dated, orphan_agent_folders: orphans.length, dated_pages: dated }, flagged };
}

/** The wiki on this box from ~/.config/sieun-pi/wiki.json: its agents/ folders and the curated pages (html and md) under `CURATED_FOLDERS`. */
export function readWiki(configFile: string): { agentFolders: string[]; pages: { path: string; text: string }[] } {
  const config = JSON.parse(readFileSync(configFile, "utf8")) as { contentRoot: string; mounts?: { agents?: string } };
  const agentsDir = config.mounts?.agents ?? join(config.contentRoot, "agents");
  const agentFolders = readdirSync(agentsDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  const pages: { path: string; text: string }[] = [];
  for (const folder of CURATED_FOLDERS) {
    const dir = join(config.contentRoot, folder);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(html|md)$/.test(entry.name)) continue;
      const file = join(entry.parentPath, entry.name);
      pages.push({ path: relative(config.contentRoot, file), text: readFileSync(file, "utf8") });
    }
  }
  pages.push(...["index.html", "index.md"].filter(name => existsSync(join(config.contentRoot, name))).map(name => ({ path: name, text: readFileSync(join(config.contentRoot, name), "utf8") })));
  return { agentFolders, pages };
}

/**
 * The areas file, or none when it is absent. It is a list of `{agent, areas}`, or an object keyed by agent id or name whose value holds
 * `areas` and `missing` lists of `{area, source, duty?}` (the duty gaps job's 11-26 file); keys that start with "_" are notes. Any other
 * shape throws, so a typo never reads as covered.
 */
export function readAreas(file: string): AgentAreas[] {
  if (!existsSync(file)) return [];
  const data: unknown = JSON.parse(readFileSync(file, "utf8"));
  const entries: unknown[] = Array.isArray(data) ? data : data && typeof data === "object"
    ? Object.entries(data).filter(([key]) => !key.startsWith("_")).map(([agent, value]) => {
      const { areas, missing } = (value ?? {}) as { areas?: unknown; missing?: unknown };
      if (!Array.isArray(areas) && !Array.isArray(missing)) return null;
      return { agent, areas: [...Array.isArray(areas) ? areas : [], ...Array.isArray(missing) ? missing : []] };
    })
    : [];
  const valid = (entry: unknown): entry is AgentAreas => typeof (entry as AgentAreas)?.agent === "string" && Array.isArray((entry as AgentAreas).areas)
    && (entry as AgentAreas).areas.every(area => typeof area?.area === "string");
  if ((!Array.isArray(data) && (!data || typeof data !== "object")) || !entries.every(valid)) {
    throw new Error(`${file} is not a list of {agent, areas: [{area, source, duty}]} or an object of agent: {areas, missing}`);
  }
  return entries as AgentAreas[];
}

/** Prime's late rule (checkin-schedule.ts): a check-in with no run in 1.5 intervals is late. */
export const LATE_INTERVALS = 1.5;

export interface Flag { kind: string; sig: string; item?: string; excerpt: string }

/** The precheck output for the agents' steps and check-ins read at `now`. */
export function agentBoards(agents: readonly { agent: Agent; steps: Steps; checkIn: CheckIn }[], now: number): { metrics: Record<string, number>; flagged: Flag[] } {
  const flagged: Flag[] = [];
  let open = 0;
  let stuck = 0;
  let gaps = 0;
  let late = 0;
  for (const { agent, steps, checkIn } of agents) {
    open += steps.open;
    stuck += steps.stuck.length;
    gaps += steps.gaps.length;
    for (const step of steps.stuck) {
      const why = [step.job ? `job ${step.job} not at work` : "no job", ...step.waitFor ? [`waits for "${step.waitFor}"`] : [], ...step.waitUntil ? [`waits until ${step.waitUntil}`] : []];
      flagged.push({ kind: "stuck_step", sig: `${agent.id}/${step.id}`, item: step.id, excerpt: `${agent.name} ${step.id} "${step.text.slice(0, 120)}" ${step.status}: ${why.join(", ")}` });
    }
    for (const goal of steps.gaps) flagged.push({ kind: "goal_gap", sig: `${agent.id}/${goal.id}`, item: goal.id, excerpt: `${agent.name} ${goal.id} "${goal.text.slice(0, 120)}" is short of its target and no live job owns it` });
    const newest = checkIn.runs?.[0]?.at ?? checkIn.lastAt;
    if (!checkIn.paused && newest !== null && now - newest > LATE_INTERVALS * checkIn.everyMs) {
      late += 1;
      flagged.push({ kind: "checkin_late", sig: `${agent.id}/checkin/${newest}`, excerpt: `${agent.name}'s check-in last ran ${Math.round((now - newest) / 60_000)} min ago on a ${Math.round(checkIn.everyMs / 60_000)} min interval` });
    }
  }
  return { metrics: { stuck_steps_all: stuck, goal_gaps_all: gaps, checkins_late: late, open_steps_all: open }, flagged };
}

/** An agent's board as GET /board returns it, the fields `pauseReason` reads. */
interface BoardRead { updatedAt?: string; plan?: { text?: string; note?: string; children?: unknown[] }[]; todos?: { text?: string; note?: string }[] }

/** A JSON file, or undefined when it is absent or not JSON. */
function readJson<T = unknown>(file: string): T | undefined {
  try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return undefined; }
}

/** The first sentence of the agent's board or the duty's goal that names the pause and the duty, by its id or name. */
export function pauseReason(row: DutyRow, board: BoardRead | undefined): string | undefined {
  const texts: string[] = [];
  const walk = (steps: readonly { text?: string; note?: string; children?: unknown[] }[] = []) => {
    for (const step of steps) {
      texts.push(step.text ?? "", step.note ?? "");
      walk(step.children as typeof steps | undefined);
    }
  };
  walk(board?.plan);
  for (const todo of board?.todos ?? []) texts.push(todo.text ?? "", todo.note ?? "");
  texts.push(row.duty.goal ?? "");
  const id = new RegExp(`\\b${row.duty.id}\\b`);
  for (const sentence of texts.flatMap(text => text.split(/(?<=[.!?])\s+/))) {
    if (/paus/i.test(sentence) && (id.test(sentence) || sentence.includes(row.duty.name))) return sentence.trim();
  }
  return undefined;
}

/** The owner's ongoing asks to an agent since `since`: his DM posts and the group posts that tag it, or reach it untagged as a member. */
export function asksTo(store: { rooms: { rooms: readonly unknown[] }; postsOf(room: string): readonly unknown[] }, agent: Agent, since: number): Ask[] {
  const asks: Ask[] = [];
  for (const room of store.rooms.rooms as { id: string; kind: string; agent?: string; name?: string; test?: true; archived: boolean; members?: { agent: string; wakeOn: string }[] }[]) {
    if (room.test || room.archived) continue;
    const dm = room.kind === "dm";
    if (dm ? room.agent !== agent.id : !room.members?.some(member => member.agent === agent.id)) continue;
    for (const post of store.postsOf(room.id) as { id: string; author: string; text?: string; at: number; deletedAt?: number; mentions?: string[]; inputs?: { at: number }[] }[]) {
      if (post.author !== "owner" || post.deletedAt !== undefined || post.at <= since || !ongoingAsk(post.text ?? "")) continue;
      const tagged = (post.mentions ?? []).filter(id => id !== "owner");
      if (!dm && tagged.length && !tagged.includes(agent.id)) continue;
      asks.push({ ref: `${dm ? room.id : `#${room.name ?? room.id}`} ${post.id}`, ids: (post.inputs ?? []).map(input => input.at.toString(36)), at: post.at, text: post.text ?? "" });
    }
  }
  return asks;
}

async function get<T>(server: string, path: string): Promise<T> {
  const res = await fetch(`${server}${path}`);
  if (!res.ok) throw new Error(`GET ${path} answered ${res.status}`);
  return await res.json() as T;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // `--part boards` (the default, d5 "Agent boards") reads steps and check-ins; `--part duties` (agent factory's "Agents keep their duties")
  // reads each agent's duties, brief and areas.
  const { values } = parseArgs({ options: { server: { type: "string" }, areas: { type: "string" }, part: { type: "string" }, wiki: { type: "string" }, "data-dir": { type: "string" } } });
  const part = values.part ?? "boards";
  if (part !== "boards" && part !== "duties") throw new Error(`--part ${part} is neither boards nor duties`);
  const server = values.server ?? process.env.APPS_CHAT_URL ?? "http://127.0.0.1:5184";
  const areasFile = values.areas ?? process.env.AREAS_FILE ?? join(homedir(), "work/agent-duties/areas.json");
  const agents = (await get<Agent[]>(server, "/api/agents")).filter(agent => !agent.archived && agent.hostState !== "away");
  const json = part === "boards"
    ? JSON.stringify(agentBoards(await Promise.all(agents.map(async agent => ({
      agent, steps: await get<Steps>(server, `/api/agents/${agent.id}/steps`), checkIn: await get<CheckIn>(server, `/api/agents/${agent.id}/check-in`),
    }))), Date.now()), null, 1)
    : JSON.stringify(await (async () => {
      const now = Date.now();
      const dataDir = values["data-dir"] ?? process.env.APPS_CHAT_DATA_DIR ?? join(homedir(), ".pi/agent/chat");
      const { AgentStore } = await import("../../server/agent-store.ts");
      const store = new AgentStore(dataDir);
      const reads = await Promise.all(agents.map(async agent => {
        const [board, duties, folder, checkIn, steps, jobs] = await Promise.all([
          get<{ board?: BoardRead }>(server, `/api/agents/${agent.id}/board`).then(answer => answer.board),
          get<{ duties: DutyRow[] }>(server, `/api/agents/${agent.id}/duties`).then(answer => answer.duties),
          get<{ brief?: { text?: string; modifiedAt?: number | null } }>(server, `/api/agents/${agent.id}/folder`),
          get<PushRead>(server, `/api/agents/${agent.id}/check-in`),
          get<Steps>(server, `/api/agents/${agent.id}/steps`),
          get<{ agents: { lastActivityAt?: string }[] }>(server, `/api/agents/${agent.id}/agents`).then(answer => answer.agents),
        ]);
        const stored = readJson<{ duties?: { id: string; updatedAt?: number }[] }>(join(dataDir, "agents", agent.id, "duties.json"))?.duties ?? [];
        const pauses = Object.fromEntries(duties.filter(pausedDuty).map(row => [row.duty.id, {
          since: stored.find(duty => duty.id === row.duty.id)?.updatedAt ?? now, ...pauseReason(row, board) ? { reason: pauseReason(row, board)! } : {},
        }]));
        const samples: Record<string, number | null> = {};
        for (const row of duties) {
          const detail = row.runs.find(run => run.verdict !== "skipped")?.detail;
          if (detail && existsSync(detail)) samples[row.duty.id] = sampleSize(readJson(detail));
        }
        const jobsAt = [...jobs.flatMap(job => job.lastActivityAt ? [Date.parse(job.lastActivityAt)] : []), ...duties.flatMap(row => row.runs.flatMap(run => run.job && run.at ? [run.at] : []))];
        return {
          read: {
            agent, duties, brief: folder.brief?.text ?? "", checkIn, stuck: steps.stuck.length, boardAt: board?.updatedAt ? Date.parse(board.updatedAt) : null,
            asks: asksTo(store, agent, folder.brief?.text?.trim() ? folder.brief.modifiedAt ?? 0 : 0), pauses, samples,
          } satisfies AgentRead,
          jobsAt,
        };
      }));
      const pattern = agentPattern(reads.map(entry => entry.read), readAreas(areasFile), now);
      // Every agent that is not archived keeps its folder, an away one too; GET /api/agents lists no test agent.
      const live = (await get<Agent[]>(server, "/api/agents")).filter(agent => !agent.archived);
      const slugs = new Set(await Promise.all(live.map(async agent => basename((await get<{ dir?: string }>(server, `/api/agents/${agent.id}/folder`)).dir ?? agent.id.replace(/^ag_/, "")))));
      const wiki = readWiki(values.wiki ?? process.env.WIKI_CONFIG ?? join(homedir(), ".config/sieun-pi/wiki.json"));
      const clutter = wikiClutter(wiki.agentFolders, slugs, wiki.pages);
      // This duty's own earlier runs, read back from their detail files, for the misses no job took up in a day.
      const own = (await get<{ duties: DutyRow[] }>(server, "/api/agents/ag_agent-factory/duties")).duties.find(row => row.duty.name === "Agents keep their duties");
      const earlier = (own?.runs ?? []).flatMap(run => run.detail && run.at && existsSync(run.detail) ? [{ at: run.at, flagged: readJson<{ flagged?: Flag[] }>(run.detail)?.flagged ?? [] }] : []);
      const unfixed = unfixedMisses(earlier, pattern.flagged, new Map(reads.map(entry => [entry.read.agent.id, entry.jobsAt])), now);
      const flagged = [...pattern.flagged, ...clutter.flagged, ...unfixed.map(flag => ({ ...flag, kind: "miss_unfixed_24h", sig: `unfixed/${flag.sig}`, excerpt: `${flag.excerpt} (flagged over a day ago, and no job of the agent worked since)` }))];
      return {
        metrics: { ...pattern.metrics, ...clutter.metrics, misses_unfixed_24h: unfixed.length }, n: agents.length, flagged, messages: pattern.messages,
        areasFile: existsSync(areasFile) ? areasFile : null,
      };
    })(), null, 1);
  if (process.env.OUTPUT_FILE) writeFileSync(process.env.OUTPUT_FILE, json);
  else console.log(json);
}
