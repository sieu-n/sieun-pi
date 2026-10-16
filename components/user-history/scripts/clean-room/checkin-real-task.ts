import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatBoard, PlanItem } from "../../src/shared/types.ts";
import { readSession, type RunState, type Scenario, type SessionEvent, type Verdict } from "./session-read.ts";
import { flagHits, names, reportShape, stepIdLists } from "./text-checks.ts";

/**
 * The clean-room scenario for the check-in goal push with an ordinary task (owner 10-15: "also clean room test라고 말하면 어떻게 ^^^ 그냥
 * "research some topic" 이런식으로 해야지"). A fresh chat gets one owner-style message with a small goal that has a number, and nothing in
 * the chat, its name or its board says it is a test. The criteria live in the run folder's criteria.md, written before the run.
 */
const PUSH_LINK = "checkin/goal_gaps";
export const TASK = "research which of our instagram index gaps matter most and keep a page with the top 10 updated. measure each gap's size " +
  "from real data, i want all 10 measured by tomorrow";

const walk = (items: readonly PlanItem[], visit: (item: PlanItem, goal: PlanItem) => void, goal?: PlanItem): void => {
  for (const item of items) { visit(item, goal ?? item); walk(item.children, visit, goal ?? item); }
};
const OPEN = new Set(["todo", "doing", "blocked"]);
const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 300): string => (text.length > length ? text.slice(0, length - 1) + "…" : text).replace(/\s+/g, " ");
const amount = (value: number): string => value.toLocaleString("en-US", { maximumFractionDigits: 2, useGrouping: false });

export const checkinRealTask: Scenario = {
  name: "checkin-real-task",
  headMessage: () => TASK,
  fixtures: [],
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message and no seeded board, todo or fixture.`,
    `Its check-in runs every ${state.everyMs / 60_000} min on the server's clock, set through POST api/threads/<id>/check-in. The owner asked for a run the system does alone (c84), and a short interval gets 2 check-ins in about an hour; no other chat's interval changed.`, "",
    "## The first message", "", `> ${TASK}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline; use checkin-goal-push's"); },
};

interface Check { id: string; ok: boolean | null; detail: string }
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";
interface Run { at: number; trigger: string; job?: { id: string; name: string }; summary?: string; duty: string }
interface Agent { sessionId?: string; name: string; state: string; key: string }
interface Snapshot { at: number; board: ChatBoard }

function snapshots(run: string): Snapshot[] {
  const dir = join(run, "boards");
  return existsSync(dir) ? readdirSync(dir).sort().map(file => {
    const board = JSON.parse(readFileSync(join(dir, file), "utf8")) as ChatBoard;
    return { at: Date.parse(board.updatedAt) || 0, board };
  }) : [];
}
const boardAt = (all: readonly Snapshot[], at: number): ChatBoard | undefined => all.filter(snap => snap.at <= at).at(-1)?.board;
/** The open top-level goals with a target, as of a board. */
const goalsOf = (board: ChatBoard | undefined): PlanItem[] => (board?.plan ?? []).filter(goal => OPEN.has(goal.status) && goal.target);
/** The words a push for a goal must carry: its current number, its target and the gap, or the target and "no measurement" before one. */
function numberWords(goal: PlanItem): { need: string[]; any: string[]; text: string } {
  const target = goal.target!;
  if (target.current === undefined) return { need: [amount(target.target)], any: [], text: `target ${amount(target.target)} ${target.unit}, not measured yet` };
  const gap = Math.abs(target.target - target.current);
  return { need: [amount(target.current), amount(target.target)], any: [amount(gap), String(Math.round(gap))], text: `${amount(target.current)} of ${amount(target.target)} ${target.unit}, gap ${amount(gap)}` };
}
const carries = (text: string, goal: PlanItem): boolean => {
  const words = numberWords(goal);
  return words.need.every(word => names(text, word)) && (!words.any.length || words.any.some(word => names(text, word)));
};
const firstUserText = (events: readonly SessionEvent[]): string => {
  for (const event of events) if (event.kind === "text" && event.role === "user") return event.text;
  return "";
};

