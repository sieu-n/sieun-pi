import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DutyRunRecord, FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The Wiki dream duty's precheck (`node --import tsx scripts/duties/wiki-dream.ts`). It is a thin adapter with no model call:
 * - the wiki facts come from `node apps/llm-wiki/scripts/wiki-health.mjs --since <last run>` in auto-sns-agent, which owns the wiki rules;
 * - the mistake signal comes from the owner corrections ledger and the continual-harness memories and refinements made since the last run;
 * - the duty's own ledger says which duplicate pairs were judged and which mistake classes are open, fixed or back;
 * - `git log` in both repos says which `(wiki-dream)` commits were reverted and which files the dream edited twice in 7 days;
 * - wiki-health's stale list plus `git log` in auto-sns-agent say which pages are behind their code (pagesBehindCode).
 * wiki-health judges the pages as committed at HEAD, so an uncommitted page edit in the shared checkout neither hides nor adds a problem.
 * The headline `wiki_problems` adds up the sync problems the owner asked to keep at 0; the run detail file keeps every other number.
 * An input it cannot read counts in `source_errors` and writes 999999 for the metrics that input feeds, so the run misses and says why.
 */

const DAY = 24 * 60 * 60_000;
export const UNMEASURED = 999_999;
/** Both glide plans start on this day (KST); the job closes 5 lint pages and moves 10 repo-fact memories into skills per day. */
export const GLIDE_START = Date.parse("2026-10-11T00:00:00+09:00");
export const LINT_GLIDE = { base: 250, perDay: 5 };
export const MEMORY_GLIDE = { base: 306, perDay: 10 };
/** A duplicate pair judged within this long is settled. */
export const PAIR_SETTLED_MS = 30 * DAY;
export const CHURN_MS = 7 * DAY;
export const FLAGGED_MAX = 80;
const HEALTH_TIMEOUT_MS = 100_000;
const GIT_TIMEOUT_MS = 20_000;

/** Runs a program with no shell in `cwd` and gives its stdout; throws on a nonzero exit or a timeout. */
export type Exec = (file: string, args: readonly string[], options: { cwd: string; timeoutMs: number }) => Promise<string>;
export interface DreamDeps {
  now: number;
  exec: Exec;
  readText: (path: string) => Promise<string>;
  /** The node binary that runs wiki-health.mjs. */
  node: string;
  repos: { wiki: string; pi: string };
  files: { corrections: string; harness: string; ledger: string };
}

/** What `wiki-health.mjs` prints (build contract part A). */
export interface HealthItem { kind: string; path: string; excerpt?: string; target?: string }
export interface Health {
  at?: string; curatedPages?: number;
  /** Numeric facts only; a fact wiki-health could not measure is null there and missing here. */
  facts: Record<string, number>; items: HealthItem[];
  /** The inputs wiki-health could not read (for example views, prose-lint). */
  errors: string[];
  dupPairs: { a: string; b: string; score: number }[];
  signals: { path: string; phrase: string; excerpt?: string }[];
  /** The engine's stale report over the committed pages, read by parseStale. */
  stale: unknown;
}
export interface LedgerClass {
  title?: string; skill?: string; gap?: string; status?: string; firstSeen?: string; fixCommit?: string; fixedAt?: string;
  watchUntil?: string; recurred?: string[]; sources?: string[];
}
export interface Ledger {
  version?: number;
  pairs?: Record<string, { verdict?: string; at?: string; job?: string }>;
  classes?: Record<string, LedgerClass>;
  memoryMoves?: Record<string, { skill?: string; commit?: string; deletedAt?: string }>;
}
interface Correction { id: string; at: string; chat?: { id?: string; name?: string }; words?: string; rule?: string; status?: string; repeats?: { at: string; chat?: { id?: string }; words?: string }[] }
interface HarnessEntry { id?: string; title?: string; path?: string; scope?: string; content?: string; created_at?: string; updated_at?: string }
interface Refinement { id?: string; trigger?: string; changes?: string[]; outcome?: string; created_at?: string }
export interface DreamCommit { repo: string; sha: string; subject: string; files: string[] }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const clip = (text: string, max = 240): string => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat; };
const message = (error: unknown): string => clip(error instanceof Error ? error.message : String(error), 200);
const ms = (iso: string | undefined): number => (iso ? Date.parse(iso) : NaN);

