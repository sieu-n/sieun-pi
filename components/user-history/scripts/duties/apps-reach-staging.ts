import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The Apps reach staging duty's precheck (`node --import tsx scripts/duties/apps-reach-staging.ts`) for the frontend chat: how many of the
 * 6 Prospect apps have an owner pick in the 5180 demo's Staging line (apps/virev-demo/lines/staging.json in auto-sns-agent), how long an
 * app with no pick has gone without a new review todo on the chat's board, and whether the last verify-dev run on sieun/dev that ran the
 * virev-demo turbo tasks passed them (gh, the receipt lines of the monorepo lint job's log). No model call, no browser. A source it cannot read adds 1 to source_errors and a flagged slice.
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

export async function measureStaging(deps: StagingDeps): Promise<PrecheckOutput> {
  const at = deps.now();
  const flagged: FlaggedSlice[] = [];
  // Targets in apps-reach-staging.duty.json and their sources. apps_picked at least 6: the 6 Prospect apps (board goal p14 targets 6) and the
  // owner's "get an accepted version of each app in the prospects view". review_wait_max_h at most 48: the proposal's limit; incident, the
  // board's review todos for the apps went from t5 (2026-10-09T12:38Z) to t11 (2026-10-12T05:55Z), 65 h with nothing new to pick, and on
  // 2026-10-12T13:34Z the owner asked "what should i review?". demo_ci_ok at least 1 and source_errors 0 are yes or no checks.
  const metrics: Record<string, number> = { apps_picked: 0, review_wait_max_h: 0, demo_ci_ok: 0, source_errors: 0 };
  const sourceError = (excerpt: string) => { metrics.source_errors = (metrics.source_errors ?? 0) + 1; flagged.push({ at, kind: "source", excerpt }); };
  const message = (error: unknown) => error instanceof Error ? error.message : String(error);

  let line: StagingLine | undefined;
  try { line = JSON.parse(await deps.read(join(deps.repo, LINE_FILE))) as StagingLine; } catch (error) { sourceError(`${LINE_FILE}: ${message(error)}`); }
  let board: Board | undefined;
  try { board = JSON.parse(await deps.read(deps.board)) as Board; } catch (error) { sourceError(`board ${deps.board}: ${message(error)}`); }

  if (line) {
    const apps = picks(line);
    metrics.apps_picked = apps.filter(app => app.picked).length;
    const since = Math.min(...(line.log ?? []).map(entry => Date.parse(entry.at ?? "")).filter(Number.isFinite), at);
    for (const app of apps) {
      if (app.picked) { flagged.push({ at, kind: "picked", item: app.key, excerpt: `${app.word}: Staging points at ${app.variant}${app.at ? ` since ${app.at}` : ""}` }); continue; }
      if (!board) continue;
      const wait = reviewWait(board.todos ?? [], app.word, at, since);
      metrics.review_wait_max_h = Math.max(metrics.review_wait_max_h ?? 0, wait.hours);
      const todo = wait.open ? `open review todo ${wait.open.id} from ${wait.open.at}` : wait.last ? `last review todo ${wait.last.id} at ${wait.last.at}, done, ${wait.hours} h ago` : `no review todo yet, ${wait.hours} h since the line started`;
      const steps = openSteps(board.plan ?? [], app.word);
      flagged.push({ at, kind: "no_pick", item: app.key, excerpt: `${app.word}: Staging points at shipped; ${todo}; open steps: ${steps.join(", ") || "none"}` });
    }
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
  return { metrics, flagged };
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
