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
 * `--part duties` is the precheck of agent factory's duty "Agents keep their duties" (agent-duties.duty.json); the default is d5's.
 * Without OUTPUT_FILE the result prints to stdout.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

interface Agent { id: string; name: string; archived?: boolean; hostState?: string }
interface Step { id: string; text: string; status: string; job?: string; waitFor?: string; waitUntil?: string }
interface Steps { open: number; stuck: Step[]; gaps: { id: string; text: string }[] }
interface CheckIn { everyMs: number; paused: boolean; lastAt: number | null; runs?: { at: number; verdict: string; summary: string }[] }
/** A row of `GET /api/agents/:id/duties`, the fields this check reads. */
export interface DutyRow {
  duty: { id: string; name: string; status?: string }; paused: boolean; runs: { verdict: string; at?: number }[];
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
export function dutyCoverage(agents: readonly { agent: Agent; duties: readonly DutyRow[]; brief?: string }[], areas: readonly AgentAreas[] = [], now = Date.now()): { metrics: Record<string, number>; flagged: Flag[] } {
  const flagged: Flag[] = [];
  let uncoveredAgents = 0;
  let uncoveredAreas = 0;
  let noArea = 0;
  let paused = 0;
  let overdue = 0;
  for (const { agent, duties, brief } of agents) {
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
    if (live.length === 0 && given.length === 0 && !brief?.trim()) {
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

async function get<T>(server: string, path: string): Promise<T> {
  const res = await fetch(`${server}${path}`);
  if (!res.ok) throw new Error(`GET ${path} answered ${res.status}`);
  return await res.json() as T;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // `--part boards` (the default, d5 "Agent boards") reads steps and check-ins; `--part duties` (agent factory's "Agents keep their duties")
  // reads each agent's duties, brief and areas.
  const { values } = parseArgs({ options: { server: { type: "string" }, areas: { type: "string" }, part: { type: "string" } } });
  const part = values.part ?? "boards";
  if (part !== "boards" && part !== "duties") throw new Error(`--part ${part} is neither boards nor duties`);
  const server = values.server ?? process.env.APPS_CHAT_URL ?? "http://127.0.0.1:5184";
  const areasFile = values.areas ?? process.env.AREAS_FILE ?? join(homedir(), "work/agent-duties/areas.json");
  const agents = (await get<Agent[]>(server, "/api/agents")).filter(agent => !agent.archived && agent.hostState !== "away");
  const json = part === "boards"
    ? JSON.stringify(agentBoards(await Promise.all(agents.map(async agent => ({
      agent, steps: await get<Steps>(server, `/api/agents/${agent.id}/steps`), checkIn: await get<CheckIn>(server, `/api/agents/${agent.id}/check-in`),
    }))), Date.now()), null, 1)
    : JSON.stringify({
      ...dutyCoverage(await Promise.all(agents.map(async agent => ({
        agent, duties: (await get<{ duties: DutyRow[] }>(server, `/api/agents/${agent.id}/duties`)).duties,
        brief: (await get<{ brief?: { text?: string } }>(server, `/api/agents/${agent.id}/folder`)).brief?.text ?? "",
      }))), readAreas(areasFile), Date.now()),
      areasFile: existsSync(areasFile) ? areasFile : null,
    }, null, 1);
  if (process.env.OUTPUT_FILE) writeFileSync(process.env.OUTPUT_FILE, json);
  else console.log(json);
}