/** The time the last measured run started (a met or missed run); with none, 24 h ago. Never more than 7 days back. */
export function sinceFrom(lastRuns: readonly DutyRunRecord[], now: number): number {
  const last = lastRuns.filter(run => run.verdict === "met" || run.verdict === "missed").reduce((max, run) => Math.max(max, run.at), 0);
  return Math.max(last || now - DAY, now - 7 * DAY);
}

/** Where a glide plan stands on `now`: the base minus the daily slope for each whole day since GLIDE_START, never below 0. */
export function glide(plan: { base: number; perDay: number }, now: number): number {
  const days = Math.max(0, Math.floor((now - GLIDE_START) / DAY));
  return Math.max(0, plan.base - plan.perDay * days);
}

/** Parses wiki-health.mjs output; throws when it has no facts object. */
export function parseHealth(text: string): Health {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || !isRecord(value.facts)) throw new Error("wiki-health printed no facts object");
  const facts: Record<string, number> = {};
  for (const [key, count] of Object.entries(value.facts)) if (typeof count === "number" && Number.isFinite(count)) facts[key] = count;
  const list = <T>(field: unknown, keep: (row: Record<string, unknown>) => boolean): T[] => Array.isArray(field) ? field.filter(isRecord).filter(keep) as T[] : [];
  return {
    ...(typeof value.at === "string" ? { at: value.at } : {}),
    ...(typeof value.curatedPages === "number" ? { curatedPages: value.curatedPages } : {}),
    facts,
    errors: Array.isArray(value.errors) ? value.errors.filter((row): row is string => typeof row === "string") : [],
    items: list<HealthItem>(value.items, row => typeof row.kind === "string" && typeof row.path === "string"),
    dupPairs: list<Health["dupPairs"][number]>(value.dupPairs, row => typeof row.a === "string" && typeof row.b === "string" && typeof row.score === "number"),
    signals: list<Health["signals"][number]>(value.signals, row => typeof row.path === "string" && typeof row.phrase === "string"),
    stale: value.stale,
  };
}

export const pairKey = (a: string, b: string): string => [a, b].sort().join("|");

/** Duplicate pairs with no ledger verdict newer than 30 days. */
export function unjudgedPairs(pairs: Health["dupPairs"], ledger: Ledger, now: number): Health["dupPairs"] {
  return pairs.filter(pair => { const verdict = ledger.pairs?.[pairKey(pair.a, pair.b)]; return !(verdict?.verdict && now - ms(verdict.at) <= PAIR_SETTLED_MS); });
}

/**
 * Ledger classes still open (open or reopened); the open ones the last run already had (first seen before `since`, or with no date), which
 * open_mistakes counts; and classes with a recurrence in the last 7 days. A class the last run found gets one daily run to land its fix,
 * because a rule takes a CI probe: the 10-13 rules took 22 h from draft (10-13 17:47Z) to land (68d53dd86d, 10-14 16:07Z).
 */
export function classStates(ledger: Ledger, now: number, since = now): { open: [string, LedgerClass][]; due: [string, LedgerClass][]; back: [string, LedgerClass][] } {
  const classes = Object.entries(ledger.classes ?? {});
  const open = classes.filter(([, row]) => row.status === "open" || row.status === "reopened");
  return {
    open,
    due: open.filter(([, row]) => !(ms(row.firstSeen) >= since)),
    back: classes.filter(([, row]) => (row.recurred ?? []).some(at => now - ms(at) <= CHURN_MS && ms(at) <= now)),
  };
}

/** Parses `git log --format=%x1e%H%x1f%s --name-only` into commits with their files. */
export function parseGitLog(repo: string, text: string): DreamCommit[] {
  return text.split("\x1e").map(block => block.trim()).filter(Boolean).map(block => {
    const [head = "", ...files] = block.split("\n");
    const [sha = "", subject = ""] = head.split("\x1f");
    return { repo, sha, subject, files: files.map(file => file.trim()).filter(Boolean) };
  }).filter(commit => commit.sha);
}

const isDream = (subject: string): boolean => subject.includes("(wiki-dream)");
export const isRevert = (subject: string): boolean => subject.startsWith('Revert "') && isDream(subject);

