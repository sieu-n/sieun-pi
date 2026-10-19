import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatBoard, PlanItem } from "../../src/shared/types.ts";
import { upkeepWords } from "../../src/shared/upkeep-title.ts";
import { throttledMs } from "./plan-and-duties.ts";
import { readSession, type RunState, type Scenario, type SessionEvent, sessionFile, sessionFiles, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for the plan-versus-duty rule (owner 10-19 on the AI harness chat: "things like "i need to keep X working" should NOT
 * be registered as a zombie plan. ALL PLANS SHOULD BE EPHEMERAL"). A fresh chat gets one owner-style message that holds a task that finishes and
 * an upkeep ask, and nothing is seeded. The pass is a plan that holds only the finishable work, a duty for the upkeep, and the work closed done
 * with no steer. The criteria live in ~/.prime/agent/clean-room/task-and-upkeep/criteria.md, written before the first run.
 */
export const TASK = "which of our crawler-v3 platforms have no unit tests? put the list on a wiki page and make sure it keeps matching the code as platforms get added";
const DATA = process.env.AGENT_CHAT_DATA_DIR ?? join(homedir(), ".prime/agent/browser-chat");
const WIKI = process.env.WIKI_CONTENT_DIR ?? join(homedir(), "Documents/Github/auto-sns-agent/apps/llm-wiki/content");
const OPEN = new Set(["todo", "doing", "blocked"]);

/**
 * A title that describes upkeep instead of work that ends: the board's own upkeepWords, plus the wording of this request ("keeps matching the
 * code", "up to date"). A "Build the duty ..." step is work: it ends when the duty is written.
 */
const MATCHING = /\bkeeps? (?:[\w'-]+ ){0,3}?matching\b|\bstays? (?:[\w'-]+ ){0,3}?(?:matching|in step)\b|\bup to date\b|\bongoing\b/i;
const BUILD_DUTY = /^\s*build the\b[^.]*\bduty\b/i;
export const upkeepTitle = (text: string): boolean => (upkeepWords(text) !== null || MATCHING.test(text)) && !BUILD_DUTY.test(text);

interface Check { id: string; ok: boolean | null; detail: string }
interface Duty { id: string; name: string; goal?: string; metrics?: { key: string; label: string }[]; status?: string }
interface Agent { sessionId?: string; name: string; job?: string; state: string; steps: string[]; lastActivityAt?: string }
const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 200): string => (text.length > length ? text.slice(0, length - 1) + "…" : text).replace(/\s+/g, " ");
const walk = (items: readonly PlanItem[], visit: (item: PlanItem) => void): void => { for (const one of items) { visit(one); walk(one.children, visit); } };
const readJson = <T>(path: string): T | undefined => { try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; } };

