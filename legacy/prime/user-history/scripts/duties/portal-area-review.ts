import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { BASE } from "./apps-chat.ts";

/**
 * The api-portal agent's "Area review" precheck (`node --import tsx scripts/duties/portal-area-review.ts`), its common daily duty of c249. No
 * model call, reads only. The owner, #sw-factory-build p234: "every day checks their area of responsiblity and proactively (as an actual person
 * would) watch and maintain dashboards, identify issues, act on issues, clean up ... and self-improve". The review itself is the duty job's work,
 * so every run hands off one `area_review` item, which starts the job each day. The precheck counts what the area holds that nobody acts on:
 *   red_duties_unowned: a missed metric or failed precheck of one of the agent's other duties with no live job and no open step linked to it
 *     (`dN/<key>`) that the board's own rule (GET /steps `stuck`) reads as moved.
 *   steps_unmoved_2d: open plan steps that GET /steps reads as stuck and whose board entry has not changed for 2 days: the step's `updatedAt`,
 *     which the board stamps since apps/chat 57b1b63fb, or for a step changed before that, the run that first saw its present signature
 *     (STATE_FILE keeps each one).
 *   wiki_pages_off: the agent's wiki pages (agents/api-portal/ and apps/api-portal/) whose last_verified, or updated when none, is over 7 days
 *     old, or that fail the wiki prose lint of this checkout (apps/wiki/src/lib/prose-lint.mjs).
 *   corrections_unsaved: the shared Area review precheck's count (apps/chat/scripts/duties/area-review.ts) of the owner's corrections from the
 *     agent's rooms that its memory names nowhere, with its owner_post items, when that script is in this checkout.
 * The headline issues_not_acted_on is their sum, target 0. A count the run could not read is left out, so the run reads not measured: every
 * count when a source fails, and corrections_unsaved with the headline when the shared review's box is away (its `host_away` item comes along).
 */

export const AGENT = process.env.AREA_REVIEW_AGENT || "ag_api-portal";
export const WIKI_GLOBS = ["agents/api-portal/**", "apps/api-portal/**"];
const DAY_MS = 86_400_000;
export const STEP_UNMOVED_MS = 2 * DAY_MS;
export const PAGE_STALE_MS = 7 * DAY_MS;
const LINT_URL = new URL("../../../../../apps/wiki/src/lib/prose-lint.mjs", import.meta.url).href;
const SHARED_REVIEW = fileURLToPath(new URL("../../../../../apps/chat/scripts/duties/area-review.ts", import.meta.url));
const OWN_NAME = "Area review";

export interface DutyRow {
  duty: { id: string; name: string };
  paused: boolean;
  last?: { verdict?: string; at?: number } | null;
  card?: { headlineMiss?: { key: string; text?: string } | null; misses?: { key: string; text?: string }[]; job?: { name?: string; live?: boolean } | null } | null;
}
export interface Step { id: string; text: string; status: string; note?: string; job?: string; duty?: string; waitFor?: string; waitUntil?: string; updatedAt?: string;
  target?: { current?: number; measuredAt?: string }; children?: Step[] }
export interface Page { path: string; last_verified?: string | null; updated?: string | null; status?: string | null }
export interface StepMark { sig: string; since: number }
export interface State { steps: Record<string, StepMark> }
export interface AreaInput { duties: DutyRow[]; plan: Step[]; stuck: string[]; pages: (Page & { lintErrors: string[] })[]; state: State; now: number;
  /** The shared Area review precheck's output, or null when this checkout has none. */
  shared: PrecheckOutput | null }

