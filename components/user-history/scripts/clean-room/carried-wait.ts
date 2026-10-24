import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { firstClause, planJob } from "../../src/shared/chat-board.ts";
import type { ChatAgent, ChatBoard, PlanItem } from "../../src/shared/types.ts";
import { nextIds } from "../../src/shared/chat-board.ts";
import { ownedDescendants, readSession, type RunState, type Scenario, type SessionEvent, sessionFile, type Verdict } from "./session-read.ts";
import { type Delivery, readDelivery, steering, type TrialSession } from "./unrelated-ci-wait.ts";

/**
 * The clean-room scenario for check-ins that follow the live job carrying a wait (chat-2572 p18, 10-24). Its p8 and p10 waited on p6, whose
 * release job was live, and the check-in flagged them stalled 8 and 5 times, moved them under p6, tied an unrelated CI probe run to them, and
 * then read goal_gaps 1 and stuck_steps 2 because p6 was no leaf any more. A fresh chat gets one ordinary task whose plan needs a step that
 * waits about 3 h on another step's live job, and nothing says it is a test. The criteria live in the run folder's criteria.md.
 */
export const TASK = "get a separate job to sample the free space on this box's / every 15 minutes for the next 3 hours, as its own step. checking " +
  "its last sample against a fresh df and writing me a short page with all 12 readings and the trend is your own step, and it waits on the sampling step";
const STALL_MS = 2 * 60 * 60_000;
const OPEN = new Set(["todo", "doing", "blocked"]);
const STEP_FLAGS = new Set(["stalled_steps", "blocked_on_others", "stuck_steps", "stale_chase_24h"]);

interface Slice { kind: string; item?: string; excerpt: string }
interface Measure { at: number; metrics?: Record<string, { value: number }> }
interface Run extends Measure { duty: string; trigger: string; job?: { id: string; name: string }; flagged?: Slice[]; after?: Measure }
interface Snapshot { at: number; board: ChatBoard }
interface Carried { step: PlanItem; on: PlanItem; owners: string[]; since: number }

const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 240): string => (text.length > length ? text.slice(0, length - 1) + "\u2026" : text).replace(/\s+/g, " ");
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const files = (dir: string): string[] => existsSync(dir) ? readdirSync(dir).sort() : [];

function items(board: ChatBoard): Map<string, { item: PlanItem; parent?: string }> {
  const out = new Map<string, { item: PlanItem; parent?: string }>();
  const visit = (list: readonly PlanItem[], parent?: string) => { for (const item of list) { out.set(item.id, { item, ...parent ? { parent } : {} }); visit(item.children, item.id); } };
  visit(board.plan);
  return out;
}
const ownerOf = (item: PlanItem): string | undefined => planJob(item.job) ?? item.sessionId;
/** The owners of an item and of every open item under it. */
function owners(item: PlanItem): string[] {
  const out = new Set<string>();
  const visit = (at: PlanItem) => { if (!OPEN.has(at.status)) return; const owner = ownerOf(at); if (owner) out.add(owner); at.children.forEach(visit); };
  visit(item);
  return [...out];
}
const live = (agents: readonly ChatAgent[], owner: string): boolean =>
  agents.some(agent => agent.state === "working" && (agent.sessionId === owner || agent.name === owner || agent.job === owner));
const shape = (entry: { item: PlanItem; parent?: string }): string => `${ownerOf(entry.item) ?? ""}|${entry.item.sessionId ?? ""}|${entry.parent ?? ""}`;
const waitsOn = (item: PlanItem): string[] => (firstClause(item.waitFor ?? "").match(/\bp\d+\b/g) ?? []).filter(id => id !== item.id);

/** The carried waits of the board at `at`: each open step whose wait names an open step a working job carries, with how long it has waited so. */
function carriedAt(snaps: readonly Snapshot[], agents: readonly { at: number; list: ChatAgent[] }[], at: number): Carried[] {
  const index = snaps.findLastIndex(snap => snap.at <= at);
  if (index < 0) return [];
  const now = items(snaps[index]!.board);
  const team = agents.filter(entry => entry.at <= at).at(-1)?.list ?? [];
  const out: Carried[] = [];
  for (const { item } of now.values()) {
    if (!OPEN.has(item.status) || !item.waitFor) continue;
    for (const id of waitsOn(item)) {
      const on = now.get(id)?.item;
      if (!on || !OPEN.has(on.status)) continue;
      const by = owners(on).filter(owner => live(team, owner));
      if (!by.length) continue;
      let since = snaps[index]!.at;
      for (let back = index - 1; back >= 0; back--) {
        const then = items(snaps[back]!.board).get(item.id);
        if (!then || !waitsOn(then.item).includes(id) || shape(then) !== shape(now.get(item.id)!)) break;
        since = snaps[back]!.at;
      }
      out.push({ step: item, on, owners: by, since });
      break;
    }
  }
  return out;
}

