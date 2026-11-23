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
 * Usage: OUTPUT_FILE=<file> node --import tsx scripts/duties/agent-boards.ts [--server http://127.0.0.1:5184]
 * Without OUTPUT_FILE the result prints to stdout.
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

interface Agent { id: string; name: string; archived?: boolean; hostState?: string }
interface Step { id: string; text: string; status: string; job?: string; waitFor?: string; waitUntil?: string }
interface Steps { open: number; stuck: Step[]; gaps: { id: string; text: string }[] }
interface CheckIn { everyMs: number; paused: boolean; lastAt: number | null; runs?: { at: number; verdict: string; summary: string }[] }

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
  const { values } = parseArgs({ options: { server: { type: "string" } } });
  const server = values.server ?? process.env.APPS_CHAT_URL ?? "http://127.0.0.1:5184";
  const agents = (await get<Agent[]>(server, "/api/agents")).filter(agent => !agent.archived && agent.hostState !== "away");
  const read = await Promise.all(agents.map(async agent => ({
    agent, steps: await get<Steps>(server, `/api/agents/${agent.id}/steps`), checkIn: await get<CheckIn>(server, `/api/agents/${agent.id}/check-in`),
  })));
  const json = JSON.stringify(agentBoards(read, Date.now()), null, 1);
  if (process.env.OUTPUT_FILE) writeFileSync(process.env.OUTPUT_FILE, json);
  else console.log(json);
}
