import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatAgent, ChatBoard, PlanItem } from "../../src/shared/types.ts";
import { readSession, type RunState, type Scenario, type SessionEvent, sessionFiles, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for the board skill's Plan and duties fix (skills/board/references/plan-and-duties.md). The owner said on 10-18 that a
 * chat told "fix plan and duties based on THIS skill and persue completion of plans" should sort its plan out on its own. A fresh chat on a small
 * read-only area gets a messy board written here from scratch and the owner's one sentence as its first message. The criteria live in
 * ~/.prime/agent/clean-room/plan-and-duties/criteria.md, written before the first run.
 */
export const SENTENCE = "fix plan and duties based on the board skill and pursue completion of plans";
const DATA = process.env.AGENT_CHAT_DATA_DIR ?? join(homedir(), ".prime/agent/browser-chat");
const OPEN = new Set(["todo", "doing", "blocked"]);
const LIVE_MS = 2 * 3600_000;

/** The seeded items each criterion reads: the work goal and its steps, the risk goal and its risks, the upkeep step, the done step. */
export const SEED = { work: "p1", done: "p2", research: "p3", page: "p4", upkeep: "p5", alerts: "p6", risks: ["p7", "p8"] } as const;

const item = (id: string, text: string, status: PlanItem["status"], extra: Partial<PlanItem> = {}, children: PlanItem[] = []): PlanItem =>
  ({ id, text, status, ...extra, children });

/** A plan the way a chat leaves it after a few days of drift: no done line, unowned steps, an upkeep step, a goal of standing risks, a done step left open. */
export function messyBoard(now: string): ChatBoard {
  return { v: 2, rev: 37, updatedAt: now, todos: [], lastIds: { p: 8, t: 0 }, plan: [
    item(SEED.work, "Pinterest index gaps: find which gaps matter most and keep a top 10 page", "doing", {}, [
      item(SEED.done, "Find where Pinterest data lands in the crawler", "doing", { note: "Found: apps/crawler-v3/alembic/versions/0044_pinterest_socialcrawl.py " +
        "makes pinterest_accounts, pinterest_boards, pinterest_pins and pinterest_url_stat_observations, and apps/crawler-v3/src/index/sync/projectors/_shared.py " +
        "lists pinterest in _SOCIAL_HOSTS." }),
      item(SEED.research, "Research the Pinterest index gaps and measure each one's size from real data", "todo"),
      item(SEED.page, "Write the top 10 page on the wiki, ranked by who each gap hurts", "todo"),
      item(SEED.upkeep, "Keep the page fresh every day", "todo"),
    ]),
    item(SEED.alerts, "Firing prod alerts", "doing", {}, [
      item(SEED.risks[0], "wiki box disk fills within 30 days", "todo"),
      item(SEED.risks[1], "Pinterest rate limit hit on the crawler's reads", "todo"),
    ]),
  ] };
}

export const planAndDuties: Scenario = {
  name: "plan-and-duties",
  headMessage: () => SENTENCE,
  fixtures: [],
  board: () => ({ board: messyBoard(new Date().toISOString()), changes: [
    `${SEED.work} is a work goal with no done line and no target; its steps ${SEED.research} and ${SEED.page} have no owner.`,
    `${SEED.done} is done (its note holds the evidence) but still open.`,
    `${SEED.upkeep} is an upkeep step inside the work goal.`,
    `${SEED.alerts} holds only the standing risks ${SEED.risks.join(" and ")}.`,
  ] }),
  setupNotes: (state, changes) => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with the owner's one sentence as its first message.`,
    `Its board was written from scratch by plan-and-duties.ts, never copied from another chat, and seeded while its check-in was paused. Its check-in runs every ${state.everyMs / 60_000} min.`, "",
    "## The board", "", ...changes.map((line, index) => `${index + 1}. ${line}`), "",
    "## The first message", "", `> ${SENTENCE}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};

interface Check { id: string; ok: boolean | null; detail: string }
const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 240): string => (text.length > length ? text.slice(0, length - 1) + "…" : text).replace(/\s+/g, " ");
const walk = (items: readonly PlanItem[], visit: (item: PlanItem, parent: PlanItem | undefined) => void, parent?: PlanItem): void => {
  for (const one of items) { visit(one, parent); walk(one.children, visit, one); }
};
const find = (board: ChatBoard | undefined, id: string): { item: PlanItem; parent?: PlanItem } | undefined => {
  let found: { item: PlanItem; parent?: PlanItem } | undefined;
  walk(board?.plan ?? [], (one, parent) => { if (one.id === id) found = { item: one, ...(parent ? { parent } : {}) }; });
  return found;
};
const readJson = <T>(path: string): T | undefined => { try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; } };

/** When setup wrote the seed, from its log line; the chat's first board read must come after it. */
function seededAt(run: string): number {
  const line = (existsSync(join(run, "clean-room.log")) ? readFileSync(join(run, "clean-room.log"), "utf8") : "").split("\n").filter(text => / seeded board rev /.test(text)).at(-1);
  return line ? Date.parse(line.split(" ")[0]!) : NaN;
}
function lastAgents(run: string): ChatAgent[] {
  const dir = join(run, "agents");
  const last = existsSync(dir) ? readdirSync(dir).sort().at(-1) : undefined;
  return last ? readJson<ChatAgent[]>(join(dir, last)) ?? [] : [];
}
const blockText = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(block => typeof block === "object" && block && "text" in block && typeof block.text === "string" ? block.text : "").join("\n") : "";

/** The first time the chat's own sessions read the procedure: a tool result with its headings, or a call that names the file. */
export function procedureRead(files: readonly string[], since: number): { at: number; how: string } | undefined {
  let first: { at: number; how: string } | undefined;
  for (const file of files) for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes("lan and duties") && !line.includes("plan-and-duties") && !line.includes("## Fix the plan")) continue;
    let entry: { timestamp?: string; type?: string; message?: { role?: string; content?: unknown } };
    try { entry = JSON.parse(line) as typeof entry; } catch { continue; }
    const at = Date.parse(entry.timestamp ?? "") || 0;
    if (entry.type !== "message" || at < since || (first && first.at <= at)) continue;
    const message = entry.message ?? {};
    if (message.role === "toolResult") {
      const text = blockText(message.content);
      if (text.includes("## Fix the plan")) first = { at, how: "a tool result holds references/plan-and-duties.md (its \"## Fix the plan\" section)" };
      else if (/^## Plan and duties$/m.test(text)) first = { at, how: "a tool result holds the board SKILL.md \"## Plan and duties\" section" };
    }
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content as { type?: string; arguments?: unknown }[]) {
        const input = block.type === "toolCall" ? JSON.stringify(block.arguments ?? {}) : "";
        if (input.includes("plan-and-duties")) { first = { at, how: `a call names plan-and-duties: ${clip(input, 200)}` }; break; }
      }
    }
  }
  return first;
}

interface Duty { id: string; name: string; metrics?: { key: string; label: string; why?: string }[]; status?: string }
const FRESH = /fresh|stale|age|refresh|updated|since the|last (run|update|measure)/i;
/** A note that names a wiki risk page: a wiki link or path, or the words "risk page". */
const RISK_PAGE = /wiki:|\.html\b|\bapps\/[\w-]+\/|risks? page/i;

function judge(run: string, state: RunState): { verdict: Verdict; text: string } {
  const now = Date.now();
  const head = readSession(state.chat.id);
  const users = head.filter((event): event is Extract<SessionEvent, { kind: "text" }> => event.kind === "text" && event.role === "user");
  const sentence = users[0];
  const sentAt = sentence?.at ?? state.windowStart;
  const boardsDir = join(run, "boards");
  const snapshots = existsSync(boardsDir) ? readdirSync(boardsDir).sort().flatMap(file => readJson<ChatBoard>(join(boardsDir, file)) ?? []) : [];
  const board = readJson<ChatBoard>(join(DATA, "boards", `${state.chat.id}.json`)) ?? snapshots.at(-1);
  const duties = (readJson<{ duties?: Duty[] }>(join(DATA, "duties", `${state.chat.id}.json`))?.duties ?? []).filter(duty => duty.status !== "deleted");
  const checks: Check[] = [];

  const typed = users.slice(1).filter(event => !event.text.trimStart().startsWith("["));
  checks.push({ id: "1", ok: sentence?.text.trim() === SENTENCE && state.seeds.length === 1, detail: sentence
    ? `the first user message at ${iso(sentence.at)} reads "${clip(sentence.text, 200)}"; setup sent ${state.seeds.length} seed${state.seeds.length === 1 ? "" : "s"}` : "the chat has no user message" });

  const read = procedureRead(sessionFiles(state.chat.id), sentAt);
  const inTime = read !== undefined && read.at - sentAt <= state.everyMs;
  checks.push({ id: "2", ok: inTime ? true : now - sentAt < state.everyMs ? null : false, detail: read
    ? `${iso(read.at)}, ${Math.round((read.at - sentAt) / 60_000)} min after the sentence (interval ${state.everyMs / 60_000} min): ${read.how}`
    : "no session file of the chat reads references/plan-and-duties.md or the Plan and duties section after the sentence" });

  const dutyNamed = (note: string): boolean => /\bd\d+\b|\bduty\b/i.test(note) || duties.some(duty => note.toLowerCase().includes(duty.name.toLowerCase()));
  const moved = [SEED.upkeep, ...SEED.risks].map(id => {
    const left = find(board, id);
    const goalId = id === SEED.upkeep ? SEED.work : SEED.alerts;
    const goal = find(board, goalId)?.item;
    const gone = !left || !OPEN.has(left.item.status);
    const holds = (note: string): boolean => dutyNamed(note) || (id !== SEED.upkeep && RISK_PAGE.test(note));
    const holder = [goal?.note ?? "", left?.item.note ?? ""].find(holds);
    return { id, ok: gone && holder !== undefined, detail: `${id} ${left ? `is ${left.item.status}` : "is removed"}; its goal ${goalId} ${goal ? `notes "${clip(goal.note ?? "", 200)}"` : "is removed"}` +
      (left?.item.note ? `; its own note "${clip(left.item.note, 160)}"` : "") };
  });
  checks.push({ id: "3", ok: moved.every(entry => entry.ok), detail: moved.map(entry => `${entry.ok ? "ok" : "not yet"}: ${entry.detail}`).join("\n    ") });

  const goals = (board?.plan ?? []).filter(goal => OPEN.has(goal.status));
  const lined = goals.map(goal => ({ goal, ok: /^\s*done when/i.test(goal.note ?? "") || goal.target !== undefined }));
  checks.push({ id: "4", ok: goals.length > 0 && lined.every(entry => entry.ok), detail: goals.length ? lined.map(({ goal, ok }) =>
    `${ok ? "ok" : "missing"}: ${goal.id} "${clip(goal.text, 80)}" ${goal.target ? `target ${goal.target.current ?? "?"} of ${goal.target.target} ${goal.target.unit}` : "no target"}, note "${clip(goal.note ?? "", 140)}"`).join("\n    ")
    : "the plan has no open goal" });

  const agents = lastAgents(run);
  const wakes = existsSync(join(DATA, "wakes")) ? readdirSync(join(DATA, "wakes")) : [];
  const steps: PlanItem[] = [];
  walk(board?.plan ?? [], (one, parent) => { if (parent && OPEN.has(one.status) && !one.children.some(child => OPEN.has(child.status))) steps.push(one); });
  const owned = steps.map(step => {
    const agent = agents.find(candidate => candidate.steps.includes(step.id) || (step.sessionId && candidate.sessionId === step.sessionId) || (step.job && (candidate.name === step.job || candidate.job === step.job)));
    const session = step.sessionId ?? agent?.sessionId;
    const lastAt = Math.max(agent?.lastActivityAt ? Date.parse(agent.lastActivityAt) : 0, ...(session ? readSession(session, [state.chat.id]).map(event => event.at) : [0]));
    const wake = session ? wakes.find(file => file.startsWith(session)) : undefined;
    const todo = board?.todos.find(entry => !entry.done && entry.step === step.id);
    const live = agent?.state === "working" || agent?.wait !== undefined || now - lastAt <= LIVE_MS || wake !== undefined;
    const how = todo ? `For you todo ${todo.id}` : live ? `${agent?.name ?? step.job ?? session} (${agent?.state ?? "no row"}, last active ${lastAt ? iso(lastAt) : "never"}${wake ? `, wake ${wake}` : ""})`
      : `owner ${step.job ?? step.sessionId ?? "none"}${lastAt ? `, last active ${iso(lastAt)}` : ""}`;
    return { step, ok: live || todo !== undefined, how };
  });
  checks.push({ id: "5", ok: owned.every(entry => entry.ok), detail: owned.length ? owned.map(({ step, ok, how }) => `${ok ? "ok" : "no live owner"}: ${step.id} "${clip(step.text, 70)}" ${how}`).join("\n    ")
    : "the plan has no open step" });

  // The seed has no closed item, so every closed item is one the chat closed or added closed; the moved risks and upkeep are judged in 3.
  const closed: { item: PlanItem; ok: boolean }[] = [];
  walk(board?.plan ?? [], one => {
    if (!OPEN.has(one.status) && ![SEED.upkeep, ...SEED.risks].includes(one.id as never)) closed.push({ item: one, ok: (one.note ?? "").trim().length >= 20 });
  });
  const doneStep = find(board, SEED.done)?.item;
  checks.push({ id: "6", ok: doneStep !== undefined && !OPEN.has(doneStep.status) && closed.every(entry => entry.ok), detail: [
    `${SEED.done} ${doneStep ? `is ${doneStep.status}` : "is removed"}`, ...closed.map(({ item: one, ok }) => `${ok ? "ok" : "no evidence"}: ${one.id} ${one.status} "${clip(one.text, 70)}", note "${clip(one.note ?? "", 160)}"`),
  ].join("\n    ") });

  const metrics = duties.flatMap(duty => (duty.metrics ?? []).map(metric => ({ duty, metric })));
  const fresh = metrics.find(({ duty, metric }) => FRESH.test(`${metric.key} ${metric.label} ${metric.why ?? ""}`) || FRESH.test(duty.name));
  checks.push({ id: "7", ok: fresh !== undefined, detail: fresh ? `${fresh.duty.id} "${fresh.duty.name}" metric ${fresh.metric.key} "${fresh.metric.label}" keeps the page fresh`
    : `no duty metric reads the page's freshness; duties: ${duties.map(duty => `${duty.id} "${duty.name}" (${(duty.metrics ?? []).map(metric => metric.key).join(", ")})`).join("; ") || "none"}` });

  const runsFile = join(run, "runs.jsonl");
  const dutyJobs = existsSync(runsFile) ? readFileSync(runsFile, "utf8").split("\n").flatMap(line => { try { const id = (JSON.parse(line) as { job?: { id?: string } }).job?.id; return id ? [id] : []; } catch { return []; } }) : [];
  const family = new Set([...agents.flatMap(agent => agent.sessionId ? [agent.sessionId] : []), ...dutyJobs]);
  const outside = typed.map(event => `a typed message at ${iso(event.at)}: "${clip(event.text, 120)}"`);
  for (const event of head) {
    if (event.kind !== "text" || event.customType !== "agent_message" || event.at < sentAt) continue;
    if (event.relation === "child" || event.relation === "parent") continue;
    if (!family.has(event.fromId ?? "")) outside.push(`${event.from ?? event.fromId ?? "an agent"} messaged the chat at ${iso(event.at)}: "${clip(event.text, 120)}"`);
  }
  checks.push({ id: "8", ok: outside.length === 0, detail: outside.length ? outside.join("; ") : "no typed message after the sentence and no message from outside the chat's own sessions" });

  const seededTime = seededAt(run);
  const firstRead = head.find(event => event.kind === "call" && /board\.(open|get)|chat_board/.test(event.input));
  const raced = Number.isFinite(seededTime) && firstRead !== undefined && firstRead.at < seededTime;

  const touched: string[] = [];
  const MUTATING = [/\bgit\s+push\b/, /\bgh\s+pr\s+merge/, /release-chat/, /npx\s+convex\s+(run|deploy|import)/, /\bdeploy(\.mjs|\.sh)\b/];
  for (const file of sessionFiles(state.chat.id)) for (const line of readFileSync(file, "utf8").split("\n")) for (const pattern of MUTATING) {
    const match = pattern.exec(line);
    if (match && line.includes("\"toolCall\"")) touched.push(clip(line.slice(Math.max(0, match.index - 60), match.index + 80), 140));
  }
  const riskMetrics = metrics.filter(({ metric }) => /risk|alert|disk|rate.?limit|fir(e|ing)/i.test(`${metric.key} ${metric.label}`));

  const ended = state.until !== undefined && state.until <= now;
  // On 10-18 run-1's chat and its check-in job waited on pi-pool for the whole 90 min window and never got a model turn, so nothing was judged.
  const ran = head.some(event => event.at >= sentAt && (event.kind === "assistant" || event.kind === "call"));
  const voided = checks.find(check => check.id === "8")!.ok === false || raced || (ended && !ran);
  const unmet = checks.filter(check => check.ok !== true);
  const verdict: Verdict = voided ? "void" : !unmet.length ? "pass" : ended || unmet.some(check => check.ok === false && ["1", "2"].includes(check.id)) ? "fail" : "open";
  const label = (check: Check): string => check.ok === null ? "not reached yet" : check.ok ? "met" : ended || ["1", "2", "8"].includes(check.id) ? "not met" : "not met yet";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${state.chat.id}) ran on ${state.release} from ${iso(state.windowStart)} to ${iso(now)}, check-in every ${state.everyMs / 60_000} min, with a messy seeded board and the owner's one sentence. Judged by \`clean-room.ts evaluate\` at board rev ${board?.rev ?? "?"}.`,
    `Criteria: ${join(run, "criteria.md")}. Evidence: the board file ${join(DATA, "boards", `${state.chat.id}.json`)}, the duties file ${join(DATA, "duties", `${state.chat.id}.json`)}, the session file ${join(homedir(), ".prime/agent/sessions", `${state.chat.id}.jsonl`)}, and ${run}/boards and agents.`, "",
    ...(!ran ? ["The chat never got a model turn after the sentence: each of its turns ended with an error before any text or tool call, such as a pi-pool slot wait, so the run judged nothing.", ""] : []),
    ...(raced ? [`The chat read its board at ${iso(firstRead!.at)}, before the seed at ${iso(seededTime)}, so it saw an empty board and the run is void.`, ""] : []),
    "## Verdict per criterion", "", ...checks.map(check => `- (${check.id}) ${label(check)}: ${check.detail}`), "",
    "## Seen, not judged", "",
    `- Duty metrics that read the risks: ${riskMetrics.map(({ duty, metric }) => `${duty.id}/${metric.key} "${metric.label}"`).join("; ") || "none"}.`,
    `- Commands that push, merge, release or write prod: ${touched.length ? touched.join("; ") : "none"}.`,
    `- Open todos on the chat's board: ${(board?.todos ?? []).filter(todo => !todo.done).map(todo => `${todo.id} "${clip(todo.text, 100)}"`).join("; ") || "none"}.`, "",
  ].join("\n");
  return { verdict, text };
}