function judge(run: string, state: RunState): { verdict: Verdict; text: string } {
  const runsFile = join(run, "runs.jsonl");
  const all = (existsSync(runsFile) ? readFileSync(runsFile, "utf8").split("\n").filter(line => line.trim()).map(line => JSON.parse(line) as Run) : [])
    .filter(entry => entry.duty === "checkin" && entry.at >= state.windowStart);
  const dutyJobs = new Map(all.flatMap(entry => entry.job ? [[entry.job.id, entry.job.name] as const] : []));
  const boards = snapshots(run);
  const agentsDir = join(run, "agents");
  const seen = new Map<string, { name: string; first: number; key: string }>();
  for (const file of existsSync(agentsDir) ? readdirSync(agentsDir).sort() : []) {
    for (const agent of JSON.parse(readFileSync(join(agentsDir, file), "utf8")) as Agent[]) {
      if (agent.sessionId && !seen.has(agent.sessionId) && !dutyJobs.has(agent.sessionId)) seen.set(agent.sessionId, { name: agent.name, first: Number(file.replace(".json", "")), key: agent.key });
    }
  }
  for (const [id, info] of seen) if (/^check-in /.test(info.name)) { dutyJobs.set(id, info.name); seen.delete(id); }
  const jobs = [...seen].map(([id, info]) => ({ id, ...info, events: readSession(id, [state.chat.id]) }));
  const findSession = (id: string): SessionEvent[] => jobs.find(job => job.id === id)?.events ?? readSession(id, [state.chat.id]);
  const stepsOf = (board: ChatBoard | undefined, job: { id: string; name: string }): { goal: PlanItem; step: PlanItem }[] => {
    const found: { goal: PlanItem; step: PlanItem }[] = [];
    walk(board?.plan ?? [], (item, goal) => { if (item !== goal && (item.sessionId === job.id || item.job === job.name)) found.push({ goal, step: item }); });
    return found;
  };
  const clock = (at: number): string => { const date = new Date(at); return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`; };
  const scheduled = all.filter(entry => entry.trigger === "schedule").flatMap(entry => {
    if (entry.job) return [entry];
    const found = [...dutyJobs].find(([, name]) => name.endsWith(` ${clock(entry.at)}`));
    return found ? [{ ...entry, job: { id: found[0], name: found[1] } }] : [];
  });
  const last = boards.at(-1)?.board;
  const goals = goalsOf(last);
  const checks: Check[] = [];
  const t2 = scheduled[1]?.at ?? Date.now();

  const working = goals.map(goal => {
    const job = jobs.find(candidate => boards.some(snap => stepsOf(snap.board, candidate).some(found => found.goal.id === goal.id && found.step.status === "doing"))
      && candidate.events.some(event => event.kind === "assistant" || event.kind === "call"));
    return { goal, job };
  });
  checks.push({ id: "a", ok: goals.length > 0 && working.every(entry => entry.job), detail: goals.length ? working.map(({ goal, job }) => `${goal.id} "${clip(goal.text, 80)}": ${job ? `${job.name} (${job.id}) works on it, first seen ${iso(job.first)}` : "no job of the chat works on a doing step under it"}`).join("; ")
    : "the chat made no goal with a target" });

  const pushes: string[] = [];
  const steers: { run: Run; ok: boolean | null; detail: string }[] = [];
  for (const entry of scheduled) {
    const board = boardAt(boards, entry.at);
    const events = findSession(entry.job!.id);
    const brief = firstUserText(events);
    const sent = events.filter((event): event is Extract<SessionEvent, { kind: "sent" }> => event.kind === "sent" && event.to !== state.chat.id);
    const started = events.filter((event): event is Extract<SessionEvent, { kind: "call" }> => event.kind === "call" && /create_session\(/.test(event.input));
    for (const goal of goalsOf(board)) {
      const words = numberWords(goal);
      const steer = sent.find(event => carries(event.text, goal));
      const start = started.find(event => carries(event.input, goal));
      if (steer) pushes.push(`${entry.job!.name} steered ${steer.toName} on ${goal.id} (${words.text}): "${clip(steer.text, 300)}"`);
      if (start) pushes.push(`${entry.job!.name} started a job for ${goal.id} (${words.text}): "${clip(start.input, 300)}"`);
      let owner: PlanItem | undefined;
      walk([goal], item => { if (item !== goal && item.duty === PUSH_LINK && OPEN.has(item.status) && item.sessionId) owner = item; });
      const ownerLive = owner && jobs.some(job => job.id === owner!.sessionId && job.events.some(event => event.at >= entry.at - 30 * 60_000));
      const met = goal.target!.current !== undefined && goal.target!.current >= goal.target!.target;
      if (owner && ownerLive && !met) {
        const toOwner = sent.find(event => event.to === owner!.sessionId);
        steers.push({ run: entry, ok: !!toOwner && carries(toOwner.text, goal), detail: `${entry.job!.name}: ${goal.id}'s push step ${owner.id} has a live job (${owner.job}); ${toOwner ? `it got "${clip(toOwner.text, 300)}"` : "the check-in sent it nothing"}` });
      }
      if (!brief) pushes.push(`${entry.job!.name} has no brief on file`);
    }
  }
  checks.push({ id: "b", ok: pushes.some(line => / (steered|started) /.test(line)), detail: pushes.length ? pushes.join("\n    ") : `none of ${scheduled.length} check-in jobs sent a job a message or started one that named a goal's number, target and gap` });
  checks.push({ id: "b2", ok: steers.length ? steers.every(steer => steer.ok) : null, detail: steers.length ? steers.map(steer => steer.detail).join("\n    ") : "no check-in ran while a live job owned a goal's push step, so the steer case did not come up" });

  const family = new Set([state.chat.id, ...dutyJobs.keys(), ...jobs.map(job => job.id)]);
  const scanned: { session: string; at: number; text: string; from: string }[] = [];
  const outside: string[] = [];
  for (const id of family) {
    for (const event of findSession(id)) {
      if (event.kind !== "text" || event.at < state.windowStart) continue;
      if (["harness_digest", "refinement_notice", "refinement_outcome", "ipython_state", "ipython_state_restored"].includes(event.customType ?? "")) continue;
      if (id === state.chat.id && event.role === "user" && event.text.trim() === TASK) continue;
      scanned.push({ session: id, at: event.at, text: event.text, from: event.from ?? event.customType ?? event.role });
      if (id === state.chat.id && event.role === "user" && !event.text.trimStart().startsWith("[")) outside.push(`a typed message in the chat at ${iso(event.at)}: "${clip(event.text, 120)}"`);
      if (event.customType === "agent_message" && event.fromId && !family.has(event.fromId) && event.relation !== "child" && event.relation !== "parent") {
        outside.push(`${event.from ?? event.fromId} messaged ${id.slice(0, 8)} at ${iso(event.at)}: "${clip(event.text, 120)}"`);
      }
    }
  }
  const hits = scanned.flatMap(text => {
    const flags = flagHits(text.text);
    const lists = stepIdLists(text.text);
    return flags.length || lists.length ? [`${text.session.slice(0, 8)} from ${text.from} at ${iso(text.at)}: ${[flags.length ? `flag kinds ${flags.join(", ")}` : "", lists.length ? `step id lists ${lists.map(ids => ids.join(" ")).join(" / ")}` : ""].filter(Boolean).join("; ")}`] : [];
  });
  checks.push({ id: "c", ok: hits.length === 0, detail: `${scanned.length} system texts in ${new Set(scanned.map(text => text.session)).size} sessions; ${hits.length} with hits${hits.length ? `:\n${hits.slice(0, 15).map(hit => `    - ${hit}`).join("\n")}` : ""}` });

  const churn: string[] = [];
  for (const goal of goals) {
    const on = jobs.filter(job => boards.some(snap => stepsOf(snap.board, job).some(found => found.goal.id === goal.id))).map(job => ({ ...job, end: Math.max(job.first, ...job.events.map(event => event.at)) }))
      .sort((a, b) => a.first - b.first);
    for (let i = 1; i < on.length; i++) {
      const alive = on.slice(0, i).filter(earlier => earlier.end + 30 * 60_000 > on[i]!.first && earlier.key.startsWith("thread:"));
      if (alive.length) churn.push(`${goal.id}: ${on[i]!.name} started at ${iso(on[i]!.first)} while ${alive.map(job => job.name).join(", ")} was alive`);
    }
  }
  checks.push({ id: "d", ok: churn.length === 0, detail: churn.length ? churn.join("; ") : `${jobs.length} jobs over ${goals.length} goals, and no root job started for a goal while another root job on it was alive` });

  const reports = findSession(state.chat.id).filter((event): event is Extract<SessionEvent, { kind: "text" }> => event.kind === "text" && event.at >= state.windowStart
    && event.customType === "agent_message" && event.fromId !== undefined && dutyJobs.has(event.fromId));
  const value = goals[0]?.target ? (goals[0].target.current !== undefined ? amount(goals[0].target.current) : amount(goals[0].target.target)) : "";
  const shapes = reports.map(event => ({ event, shape: reportShape(event.text.replace(/^\[agent-message from [^\]]*\]\s*/, ""), value) }));
  checks.push({ id: "e", ok: shapes.length ? shapes.every(({ shape }) => shape.ok && shape.namesGoal) : null, detail: shapes.length ? shapes.map(({ event, shape }) =>
    `${event.from} at ${iso(event.at)}: ${shape.lines} lines, goal number ${value} ${shape.namesGoal ? "named" : "missing"}: "${clip(event.text, 500)}"`).join("\n    ") : "no check-in job has sent the chat a message yet" });

  checks.push({ id: "f", ok: scheduled.length >= 2, detail: `${all.length} check-in runs in the window, ${scheduled.length} scheduled with a duty job: ${all.map(entry => `${iso(entry.at)} ${entry.trigger} ${entry.job?.name ?? entry.summary ?? ""}`).join("; ") || "none"}` });
  checks.push({ id: "h", ok: outside.length === 0, detail: outside.length ? outside.join("; ") : "no typed message after the first and no message from outside the chat's own sessions" });

  const touched: string[] = [];
  const MUTATING = [/\bgit\s+push\b/, /\bgh\s+(pr\s+merge|run\s+(rerun|cancel))/, /release-chat/, /npx\s+convex\s+(run|deploy|import)/, /\bdeploy(\.mjs|\.sh)\b/];
  for (const id of family) for (const event of findSession(id)) {
    if (event.kind === "call" && event.at >= state.windowStart) for (const pattern of MUTATING) { const match = pattern.exec(event.input); if (match) touched.push(`${id.slice(0, 8)} ran "${clip(event.input.slice(Math.max(0, match.index - 40), match.index + 80), 140)}"`); }
  }
  const cases: string[] = [];
  for (const id of dutyJobs.keys()) {
    const brief = firstUserText(findSession(id));
    if (/owner'?s stop|stop (lifted|is off)/i.test(brief)) cases.push(`${dutyJobs.get(id)} brief names a wait on the owner's stop: "${clip(brief.slice(brief.search(/stop/i) - 120, brief.search(/stop/i) + 160), 280)}"`);
    if (/\bPRs?\b.*\b(look|looks) done|merged/i.test(brief)) cases.push(`${dutyJobs.get(id)} brief names a PR step that looks done`);
  }

  const head = findSession(state.chat.id);
  const firstReply = head.find((event): event is Extract<SessionEvent, { kind: "assistant" }> => event.kind === "assistant" && event.at >= state.windowStart)?.text ?? "";
  const measured = firstReply.replace(/\b\d{4}-\d{2}-\d{2}\b|\btop 10\b|\b10 gaps\b|\ball 10\b|\b\d+ of 10\b/gi, "").match(/\b\d[\d,.]*\s*(%|k|m|accounts?|profiles?|rows?|posts?|reads?|days?|h|hours?)\b/gi) ?? [];
  const defers = firstReply.match(/nothing is measured yet|i started|will (find|measure|send|check)|once (it|the job)|when it is ready/gi) ?? [];
  checks.push({ id: "i", ok: firstReply ? measured.length > 0 && defers.length === 0 : false, detail: firstReply
    ? `measured numbers ${measured.length ? measured.join(", ") : "none"}; put-off words ${defers.length ? defers.map(word => `"${word}"`).join(", ") : "none"}. First reply: "${clip(firstReply, 700)}"` : "the chat has not replied" });

  const board = last;
  const ledgerFile = join(process.env.AGENT_CHAT_DATA_DIR ?? join(process.env.HOME ?? "", ".prime/agent/browser-chat"), "corrections.json");
  const ledger = existsSync(ledgerFile) ? readFileSync(ledgerFile, "utf8") : "";
  const leaks = [...(board?.todos ?? []).map(todo => `todo ${todo.id} "${clip(todo.text, 100)}"`), ...(ledger.includes(state.chat.id) || ledger.includes(`"${state.chat.name}"`) ? ["a correction in corrections.json names this chat"] : [])];
  checks.push({ id: "j", ok: leaks.length === 0, detail: leaks.length ? leaks.join("; ") : "the chat's board has no todo and corrections.json does not name the chat" });

  const get = (id: string) => checks.find(check => check.id === id)!;
  if (get("f").ok === false) for (const id of ["a", "b", "e"]) { const check = get(id); if (check.ok === false) { check.ok = null; check.detail += " (judged again after 2 check-ins with a duty job)"; } }
  const voided = get("h").ok === false;
  const open = !voided && (get("f").ok === false || checks.some(check => check.ok === null));
  const verdict: Verdict = voided ? "void" : checks.some(check => check.ok === false && check.id !== "f") ? "fail" : open ? "open" : "pass";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${state.chat.id}) ran on ${state.release} from ${iso(state.windowStart)} to ${iso(Date.now())}, check-in every ${state.everyMs / 60_000} min, with no seeded board and one owner-style message. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ${join(run, "criteria.md")}. Setup: ${join(run, "setup.md")}. Evidence: ${run}/boards, agents, prompts, runs.jsonl and service.log, and the session files of the sessions named below.`, "",
    "## Verdict per criterion", "", ...checks.map(check => `- (${check.id}) ${yes(check.ok)}: ${check.detail}`), "",
    "## Seen, not judged", "",
    `- Commands that write outside the repo's working tree: ${touched.length ? touched.join("; ") : "none"}.`,
    `- The two slack green cases (a wait on the owner's stop after it lifts, a PR step that looks done): ${cases.length ? cases.join("; ") : "neither showed up in a check-in brief"}.`, "",
    `Goals: ${goals.map(goal => `${goal.id} ${numberWords(goal).text}`).join("; ") || "none"}. Duty jobs: ${[...dutyJobs].map(([id, name]) => `${name} ${id}`).join(", ") || "none"}. Jobs: ${jobs.map(job => `${job.name} ${job.id}`).join(", ") || "none"}.`, "",
  ].join("\n");
  return { verdict, text };
}
