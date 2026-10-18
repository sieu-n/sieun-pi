import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nextIds } from "../../src/shared/chat-board.ts";
import type { ChatBoard, PlanItem } from "../../src/shared/types.ts";
import { flagHits, names, reportShape as shape, stepIdLists } from "./text-checks.ts";
import { readSession, readSessionFile, type RunState, type Scenario, type SessionEvent, sessionFiles, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for the check-in goal push (owner 10-15: "Check in 이 일을 쭉쭉 밀어줘야되는데 it's deeply flawed. fix this"). The
 * test chat gets Crawler VP's board as of 10-15 22:00Z: goal A, p71 at 14.9 of 100 % with no job owning its number, and goal B, p28 at 17.95
 * of 99 reads/s whose push step belongs to a live fixture job that only logs what it gets. The criteria live in
 * ~/.prime/agent/clean-room/checkin-goal-push/criteria.md, written before the first run.
 */
export const GOAL_A = { id: "p71", value: "14.9", target: "100", gap: ["85.1"] };
export const GOAL_B = { id: "p28", value: "17.95", target: "99", gap: ["81.05", "81"] };
export const FIXTURE = "crawler ops train twin";
const PUSH_LINK = "checkin/goal_gaps";

export { FLAG_KINDS, flagHits, names, stepIdLists } from "./text-checks.ts";
/** A report's shape against goal A's number (criterion e). */
export const reportShape = (text: string): ReturnType<typeof shape> => shape(text, GOAL_A.value);

const twinNote = (sandbox: string): string => `Clean-room twin of Crawler VP's board, copied 10-15 22:00Z for a test of the check-in. Jobs for this board work in ${sandbox} ` +
  "as a dry run: they read code, data and logs freely, write only under that folder, and report what they would change and what number it would move. " +
  "They never push, commit, deploy, run or cancel CI, write Convex or prod, or message a session outside this test chat.";

const walk = (items: readonly PlanItem[], visit: (item: PlanItem, goal: PlanItem) => void, goal?: PlanItem): void => {
  for (const item of items) { visit(item, goal ?? item); walk(item.children, visit, goal ?? item); }
};
const OPEN = new Set(["todo", "doing", "blocked"]);

export const checkinGoalPush: Scenario = {
  name: "checkin-goal-push",
  agentsMd: sandbox => `# Clean-room test folder\n\n${twinNote(sandbox)}\n\nEverything else works as in the real chat: the check-in measures, starts, steers and reports as it would there.\n`,
  headMessage: chatName => `This is "${chatName}", a clean-room test chat. A script seeded its board from a copy of Crawler VP's board to watch what the ` +
    "server's check-in does on its own. Stay out of it for the whole test: make no board change, start or message no job, and answer every message, " +
    "notice and report with the one word ok, then end your turn.",
  fixtures: [{
    name: FIXTURE,
    brief: ({ chat, chatName, logFile }) => `You are the fixture job "${FIXTURE}" of the clean-room test chat "${chatName}" (session ${chat}). You stand in for ` +
      "Crawler VP's crawler ops train, so the test chat's check-in sees a live owner. You do no work.\n\n" +
      `1. Now, in Python, run \`board.wake(at="${new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19)}Z", note="clean-room fixture waits for messages")\` and end your turn.\n` +
      `2. On every later message, append one JSON line with the time and the message's full text to ${logFile} in Python, then end your turn. ` +
      "Reply to nobody, change no board, and start nothing.",
  }],
  board(copy, { fixtures, sandbox }) {
    const board = structuredClone(copy);
    const fixture = fixtures[FIXTURE];
    if (!fixture) throw new Error("the fixture job was not created");
    const owners = new Map<string, number>();
    walk(board.plan, item => {
      if (!item.job && !item.sessionId) return;
      const was = item.job ?? item.sessionId ?? "";
      owners.set(was, (owners.get(was) ?? 0) + 1);
      item.job = FIXTURE;
      item.sessionId = fixture;
    });
    const goalB = board.plan.find(item => item.id === GOAL_B.id);
    if (!goalB) throw new Error(`${GOAL_B.id} is not a top-level item of the copy`);
    goalB.status = "doing";
    const push = nextIds(board)("p");
    goalB.children.push({ id: push, text: "Push prod Instagram reads to 99 a second: name the biggest blocker and attack it", status: "doing",
      job: FIXTURE, sessionId: fixture, duty: PUSH_LINK, note: "The fixture job owns this number for the clean-room test.", children: [] });
    for (const goal of board.plan) if (OPEN.has(goal.status)) goal.note = `${twinNote(sandbox)}${goal.note ? `\n\n${goal.note}` : ""}`;
    const changes = [
      `Every step owner in the copy (${[...owners].map(([name, count]) => `${name} on ${count}`).join(", ")}) now reads job "${FIXTURE}" with the fixture's session ` +
        `${fixture}, so no check-in of the test chat can read or message a real Crawler VP job. In the copy those owners were live or asleep, so their steps stay moving, as they were (110 of 113 moving at 21:20Z).`,
      `${GOAL_B.id} (target 17.95 of 99 reads/s from the d1 precheck) was closed in the copy and is reopened as goal B, with a new push step ${push} ` +
        `(duty ${PUSH_LINK}) owned by the fixture, so the check-in has one off-pace goal whose number has a live owner to steer.`,
      `Each open top-level goal's note now opens with the clean-room twin text, the same text as ${sandbox}/AGENTS.md, so a job started for this board knows it is a dry run.`,
      "The todos, targets, requirements, notes, waits, rev and updatedAt are as copied; p71 keeps 14.9 of 100 % measured at 19:35:19Z and no push step.",
      "Crawler VP's duties d1 to d3 are not copied, because their prechecks read prod; the test chat has only the built-in check-in.",
    ];
    return { board, changes };
  },
  setupNotes: (state, changes) => [
    `# Clean-room run setup: ${state.chat.name}`, "",
    `The test chat ${state.chat.id} runs on ${state.release}, in ${state.sandbox}. Its board copies ${state.board}.`, "",
    `The check-in runs every ${state.everyMs / 60_000} min on the server's own clock. This throwaway chat gets a short interval because the owner asked on ` +
      "10-15 for a clean-room run that shows the check-in working without anyone stepping in (c84); no real chat's interval changed.", "",
    "## What differs from the real board", "", ...changes.map((line, index) => `${index + 1}. ${line}`), "",
    "## Seeds sent before the window", "", ...state.seeds.map((seed, index) => `${index + 1}. ${seed.replace(/\n+/g, " ")}`), "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: before => judgeBefore(before),
};

interface Check { id: string; ok: boolean | null; detail: string }
const yes = (ok: boolean | null): string => ok === null ? "not judged" : ok ? "met" : "not met";
const clip = (text: string, length = 300): string => (text.length > length ? text.slice(0, length - 1) + "…" : text).replace(/\s+/g, " ");

function boards(run: string): ChatBoard[] {
  const dir = join(run, "boards");
  return existsSync(dir) ? readdirSync(dir).sort().map(file => JSON.parse(readFileSync(join(dir, file), "utf8")) as ChatBoard) : [];
}
interface Run { at: number; trigger: string; job?: { id: string; name: string }; summary?: string; duty: string }
function runs(run: string, state: RunState): Run[] {
  const file = join(run, "runs.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(line => line.trim()).map(line => JSON.parse(line) as Run)
    .filter(entry => entry.duty === "checkin" && entry.at >= state.windowStart);
}
interface Agent { sessionId?: string; name: string; state: string; steps: string[] }
function agentsSeen(run: string): Map<string, { name: string; first: number }> {
  const seen = new Map<string, { name: string; first: number }>();
  const dir = join(run, "agents");
  for (const file of existsSync(dir) ? readdirSync(dir).sort() : []) {
    for (const agent of JSON.parse(readFileSync(join(dir, file), "utf8")) as Agent[]) {
      if (agent.sessionId && !seen.has(agent.sessionId)) seen.set(agent.sessionId, { name: agent.name, first: Number(file.replace(".json", "")) });
    }
  }
  return seen;
}
/** The top-level goal over each step that names a job, per board snapshot. */
function goalOf(board: ChatBoard, job: { id: string; name: string }): { goal: string; step: PlanItem }[] {
  const found: { goal: string; step: PlanItem }[] = [];
  walk(board.plan, (item, goal) => { if (item !== goal && (item.sessionId === job.id || item.job === job.name)) found.push({ goal: goal.id, step: item }); });
  return found;
}
/** The texts the system or another agent put in a session: user messages and custom messages, less the run's own seeds and tool output. */
function systemTexts(events: readonly SessionEvent[], seeds: readonly string[], since: number): { at: number; text: string; from: string }[] {
  return events.flatMap(event => event.kind === "text" && event.at >= since && !seeds.some(seed => event.text.includes(seed.slice(0, 120)))
    && !["harness_digest", "refinement_notice", "refinement_outcome", "ipython_state", "ipython_state_restored"].includes(event.customType ?? "")
    ? [{ at: event.at, text: event.text, from: event.from ?? event.customType ?? event.role }] : []);
}
/** A session's brief: its first user message. */
const firstUserText = (events: readonly SessionEvent[]): string => {
  for (const event of events) if (event.kind === "text" && event.role === "user") return event.text;
  return "";
};
const MUTATING = [/\bgit\s+(push|commit)\b/, /\bgh\s+(pr\s+(create|merge)|run\s+(rerun|cancel)|workflow\s+run|api\s+-X\s*(POST|PATCH|PUT|DELETE))/, /--push-ci/, /release-chat/,
  /npx\s+convex/, /\bssh\s/, /\bdeploy(\.mjs|\.sh|\s)/];

function judge(run: string, state: RunState): { verdict: Verdict; text: string } {
  const all = runs(run, state);
  const scheduled = all.filter(entry => entry.trigger === "schedule");
  const t1 = scheduled[0]?.at ?? Infinity;
  const t2 = scheduled[1]?.at ?? Date.now();
  const dutyJobs = new Map(all.flatMap(entry => entry.job ? [[entry.job.id, entry.job.name] as const] : []));
  const fixtureId = state.fixtures[FIXTURE]!;
  const seen = agentsSeen(run);
  const snapshots = boards(run);
  const newJobs = [...seen].filter(([id]) => id !== fixtureId && !dutyJobs.has(id)).map(([id, info]) => ({ id, ...info }));
  const sessionsOf = (id: string): SessionEvent[] => sessionFiles(id).flatMap(readSessionFile);
  const checks: Check[] = [];

  const goalA = newJobs.map(job => {
    const steps = snapshots.flatMap(board => goalOf(board, { id: job.id, name: job.name })).filter(found => found.goal === GOAL_A.id);
    const events = readSession(job.id);
    const turn = events.find(event => event.kind === "assistant" || event.kind === "call");
    const brief = firstUserText(events);
    return { job, steps, turn, brief };
  }).filter(entry => entry.steps.length);
  const startedA = goalA.find(entry => entry.job.first <= t2 && entry.turn && entry.turn.at <= t2 && entry.steps.some(found => found.step.status === "doing"));
  checks.push({ id: "a", ok: !!startedA, detail: startedA ? `${startedA.job.name} (${startedA.job.id}) is on ${startedA.steps[0]!.step.id} "${clip(startedA.steps[0]!.step.text, 90)}", first seen ${new Date(startedA.job.first).toISOString()}, first turn ${new Date(startedA.turn!.at).toISOString()}`
    : `no new job of the test chat sits on a doing step under ${GOAL_A.id} with a turn before ${new Date(t2).toISOString()}; jobs tied to ${GOAL_A.id}: ${goalA.map(entry => entry.job.name).join(", ") || "none"}` });
  const briefA = goalA[0]?.brief ?? "";
  const a2 = !!briefA && names(briefA, GOAL_A.value) && names(briefA, GOAL_A.target) && GOAL_A.gap.some(gap => names(briefA, gap));
  checks.push({ id: "a2", ok: goalA.length ? a2 : false, detail: briefA ? `brief of ${goalA[0]!.job.name}: 14.9 ${names(briefA, "14.9") ? "named" : "missing"}, 100 ${names(briefA, "100") ? "named" : "missing"}, gap 85.1 ${names(briefA, "85.1") ? "named" : "missing"}. "${clip(briefA, 400)}"` : "no job for goal A, so no brief" });

  const fixtureIn = readSession(fixtureId).filter((event): event is Extract<SessionEvent, { kind: "text" }> => event.kind === "text" && event.at >= state.windowStart && event.customType === "agent_message");
  const steers = fixtureIn.filter(event => (event.fromId && dutyJobs.has(event.fromId)) || /^check-in/.test(event.from ?? ""));
  const steerB = steers.find(event => names(event.text, GOAL_B.value) && names(event.text, GOAL_B.target) && GOAL_B.gap.some(gap => names(event.text, gap)));
  checks.push({ id: "b", ok: !!steerB, detail: steerB ? `from ${steerB.from} at ${new Date(steerB.at).toISOString()}: "${clip(steerB.text, 400)}"`
    : `${steers.length} messages from check-in jobs reached the fixture; ${steers.map(event => `"${clip(event.text, 200)}"`).join(" | ") || "none"}` });

  const scanned: { session: string; at: number; text: string; from: string }[] = [];
  for (const id of new Set([state.chat.id, fixtureId, ...dutyJobs.keys(), ...newJobs.map(job => job.id)])) {
    for (const text of systemTexts(readSession(id), state.seeds, state.windowStart)) scanned.push({ session: id, ...text });
  }
  const hits = scanned.flatMap(text => {
    const flags = flagHits(text.text);
    const lists = stepIdLists(text.text);
    return flags.length || lists.length ? [`${text.session.slice(0, 8)} from ${text.from} at ${new Date(text.at).toISOString()}: ${flags.length ? `flag kinds ${flags.join(", ")}` : ""}${flags.length && lists.length ? "; " : ""}${lists.length ? `step id lists ${lists.map(ids => ids.join(" ")).join(" / ")}` : ""}`] : [];
  });
  checks.push({ id: "c", ok: hits.length === 0, detail: `${scanned.length} system texts scanned in ${new Set(scanned.map(text => text.session)).size} sessions; ${hits.length} with hits${hits.length ? `:\n${hits.slice(0, 12).map(hit => `    - ${hit}`).join("\n")}` : ""}` });

  const byGoal = new Map<string, { id: string; name: string; first: number; last: number }[]>();
  for (const job of newJobs) {
    const goals = new Set(snapshots.flatMap(board => goalOf(board, job)).map(found => found.goal));
    const events = readSession(job.id);
    const last = Math.max(job.first, ...events.map(event => event.at));
    for (const goal of goals) byGoal.set(goal, [...(byGoal.get(goal) ?? []), { ...job, last }]);
  }
  const churn: string[] = [];
  for (const [goal, jobs] of byGoal) {
    const sorted = jobs.sort((a, b) => a.first - b.first);
    for (let i = 1; i < sorted.length; i++) if (sorted[i - 1]!.last + 30 * 60_000 > sorted[i]!.first) churn.push(`${goal}: ${sorted[i]!.name} started while ${sorted[i - 1]!.name} was alive`);
  }
  for (const board of snapshots) {
    const goal = board.plan.find(item => item.id === GOAL_B.id);
    walk(goal ? [goal] : [], item => { if (item.duty === PUSH_LINK && item.job !== FIXTURE && item.sessionId !== fixtureId) churn.push(`rev ${board.rev}: ${item.id} moved from the fixture to ${item.job ?? "no job"}`); });
  }
  checks.push({ id: "d", ok: churn.length === 0, detail: churn.length ? [...new Set(churn)].join("; ") : `${newJobs.length} new jobs over ${byGoal.size} goals, no second job while a first was alive, and the fixture kept goal B` });

  const reports = readSession(state.chat.id).filter((event): event is Extract<SessionEvent, { kind: "text" }> => event.kind === "text" && event.at >= state.windowStart
    && event.customType === "agent_message" && ((event.fromId !== undefined && dutyJobs.has(event.fromId)) || /^check-in/.test(event.from ?? "")));
  const shapes = reports.map(event => ({ event, shape: reportShape(event.text.replace(/^\[agent-message from [^\]]*\]\s*/, "")) }));
  checks.push({ id: "e", ok: shapes.length > 0 && shapes.every(({ shape }) => shape.ok && shape.namesGoal), detail: shapes.length ? shapes.map(({ event, shape }) =>
    `${event.from} at ${new Date(event.at).toISOString()}: ${shape.lines} lines, 14.9 ${shape.namesGoal ? "named" : "missing"}: "${clip(event.text, 500)}"`).join("\n    ") : "no check-in job sent the test chat a message" });

  const withJob = scheduled.filter(entry => entry.job);
  checks.push({ id: "f", ok: withJob.length >= 2, detail: `${scheduled.length} scheduled check-in runs in the window, ${withJob.length} with a duty job: ${all.map(entry => `${new Date(entry.at).toISOString()} ${entry.trigger} ${entry.job?.name ?? entry.summary ?? ""}`).join("; ") || "none"}` });

  const allowed = new Set([state.chat.id, fixtureId, ...dutyJobs.keys(), ...newJobs.map(job => job.id)]);
  const unsafe: string[] = [];
  for (const id of allowed) {
    if (id === fixtureId) continue;
    for (const event of sessionsOf(id)) {
      if (event.at < state.windowStart) continue;
      if (event.kind === "call") for (const pattern of MUTATING) { const match = pattern.exec(event.input); if (match) unsafe.push(`${id.slice(0, 8)} ran "${clip(event.input.slice(Math.max(0, match.index - 60), match.index + 80), 160)}"`); }
      if (event.kind === "sent" && event.to && !allowed.has(event.to)) unsafe.push(`${id.slice(0, 8)} messaged ${event.toName || event.to} outside the test chat`);
    }
  }
  checks.push({ id: "g", ok: unsafe.length === 0, detail: unsafe.length ? unsafe.slice(0, 12).join("; ") : `no mutating command and no message outside the test chat in ${allowed.size - 1} sessions and their subagents` });

  const head = readSession(state.chat.id).filter(event => event.at >= state.windowStart);
  const acts = head.flatMap(event => event.kind === "call" && (event.tool === "chat_board" && /"ops"/.test(event.input) || /spawn\(|create_session\(|agent_message\.send/.test(event.input)) ? [`${event.tool} ${clip(event.input, 120)}`]
    : event.kind === "sent" ? [`sent to ${event.toName}`] : []);
  checks.push({ id: "h", ok: acts.length === 0, detail: acts.length ? acts.slice(0, 8).join("; ") : `the head made ${head.filter(event => event.kind === "assistant").length} replies and no board op, start or send` });

  const get = (id: string) => checks.find(check => check.id === id)!;
  const voided = !get("f").ok || !get("g").ok || !get("h").ok;
  const verdict: Verdict = voided ? "void" : checks.every(check => check.ok) ? "pass" : "fail";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `The test chat "${state.chat.name}" (${state.chat.id}) ran on ${state.release} from ${new Date(state.windowStart).toISOString()} to ${new Date().toISOString()}, check-in every ${state.everyMs / 60_000} min, judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ${join(run, "criteria.md")}. Setup and changes from the real board: ${join(run, "setup.md")}. Evidence: ${run}/boards, agents, prompts, runs.jsonl and service.log, and the session files named below.`, "",
    "## Verdict per criterion", "",
    ...checks.map(check => `- (${check.id}) ${yes(check.ok)}: ${check.detail}`), "",
    `Window: first scheduled run ${Number.isFinite(t1) ? new Date(t1).toISOString() : "none"}, second ${scheduled[1] ? new Date(t2).toISOString() : "none"}. Duty jobs: ${[...dutyJobs].map(([id, name]) => `${name} ${id}`).join(", ") || "none"}. New jobs: ${newJobs.map(job => `${job.name} ${job.id}`).join(", ") || "none"}.`, "",
  ].join("\n");
  return { verdict, text };
}

/** The duty job of Crawler VP's 06:20 KST check-in on 10-16, whose brief is the before's check-in brief. */
const BEFORE_CHECKIN_JOB = "01a14187-03dd-752f-a021-34c5d38e5076";
/** The before: the same text checks on the saved evidence of Crawler VP's 06:20 KST check-in on 10-16, run on the old check-in. */
function judgeBefore(before: string): { verdict: Verdict; text: string } {
  const report = readFileSync(join(before, "crawler-vp-checkin-0620-report.md"), "utf8");
  const board = JSON.parse(readFileSync(join(before, "crawler-vp-board-20261015T2200Z.json"), "utf8")) as ChatBoard;
  const goal = board.plan.find(item => item.id === GOAL_A.id)!;
  let push: PlanItem | undefined;
  walk([goal], item => { if (item.duty === PUSH_LINK) push = item; });
  const body = report.replace(/^\[agent-message from [^\]]*\]\s*/, "");
  const shape = reportShape(body);
  const brief = firstUserText(readSession(BEFORE_CHECKIN_JOB));
  const flags = [...new Set([...flagHits(body), ...flagHits(brief)])];
  const lists = [...stepIdLists(body), ...stepIdLists(brief)];
  const checks: Check[] = [
    { id: "a", ok: !!push, detail: push ? `${push.id} pushes ${GOAL_A.id}` : `the board at 22:00Z, 100 min after the 06:20 KST run, has no step under ${GOAL_A.id} that owns its number, and the report names no job started for it` },
    { id: "a2", ok: false, detail: "no job was started for goal A, so no brief named 14.9, 100 and 85.1" },
    { id: "b", ok: names(body, GOAL_A.value), detail: `the report ${names(body, GOAL_A.value) ? "names" : "never names"} p71's 14.9, and no steer of a number's owner shows in it` },
    { id: "c", ok: !flags.length && !lists.length, detail: `the 06:20 job's brief (session ${BEFORE_CHECKIN_JOB}) and its report to Crawler VP have flag kinds ${flags.join(", ") || "none"} and step id lists ${lists.map(ids => ids.join(" ")).join(" / ") || "none"}` },
    { id: "d", ok: null, detail: "one run of evidence, so churn across cycles is not judged" },
    { id: "e", ok: shape.ok && shape.namesGoal, detail: `${shape.lines} non-empty lines, 14.9 ${shape.namesGoal ? "named" : "missing"}` },
  ];
  const text = [
    "# Before: Crawler VP's 06:20 KST check-in on 10-16 (old check-in), judged by `clean-room.ts baseline`", "",
    `Evidence: ${before}/crawler-vp-checkin-0620-report.md, checkin-261016-0620.flagged.md and crawler-vp-board-20261015T2200Z.json.`,
    "The live release was already the redesign (release-293f722) when this job started, so the before uses the saved run instead of a live one.", "",
    ...checks.map(check => `- (${check.id}) ${yes(check.ok)}: ${check.detail}`), "",
  ].join("\n");
  return { verdict: checks.some(check => check.ok === false) ? "fail" : "pass", text };
}