export function judge(run: string, state: RunState, now = Date.now(), delivery?: Delivery): { verdict: Verdict; text: string } {
  const chat = state.chat.id;
  const ended = now >= (state.until ?? Infinity);
  const snaps: Snapshot[] = files(join(run, "boards")).map(file => { const board = readJson<ChatBoard>(join(run, "boards", file)); return { at: Date.parse(board.updatedAt) || 0, board }; })
    .sort((a, b) => a.at - b.at);
  const agents = files(join(run, "agents")).map(file => ({ at: Number(file.replace(".json", "")), list: readJson<ChatAgent[]>(join(run, "agents", file)) }));
  const runs = (existsSync(join(run, "runs.jsonl")) ? readFileSync(join(run, "runs.jsonl"), "utf8").split("\n").filter(line => line.trim()).map(line => JSON.parse(line) as Run) : [])
    .filter(entry => entry.duty === "checkin" && entry.at >= state.windowStart);
  const checks: { id: string; ok: boolean | null; detail: string }[] = [];
  const add = (id: string, ok: boolean | null, detail: string) => checks.push({ id, ok, detail });

  const judged = runs.map(entry => ({ entry, carried: carriedAt(snaps, agents, entry.at) })).filter(({ carried }) => carried.length);
  const reached = judged.filter(({ entry, carried }) => entry.trigger === "schedule" && carried.some(wait => entry.at - wait.since > STALL_MS));
  const line = (wait: Carried) => `${wait.step.id} waits on ${wait.on.id} ("${clip(wait.step.waitFor ?? "", 80)}") carried by ${wait.owners.join(", ")} since ${iso(wait.since)}`;
  add("a", reached.length ? true : null, reached.length
    ? `${reached.length} scheduled check-ins ran on a wait over 2 h old, first at ${iso(reached[0]!.entry.at)}: ${reached[0]!.carried.map(line).join("; ")}`
    : `${judged.length} check-ins ran on a carried wait, none on one over 2 h old yet (${runs.length} check-ins in the window)`);

  const wrongFlags = judged.flatMap(({ entry, carried }) => (entry.flagged ?? []).filter(slice =>
    (STEP_FLAGS.has(slice.kind) && carried.some(wait => wait.step.id === slice.item)) ||
    (slice.kind === "no_progress" && carried.some(wait => new RegExp(`\\b${wait.step.id}\\b`).test(slice.excerpt))))
    .map(slice => `${iso(entry.at)} ${slice.kind} ${slice.item ?? ""}: "${clip(slice.excerpt)}"`));
  add("b", judged.length ? !wrongFlags.length : ended ? false : null, wrongFlags.length ? wrongFlags.join("; ")
    : `${judged.length} check-ins ran on carried waits, and none flagged the waiting step`);

  // A reading that is missing leaves the proof open: a run with no metric, or a run whose job ran and whose after-job measure is not in yet.
  // A miss in the run's own measure is excused only when every flagged item of that kind names something outside the carried waits: a
  // stuck step that is not one of them, or a goal gap on a goal that holds none of them.
  const under = (goal: string, step: string, board: ChatBoard | undefined): boolean => {
    const found = board ? items(board) : new Map<string, { item: PlanItem; parent?: string }>();
    for (let at = found.get(step)?.parent; at !== undefined; at = found.get(at)?.parent) if (at === goal) return true;
    return false;
  };
  const boardAt = (at: number): ChatBoard | undefined => snaps.filter(snap => snap.at <= at).at(-1)?.board;
  const missing: string[] = [];
  const misses: string[] = [];
  for (const { entry, carried } of judged) {
    for (const key of ["goal_gaps", "stuck_steps"]) {
      const own = entry.metrics?.[key]?.value;
      if (own === undefined) missing.push(`run at ${iso(entry.at)} has no ${key}`);
      else if (own > 0) {
        const slices = (entry.flagged ?? []).filter(slice => slice.kind === key);
        const related = slices.filter(slice => slice.item === undefined || carried.some(wait => key === "stuck_steps" ? wait.step.id === slice.item
          : wait.step.id === slice.item || under(slice.item!, wait.step.id, boardAt(entry.at))));
        if (related.length || !slices.length) misses.push(`run at ${iso(entry.at)} read ${key} ${own}: ${slices.map(slice => `"${clip(slice.excerpt, 160)}"`).join("; ") || "no flagged item names it"}`);
      }
      if (!entry.job) continue;
      const after = entry.after?.metrics?.[key]?.value;
      if (after === undefined) missing.push(`run at ${iso(entry.at)} started job ${entry.job.name} and has no after-job ${key} yet`);
      else if (after > 0) misses.push(`after-job measure at ${iso(entry.after!.at)} read ${key} ${after}, with no flagged item to show which step`);
    }
  }
  add("c", misses.length ? false : judged.length && !missing.length ? true : null, misses.length ? misses.join("; ")
    : missing.length ? `open: ${missing.join("; ")}` : judged.length ? `${judged.length} check-ins and their after-job measures read goal_gaps 0 and stuck_steps 0` : "no check-in ran on a carried wait yet");

  // Each call counts against the waits that were carried when it ran, so work on a step after its wait ended is the chat's to do.
  const jobs = runs.flatMap(entry => entry.job ? [entry.job] : []);
  const calls = jobs.flatMap(job => readSession(job.id, [chat]).filter((event): event is Extract<SessionEvent, { kind: "call" }> => event.kind === "call")
    .map(event => ({ job, event })));
  const named = (input: string, id: string): boolean => new RegExp(`\\b${id}\\b`).test(input);
  const changes: string[] = [];
  const steers: string[] = [];
  const runIds: string[] = [];
  let checked = 0;
  for (const { job, event } of calls) {
    for (const wait of carriedAt(snaps, agents, event.at)) {
      const id = wait.step.id;
      if (!named(event.input, id)) continue;
      checked++;
      const op = new RegExp(`["']id["']\\s*:\\s*["']${id}["'][^}]*["'](?:parent|job|sessionId)["']\\s*:`).test(event.input) ||
        new RegExp(`["'](?:parent|job|sessionId)["']\\s*:[^}]*["']id["']\\s*:\\s*["']${id}["']`).test(event.input);
      const runId = new RegExp(`["']id["']\\s*:\\s*["']${id}["'][^}]*["']note["']\\s*:\\s*["'][^"']*\\b\\d{9,}\\b`).test(event.input);
      const start = /create_session\(|rlm\.spawn\(/.test(event.input);
      if (op || start) changes.push(`${job.name} at ${iso(event.at)} ${op ? "changed the owner or parent of" : "started a job on"} ${id}: "${clip(event.input)}"`);
      if (runId) runIds.push(`${job.name} at ${iso(event.at)} wrote a run id into ${id}: "${clip(event.input)}"`);
      if (/job-steer\.ts/.test(event.input) && !wait.owners.some(owner => event.input.includes(owner)))
        steers.push(`${job.name} at ${iso(event.at)} steered about ${id} someone other than ${wait.owners.join(", ")}: "${clip(event.input)}"`);
    }
  }
  const waiting = judged.length > 0;
  add("d", waiting ? !changes.length && !runIds.length : ended ? false : null, [...changes, ...runIds].join("; ")
    || `${calls.length} calls of ${jobs.length} check-in jobs, ${checked} of them about a step while its wait was carried, and none changed it`);
  add("e", waiting ? !steers.length : ended ? false : null, steers.length ? steers.join("; ") : "no check-in job steered anyone but the carrier about a carried wait");
  // An unrelated CI wake is exercised only when some agent of the chat slept on a run while a wait was carried. Unexercised, it proves nothing
  // and stays out of the verdict.
  const ciWakes = agents.filter(entry => carriedAt(snaps, agents, entry.at).length)
    .flatMap(entry => entry.list.filter(agent => /\brun\s+\d{9,}\b/.test(agent.wait ?? "")).map(agent => `${agent.name} at ${iso(entry.at)}: ${agent.wait}`));
  const exercised = ciWakes.length ? `exercised (${[...new Set(ciWakes)].slice(0, 3).join("; ")}): ${runIds.length ? "a run id reached a carried step" : "no run id reached a carried step"}`
    : "not exercised: no agent of the chat slept on a CI run while a wait was carried";

  const head = readSession(chat, [chat]).filter(event => event.at >= state.windowStart);
  const asked = new Map<string, number>();
  for (const event of head) if (event.kind === "sent" && !asked.has(event.to)) asked.set(event.to, event.at);
  // The check-in jobs the server starts for the chat report to it as siblings; those reports are the system at work, not someone stepping in.
  // The chat's own jobs, which the agents snapshots list under it with link subagent or root, report to it as siblings when the chat started
  // them as root sessions: run-3's "disk free sampling 2" reported its 12 readings at 16:59Z that way. A thread listed only because it messaged
  // the chat (link "message", run-3's AI harness developer environment VP at 15:46Z) is no job of the chat, and names never count.
  const checkIns = new Set(jobs.map(job => job.id));
  const ownJobs = new Map(agents.flatMap(entry => entry.list.flatMap(agent =>
    agent.sessionId && !checkIns.has(agent.sessionId) && (agent.link === "subagent" || agent.link === "root") ? [[agent.sessionId, agent.name] as const] : [])));
  // Each session one of those spawned, at any depth, is the trial's own too, by the parent its session header records (`ownedDescendants`).
  const below = ownedDescendants([chat, ...checkIns, ...ownJobs.keys()], [chat, ...checkIns, ...ownJobs.keys()]);
  const own = new Set([...checkIns, ...ownJobs.keys(), ...below.keys()]);
  const typed = head.filter(event => event.kind === "text" && event.role === "user" && !event.text.trimStart().startsWith("[") &&
    !state.seeds.some(seed => event.text.includes(seed.slice(0, 60))) && !event.text.includes("<skill"));
  const messaged = head.filter(event => event.kind === "text" && event.role === "custom" && (event.relation === "parent" || event.relation === "sibling") &&
    !(event.fromId && (asked.get(event.fromId) ?? Infinity) < event.at) && !(event.fromId && own.has(event.fromId)));
  // Steering also reaches the chat and its jobs as notes the service wraps as its own, such as a d9 push or another chat's job-steer, so each
  // delivery is judged by its recorded origin (`steering`, shared with unrelated-ci-wait), and one whose origin the evidence cannot show is unknown.
  const trial: TrialSession[] = [{ id: chat, head: true, file: sessionFile(chat, [chat]) ?? "" },
    ...[...ownJobs].map(([id, name]) => ({ id, name, head: false, file: sessionFile(id, [chat]) ?? "" })),
    ...[...below].filter(([id]) => !checkIns.has(id) && !ownJobs.has(id)).map(([id, file]) => ({ id, head: false, file }))].filter(session => session.file);
  const steered = steering(trial, chat, state.windowStart, own, delivery);
  const outside = [...[...typed, ...messaged].map(event => `at ${iso(event.at)}: "${clip(event.kind === "text" ? event.text : "", 160)}"`), ...steered.outside];
  const turns = head.filter(event => event.kind === "assistant" || event.kind === "call").length;
  add("f", outside.length ? false : steered.unknown.length ? null : turns ? true : ended ? false : null, outside.length ? outside.join("; ")
    : steered.unknown.length ? `unknown: ${steered.unknown.join("; ")}`
    : `${turns} model turns and calls of the chat; ${steered.owned} deliveries into it, its ${ownJobs.size} jobs and their ${below.size} subagents trace to its own check-ins, jobs, wakes and resumes`);

  const verdict: Verdict = checks.find(check => check.id === "f")!.ok === false ? "void"
    : checks.some(check => check.ok === false) ? "fail"
    : checks.some(check => check.ok === null) ? "open" : "pass";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${chat}) ran on ${state.release} from ${iso(state.windowStart)} to ${iso(now)}. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ${join(run, "criteria.md")}. Evidence: ${snaps.length} board snapshots, ${agents.length} agents snapshots, ${runs.length} check-in runs and their jobs' session files.`, "",
    ...checks.map(check => `- ${check.id} ${yes(check.ok)}: ${check.detail}`), "",
    `The unrelated CI wake case was ${exercised}.`, "",
    "## Check-ins", "",
    ...runs.map(entry => `- ${iso(entry.at)} ${entry.trigger}: goal_gaps ${entry.metrics?.goal_gaps?.value ?? "-"}, stuck_steps ${entry.metrics?.stuck_steps?.value ?? "-"}` +
      `${entry.after ? `, after-job ${entry.after.metrics?.goal_gaps?.value ?? "-"} and ${entry.after.metrics?.stuck_steps?.value ?? "-"}` : ""}; ` +
      `flagged ${(entry.flagged ?? []).map(slice => `${slice.kind} ${slice.item ?? ""}`.trim()).join(", ") || "nothing"}; carried ${carriedAt(snaps, agents, entry.at).map(line).join("; ") || "none"}`), "",
  ].join("\n");
  return { verdict, text };
}