export const taskAndUpkeep: Scenario = {
  name: "task-and-upkeep",
  headMessage: () => TASK,
  fixtures: [],
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message and no seeded board, todo or fixture.`,
    `Its check-in runs every ${state.everyMs / 60_000} min. No other chat's interval changed.`, "",
    "## The first message", "", `> ${TASK}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};

function snapshots(run: string): ChatBoard[] {
  const dir = join(run, "boards");
  return existsSync(dir) ? readdirSync(dir).sort().flatMap(file => readJson<ChatBoard>(join(dir, file)) ?? []) : [];
}
function lastAgents(run: string): Agent[] {
  const dir = join(run, "agents");
  const last = existsSync(dir) ? readdirSync(dir).sort().at(-1) : undefined;
  return last ? readJson<Agent[]>(join(dir, last)) ?? [] : [];
}

/** Each open upkeep-worded item and how long it stayed open on the board, from the first snapshot that shows it to the first that does not. */
function upkeepSpans(boards: readonly ChatBoard[], end: number): { id: string; text: string; from: number; to: number }[] {
  const spans = new Map<string, { id: string; text: string; from: number; to: number }>();
  for (const board of boards) {
    const at = Date.parse(board.updatedAt) || 0;
    const now = new Set<string>();
    walk(board.plan, item => {
      if (!OPEN.has(item.status) || !upkeepTitle(item.text)) return;
      now.add(item.id);
      const span = spans.get(item.id);
      if (!span) spans.set(item.id, { id: item.id, text: item.text, from: at, to: end });
    });
    for (const span of spans.values()) if (span.to === end && !now.has(span.id) && span.from < at) span.to = at;
  }
  return [...spans.values()];
}

/** The wiki paths a note names, like apps/crawler-v3/foo/index.html or wiki:apps/crawler-v3/foo. */
const wikiPaths = (note: string): string[] => [...note.matchAll(/(?:wiki:)?((?:apps|projects|domains|agents)\/[\w./-]+)/g)].map(match => match[1]!.replace(/[.,)]+$/, ""));
const pageExists = (path: string): boolean => [path, `${path}.html`, join(path, "index.html")].some(candidate => existsSync(join(WIKI, candidate)));

function judge(run: string, state: RunState): { verdict: Verdict; text: string } {
  const now = Date.now();
  const ended = state.until !== undefined && state.until <= now;
  const head = readSession(state.chat.id);
  const users = head.filter((event): event is Extract<SessionEvent, { kind: "text" }> => event.kind === "text" && event.role === "user");
  const first = users[0];
  const sentAt = first?.at ?? state.windowStart;
  const boards = snapshots(run);
  const board = readJson<ChatBoard>(join(DATA, "boards", `${state.chat.id}.json`)) ?? boards.at(-1);
  const duties = (readJson<{ duties?: Duty[] }>(join(DATA, "duties", `${state.chat.id}.json`))?.duties ?? []).filter(duty => duty.status !== "deleted");
  const checks: Check[] = [];

  checks.push({ id: "1", ok: first?.text.trim() === TASK && state.seeds.length === 1, detail: first
    ? `the first user message at ${iso(first.at)} reads "${clip(first.text)}"; setup sent ${state.seeds.length} seed${state.seeds.length === 1 ? "" : "s"}` : "the chat has no user message" });

  const items: PlanItem[] = [];
  walk(board?.plan ?? [], item => items.push(item));
  const finishable = items.filter(item => !upkeepTitle(item.text));
  const spans = upkeepSpans(boards, Math.min(now, state.until ?? now));
  const lingering = spans.filter(span => span.to - span.from > state.everyMs);
  const openUpkeep = items.filter(item => OPEN.has(item.status) && upkeepTitle(item.text));
  checks.push({ id: "2", ok: items.length === 0 ? (ended ? false : null) : finishable.length > 0 && !lingering.length && !openUpkeep.length, detail: [
    `${items.length} plan items, ${finishable.length} worded as work that ends`,
    ...spans.map(span => `${span.to - span.from > state.everyMs ? "lingered" : "fixed in time"}: ${span.id} "${clip(span.text, 90)}" open with upkeep wording from ${iso(span.from)} to ${iso(span.to)}`),
    ...openUpkeep.map(item => `still open with upkeep wording: ${item.id} "${clip(item.text, 90)}"`),
  ].join("\n    ") });

  const metrics = duties.flatMap(duty => (duty.metrics ?? []).map(metric => ({ duty, metric })));
  const covering = metrics.filter(({ duty, metric }) => /test|platform|match|drift|page|list/i.test(`${duty.name} ${duty.goal ?? ""} ${metric.key} ${metric.label}`));
  checks.push({ id: "3", ok: covering.length ? true : ended ? false : null, detail: covering.length
    ? covering.map(({ duty, metric }) => `${duty.id} "${duty.name}" metric ${metric.key} "${clip(metric.label, 120)}"`).join("; ")
    : `no duty metric checks that the page matches the code; duties: ${duties.map(duty => `${duty.id} "${duty.name}" (${(duty.metrics ?? []).map(metric => metric.key).join(", ")})`).join("; ") || "none"}` });

  const doneWork = finishable.filter(item => item.status === "done" && !BUILD_DUTY.test(item.text));
  const withPage = doneWork.flatMap(item => wikiPaths(item.note ?? "").filter(pageExists).map(path => ({ item, path })));
  const agents = lastAgents(run);
  const openSteps = items.filter(item => OPEN.has(item.status) && !item.children.some(child => OPEN.has(child.status)));
  const unowned = openSteps.filter(step => {
    const agent = agents.find(candidate => candidate.steps?.includes(step.id) || (step.sessionId && candidate.sessionId === step.sessionId) || (step.job && (candidate.name === step.job || candidate.job === step.job)));
    const todo = board?.todos.find(entry => !entry.done && entry.step === step.id);
    return !todo && agent?.state !== "working";
  });
  checks.push({ id: "4", ok: withPage.length && !unowned.length ? true : ended ? false : null, detail: [
    ...withPage.map(({ item, path }) => `done with its page: ${item.id} "${clip(item.text, 90)}", note names ${path}, which exists`),
    ...doneWork.filter(item => !withPage.some(entry => entry.item === item)).map(item => `done: ${item.id} "${clip(item.text, 90)}", note "${clip(item.note ?? "", 140)}"`),
    ...unowned.map(step => `open with no working job or todo: ${step.id} "${clip(step.text, 90)}" (${step.status})`),
  ].join("\n    ") || "no plan item is done yet" });

  const runsFile = join(run, "runs.jsonl");
  const dutyJobs = existsSync(runsFile) ? readFileSync(runsFile, "utf8").split("\n").flatMap(line => { try { const id = (JSON.parse(line) as { job?: { id?: string } }).job?.id; return id ? [id] : []; } catch { return []; } }) : [];
  const family = new Set([...agents.flatMap(agent => agent.sessionId ? [agent.sessionId] : []), ...dutyJobs]);
  const outside = users.slice(1).filter(event => !event.text.trimStart().startsWith("[")).map(event => `a typed message at ${iso(event.at)}: "${clip(event.text, 120)}"`);
  for (const event of head) {
    if (event.kind !== "text" || event.customType !== "agent_message" || event.at < sentAt) continue;
    if (event.relation === "child" || event.relation === "parent") continue;
    if (/^\[agent-message from [^\]]*\]\s*\[relay\]/.test(event.text)) continue;
    if (!family.has(event.fromId ?? "")) outside.push(`${event.from ?? event.fromId ?? "an agent"} messaged the chat at ${iso(event.at)}: "${clip(event.text, 120)}"`);
  }
  checks.push({ id: "5", ok: outside.length === 0, detail: outside.length ? outside.join("; ") : "no typed message after the first one and no message from outside the chat's own sessions" });

  const touched: string[] = [];
  const MUTATING = [/\bgit\s+push\b/, /\bgh\s+pr\s+merge/, /release-chat/, /npx\s+convex\s+(run|deploy|import)/, /\bdeploy(\.mjs|\.sh)\b/];
  for (const file of sessionFiles(state.chat.id)) for (const line of readFileSync(file, "utf8").split("\n")) for (const pattern of MUTATING) {
    const match = pattern.exec(line);
    if (match && line.includes("\"toolCall\"")) touched.push(clip(line.slice(Math.max(0, match.index - 60), match.index + 80), 140));
  }
  const ran = head.some(event => event.at >= sentAt && (event.kind === "assistant" || event.kind === "call"));
  const until = Math.min(now, state.until ?? now);
  const stretches = [state.chat.id, ...family].map(id => ({ id, ms: throttledMs(sessionFile(id, [state.chat.id]), sentAt, until) }));
  const throttled = Math.max(0, ...stretches.map(entry => entry.ms));
  const span = Math.max(1, until - sentAt);
  const starved = ended && throttled / span > 0.5;
  const voided = outside.length > 0 || (ended && !ran) || starved;
  const unmet = checks.filter(check => check.ok !== true);
  const verdict: Verdict = voided ? "void" : !unmet.length ? "pass" : ended || unmet.some(check => check.ok === false && check.id === "1") ? "fail" : "open";
  const label = (check: Check): string => check.ok === null ? "not reached yet" : check.ok ? "met" : ended ? "not met" : "not met yet";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${state.chat.id}) ran on ${state.release} from ${iso(state.windowStart)} to ${iso(now)}, check-in every ${state.everyMs / 60_000} min, with one owner-style message and nothing seeded. Judged by \`clean-room.ts evaluate\` at board rev ${board?.rev ?? "?"}.`,
    `Criteria: ${join(run, "criteria.md")}. Evidence: the board file ${join(DATA, "boards", `${state.chat.id}.json`)}, the duties file ${join(DATA, "duties", `${state.chat.id}.json`)}, the session file ${join(homedir(), ".prime/agent/sessions", `${state.chat.id}.jsonl`)}, and ${run}/boards and agents.`, "",
    `The longest a session of the chat sat on a 429 or a pool slot wait was ${Math.round(throttled / 60_000)} of ${Math.round(span / 60_000)} min${starved ? ", more than half the window, so the run is void" : ""}.`, "",
    "## Verdict per criterion", "", ...checks.map(check => `- (${check.id}) ${label(check)}: ${check.detail}`), "",
    "## Seen, not judged", "",
    `- The final plan: ${items.map(item => `${item.id} ${item.status} "${clip(item.text, 80)}"`).join("; ") || "empty"}.`,
    `- Duties: ${duties.map(duty => `${duty.id} "${duty.name}"`).join("; ") || "none"}.`,
    `- Commands that push, merge, release or write prod: ${touched.length ? touched.join("; ") : "none"}.`,
    `- Open todos on the chat's board: ${(board?.todos ?? []).filter(todo => !todo.done).map(todo => `${todo.id} "${clip(todo.text, 100)}"`).join("; ") || "none"}.`, "",
  ].join("\n");
  return { verdict, text };
}