const isOpen = (step: Step): boolean => step.status !== "done" && step.status !== "dropped";
const openSteps = (plan: readonly Step[]): Step[] => plan.flatMap(step => [...isOpen(step) ? [step] : [], ...openSteps(step.children ?? [])]);
/** What a move of a step changes: its status, note, wait, job, target reading or a child's status. */
const signature = (step: Step): string => JSON.stringify([step.status, step.note ?? "", step.waitFor ?? "", step.waitUntil ?? "", step.job ?? "",
  step.target?.current ?? null, step.target?.measuredAt ?? null, (step.children ?? []).map(child => `${child.id}:${child.status}`)]);
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function review(input: AreaInput): { output: PrecheckOutput; state: State } {
  const { now } = input;
  const open = openSteps(input.plan);
  const stuck = new Set(input.stuck);
  const moving = open.filter(step => !stuck.has(step.id));

  const redDuties: FlaggedSlice[] = [];
  for (const row of input.duties) {
    if (row.paused || row.duty.name === OWN_NAME) continue;
    const verdict = row.last?.verdict;
    if (verdict !== "missed" && verdict !== "error") continue;
    if (row.card?.job?.live) continue;
    const misses = verdict === "error" ? [{ key: "error", text: "the precheck failed" }]
      : [...row.card?.headlineMiss ? [row.card.headlineMiss] : [], ...row.card?.misses ?? []];
    for (const miss of misses) {
      const link = `${row.duty.id}/${miss.key}`;
      if (moving.some(step => step.duty === link || step.duty === row.duty.id)) continue;
      redDuties.push({ kind: "red_duty_unowned", item: link, sig: miss.text ?? miss.key,
        excerpt: `${row.duty.id} ${row.duty.name}: ${miss.text ?? miss.key}. No live job and no moving step links ${link}.` });
    }
  }

  const steps: Record<string, StepMark> = {};
  const unmoved: FlaggedSlice[] = [];
  for (const step of open) {
    const sig = signature(step);
    const prior = input.state.steps[step.id];
    const mark = steps[step.id] = prior?.sig === sig ? prior : { sig, since: now };
    const stamped = Date.parse(step.updatedAt ?? "");
    const since = Number.isNaN(stamped) ? mark.since : stamped;
    if (!stuck.has(step.id) || now - since < STEP_UNMOVED_MS) continue;
    unmoved.push({ kind: "step_unmoved", item: step.id, sig: String(since),
      excerpt: `${step.id} (${step.status}${step.job ? `, job ${step.job}` : ""}) unchanged for ${Math.floor((now - since) / DAY_MS)} days and nobody moves it: ${step.text}` });
  }

  const pages: FlaggedSlice[] = [];
  for (const page of input.pages) {
    const verified = Date.parse(page.last_verified ?? page.updated ?? "");
    const reasons = [
      ...Number.isNaN(verified) ? ["no last_verified or updated date"] : now - verified > PAGE_STALE_MS ? [`last checked ${day(verified)}`] : [],
      ...page.lintErrors.length ? [`prose lint errors ${page.lintErrors.join(", ")}`] : [],
    ];
    if (reasons.length) pages.push({ kind: "wiki_page_off", item: page.path, sig: reasons.join("; "), excerpt: `${page.path}: ${reasons.join("; ")}.` });
  }

  const corrections = input.shared ? input.shared.metrics.corrections_unsaved : 0;
  const sharedItems = (input.shared?.flagged ?? []).filter(slice => ["correction_unsaved", "owner_post", "host_away"].includes(slice.kind));

  const flagged: FlaggedSlice[] = [
    { kind: "area_review", sig: day(now), handOff: true,
      excerpt: "The daily review of api.virev.ai as its owner: the Grafana board https://obs.virev.ai/d/virev-api-portal, the live portal and docs, " +
        "d1 to d6's latest results, open steps, code and wiki pages; act on each real issue and update the wiki, brief and memory." },
    ...redDuties, ...unmoved, ...pages, ...sharedItems,
    ...input.shared ? [] : [{ kind: "shared_review_missing", excerpt: `No shared Area review precheck at ${SHARED_REVIEW}, so corrections_unsaved reads 0.` }],
  ];
  const counts = { red_duties_unowned: redDuties.length, steps_unmoved_2d: unmoved.length, wiki_pages_off: pages.length };
  const metrics = typeof corrections === "number"
    ? { issues_not_acted_on: redDuties.length + unmoved.length + pages.length + corrections, ...counts, corrections_unsaved: corrections } : counts;
  /** What each count looked at: the other duties checked, the open steps, the wiki pages and the shared review's own n. */
  const checkedDuties = input.duties.filter(row => !row.paused && row.duty.name !== OWN_NAME).length;
  const sharedN = input.shared?.n;
  const correctionsN = typeof sharedN === "number" ? sharedN : sharedN?.corrections_unsaved ?? (input.shared ? 1 : 0);
  const n = { red_duties_unowned: checkedDuties, steps_unmoved_2d: open.length, wiki_pages_off: input.pages.length, corrections_unsaved: correctionsN,
    issues_not_acted_on: checkedDuties + open.length + input.pages.length + correctionsN };
  return {
    output: { metrics, n, flagged },
    state: { steps },
  };
}