export const carriedWait: Scenario = {
  name: "carried-wait",
  headMessage: () => TASK,
  fixtures: [],
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message and no seeded board, todo or fixture.`,
    `Its check-in runs every ${state.everyMs / 60_000} min on the server's clock. The owner asked for runs the system does alone (c84); no other chat's interval changed.`, "",
    "## The first message", "", `> ${TASK}`, "",
  ].join("\n"),
  evaluate: async (run, state) => judge(run, state, Date.now(), await readDelivery(state, Math.min(Date.now(), state.until ?? Date.now()))),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};

/**
 * The same judge on the shape chat-2572 had at 08:03Z on 10-24, which a chat that plans its own board did not make in run-1 to run-3: a step of
 * the chat under another job's step, waiting on that job's handoff, so the step above it is no leaf and its live job carries the wait. Run-3's
 * chat set a carried wait at 13:34Z, and its sampling job ended at 14:2xZ, an hour before the 2 h a stall needs. The board is seeded at setup,
 * and the job on p2 is a real one that samples for 3 h and sleeps on a board.wake meanwhile.
 */
export const NESTED_TASK = "the disk sampler job is sampling free space on this box's / every 15 minutes for the next 3 hours, that's p2. once its " +
  "12th reading is in, check it against a fresh df and write me a short page with all 12 readings and the trend. that part is p3 and it's yours";
const SAMPLER = "disk sampler";
export const carriedRelease: Scenario = {
  name: "carried-release",
  headMessage: () => NESTED_TASK,
  fixtures: [{
    name: SAMPLER,
    brief: ({ chat, chatName, sandbox }) => `You sample disk space for the chat "${chatName}" (session ${chat}), and you own its step p2. Work in ${sandbox}.\n\n` +
      `1. Start the sampler detached: \`systemd-run --user --unit=disk-sampler-${chat.slice(0, 8)} --collect --same-dir sh -c 'for i in $(seq 12); do ` +
      `echo "$(date -u +%FT%TZ),$(df -B1 --output=avail / | tail -1)" >> ${sandbox}/samples.csv; [ $i -lt 12 ] && sleep 900; done'\`.\n` +
      "2. In Python, set `board.wake(at=<the time 2 h 50 min from now, ISO>, note=\"read samples.csv\")` and end your turn.\n" +
      `3. When the wake comes, count the rows of ${sandbox}/samples.csv. Below 12, set another board.wake at the time the next rows are due and end your turn. ` +
      `At 12, run \`node --import tsx scripts/board-apply.ts ${chat} '[{"op":"plan_update","id":"p2","status":"done","note":"12 readings in ${sandbox}/samples.csv"}]'\` ` +
      "from ~/.local/share/sieun-pi-chat/current/components/user-history, and end your turn.",
  }],
  board(copy, { fixtures }) {
    const sampler = fixtures[SAMPLER];
    if (!sampler) throw new Error("the sampler job was not created");
    const board = structuredClone(copy);
    const ids = nextIds(board);
    const [p1, p2, p3] = [ids("p"), ids("p"), ids("p")];
    if (p1 !== "p1" || p2 !== "p2" || p3 !== "p3") throw new Error(`the board is not empty: it gives ${p1}, ${p2} and ${p3}`);
    const at = new Date().toISOString();
    board.plan = [{ id: "p1", text: "Show how free space on this box's / moves over 3 hours", status: "doing",
      target: { metric: "readings checked against a fresh df", target: 12, unit: "readings", current: 0, measuredAt: at, direction: "up" },
      note: "Done when the trend page lists all 12 readings and the last one matches a fresh df.", children: [
        { id: "p2", text: "Sample free space on / every 15 minutes for 3 hours", status: "doing", job: SAMPLER, sessionId: sampler, children: [
          { id: "p3", text: "Check the last sample against a fresh df and write the trend page", status: "todo", waitFor: "p2's 12th reading", children: [] }] }] }];
    board.lastIds = { p: 3, t: board.lastIds?.t ?? 0 };
    return { board, changes: ["p1 with a target of 12 readings, p2 owned by the disk sampler job, and p3 for the chat under p2, waiting on p2's 12th reading."] };
  },
  setupNotes: (state, changes) => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, and its board was seeded: ${changes.join(" ")}`,
    `The disk sampler job is ${state.fixtures[SAMPLER]}. The check-in runs every ${state.everyMs / 60_000} min on the server's clock (c84).`, "",
    "## The first message", "", `> ${NESTED_TASK}`, "",
  ].join("\n"),
  evaluate: async (run, state) => judge(run, state, Date.now(), await readDelivery(state, Math.min(Date.now(), state.until ?? Date.now()))),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};