/** Reverted dream commits, and files (repo:path) that 2 or more dream commits changed. Reverts do not count as edits. */
export function churn(commits: readonly DreamCommit[]): { reverts: DreamCommit[]; retouched: { file: string; commits: number }[] } {
  const reverts = commits.filter(commit => isRevert(commit.subject));
  const edits = new Map<string, number>();
  for (const commit of commits) {
    if (!isDream(commit.subject) || isRevert(commit.subject)) continue;
    for (const file of new Set(commit.files)) edits.set(`${commit.repo}:${file}`, (edits.get(`${commit.repo}:${file}`) ?? 0) + 1);
  }
  const retouched = [...edits].filter(([, count]) => count >= 2).map(([file, count]) => ({ file, commits: count })).sort((a, b) => b.commits - a.commits);
  return { reverts, retouched };
}

/** One page of wiki-health's `stale` report: the engine lists a page when a `source_refs` file's mtime is after its `last_verified` day. */
export interface StalePage { path: string; last_verified: string; staleRefs: { ref: string; modified: string }[] }
export function parseStale(value: unknown): StalePage[] {
  if (!isRecord(value) || !Array.isArray(value.stale)) throw new Error("wiki-health gave no stale list");
  return value.stale.filter(isRecord).filter(row => typeof row.path === "string" && typeof row.last_verified === "string" && Array.isArray(row.staleRefs))
    .map(row => ({ path: row.path as string, last_verified: row.last_verified as string,
      staleRefs: (row.staleRefs as unknown[]).filter(isRecord).filter(ref => typeof ref.ref === "string").map(ref => ({ ref: ref.ref as string, modified: String(ref.modified ?? "") })) }));
}

/** Parses `git log --format=%x1e%ct --name-only` (newest first) into the newest commit time in ms per file. */
export function lastChanged(text: string): Map<string, number> {
  const changed = new Map<string, number>();
  for (const block of text.split("\x1e").map(part => part.trim()).filter(Boolean)) {
    const [head = "", ...files] = block.split("\n");
    const at = Number(head.trim()) * 1000;
    if (!Number.isFinite(at)) continue;
    for (const file of files.map(line => line.trim()).filter(Boolean)) if (!changed.has(file)) changed.set(file, at);
  }
  return changed;
}

/** The engine's rule: a page is checked through the end of its `last_verified` day, UTC. */
export const verifiedUntil = (lastVerified: string): number => Date.parse(`${lastVerified}T23:59:59Z`);

/**
 * Pages behind their code: a `source_refs` path (a file, or any file under a folder) changed in a commit after the page's
 * `last_verified` day and before `since`, the start of the last measured run, so the last dream run had the change in front of it.
 * The engine compares file mtimes, and a checkout or stash in the shared tree rewrites them with no content change: on 2026-10-15 30 of
 * the 75 refs it listed had no commit after the page's check, and apps/admin/index.html, checked on 10-14, was listed for 3 such refs.
 * A ref git has no commit for (an untracked file) keeps the engine's verdict.
 */
export function pagesBehindCode(pages: readonly StalePage[], changed: ReadonlyMap<string, number>, since: number): { path: string; lastVerified: string; refs: { ref: string; at: number }[] }[] {
  const commitAt = (ref: string): number | undefined => {
    const folder = `${ref.replace(/\/+$/, "")}/`;
    let newest: number | undefined;
    for (const [file, at] of changed) if ((file === ref || file.startsWith(folder)) && (newest === undefined || at > newest)) newest = at;
    return newest;
  };
  return pages.map(page => {
    const until = verifiedUntil(page.last_verified);
    const refs = page.staleRefs.flatMap(({ ref, modified }) => {
      const at = commitAt(ref);
      if (at === undefined) { const engineAt = Date.parse(modified); return Number.isFinite(engineAt) && engineAt >= since ? [] : [{ ref, at: Number.isFinite(engineAt) ? engineAt : 0 }]; }
      return at > until && at < since ? [{ ref, at }] : [];
    });
    return { path: page.path, lastVerified: page.last_verified, refs };
  }).filter(page => page.refs.length);
}

