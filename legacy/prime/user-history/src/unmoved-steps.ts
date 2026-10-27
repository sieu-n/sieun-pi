import { clockTime } from "./checkin-settings.ts";
import { liveWindowMs, OPEN, parkedBy, quote, walk } from "./checkin-steps.ts";
import { BRIEF_ITEMS } from "./shared/brief-cap.ts";
import { jobSession } from "./shared/chat-board.ts";
import { heldByTodo } from "./shared/todo-hold.ts";
import type { ChatBoard, PlanItem, SessionRow } from "./shared/types.ts";

/**
 * The sessions that own a step: its session id, and each session of a job of the chat, not deleted, that carries the step's job name (`named`).
 * At 07:40Z on 10-18 Crawler VP's p510 and p700 kept the session of the stopped "crawler ops train before move" while "crawler ops train",
 * its continuation after the host move, slept on 9 CI run wakes. A job field that holds a session id names that session: at 06:05Z on 10-25
 * SEO guy's p101 had job set to the thread "sep launch!!" (01a15427-145f) with no sessionId, so d9 read it as running on the chat's own
 * us-metal02 and counted it stuck, though that thread sat on the offline Mac that For you t30 asked the owner to bring back. A job field written
 * as `thread:<id>` names that session the same way (`jobSession`).
 */
export function stepSessions(item: { sessionId?: string; job?: string }, named: ReadonlyMap<string, readonly string[]>): string[] {
  const own = jobSession(item.job);
  const job = item.job ? named.get(item.job) ?? (own ? [own] : []) : [];
  return [...new Set([...item.sessionId ? [item.sessionId] : [], ...job])];
}

/**
 * Each session's last write raised to the newest write of any session below it (`parents`, child to parent, at any depth). A job that waits on
 * its own subagents moves its step while they work: at 22:57Z on 10-27 d9 counted frontend bro's p354, whose job "ai chat like claude" went
 * idle at 22:58Z on a pi-pool token failure while its subagents chat-cards-fix and chat-endpage-fix still worked on p354 on the Mac.
 */
export function withDescendantActivity(activity: ReadonlyMap<string, number>, parents: ReadonlyMap<string, string>): Map<string, number> {
  const out = new Map(activity);
  for (const [session, at] of activity) {
    const seen = new Set([session]);
    for (let up = parents.get(session); up !== undefined && !seen.has(up); up = parents.get(up)) {
      seen.add(up);
      if (at > (out.get(up) ?? -Infinity)) out.set(up, at);
    }
  }
  return out;
}

/** What tells whether a step's owner moves it: when each session last wrote, the sessions a board.wake or a pool slot holds, and each job name's sessions. */
export interface OwnerReads {
  activity: ReadonlyMap<string, number>;
  live: ReadonlySet<string>;
  named: ReadonlyMap<string, readonly string[]>;
}

/**
 * The open leaf steps of a board that nobody moves, read from the board and the step owners alone. A step is held when an open For you todo
 * links it (its step field or `heldByTodo`) or an owner correction parks it (`parkedBy`), and moving when one of its owners (`stepSessions`)
 * sleeps on a board.wake, waits for its pi-pool slot (`live`) or wrote within the check-in's live window (`liveWindowMs`). d9 counts a paused
 * chat's stuck steps with it, and the chat service tells every chat the same steps as they go stuck (`unmovedNotice`).
 */
export function unmovedSteps(board: ChatBoard | null | undefined, now: number, everyMs: number | undefined, { activity, live, named }: OwnerReads): PlanItem[] {
  const todos = board?.todos ?? [];
  const asked = new Set(todos.filter(todo => !todo.done && todo.step).map(todo => todo.step));
  const window = liveWindowMs(everyMs ?? Infinity);
  const out: PlanItem[] = [];
  walk(board?.plan ?? [], item => {
    if (!OPEN.has(item.status) || item.children.some(child => OPEN.has(child.status))) return;
    if (asked.has(item.id) || heldByTodo(item, todos) || parkedBy(item) !== undefined) return;
    if (stepSessions(item, named).some(session => live.has(session) || now - (activity.get(session) ?? -Infinity) <= window)) return;
    out.push(item);
  });
  return out;
}

/**
 * The owner reads of one chat from its catalog row, as d9 reads both boxes' rows (`withCatalogOwners`): the chat and each of its jobs wrote at
 * its `lastActivityAt`, or now while it works; a job asleep on a board.wake, queued for a pi-pool slot or with a subagent at work below it is
 * live; and each job's name and sender name its session.
 */
export function rowOwnerReads(row: Pick<SessionRow, "id" | "working" | "lastActivityAt" | "agents">, now: number): OwnerReads {
  const activity = new Map<string, number>();
  const live = new Set<string>();
  const named = new Map<string, string[]>();
  const wrote = (session: string, at: number) => { if (Number.isFinite(at) && at > (activity.get(session) ?? -Infinity)) activity.set(session, at); };
  wrote(row.id, row.working ? now : Date.parse(row.lastActivityAt ?? ""));
  for (const agent of row.agents ?? []) {
    const session = agent.sessionId;
    if (session === undefined) continue;
    wrote(session, agent.state === "working" ? now : Date.parse(agent.lastActivityAt ?? ""));
    if (agent.wait !== undefined || agent.queued !== undefined || (agent.subagentsRunning ?? 0) > 0) live.add(session);
    for (const name of new Set([agent.name, agent.sender])) if (name && !named.get(name)?.includes(session)) named.set(name, [...named.get(name) ?? [], session]);
  }
  return { activity, live, named };
}

/** One unmoved step in a notice: its id, title and wait or status, and its owner with when that owner last wrote. */
export function unmovedLine(step: PlanItem, reads: OwnerReads): string {
  const wait = step.waitFor !== undefined ? `waits for ${quote(step.waitFor)}` : `is ${step.status}`;
  const times = stepSessions(step, reads.named).map(session => reads.activity.get(session)).filter((at): at is number => at !== undefined);
  const owner = step.job ?? step.sessionId;
  const who = owner === undefined ? "no owner" : `${owner}${times.length ? `, quiet since ${clockTime(Math.max(...times))}` : ", not running"}`;
  return `${step.id} ${quote(step.text)} ${wait} (${who})`;
}

/** The turn a chat gets for its steps nobody moves (`unmovedSteps`): at most BRIEF_ITEMS of them, the file that lists the rest, and what to do now. */
export function unmovedNotice(lines: readonly string[], windowMs: number, detail?: string): string {
  const one = lines.length === 1;
  const rest = lines.length - BRIEF_ITEMS;
  const listed = [...lines.slice(0, BRIEF_ITEMS), ...rest > 0 ? [`and ${rest} more${detail ? `, all listed in ${detail}` : ""}`] : []];
  return `${one ? "This open step has" : "These open steps have"} no live owner: nobody wrote on ${one ? "it" : "them"} for ${Math.round(windowMs / 60_000)} min, ` +
    `and no board.wake, pi-pool slot or open For you todo holds ${one ? "it" : "them"}, so d9 counts ${one ? "it" : "them"} as stuck: ${listed.join("; ")}. ` +
    "Give each one a live owner now: send its job the next action or start a job for it, have the job that waits on something set a board.wake for it, " +
    "link it to the open For you todo it waits on, or close it with its evidence.";
}
