import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The Apps reach staging duty's precheck (`node --import tsx scripts/duties/apps-reach-staging.ts`) for the frontend chat. The headline,
 * apps_picked, is how many of the 6 Prospect apps have an owner pick in the 5180 demo's Staging line (apps/virev-demo/lines/staging.json in
 * auto-sns-agent). open_review_max_h is the age of the oldest open review todo the chat put on For you, and demo_ci_ok whether the last
 * verify-dev run on sieun/dev that ran the virev-demo turbo tasks passed them (gh, the receipt lines of the monorepo lint job's log). Run
 * detail, not judged: source_errors and each tab's 0 to 100% status (`tabs`), the owner's "report status (in 0%-100%) of each tab". An
 * unreadable Staging line or board fails the run, since neither the headline nor the reviews can be read without it; a failed gh read leaves
 * demo_ci_ok at 0. No model call, no browser.
 */

const REPO = process.env.LLM_WIKI_REPO || join(homedir(), "Documents/Github/auto-sns-agent");
export const CHAT_ID = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";
const BOARD = join(homedir(), ".prime/agent/browser-chat/boards", `${CHAT_ID}.json`);
export const LINE_FILE = "apps/virev-demo/lines/staging.json";
/** The 6 Prospect apps: their key in the Staging line and the word todos and plan steps use for them. */
export const APPS = [
  { key: "home", word: "Home" }, { key: "inbox", word: "Inbox" }, { key: "watchlist", word: "Watchlist" },
  { key: "email", word: "Email" }, { key: "creators", word: "Creators" }, { key: "connections", word: "Connections" },
] as const;
export const SHIPPED = "shipped";
export const CI_BRANCH = "sieun/dev";
/** checks.yml runs virev-demo#check and virev-demo#test:unit in this job and step when the classify step sets virev_demo. */
export const LINT_JOB = "checks / monorepo / lint";
export const LINT_STEP = "js / lint + typecheck + unit";
export const DEMO_TASKS = ["virev-demo#check", "virev-demo#test:unit"] as const;
const HOUR_MS = 3_600_000;

export interface StagingLine { apps?: Record<string, { variant?: string; at?: string }>; log?: { at?: string }[] }
export interface BoardTodo { id: string; text?: string; done?: boolean; from?: string; at?: string; step?: string }
export interface BoardItem { id: string; text?: string; status?: string; job?: string; children?: BoardItem[] }
export interface Board { plan?: BoardItem[]; todos?: BoardTodo[] }
export interface GhRun { databaseId: number; status?: string; conclusion?: string; createdAt?: string }
export interface GhJob { databaseId?: number; name?: string; steps?: { name?: string; conclusion?: string }[] }
export interface DemoTask { ok: boolean; receipt: string }

export type Exec = (file: string, args: readonly string[], cwd: string) => Promise<string>;
export interface StagingDeps { exec: Exec; now: () => number; read: (path: string) => Promise<string>; repo: string; board: string }

const mentions = (text: string | undefined, word: string): boolean => new RegExp(`\\b${word}\\b`).test(text ?? "");

/** Each app's Staging variant, and whether it is an owner pick: any variant other than the shipped page counts. A missing app is shipped. */
export function picks(line: StagingLine): { key: string; word: string; variant: string; picked: boolean; at?: string }[] {
  return APPS.map(app => {
    const entry = line.apps?.[app.key];
    const variant = entry?.variant ?? SHIPPED;
    return { ...app, variant, picked: variant !== SHIPPED, ...(entry?.at ? { at: entry.at } : {}) };
  });
}

/**
 * Hours an app with no pick has waited for a new review todo: 0 while an agent todo naming the app is open (the owner has it), else the hours
 * since the newest agent todo naming it, else the hours since `since` (the Staging line's first log entry).
 */
export function reviewWait(todos: readonly BoardTodo[], word: string, now: number, since: number): { hours: number; last?: BoardTodo; open?: BoardTodo } {
  const named = todos.filter(todo => todo.from === "agent" && mentions(todo.text, word) && todo.at && Number.isFinite(Date.parse(todo.at)));
  const open = named.find(todo => !todo.done);
  if (open) return { hours: 0, open };
  const last = named.sort((a, b) => Date.parse(b.at!) - Date.parse(a.at!))[0];
  const from = last ? Date.parse(last.at!) : since;
  return { hours: Number.isFinite(from) ? Math.max(0, Math.round((now - from) / HOUR_MS * 10) / 10) : 0, ...(last ? { last } : {}) };
}

/** Open plan steps (todo, doing or blocked) whose text names the app, with their job, so the duty job sees work already in flight. */
export function openSteps(plan: readonly BoardItem[], word: string): string[] {
  const found: string[] = [];
  const walk = (items: readonly BoardItem[]) => {
    for (const item of items) {
      if (["todo", "doing", "blocked"].includes(item.status ?? "") && mentions(item.text, word)) found.push(item.job ? `${item.id} (job ${item.job})` : item.id);
      walk(item.children ?? []);
    }
  };
  walk(plan);
  return found;
}

/** A review ask: an agent todo that names one of the 6 apps or asks to review or pick (t27 on 10-15 says "List app", not "Creators"). */
export const isReview = (todo: BoardTodo): boolean => todo.from === "agent"
  && (APPS.some(app => mentions(todo.text, app.word)) || /\b(review|pick|put in line)\b/i.test(todo.text ?? ""));

/** Open review todos on For you, oldest first, with their age in hours (one decimal). */
export function openReviews(todos: readonly BoardTodo[], now: number): { todo: BoardTodo; hours: number }[] {
  return todos.filter(todo => !todo.done && isReview(todo) && Number.isFinite(Date.parse(todo.at ?? "")))
    .map(todo => ({ todo, hours: Math.max(0, Math.round((now - Date.parse(todo.at!)) / HOUR_MS * 10) / 10) }))
    .sort((a, b) => b.hours - a.hours);
}

export interface TabStatus { key: string; word: string; pct: number; picked: boolean; done: string[]; open: string[] }

/**
 * Each tab's 0 to 100% status: its owner pick on Staging counts as one step, plus every plan step whose text names the tab (dropped steps
 * left out), and the status is the done share. A tab reads 100% only with a pick and every named step done. On 10-15 09:2xZ the board gave
 * Home 6 of 7, Email 6 of 9.
 */
export function tabStatus(plan: readonly BoardItem[], app: { key: string; word: string; picked: boolean }): TabStatus {
  const done: string[] = [];
  const open: string[] = [];
  const walk = (items: readonly BoardItem[]) => {
    for (const item of items) {
      if (mentions(item.text, app.word)) {
        if (item.status === "done") done.push(item.id);
        else if (["todo", "doing", "blocked"].includes(item.status ?? "")) open.push(item.id);
      }
      walk(item.children ?? []);
    }
  };
  walk(plan);
  const pct = Math.round(100 * (done.length + (app.picked ? 1 : 0)) / (done.length + open.length + 1));
  return { key: app.key, word: app.word, pct, picked: app.picked, done, open };
}

/** The lint job's id when it ran the lint + typecheck + unit step to an end (success or failure), else null (skipped, cancelled). */
export function lintJob(jobs: readonly GhJob[]): number | null {
  const job = jobs.find(candidate => candidate.name === LINT_JOB
    && candidate.steps?.some(step => step.name === LINT_STEP && (step.conclusion === "success" || step.conclusion === "failure")));
  return job?.databaseId ?? null;
}

/**
 * The two virev-demo task results from the receipt lines scripts/ci/turbo-run.mjs prints in the job log, or null when the classify step left
 * virev-demo out (no receipt). "exit 0" and a cache hit pass (turbo caches only a task that exited 0); "failed with exit N" and "not run" fail.
 */
export function demoSteps(log: string): Record<string, DemoTask> | null {
  const result: Record<string, DemoTask> = {};
  for (const line of log.split("\n")) {
    const match = /turbo task (\S+): (.*)$/.exec(line.trimEnd());
    if (!match || !(DEMO_TASKS as readonly string[]).includes(match[1]!)) continue;
    const receipt = match[2]!;
    result[match[1]!] = { ok: /, exit 0$/.test(receipt) || receipt.startsWith("not executed in this run, cache hit"), receipt };
  }
  return DEMO_TASKS.every(task => result[task]) ? result : null;
}

export interface StagingOutput extends PrecheckOutput { tabs: TabStatus[] }

export async function measureStaging(deps: StagingDeps): Promise<StagingOutput> {
  const at = deps.now();
  const flagged: FlaggedSlice[] = [];
  // Targets in apps-reach-staging.duty.json and their sources. apps_picked at least 6 is the headline: the 6 Prospect apps (board goal p14
  // targets 6) and the owner's "get an accepted version of each app in the prospects view". open_review_max_h at most 48: the review limit the
  // duty has held since 10-12; incident, the board went from t5 (2026-10-09T12:38Z) to t11 (2026-10-12T05:55Z), 65 h with nothing to pick, and
  // on 2026-10-12T13:34Z the owner asked "what should i review?". demo_ci_ok at least 1 is a yes or no check. source_errors is run detail.
  const metrics: Record<string, number> = { apps_picked: 0, open_review_max_h: 0, demo_ci_ok: 0, source_errors: 0 };
  const sourceError = (excerpt: string) => { metrics.source_errors! += 1; flagged.push({ at, kind: "source", excerpt }); };
  const message = (error: unknown) => error instanceof Error ? error.message : String(error);
  const readJson = async <T>(path: string, what: string): Promise<T> => {
    try { return JSON.parse(await deps.read(path)) as T; } catch (error) { throw new Error(`${what} ${path}: ${message(error)}`); }
  };
  const line = await readJson<StagingLine>(join(deps.repo, LINE_FILE), "Staging line");
  const board = await readJson<Board>(deps.board, "board");

  const apps = picks(line);
  metrics.apps_picked = apps.filter(app => app.picked).length;
  const since = Math.min(...(line.log ?? []).map(entry => Date.parse(entry.at ?? "")).filter(Number.isFinite), at);
  for (const app of apps) {
    if (app.picked) { flagged.push({ at, kind: "picked", item: app.key, excerpt: `${app.word}: Staging points at ${app.variant}${app.at ? ` since ${app.at}` : ""}` }); continue; }
    const wait = reviewWait(board.todos ?? [], app.word, at, since);
    const todo = wait.open ? `open review todo ${wait.open.id} from ${wait.open.at}` : wait.last ? `last review todo ${wait.last.id} at ${wait.last.at}, done, ${wait.hours} h ago` : `no review todo yet, ${wait.hours} h since the line started`;
    const steps = openSteps(board.plan ?? [], app.word);
    flagged.push({ at, kind: "no_pick", item: app.key, excerpt: `${app.word}: Staging points at shipped; ${todo}; open steps: ${steps.join(", ") || "none"}` });
  }

  const reviews = openReviews(board.todos ?? [], at);
  metrics.open_review_max_h = reviews[0]?.hours ?? 0;
  for (const { todo, hours } of reviews) {
    flagged.push({ at, kind: "open_review", ...(todo.step ? { item: todo.step } : {}),
      excerpt: `${todo.id} open ${hours} h (since ${todo.at}${todo.step ? `, step ${todo.step}` : ""}): ${(todo.text ?? "").slice(0, 160)}` });
  }

  const tabs = apps.map(app => tabStatus(board.plan ?? [], app));
  for (const tab of tabs) {
    flagged.push({ at, kind: "tab_status", item: tab.key, excerpt: `${tab.word} ${tab.pct}%: ${tab.picked ? "owner pick on Staging" : "no pick on Staging"}, ` +
      `${tab.done.length} of ${tab.done.length + tab.open.length} board steps done${tab.open.length ? `; open: ${tab.open.join(", ")}` : ""}` });
  }

  try {
    const runs = JSON.parse(await deps.exec("gh", ["run", "list", "--workflow", "verify-dev.yml", "--branch", CI_BRANCH,
      "--json", "databaseId,status,conclusion,createdAt"], deps.repo)) as GhRun[];
    let found = false;
    for (const run of runs.filter(candidate => candidate.status === "completed")) {
      const { jobs } = JSON.parse(await deps.exec("gh", ["run", "view", String(run.databaseId), "--json", "jobs"], deps.repo)) as { jobs?: GhJob[] };
      const job = lintJob(jobs ?? []);
      if (job === null) continue;
      const tasks = demoSteps(await deps.exec("gh", ["api", `repos/{owner}/{repo}/actions/jobs/${job}/logs`], deps.repo));
      if (!tasks) continue;
      found = true;
      metrics.demo_ci_ok = Object.values(tasks).every(task => task.ok) ? 1 : 0;
      flagged.push({ at, kind: metrics.demo_ci_ok ? "demo_ci" : "demo_ci_failed",
        excerpt: `verify-dev run ${run.databaseId} on ${CI_BRANCH} (${run.createdAt}), job ${job}: ${Object.entries(tasks).map(([task, { receipt }]) => `${task} ${receipt}`).join("; ")}` });
      break;
    }
    if (!found) sourceError(`none of the last ${runs.length} verify-dev runs on ${CI_BRANCH} ran both virev-demo turbo tasks in ${LINT_JOB}`);
  } catch (error) { sourceError(`gh run list or view for verify-dev.yml on ${CI_BRANCH}: ${message(error)}`); }
  return { metrics, flagged, tabs };
}

const exec: Exec = (file, args, cwd) => new Promise((resolve, reject) => {
  // No timeout of its own: the runner's precheck timeout ends a hung run. No buffer limit either: the lint job logs measured 2026-10-15 run
  // 2.0 to 2.1 MB, past Node's 1 MB default.
  execFile(file, [...args], { cwd, encoding: "utf8", maxBuffer: Infinity }, (error, stdout) => error ? reject(error) : resolve(stdout));
});

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("apps-reach-staging: OUTPUT_FILE is not set\n"); process.exit(2); }
  const result = await measureStaging({ exec, now: Date.now, read: path => readFile(path, "utf8"), repo: REPO, board: BOARD });
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