/** A global memory about the auto-sns-agent repo: its path or title starts with "auto-sns-agent". */
export const isRepoFact = (entry: HarnessEntry): boolean => /^auto-sns-agent/i.test(entry.path ?? "") || /^auto-sns-agent/i.test(entry.title ?? "");
const skillPath = (text: string): string | undefined => /(?:\.agents\/skills|\.claude\/skills-native|skills)\/[\w./-]+?(?:SKILL\.md|\.md)/.exec(text)?.[0];

/** The harness signal: repo-fact global memory count, memories and refinements made since `since`, and memories to move into skills. */
export function harnessSignal(state: unknown, ledger: Ledger, since: number): {
  repoFacts: number; fresh: HarnessEntry[]; refinements: Refinement[]; moves: HarnessEntry[];
} {
  if (!isRecord(state) || !isRecord(state.entries)) throw new Error("harness_state.json has no entries object");
  const memories = Object.values(isRecord(state.entries.memory) ? state.entries.memory : {}).filter(isRecord) as HarnessEntry[];
  const facts = memories.filter(entry => entry.scope === "global" && isRepoFact(entry));
  const moved = new Set(Object.keys(ledger.memoryMoves ?? {}));
  return {
    repoFacts: facts.length,
    fresh: memories.filter(entry => ms(entry.created_at) >= since).sort((a, b) => Number(isRepoFact(b)) - Number(isRepoFact(a)) || ms(b.created_at) - ms(a.created_at)),
    refinements: (Array.isArray(state.refinements) ? state.refinements.filter(isRecord) as Refinement[] : []).filter(row => ms(row.created_at) >= since),
    moves: facts.filter(entry => !moved.has(entry.id ?? "")).sort((a, b) => ms(a.updated_at) - ms(b.updated_at)),
  };
}

