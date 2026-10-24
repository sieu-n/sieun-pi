import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { firstClause, planJob } from "../../src/shared/chat-board.ts";
import type { ChatAgent, ChatBoard, PlanItem } from "../../src/shared/types.ts";
import { readSession, type RunState, type Scenario, type SessionEvent, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for check-ins that follow the live job carrying a wait (chat-2572 p18, 10-24). Its p8 and p10 waited on p6, whose
 * release job was live, and the check-in flagged them stalled 8 and 5 times, moved them under p6, tied an unrelated CI probe run to them, and
 * then read goal_gaps 1 and stuck_steps 2 because p6 was no leaf any more. A fresh chat gets one ordinary task whose plan needs a step that
 * waits about 3 h on another step's live job, and nothing says it is a test. The criteria live in the run folder's criteria.md.
 */
export const TASK = "sample the free space on this box's / every 15 minutes for the next 3 hours, then once that's done check the last sample " +
  "against a fresh df yourself and write me a short page with all 12 readings and the trend";
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

export function judge(run: string, state: RunState, now = Date.now()): { verdict: Verdict; text: string } {
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

  const misses = judged.flatMap(({ entry }) => [entry, ...entry.after ? [entry.after] : []].flatMap(measure => ["goal_gaps", "stuck_steps"]
    .filter(key => (measure.metrics?.[key]?.value ?? 0) > 0)
    .map(key => `${measure === entry ? "run" : "after-job measure"} at ${iso(measure.at)} read ${key} ${measure.metrics![key]!.value}` +
      `${measure === entry ? `: ${(entry.flagged ?? []).filter(slice => slice.kind === key).map(slice => `"${clip(slice.excerpt, 160)}"`).join("; ")}` : ""}`)));
  add("c", judged.length ? !misses.length : ended ? false : null, misses.length ? misses.join("; ")
    : `${judged.length} check-ins and their after-job measures read goal_gaps 0 and stuck_steps 0`);

  const waiting = new Map<string, Carried>();
  for (const { carried } of judged) for (const wait of carried) if (!waiting.has(wait.step.id)) waiting.set(wait.step.id, wait);
  const jobs = runs.flatMap(entry => entry.job ? [entry.job] : []);
  const calls = jobs.flatMap(job => readSession(job.id, [chat]).filter((event): event is Extract<SessionEvent, { kind: "call" }> => event.kind === "call")
    .map(event => ({ job, event })));
  const named = (input: string, id: string): boolean => new RegExp(`["'\\s]${id}["'\\s,]|\\b${id}\\b`).test(input);
  const changes: string[] = [];
  const steers: string[] = [];
  for (const { job, event } of calls) {
    for (const [id, wait] of waiting) {
      if (!named(event.input, id)) continue;
      const op = new RegExp(`["']id["']\\s*:\\s*["']${id}["'][^}]*["'](?:parent|job|sessionId)["']\\s*:`).test(event.input) ||
        new RegExp(`["'](?:parent|job|sessionId)["']\\s*:[^}]*["']id["']\\s*:\\s*["']${id}["']`).test(event.input);
      const runId = new RegExp(`["']id["']\\s*:\\s*["']${id}["'][^}]*["']note["']\\s*:\\s*["'][^"']*\\b\\d{9,}\\b`).test(event.input);
      const start = /create_session\(|rlm\.spawn\(/.test(event.input);
      if (op || runId || start) changes.push(`${job.name} at ${iso(event.at)} ${op ? "changed the owner or parent of" : runId ? "wrote a run id into" : "started a job on"} ${id}: "${clip(event.input)}"`);
      if (/job-steer\.ts/.test(event.input) && !wait.owners.some(owner => event.input.includes(owner)))
        steers.push(`${job.name} at ${iso(event.at)} steered about ${id} someone other than ${wait.owners.join(", ")}: "${clip(event.input)}"`);
    }
  }
  add("d", waiting.size ? !changes.length : ended ? false : null, changes.length ? changes.join("; ")
    : `${calls.length} calls of ${jobs.length} check-in jobs, none changed ${[...waiting.keys()].join(", ") || "a carried step"}`);
  add("e", waiting.size ? !steers.length : ended ? false : null, steers.length ? steers.join("; ") : "no check-in job steered anyone but the carrier about a carried wait");

  const head = readSession(chat, [chat]).filter(event => event.at >= state.windowStart);
  const typed = head.filter(event => event.kind === "text" && event.role === "user" && !event.text.trimStart().startsWith("[") &&
    !state.seeds.some(seed => event.text.includes(seed.slice(0, 60))) && !event.text.includes("<skill") && event.text.trim() !== TASK);
  const asked = new Map<string, number>();
  for (const event of head) if (event.kind === "sent" && !asked.has(event.to)) asked.set(event.to, event.at);
  const outside = head.filter(event => event.kind === "text" && event.role === "custom" && (event.relation === "parent" || event.relation === "sibling") &&
    !(event.fromId && (asked.get(event.fromId) ?? Infinity) < event.at));
  const turns = head.filter(event => event.kind === "assistant" || event.kind === "call").length;
  add("f", typed.length || outside.length ? false : turns ? true : ended ? false : null, typed.length || outside.length
    ? [...typed, ...outside].map(event => `at ${iso(event.at)}: "${clip(event.kind === "text" ? event.text : "", 160)}"`).join("; ")
    : `${turns} model turns and calls of the chat; only the first message, server notes and its own jobs reached it`);

  const verdict: Verdict = checks.find(check => check.id === "f")!.ok === false ? "void"
    : checks.some(check => check.ok === false) ? "fail"
    : checks.some(check => check.ok === null) ? "open" : "pass";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${chat}) ran on ${state.release} from ${iso(state.windowStart)} to ${iso(now)}. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ${join(run, "criteria.md")}. Evidence: ${snaps.length} board snapshots, ${agents.length} agents snapshots, ${runs.length} check-in runs and their jobs' session files.`, "",
    ...checks.map(check => `- ${check.id} ${yes(check.ok)}: ${check.detail}`), "",
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
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};