type Lint = (html: string, opts: { path: string }) => { findings: { rule: string; severity: string }[] };

async function json<T>(send: typeof fetch, path: string): Promise<T> {
  const response = await send(`${BASE}${path}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`GET ${BASE}${path} answered ${response.status}`);
  return await response.json() as T;
}

/** This run's env without the runner's file names, so the shared script prints to stdout instead of writing this run's OUTPUT_FILE. */
function sharedEnv(): NodeJS.ProcessEnv {
  const { OUTPUT_FILE: _output, STATE_FILE: _state, LAST_RUNS_FILE: _runs, ...env } = process.env;
  return env;
}

/** The shared Area review precheck's output for AGENT, or null when this checkout lacks the script. */
async function sharedReview(): Promise<PrecheckOutput | null> {
  if (!existsSync(SHARED_REVIEW)) return null;
  const stdout = await new Promise<string>((resolve, reject) => execFile(process.execPath, [SHARED_REVIEW, "--agent", AGENT], { timeout: 60_000, maxBuffer: 8 << 20, env: sharedEnv() },
    (error, out, err) => error ? reject(new Error(`${SHARED_REVIEW} failed: ${err || error.message}`.slice(0, 500))) : resolve(out)));
  return JSON.parse(stdout) as PrecheckOutput;
}

export async function measure(state: State, now: number, send: typeof fetch = fetch, lint?: Lint, shared: () => Promise<PrecheckOutput | null> = sharedReview):
  Promise<{ output: PrecheckOutput; state: State }> {
  try {
    const lintHtml = lint ?? ((await import(LINT_URL)) as { lintHtml: Lint }).lintHtml;
    const agent = `/api/agents/${encodeURIComponent(AGENT)}`;
    const [{ duties }, { stuck }, { board }] = await Promise.all([
      json<{ duties: DutyRow[] }>(send, `${agent}/duties`),
      json<{ stuck: { id: string }[] }>(send, `${agent}/steps`),
      json<{ board: { plan: Step[] } }>(send, `${agent}/board`),
    ]);
    const found = (await Promise.all(WIKI_GLOBS.map(glob => json<{ results: Page[] }>(send, `/wiki/api/agent/find?glob=${encodeURIComponent(glob)}`))))
      .flatMap(result => result.results).filter(page => page.path.endsWith(".html") && page.status !== "superseded" && !page.path.includes("/archive/"));
    const pages = await Promise.all(found.map(async page => {
      const response = await send(`${BASE}/wiki/raw/${page.path}`, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`GET ${BASE}/wiki/raw/${page.path} answered ${response.status}`);
      const errors = lintHtml(await response.text(), { path: page.path }).findings.filter(finding => finding.severity === "error");
      const byRule = new Map<string, number>();
      for (const finding of errors) byRule.set(finding.rule, (byRule.get(finding.rule) ?? 0) + 1);
      return { ...page, lintErrors: [...byRule].map(([rule, count]) => `${rule} x${count}`) };
    }));
    return review({ duties, plan: board.plan, stuck: stuck.map(step => step.id), pages, state, now, shared: await shared() });
  } catch (error) {
    return { state, output: { metrics: {}, n: { issues_not_acted_on: 0, red_duties_unowned: 0, steps_unmoved_2d: 0, wiki_pages_off: 0, corrections_unsaved: 0 },
      flagged: [{ kind: "source_error", excerpt: error instanceof Error ? error.message : String(error) }] } };
  }
}

async function main(): Promise<void> {
  const stateFile = process.env.STATE_FILE;
  const prior: Partial<State> = stateFile ? await readFile(stateFile, "utf8").then(text => JSON.parse(text) as Partial<State>, () => ({})) : {};
  const { output, state } = await measure({ steps: prior.steps ?? {} }, Date.now());
  const text = JSON.stringify(output, null, 2) + "\n";
  if (process.env.OUTPUT_FILE) await writeFile(process.env.OUTPUT_FILE, text);
  else process.stdout.write(text);
  if (stateFile) await writeFile(stateFile, JSON.stringify(state) + "\n");
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) await main();