/** Owner corrections and repeats made since `since`, newest first. */
export function freshCorrections(file: unknown, since: number): FlaggedSlice[] {
  if (!isRecord(file) || !Array.isArray(file.corrections)) throw new Error("corrections.json has no corrections list");
  const slices: FlaggedSlice[] = [];
  for (const row of file.corrections.filter(isRecord) as unknown as Correction[]) {
    if (ms(row.at) >= since) {
      slices.push({ kind: "correction", item: row.id, at: ms(row.at), ...(row.chat?.id ? { chat: row.chat.id } : {}),
        excerpt: clip(`new ${row.id}: ${row.rule ?? ""} Owner: "${row.words ?? ""}"`) });
    }
    for (const repeat of row.repeats ?? []) {
      if (ms(repeat.at) < since) continue;
      slices.push({ kind: "correction", item: row.id, at: ms(repeat.at), ...(repeat.chat?.id ? { chat: repeat.chat.id } : {}),
        excerpt: clip(`repeat of ${row.id} (${1 + (row.repeats?.length ?? 0)} times in all): ${row.rule ?? ""} Owner: "${repeat.words ?? ""}"`) });
    }
  }
  return slices.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

/** The order the job reads flagged items in, with a cap per kind; the list stops at FLAGGED_MAX. */
export const FLAG_ORDER: readonly [string, number][] = [
  ["source_error", 6], ["recurred", 8], ["open_class", 10], ["hub_orphan", 8], ["dead_link", 8], ["superseded_linked", 8], ["session_link", 8],
  ["missing_meta", 6], ["stale_vs_code", 10], ["dup_pair", 5], ["revert", 5], ["retouched", 5], ["correction", 10], ["signal", 6], ["refinement", 6],
  ["memory", 10], ["lint_page", 5], ["archive_candidate", 3],
];

/** Picks the flagged items: each kind in FLAG_ORDER up to its cap, unknown kinds last, FLAGGED_MAX in all. */
export function pickFlagged(slices: readonly FlaggedSlice[]): FlaggedSlice[] {
  const order = new Map(FLAG_ORDER.map(([kind], index) => [kind, index]));
  const caps = new Map(FLAG_ORDER);
  const taken = new Map<string, number>();
  const ranked = slices.map((slice, index) => ({ slice, index })).sort((a, b) =>
    (order.get(a.slice.kind) ?? order.size) - (order.get(b.slice.kind) ?? order.size) || a.index - b.index);
  const out: FlaggedSlice[] = [];
  for (const { slice } of ranked) {
    const count = taken.get(slice.kind) ?? 0;
    if (count >= (caps.get(slice.kind) ?? 3)) continue;
    taken.set(slice.kind, count + 1);
    out.push(slice);
    if (out.length >= FLAGGED_MAX) break;
  }
  return out;
}

const HEALTH_METRICS = ["hub_orphans", "dead_links", "session_links", "superseded_linked", "missing_meta", "stale_vs_code"] as const;
/** The sync problems wiki_problems adds up; pages_behind_code replaces the engine's mtime-based stale_vs_code. */
const PROBLEM_METRICS = ["hub_orphans", "dead_links", "session_links", "superseded_linked", "missing_meta", "pages_behind_code"] as const;

/** Measures everything and builds the precheck output. Each input that fails adds a source_error item and 999999 for the metrics it feeds. */
export async function measureDream(deps: DreamDeps, lastRuns: readonly DutyRunRecord[]): Promise<PrecheckOutput & { info: Record<string, number> }> {
  const { now } = deps;
  const since = sinceFrom(lastRuns, now);
  const errors: FlaggedSlice[] = [];
  const fail = (source: string, error: unknown): undefined => { errors.push({ kind: "source_error", item: source, excerpt: clip(`${source}: ${message(error)}`) }); return undefined; };
  const readJson = async (path: string): Promise<unknown> => JSON.parse(await deps.readText(path)) as unknown;

  const health = await deps.exec(deps.node, ["apps/llm-wiki/scripts/wiki-health.mjs", "--since", new Date(since).toISOString()], { cwd: deps.repos.wiki, timeoutMs: HEALTH_TIMEOUT_MS })
    .then(parseHealth, error => fail("wiki-health.mjs", error));
  const ledger = await readJson(deps.files.ledger).then(value => { if (!isRecord(value)) throw new Error("not an object"); return value as Ledger; }, error => fail("ledger", error));
  const corrections = await readJson(deps.files.corrections).then(value => freshCorrections(value, since), error => fail("corrections.json", error));
  const harness = await readJson(deps.files.harness).then(value => harnessSignal(value, ledger ?? {}, since), error => fail("harness_state.json", error));
  const gitSince = new Date(now - CHURN_MS).toISOString();
  const commits: DreamCommit[] = [];
  let gitOk = true;
  for (const [name, repo] of [["auto-sns-agent", deps.repos.wiki], ["sieun-pi", deps.repos.pi]] as const) {
    await deps.exec("git", ["-C", repo, "log", "HEAD", `--since=${gitSince}`, "--fixed-strings", "--grep=(wiki-dream)", "--format=%x1e%H%x1f%s", "--name-only", "--no-renames"],
      { cwd: repo, timeoutMs: GIT_TIMEOUT_MS }).then(text => { commits.push(...parseGitLog(name, text)); }, error => { gitOk = false; fail(`git log ${name}`, error); });
  }

  const stalePages = health && (() => { try { return parseStale(health.stale); } catch (error) { return fail("wiki-health.mjs stale", error); } })();
  let behind: ReturnType<typeof pagesBehindCode> | undefined;
  if (stalePages) {
    const refs = [...new Set(stalePages.flatMap(page => page.staleRefs.map(ref => ref.ref)))];
    const oldest = Math.min(...stalePages.map(page => verifiedUntil(page.last_verified)).filter(Number.isFinite));
    behind = !refs.length ? [] : await deps.exec("git", ["-C", deps.repos.wiki, "log", "HEAD", "--format=%x1e%ct", "--name-only", "--no-renames",
      ...(Number.isFinite(oldest) ? [`--since=${new Date(oldest).toISOString()}`] : []), "--", ...refs], { cwd: deps.repos.wiki, timeoutMs: GIT_TIMEOUT_MS })
      .then(text => pagesBehindCode(stalePages, lastChanged(text), since), error => fail("git log source_refs", error));
  }

  const metrics: Record<string, number> = {};
  for (const key of HEALTH_METRICS) metrics[key] = health?.facts[key] ?? UNMEASURED;
  metrics.pages_behind_code = behind?.length ?? UNMEASURED;
  metrics.wiki_problems = PROBLEM_METRICS.some(key => metrics[key] === UNMEASURED) ? UNMEASURED : PROBLEM_METRICS.reduce((sum, key) => sum + metrics[key]!, 0);
  const lintFailing = health?.facts.lint_failing_pages;
  metrics.lint_over_glide = lintFailing === undefined ? UNMEASURED : lintFailing - glide(LINT_GLIDE, now);
  const unjudged = health && ledger ? unjudgedPairs(health.dupPairs, ledger, now) : undefined;
  metrics.dup_unjudged = unjudged?.length ?? UNMEASURED;
  metrics.memory_rules_over_glide = harness ? harness.repoFacts - glide(MEMORY_GLIDE, now) : UNMEASURED;
  const classes = ledger ? classStates(ledger, now, since) : undefined;
  metrics.open_mistakes = classes?.due.length ?? UNMEASURED;
  metrics.mistakes_back = classes?.back.length ?? UNMEASURED;
  const dream = churn(commits);
  metrics.dream_reverts = gitOk ? dream.reverts.length : UNMEASURED;
  metrics.pages_retouched = gitOk ? dream.retouched.length : UNMEASURED;
  for (const input of health?.errors ?? []) fail("wiki-health.mjs", new Error(`could not read ${input}`));
  if (health && !health.errors.length) {
    for (const key of [...HEALTH_METRICS, "lint_failing_pages"]) if (health.facts[key] === undefined) fail("wiki-health.mjs", new Error(`no fact ${key}`));
  }
  metrics.source_errors = errors.length;

  const info: Record<string, number> = {
    since, curated_pages: health?.curatedPages ?? UNMEASURED, lint_failing_pages: lintFailing ?? UNMEASURED, lint_glide_plan: glide(LINT_GLIDE, now),
    repo_fact_memories: harness?.repoFacts ?? UNMEASURED, memory_glide_plan: glide(MEMORY_GLIDE, now), new_corrections: corrections?.length ?? UNMEASURED,
    new_memories: harness?.fresh.length ?? UNMEASURED, new_refinements: harness?.refinements.length ?? UNMEASURED, signals: health?.signals.length ?? UNMEASURED,
    open_session_logs: health?.facts.open_session_logs ?? UNMEASURED, open_classes: classes?.open.length ?? UNMEASURED, dream_commits_7d: commits.filter(commit => !isRevert(commit.subject)).length,
  };

  const slices: FlaggedSlice[] = [...errors];
  for (const [slug, row] of classes?.back ?? []) {
    slices.push({ kind: "recurred", item: slug, excerpt: clip(`${row.title ?? slug} came back on ${(row.recurred ?? []).slice(-1)[0]} after fix ${row.fixCommit ?? "?"}; skill ${row.skill ?? "?"}`) });
  }
  for (const commit of dream.reverts) slices.push({ kind: "revert", item: `${commit.repo}:${commit.sha.slice(0, 10)}`, excerpt: clip(commit.subject) });
  for (const row of dream.retouched) slices.push({ kind: "retouched", item: row.file, excerpt: `${row.file} changed by ${row.commits} (wiki-dream) commits in 7 days` });
  for (const [slug, row] of classes?.open ?? []) {
    slices.push({ kind: "open_class", item: slug, excerpt: clip(`${row.status}: ${row.title ?? slug}; skill ${row.skill ?? "?"}; gap ${row.gap ?? "?"}; sources ${(row.sources ?? []).join("; ")}`) });
  }
  slices.push(...corrections ?? []);
  for (const signal of health?.signals ?? []) slices.push({ kind: "signal", item: signal.path, excerpt: clip(`"${signal.phrase}": ${signal.excerpt ?? ""}`) });
  for (const row of harness?.refinements ?? []) {
    slices.push({ kind: "refinement", item: row.id ?? "?", at: ms(row.created_at), excerpt: clip(`${row.trigger ?? ""}: ${(row.changes ?? []).join("; ")}`) });
  }
  const memorySlice = (entry: HarnessEntry, why: string): FlaggedSlice => {
    const skill = skillPath(entry.content ?? "");
    return { kind: "memory", item: entry.id ?? "?", at: ms(entry.created_at), excerpt: clip(`${why}${isRepoFact(entry) ? ", repo fact" : ""}: ${entry.title ?? ""} [${entry.path ?? ""}]${skill ? ` names ${skill}` : ""}`) };
  };
  const freshIds = new Set((harness?.fresh ?? []).map(entry => entry.id));
  for (const entry of harness?.fresh ?? []) slices.push(memorySlice(entry, "new since last run"));
  for (const entry of (harness?.moves ?? []).filter(entry => !freshIds.has(entry.id)).slice(0, 10)) slices.push(memorySlice(entry, "move into its skill"));
  for (const page of behind ?? []) {
    slices.push({ kind: "stale_vs_code", item: page.path, excerpt: clip(`last_verified ${page.lastVerified}; code changed since: ${page.refs.map(ref => `${ref.ref}${ref.at ? ` (${new Date(ref.at).toISOString().slice(0, 10)})` : " (missing)"}`).join(", ")}`) });
  }
  for (const item of health?.items ?? []) {
    if (item.kind === "signal" || (item.kind === "stale_vs_code" && behind)) continue;
    slices.push({ kind: item.kind, item: item.path, excerpt: clip(`${item.excerpt ?? item.path}${item.target ? ` -> ${item.target}` : ""}`) });
  }
  for (const pair of unjudged ?? []) slices.push({ kind: "dup_pair", item: pairKey(pair.a, pair.b), excerpt: `${pair.a} and ${pair.b} look alike (score ${pair.score})` });

  return { metrics: { ...metrics }, flagged: pickFlagged(slices), info };
}

/** The metrics the duty judges (wiki-dream.duty.json). A run that cannot measure one of them fails, so the runner records an error, not 999999. */
export const JUDGED_METRICS = ["wiki_problems", "open_mistakes", "mistakes_back", "dup_unjudged"] as const;

/** Why this measure cannot be judged: the judged metrics left unmeasured and the inputs that failed; null when all are measured. */
export function unmeasuredReason(result: PrecheckOutput): string | null {
  const missing = JUDGED_METRICS.filter(key => result.metrics[key] === UNMEASURED);
  if (!missing.length) return null;
  const inputs = (result.flagged ?? []).filter(slice => slice.kind === "source_error").map(slice => slice.excerpt);
  return clip(`could not measure ${missing.join(", ")}: ${inputs.join("; ") || "no input named"}`, 290);
}

const execNoShell: Exec = (file, args, options) => new Promise((done, failed) => {
  execFile(file, args, { cwd: options.cwd, timeout: options.timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 << 20 }, (error, stdout, stderr) => {
    if (!error) { done(String(stdout)); return; }
    const tail = String(stderr).trim().split("\n").slice(-2).join(" ");
    failed(new Error(error.killed ? `timed out after ${Math.round(options.timeoutMs / 1000)} s` : `exit ${error.code ?? error.signal}${tail ? `: ${tail}` : ""}`));
  });
});

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("wiki-dream: OUTPUT_FILE is not set\n"); process.exit(2); }
  const home = homedir();
  const lastRuns = await readFile(process.env.LAST_RUNS_FILE ?? "", "utf8").then(text => JSON.parse(text) as unknown, () => []);
  const deps: DreamDeps = {
    now: Date.now(), exec: execNoShell, readText: path => readFile(path, "utf8"), node: process.execPath,
    repos: { wiki: process.env.LLM_WIKI_REPO || join(home, "Documents/Github/auto-sns-agent"), pi: process.env.SIEUN_PI_REPO || join(home, "Documents/Github/sieun-pi") },
    files: {
      corrections: join(home, ".prime/agent/browser-chat/corrections.json"),
      harness: join(home, ".prime/agent/harness/harness_state.json"),
      // The ledger sits in the duty chat's own duties folder, the folder the runner keeps LAST_RUNS_FILE in.
      ledger: process.env.WIKI_DREAM_LEDGER || join(dirname(process.env.LAST_RUNS_FILE || "."), "wiki-dream-ledger.json"),
    },
  };
  const result = await measureDream(deps, Array.isArray(lastRuns) ? lastRuns as DutyRunRecord[] : []);
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  const reason = unmeasuredReason(result);
  if (reason) { process.stderr.write(`wiki-dream: ${reason}\n`); process.exit(1); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
