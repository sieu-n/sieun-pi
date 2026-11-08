import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { wikiContentDir } from "../../src/chat-wiki.ts";
import type { DutyRunRecord, FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The Wiki dream duty's precheck (`node --import tsx scripts/duties/wiki-dream.ts`). It is a thin adapter with no model call:
 * - the wiki facts come from `node apps/wiki/scripts/wiki-health.mjs --since <last run>` in this sieun-pi checkout, the wiki engine's home,
 *   which reads the pages from the content root in ~/.config/sieun-pi/wiki.json;
 * - the mistake signal comes from the owner corrections ledger and the continual-harness memories and refinements made since the last run;
 * - the duty's own ledger says which duplicate pairs were judged and which mistake classes are open, fixed or back, and a commit's
 *   `Dream-class: <slug>` trailer moves its class's fix time up when no dream run copied that fix into the ledger;
 * - `git log` in both repos says which `(wiki-dream)` commits were reverted and which code files the dream edited twice in 7 days, and the page
 *   revisions in the content root's .wiki/wiki.db say which wiki pages it edited twice, since the pages left git in b767305544 (2026-11-03);
 * - wiki-health's stale list says which pages are behind their code, both sides dated on the first-parent history of auto-sns-agent's HEAD.
 * wiki-health judges a copy of the pages on disk, where the page API writes. Until 2026-11-03 it judged the pages as committed at HEAD of
 * auto-sns-agent, and this precheck also read the wiki host batch's journal (wiki-box-commit) for pages the batch left out of git; the pages
 * left that repo for the content root, so no batch decides what counts.
 * The headline `wiki_problems` adds up the sync problems the owner asked to keep at 0; the run detail file keeps every other number.
 * An input it cannot read counts in `source_errors` and writes 999999 for the metrics that input feeds, so the run misses and says why.
 */

const DAY = 24 * 60 * 60_000;
export const UNMEASURED = 999_999;
/** Both glide plans start on this day (KST); the job closes 5 lint pages and moves 10 repo-fact memories into skills per day. */
export const GLIDE_START = Date.parse("2026-10-11T00:00:00+09:00");
export const LINT_GLIDE = { base: 250, perDay: 5 };
export const MEMORY_GLIDE = { base: 306, perDay: 10 };
export const CHURN_MS = 7 * DAY;
export const FLAGGED_MAX = 80;
/**
 * wiki-health.mjs took 96 s alone and timed out at the old 100 s twice inside the precheck at 02:4xZ on 2026-10-24, with us-metal02 at load 220
 * on 80 cores; the d4 prechecks before it took 66 to 88 s in all. On 2026-10-28 at 20:17Z it timed out at the old 240 s inside the precheck with
 * us-metal02 at load 283, and alone at 20:18Z it took 228 s at load 224 to 283, so the limit is twice that. The duty's precheck limit
 * (wiki-dream.duty.json) is 600 s to match.
 */
const HEALTH_TIMEOUT_MS = 480_000;
/**
 * The 7-day (wiki-dream) git log of auto-sns-agent timed out at the old 20 s inside the prechecks at 23:33Z and 23:52Z on 2026-11-02, which put
 * 999999 on dream_reverts and pages_retouched, and alone at 23:53Z it took 16.8 s for 7,225 lines with us-metal02 at load 244 to 285 on 80 cores.
 * The limit is about four times that, well inside the duty's 600 s precheck limit.
 */
const GIT_TIMEOUT_MS = 60_000;
/** Runs a program with no shell in `cwd` and gives its stdout; throws on a nonzero exit or a timeout. */
export type Exec = (file: string, args: readonly string[], options: { cwd: string; timeoutMs: number }) => Promise<string>;
export interface DreamDeps {
  now: number;
  exec: Exec;
  readText: (path: string) => Promise<string>;
  /** The node binary that runs wiki-health.mjs. */
  node: string;
  /** `wiki` is the code repo the pages describe (auto-sns-agent), whose git dates deletions and dream commits; `pi` runs wiki-health. */
  repos: { wiki: string; pi: string };
  /** `agentDir` is Prime's agent folder, which holds the clean-room indexes under browser-chat and the session transcripts. */
  files: { corrections: string; harness: string; ledger: string; agentDir: string };
  /** The page revisions the wiki recorded since an ISO time (wiki.db `revisions`); left out, the precheck reads no page churn. */
  revisions?: (sinceIso: string) => Promise<PageRevision[]>;
  /** The root of the Prime session tree that holds a session (`sessionTree`); left out, no page names its maker. */
  treeOf?: (session: string) => Promise<string | null>;
}
/** One row of the wiki's `revisions` table: the page's wiki path, who wrote it and the write's summary. */
export interface PageRevision { path: string; author: string; summary: string }

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
  pairs?: Record<string, { verdict?: string; at?: string; job?: string; score?: number }>;
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

/**
 * Duplicate pairs with no ledger verdict, or whose score rose above the score the verdict recorded. A verdict has no
 * expiry, because the score reads only the two titles and descriptions: re-judging an unchanged pair gives the same
 * answer, and a 30-day expiry would have reopened the 29 pairs judged 2026-10-14 on 11-13 and 20 more on 11-14.
 */
export function unjudgedPairs(pairs: Health["dupPairs"], ledger: Ledger): Health["dupPairs"] {
  return pairs.filter(pair => {
    const verdict = ledger.pairs?.[pairKey(pair.a, pair.b)];
    return !(verdict?.verdict && (typeof verdict.score !== "number" || pair.score <= verdict.score));
  });
}

/** The newest commit in 7 days whose `Dream-class: <slug>` trailer names a class, with its commit time. */
export interface TrailerFix { repo: string; sha: string; at: number }

/**
 * The `git log` arguments that list the commits of the last 7 days carrying a `Dream-class:` trailer, on the first-parent history of `ref`.
 * The output is one `%x1e<sha>%x1f<commit time>%x1f<slugs split by %x1d>` record per commit.
 */
export function trailerArgs(repo: string, ref: string, since: string): string[] {
  return ["-C", repo, "log", ref, "--first-parent", `--since-as-filter=${since}`, "--fixed-strings", "--regexp-ignore-case", "--grep=Dream-class:",
    "--format=%x1e%H%x1f%ct%x1f%(trailers:key=Dream-class,valueonly,separator=%x1d)"];
}

/** Adds the trailer commits of `trailerArgs` output to `fixes`, keeping the newest commit per class slug. */
export function parseTrailers(repo: string, text: string, fixes: Map<string, TrailerFix>): Map<string, TrailerFix> {
  for (const record of text.split("\x1e").map(block => block.trim()).filter(Boolean)) {
    const [sha = "", time = "", slugs = ""] = record.split("\x1f");
    const at = Number(time) * 1000;
    if (!sha || !(at > 0)) continue;
    for (const slug of slugs.split("\x1d").map(value => value.trim()).filter(Boolean)) {
      if (!((fixes.get(slug)?.at ?? 0) >= at)) fixes.set(slug, { repo, sha, at });
    }
  }
  return fixes;
}

/**
 * A class's current fix: the newer of the ledger's `fixedAt` and its newest `Dream-class` trailer commit, with the commit that made it. On
 * 2026-11-04 dream_second_writes recurred at 18:06Z and job "wiki write base version 11-05" landed its fix, sieun-pi 76bd7a2f, at 18:16:18Z,
 * but no dream run was alive to copy that into the ledger, which still said eaca53de at 12:13Z, so mistakes_back read 1 for 3 runs.
 */
export function currentFix(row: LedgerClass, trailer?: TrailerFix): { at: number; iso?: string; commit?: string } {
  const ledgerAt = ms(row.fixedAt);
  if (trailer && !(ledgerAt >= trailer.at)) {
    return { at: trailer.at, iso: new Date(trailer.at).toISOString().replace(".000Z", "Z"), commit: `${trailer.repo} ${trailer.sha.slice(0, 10)}` };
  }
  return { at: Number.isFinite(ledgerAt) ? ledgerAt : -Infinity, ...(Number.isFinite(ledgerAt) ? { iso: row.fixedAt! } : {}), ...(row.fixCommit ? { commit: row.fixCommit } : {}) };
}

/**
 * Ledger classes still open (open or reopened); the open ones the last run already had (first seen before `since`, or with no date), which
 * open_mistakes counts; classes with a recurrence in the last 7 days (`recurred`); and of those, the ones whose recurrence came after the
 * class's current fix (`back`, or any recurrence when the class has neither a fixedAt nor a trailer commit), where `fixes` holds the
 * `Dream-class` trailer commits (currentFix). A class the last run found gets one daily run to land its fix,
 * because a rule takes a CI probe: the 10-13 rules took 22 h from draft (10-13 17:47Z) to land (68d53dd86d, 10-14 16:07Z). On 10-18
 * slop_in_replies_and_pages recurred at 05:39Z and 06:55Z and got a new fix at 07:01Z, and owner_mac_and_machines recurred at 05:20Z and got
 * a new fix at 06:39Z, so counting every recurrence kept mistakes_back at 2 for 7 days whatever the new fixes did.
 */
export function classStates(ledger: Ledger, now: number, since = now, fixes: ReadonlyMap<string, TrailerFix> = new Map()): {
  open: [string, LedgerClass][]; due: [string, LedgerClass][]; recurred: [string, LedgerClass][]; back: [string, LedgerClass][];
} {
  const classes = Object.entries(ledger.classes ?? {});
  const open = classes.filter(([, row]) => row.status === "open" || row.status === "reopened");
  const recent = (row: LedgerClass): string[] => (row.recurred ?? []).filter(at => now - ms(at) <= CHURN_MS && ms(at) <= now);
  const recurred = classes.filter(([, row]) => recent(row).length > 0);
  return {
    open,
    due: open.filter(([, row]) => !(ms(row.firstSeen) >= since)),
    recurred,
    back: recurred.filter(([slug, row]) => { const fix = currentFix(row, fixes.get(slug)); return recent(row).some(at => !(ms(at) <= fix.at)); }),
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
/** A page revision the dream wrote: its author or summary names wiki-dream or "wiki dream", in any case. */
export const isDreamRevision = (row: PageRevision): boolean => /wiki[- ]dream/i.test(`${row.author} ${row.summary}`);
/** Content-root paths in git: the pages that left auto-sns-agent in b767305544, which wiki.db counts instead. */
const OLD_CONTENT = "apps/llm-wiki/content/";
export const isRevert = (subject: string): boolean => subject.startsWith('Revert "') && isDream(subject);

/** Reverted dream commits, and files (repo:path) that 2 or more dream commits changed. Reverts do not count as edits. */
export function churn(commits: readonly DreamCommit[]): { reverts: DreamCommit[]; retouched: { file: string; commits: number }[] } {
  const reverts = commits.filter(commit => isRevert(commit.subject));
  const edits = new Map<string, number>();
  for (const commit of commits) {
    if (!isDream(commit.subject) || isRevert(commit.subject)) continue;
    for (const file of new Set(commit.files.filter(file => !file.startsWith(OLD_CONTENT)))) edits.set(`${commit.repo}:${file}`, (edits.get(`${commit.repo}:${file}`) ?? 0) + 1);
  }
  const retouched = [...edits].filter(([, count]) => count >= 2).map(([file, count]) => ({ file, commits: count })).sort((a, b) => b.commits - a.commits);
  return { reverts, retouched };
}

/** Wiki pages, named by wiki path, that 2 or more dream revisions wrote; the page API is their one writer. */
export function pageChurn(rows: readonly PageRevision[]): { file: string; revisions: number }[] {
  const edits = new Map<string, number>();
  for (const row of rows) if (isDreamRevision(row)) edits.set(row.path, (edits.get(row.path) ?? 0) + 1);
  return [...edits].filter(([, count]) => count >= 2).map(([file, count]) => ({ file, revisions: count })).sort((a, b) => b.revisions - a.revisions);
}

/**
 * One page of wiki-health's `stale` report. The engine (auto-sns-agent apps/llm-wiki/src/lib/server/wiki-stale.ts) lists a page when a
 * `source_refs` path changed on the first-parent history of HEAD after the page's check, `verified_at`: its `last_verified` time, or for a
 * bare day the page's own commit on that day. wiki-health adds the pages citing a path git lacks, with no `verified_at`.
 */
export interface StalePage { path: string; last_verified: string; verified_at?: string; staleRefs: { ref: string; modified: string; since?: string }[] }
export function parseStale(value: unknown): StalePage[] {
  if (!isRecord(value) || !Array.isArray(value.stale)) throw new Error("wiki-health gave no stale list");
  return value.stale.filter(isRecord).filter(row => typeof row.path === "string" && typeof row.last_verified === "string" && Array.isArray(row.staleRefs))
    .map(row => ({ path: row.path as string, last_verified: row.last_verified as string, ...typeof row.verified_at === "string" ? { verified_at: row.verified_at } : {},
      staleRefs: (row.staleRefs as unknown[]).filter(isRecord).filter(ref => typeof ref.ref === "string")
        .map(ref => ({ ref: ref.ref as string, modified: String(ref.modified ?? ""), ...typeof ref.since === "string" ? { since: ref.since } : {} })) }));
}

/**
 * How long a page may be behind its code before it counts in pages_behind_code: one push run plus one rewrite, each at its p90. The d4 push
 * runs of 10-19 came 16.5 min apart at p90 (38 gaps under an hour). A rewrite from the run's start to the page landing took 52.7 min at p90 over
 * four cycles weighted alike (10-19 14:40Z 53 to 63 min, 20:38Z 34 to 39, 10-20 00:46Z 26, 03:58Z 10 to 20). A page behind for less is
 * followed, the way `unlanded` waits 30 min. A followed page within FOLLOW_LEAD_MS of its window end is `wiki_problems_following`, a part the
 * verdict leaves out and a push run goes after (src/duty-push.ts); an earlier one counts in info `pages_waiting`.
 */
export const FOLLOW_WINDOW_MS = 70 * 60_000;

/**
 * How long before its window end a followed page makes a push run start a job. A page with more time left waits, flagged with no `handOff`, so
 * the pages one burst of code commits puts behind go to one job, which takes every flagged page. Until 11-01 any followed page started a job,
 * and d4 started 25 and 26 jobs on 10-30 and 10-31 (KST), 84 of the week's 105 for followed pages alone. measured: after the 15-min reads
 * began (10-29 22:57Z), a page handed to a job landed 12.1 min later at p90 (n=187), so a lead must cover that plus one 15-min read gap. A
 * replay of 10-25 to 10-31 gave 23.0 jobs a day today against 14.6 at 40 min, with no extra page past its window at a p90 of 12.1 or 20 min;
 * 30 min gave 13.1 jobs a day but 48 extra crossings at a p90 of 20 min (~/work/wiki-checks-batch/measure.md).
 */
export const FOLLOW_LEAD_MS = 40 * 60_000;

/** Whether a page that fell behind at `fell` is followed now and still has more than FOLLOW_LEAD_MS of its window left. */
export const waits = (fell: number, now: number): boolean => fell > 0 && now - fell <= FOLLOW_WINDOW_MS - FOLLOW_LEAD_MS;

/**
 * The newest time each path left HEAD's first-parent history, from `git log --first-parent --diff-filter=D --format=%x1e%ct --name-only`.
 * git lists the newest commit first, so the first time a path shows is the one kept.
 */
export function parseDeletions(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const record of text.split("\x1e").slice(1)) {
    const [head = "", ...files] = record.split("\n");
    const at = Number(head.trim()) * 1000;
    if (!Number.isFinite(at) || at <= 0) continue;
    for (const file of files.map(line => line.trim()).filter(Boolean)) if (!out.has(file)) out.set(file, at);
  }
  return out;
}

/**
 * Dates each undated ref (wiki-health's missing ones, with no `since` and no time in `modified`) by the commit that took its path off HEAD, so
 * a page whose cited file was deleted gets the same follow window as one whose cited file changed. wiki-health resolves a bare ref under the
 * repo root, the wiki content folder or an app folder, and a folder ref names every file under it, so a deleted path matches when it is the
 * ref, ends with `/<ref>`, or sits under the folder. A ref no deletion matches, such as a path that never existed, stays undated and counts
 * at once. On 10-27 0f56a96354 (07:33:49Z) and 263f8054be (08:36:10Z) deleted files 9 pages cite, and the 07:34Z and 08:35Z runs read
 * wiki_problems 3 and 6 off target from them within 2 min of each commit.
 */
export function dateMissingRefs(pages: readonly StalePage[], deleted: ReadonlyMap<string, number>): StalePage[] {
  const leftAt = (ref: string): number | undefined => {
    const bare = ref.replace(/(?::\d+(?:-\d+)?|::[\w$.-]+)$/, "").replace(/\/+$/, "");
    let newest: number | undefined;
    for (const [file, at] of deleted)
      if (file === bare || file.endsWith(`/${bare}`) || file.startsWith(`${bare}/`) || file.includes(`/${bare}/`)) newest = Math.max(newest ?? 0, at);
    return newest;
  };
  return pages.map(page => ({ ...page, staleRefs: page.staleRefs.map(ref => {
    if (ref.since !== undefined || Number.isFinite(Date.parse(ref.modified))) return ref;
    const at = leftAt(ref.ref);
    return at === undefined ? ref : { ...ref, since: new Date(at).toISOString() };
  }) }));
}

/** A `sieun-pi:<path>` or `sieun-pi:<path>::<name>` ref split into its path and definition name, with a line suffix dropped; null for any other ref. */
export function piRef(ref: string): { path: string; name?: string } | null {
  const match = /^sieun-pi:(.+?)(?:::(\S(?:.*\S)?))?$/.exec(ref);
  if (!match) return null;
  const path = match[1]!.replace(/:\d+(?:-\d+)?$/, "").replace(/\/+$/, "");
  return match[2] ? { path, name: match[2] } : { path };
}

/**
 * The `git log` arguments that find the newest first-parent sieun-pi commit after `after` that took the ref off HEAD: one that changed a line
 * holding the definition's name as a word, or for a whole-file ref one that touched the path. Renames stay off, so a moved file reads as the
 * deletion it is for the ref. Every date-limited log in this duty passes `--since-as-filter`, because `--since` stops at the first commit dated
 * before the cutoff, and on 2026-11-04 parallel lands left the auto-sns-agent tip dated out of order, so `--since=13:12:40Z` missed afc3ff7332 (13:13:02Z).
 */
export function piRemovalArgs(repo: string, ref: { path: string; name?: string }, after: number): string[] {
  const word = ref.name && `(^|[^[:alnum:]_$])${ref.name.replace(/[.[\]()*+?{}|^$\\]/g, "\\$&")}([^[:alnum:]_$]|$)`;
  return ["-C", repo, "--literal-pathspecs", "log", "HEAD", "--first-parent", "--no-renames", "-n1", "--format=%ct", `--since-as-filter=${new Date(after).toISOString()}`,
    ...(word ? [`-G${word}`] : []), "--", ref.path];
}

/**
 * Dates each undated `sieun-pi:` ref by the sieun-pi commit that removed it (`removedAt`, given the ref and the earliest time worth reading),
 * so a page whose cited sieun-pi definition or file went away gets the follow window a deleted auto-sns-agent file gets. auto-sns-agent's
 * commit.mjs runs the follow gate (apps/wiki/scripts/follow-gate.mjs), which refuses a commit that removes a definition a page cites, so an
 * undated auto-sns-agent definition still counts at once; no sieun-pi hook runs that gate. On 2026-11-03 sieun-pi 187b2866 (14:47Z) removed
 * apps/chat/server/search.ts `missingNote`, and the 15:08Z run counted domains/devops/sw-factory-threads/index.html at once with no
 * window to follow it. Only a commit after the page's check and inside the window is read, since an older removal counts anyway.
 */
export async function datePiRefs(pages: readonly StalePage[], now: number,
  removedAt: (ref: { path: string; name?: string }, after: number) => Promise<number | undefined>): Promise<StalePage[]> {
  return Promise.all(pages.map(async page => {
    const checked = Date.parse(page.verified_at ?? page.last_verified);
    const after = Math.max(Number.isFinite(checked) ? checked : 0, now - FOLLOW_WINDOW_MS);
    const staleRefs = await Promise.all(page.staleRefs.map(async ref => {
      const cited = piRef(ref.ref);
      if (!cited || ref.since !== undefined || Number.isFinite(Date.parse(ref.modified))) return ref;
      const at = await removedAt(cited, after);
      return at === undefined || at <= after ? ref : { ...ref, since: new Date(at).toISOString() };
    }));
    return { ...page, staleRefs };
  }));
}

/** When the page fell behind: its first ref change after the check (`since`, else the newest `modified`); 0 for an undated ref (dateMissingRefs). */
export function behindSince(page: StalePage): number {
  return Math.min(...page.staleRefs.map(ref => { const at = Date.parse(ref.since ?? ref.modified); return Number.isFinite(at) ? at : 0; }));
}

/** The flagged line of a page behind its code: when it was checked, when it fell behind, and each ref with the minute the tip last changed it, or `(missing)`. */
export function staleExcerpt(page: StalePage, now?: number): string {
  const minute = (text: string): string => { const at = Date.parse(text); return Number.isFinite(at) ? new Date(at).toISOString().slice(0, 16) + "Z" : "missing"; };
  const since = behindSince(page);
  const following = now !== undefined && since > 0 && now - since <= FOLLOW_WINDOW_MS
    ? `; behind since ${new Date(since).toISOString().slice(11, 16)}Z, counted from ${new Date(since + FOLLOW_WINDOW_MS).toISOString().slice(11, 16)}Z` : "";
  return `checked ${page.verified_at ? minute(page.verified_at) : page.last_verified} (last_verified ${page.last_verified})${following}; code changed since: ${page.staleRefs.map(ref => `${ref.ref} (${minute(ref.modified)})`).join(", ")}`;
}

/**
 * Who put a page behind its code: the commit at the page's `behindSince` second that touched the ref dated there, the Session-Id trailer
 * auto-sns-agent's commit.mjs wrote on it, and the root of that session's tree, the session a run can steer. A page whose maker the
 * precheck cannot name has none.
 */
export interface PageMaker { commit: string; session: string; tree: string }

/** The repo file a ref names: the ref without its `::name` or line suffix or a trailing slash; null for a `sieun-pi:` or other sibling ref. */
export function refFile(ref: string): string | null {
  if (/^[a-z][a-z0-9-]*:(?![:/])/.test(ref)) return null;
  return ref.replace(/::.*$/, "").replace(/:\d+(?:-\d+)?$/, "").replace(/\/+$/, "");
}

/**
 * The `git log` arguments that list every first-parent commit since `since` that touched one of `files`, each with its time, sha and
 * Session-Id trailer, the way `parseMakerLog` reads them.
 */
export function makerLogArgs(repo: string, files: readonly string[], since: number): string[] {
  return ["-C", repo, "--literal-pathspecs", "log", "HEAD", "--first-parent", "--no-renames", `--since-as-filter=${new Date(since).toISOString()}`,
    "--format=%x1e%ct%x1f%H%x1f%(trailers:key=Session-Id,valueonly,separator=%x2c)", "--name-only", "--", ...files];
}

/** The commits of a `makerLogArgs` log: time in ms, sha, the first Session-Id or "", and the files it touched among those asked. */
export function parseMakerLog(text: string): { at: number; sha: string; session: string; files: string[] }[] {
  return text.split("\x1e").slice(1).flatMap(record => {
    const [head = "", ...files] = record.split("\n");
    const [stamp = "", sha = "", session = ""] = head.split("\x1f");
    const at = Number(stamp) * 1000;
    return Number.isFinite(at) && at > 0 && sha ? [{ at, sha, session: session.split(",")[0]!.trim(), files: files.map(line => line.trim()).filter(Boolean) }] : [];
  });
}

/**
 * The maker of each page (`PageMaker`), read from one `git log` over the files of the refs each page fell behind on. A ref's `since` is the
 * commit time the engine dated it by, so the maker is the commit at that second that touched the ref's file, or a file under a folder ref.
 * In the 7 days to 2026-11-07 23:11Z, 188 of the 211 pages that counted in wiki_problems, and 1,277 of their 1,358 page-hours, came from
 * commits that commit.mjs had warned with the follow gate's `behindWarning`, and none of those sessions fixed its page; for 132 of them
 * (1,204 page-hours) a session of the same tree committed again while the page counted, so the tree held a slot that the Wiki dream's job,
 * held in pi-pool's line for 95% of all counted page-hours, did not (~/work/wiki-dream-held-root-cause-1108).
 */
export async function pageMakers(pages: readonly StalePage[], log: (files: readonly string[], since: number) => Promise<string>,
  treeOf: (session: string) => Promise<string | null>): Promise<Map<string, PageMaker>> {
  const wanted = pages.flatMap(page => {
    const fell = behindSince(page);
    const ref = page.staleRefs.find(row => Date.parse(row.since ?? row.modified) === fell);
    const file = fell > 0 && ref ? refFile(ref.ref) : null;
    return file ? [{ page: page.path, fell, file }] : [];
  });
  const out = new Map<string, PageMaker>();
  if (!wanted.length) return out;
  const commits = parseMakerLog(await log([...new Set(wanted.map(row => row.file))], Math.min(...wanted.map(row => row.fell)) - 1000));
  const trees = new Map<string, Promise<string | null>>();
  for (const { page, fell, file } of wanted) {
    const commit = commits.find(row => row.at === fell && row.session && row.files.some(touched => touched === file || touched.startsWith(`${file}/`)));
    if (!commit) continue;
    if (!trees.has(commit.session)) trees.set(commit.session, treeOf(commit.session).catch(() => null));
    const tree = await trees.get(commit.session)!;
    if (tree) out.set(page, { commit: commit.sha, session: commit.session, tree });
  }
  return out;
}

/**
 * The root of the Prime session tree that holds `session` under `agentDir`: the session itself when its transcript is a root's, else the
 * root folder under session-artifacts that holds it as a subagent at depth 1 or 2; null when this box has no such session.
 */
export async function sessionTree(agentDir: string, session: string): Promise<string | null> {
  if (!/^[\w-]+$/.test(session)) return null;
  if (existsSync(join(agentDir, "sessions", `${session}.jsonl`))) return session;
  const artifacts = join(agentDir, "session-artifacts");
  const { glob } = await import("node:fs/promises");
  for await (const found of glob([`*/sub-*/${session}.jsonl`, `*/sub-*/sub-*/${session}.jsonl`], { cwd: artifacts })) return String(found).split("/")[0]!;
  return null;
}

/** A global memory about the auto-sns-agent repo: its path or title starts with "auto-sns-agent". */
export const isRepoFact = (entry: HarnessEntry): boolean => /^auto-sns-agent/i.test(entry.path ?? "") || /^auto-sns-agent/i.test(entry.title ?? "");
const skillPath = (text: string): string | undefined => /(?:\.agents\/skills|\.claude\/skills-native|skills)\/[\w./-]+?(?:SKILL\.md|\.md)/.exec(text)?.[0];

/** The memories of a harness_state.json; throws when it has no entries object. */
export function harnessMemories(state: unknown): HarnessEntry[] {
  if (!isRecord(state) || !isRecord(state.entries)) throw new Error("harness_state.json has no entries object");
  return Object.values(isRecord(state.entries.memory) ? state.entries.memory : {}).filter(isRecord) as HarnessEntry[];
}

const HARNESS_WRITE = /\b(?:create|update)_memory\b/;
const strings = (value: unknown): string[] => typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings)
  : isRecord(value) ? Object.values(value).flatMap(strings) : [];

/**
 * The memories a clean-room trial wrote, each with the session that wrote it. On 10-19 at 22:46Z job sub-6091ecc5 of trial chat 01a155fc
 * (readme preview run4) saved a global memory that a server the owner keeps running needs RefuseManualStop, from the trial task's "leave it
 * running", which the owner never said. The 10-20 01:08Z d4 job read it as new, moved it into skills/board/SKILL.md (13377e9a) and deleted it
 * (~/work/archived-job-cleanup/trial-memory/run4-global-memory.md). A trial session is a chat in browser-chat/clean-room-chats.json or a
 * session filed in clean-room-harness.json, with every job and subagent under its session-artifacts folder. A memory is its write when one
 * of their tool calls runs create_memory or update_memory and names the memory's id or title anywhere in that call, so a cell that reads one
 * memory and writes another keeps both out of the moves. A digest or a cell that only reads a memory is no write. A missing index means no
 * trial ran on this box.
 */
export async function trialWrites(memories: readonly HarnessEntry[], agentDir: string): Promise<Map<string, string>> {
  const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";
  const json = (path: string): Promise<unknown> => readFile(path, "utf8").then(text => JSON.parse(text) as unknown, error => { if (missing(error)) return {}; throw error; });
  const chats = await json(join(agentDir, "browser-chat", "clean-room-chats.json"));
  const filed = await json(join(agentDir, "browser-chat", "clean-room-harness.json"));
  const trials = new Set([
    ...(isRecord(chats) && Array.isArray(chats.ids) ? chats.ids.filter((id): id is string => typeof id === "string") : []),
    ...(isRecord(filed) && isRecord(filed.trials) ? Object.keys(filed.trials) : []),
  ]);
  const found = new Map<string, string>();
  const wanted = memories.filter(entry => entry.id);
  if (!trials.size || !wanted.length) return found;
  for (const trial of trials) {
    const below = await readdir(join(agentDir, "session-artifacts", trial), { recursive: true }).catch(error => { if (missing(error)) return []; throw error; });
    const transcripts = [join(agentDir, "sessions", `${trial}.jsonl`), ...below.filter(file => file.endsWith(".jsonl")).map(file => join(agentDir, "session-artifacts", trial, file))];
    for (const transcript of transcripts) {
      const text = await readFile(transcript, "utf8").catch(error => { if (missing(error)) return ""; throw error; });
      for (const line of text.split("\n")) {
        if (!HARNESS_WRITE.test(line)) continue;
        let row: unknown;
        try { row = JSON.parse(line); } catch { continue; }
        const content = isRecord(row) && isRecord(row.message) && Array.isArray(row.message.content) ? row.message.content : [];
        const calls = content.filter(isRecord).filter(part => part.type === "toolCall").flatMap(part => strings(part.arguments)).filter(code => HARNESS_WRITE.test(code));
        for (const entry of wanted) {
          if (found.has(entry.id!)) continue;
          if (calls.some(code => code.includes(entry.id!) || (!!entry.title && code.includes(entry.title)))) found.set(entry.id!, basename(transcript, ".jsonl"));
        }
      }
    }
  }
  return found;
}

/**
 * The harness signal: repo-fact global memory count, memories and refinements made since `since`, memories to move into skills, and the
 * memories a clean-room trial wrote (`trial`, by id with the writing session), which are left out of every other list so no skill takes them.
 */
export function harnessSignal(state: unknown, ledger: Ledger, since: number, trial: ReadonlyMap<string, string> = new Map()): {
  repoFacts: number; fresh: HarnessEntry[]; refinements: Refinement[]; moves: HarnessEntry[]; trial: { entry: HarnessEntry; session: string }[];
} {
  const all = harnessMemories(state);
  const memories = all.filter(entry => !trial.has(entry.id ?? ""));
  const facts = memories.filter(entry => entry.scope === "global" && isRepoFact(entry));
  const moved = new Set(Object.keys(ledger.memoryMoves ?? {}));
  return {
    repoFacts: facts.length,
    fresh: memories.filter(entry => ms(entry.created_at) >= since).sort((a, b) => Number(isRepoFact(b)) - Number(isRepoFact(a)) || ms(b.created_at) - ms(a.created_at)),
    refinements: (isRecord(state) && Array.isArray(state.refinements) ? state.refinements.filter(isRecord) as Refinement[] : []).filter(row => ms(row.created_at) >= since),
    moves: facts.filter(entry => !moved.has(entry.id ?? "")).sort((a, b) => ms(a.updated_at) - ms(b.updated_at)),
    trial: all.filter(entry => trial.has(entry.id ?? "")).map(entry => ({ entry, session: trial.get(entry.id!)! })),
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

/**
 * The order the job reads flagged items in, with a cap per kind; the capped kinds stop at FLAGGED_MAX in all. A kind wiki_problems counts has
 * no cap, so the job's list holds every problem the headline counts: at a cap of 30 pages behind code, listed by path, 424 of the 1,221 page-hours
 * counted from 10-20 07:51Z to 10-22 07:51Z were pages past the 30th, mostly domains/ and projects/ pages that no brief named
 * (~/work/wiki-problems-follow-fix/replay_stale.py).
 */
export const FLAG_ORDER: readonly [string, number][] = [
  ["source_error", 6], ["recurred", 8], ["open_class", 10], ["hub_orphan", Infinity], ["dead_link", Infinity],
  ["superseded_linked", Infinity], ["session_link", Infinity], ["missing_meta", Infinity], ["stale_vs_code", Infinity], ["dup_pair", 5], ["revert", 5], ["retouched", 5],
  ["correction", 10], ["signal", 6], ["refinement", 6], ["trial_memory", 10], ["memory", 10], ["lint_page", 5], ["archive_candidate", 3],
];

/**
 * The kinds wiki_problems counts, the uncapped ones in FLAG_ORDER. Their items carry `handOff`, so a run that finds the last dream job still
 * working hands it the new ones (sieun-pi src/chat-duty-run.ts `handOff`).
 */
export const PROBLEM_KINDS: ReadonlySet<string> = new Set(FLAG_ORDER.filter(([, cap]) => cap === Infinity).map(([kind]) => kind));

/** Picks the flagged items: each kind in FLAG_ORDER up to its cap, unknown kinds last, and FLAGGED_MAX items of the capped kinds in all. */
export function pickFlagged(slices: readonly FlaggedSlice[]): FlaggedSlice[] {
  const order = new Map(FLAG_ORDER.map(([kind], index) => [kind, index]));
  const caps = new Map(FLAG_ORDER);
  const taken = new Map<string, number>();
  const ranked = slices.map((slice, index) => ({ slice, index })).sort((a, b) =>
    (order.get(a.slice.kind) ?? order.size) - (order.get(b.slice.kind) ?? order.size) || a.index - b.index);
  const out: FlaggedSlice[] = [];
  let capped = 0;
  for (const { slice } of ranked) {
    const count = taken.get(slice.kind) ?? 0;
    const cap = caps.get(slice.kind) ?? 3;
    if (count >= cap || (Number.isFinite(cap) && capped >= FLAGGED_MAX)) continue;
    taken.set(slice.kind, count + 1);
    out.push(slice);
    if (Number.isFinite(cap)) capped += 1;
  }
  return out;
}

const HEALTH_METRICS = ["hub_orphans", "dead_links", "session_links", "superseded_linked", "missing_meta", "stale_vs_code"] as const;
/**
 * The sync problems wiki_problems adds up; pages_behind_code counts the pages of wiki-health's stale list (parseStale) behind for longer than
 * FOLLOW_WINDOW_MS.
 */
const PROBLEM_METRICS = ["hub_orphans", "dead_links", "session_links", "superseded_linked", "missing_meta", "pages_behind_code"] as const;

/**
 * Measures everything and builds the precheck output. Each input that fails to run or to parse adds a source_error item and 999999 for
 * the metrics it feeds, so every input's parse step sits inside its `.catch`.
 */
export async function measureDream(deps: DreamDeps, lastRuns: readonly DutyRunRecord[]): Promise<PrecheckOutput & { info: Record<string, number> }> {
  const { now } = deps;
  const since = sinceFrom(lastRuns, now);
  const errors: FlaggedSlice[] = [];
  const fail = (source: string, error: unknown): undefined => { errors.push({ kind: "source_error", item: source, excerpt: clip(`${source}: ${message(error)}`) }); return undefined; };
  const readJson = async (path: string): Promise<unknown> => JSON.parse(await deps.readText(path)) as unknown;

  const health = await deps.exec(deps.node, ["apps/wiki/scripts/wiki-health.mjs", "--since", new Date(since).toISOString()], { cwd: deps.repos.pi, timeoutMs: HEALTH_TIMEOUT_MS })
    .then(parseHealth).catch(error => fail("wiki-health.mjs", error));
  const ledger = await readJson(deps.files.ledger).then(value => { if (!isRecord(value)) throw new Error("not an object"); return value as Ledger; }).catch(error => fail("ledger", error));
  const corrections = await readJson(deps.files.corrections).then(value => freshCorrections(value, since)).catch(error => fail("corrections.json", error));
  const harness = await readJson(deps.files.harness)
    .then(async value => harnessSignal(value, ledger ?? {}, since, await trialWrites(harnessMemories(value), deps.files.agentDir)))
    .catch(error => fail("harness_state.json", error));
  const gitSince = new Date(now - CHURN_MS).toISOString();
  const commits: DreamCommit[] = [];
  let gitOk = true;
  for (const [name, repo] of [["auto-sns-agent", deps.repos.wiki], ["sieun-pi", deps.repos.pi]] as const) {
    await deps.exec("git", ["-C", repo, "log", "HEAD", `--since-as-filter=${gitSince}`, "--fixed-strings", "--grep=(wiki-dream)", "--format=%x1e%H%x1f%s", "--name-only", "--no-renames"],
      { cwd: repo, timeoutMs: GIT_TIMEOUT_MS }).then(text => { commits.push(...parseGitLog(name, text)); }).catch(error => { gitOk = false; fail(`git log ${name}`, error); });
  }

  // A fix commit names its class with a `Dream-class: <slug>` trailer, read on sieun-pi origin/main and the auto-sns-agent checkout's HEAD.
  const fixes = new Map<string, TrailerFix>();
  let trailersOk = true;
  for (const [name, repo, ref] of [["auto-sns-agent", deps.repos.wiki, "HEAD"], ["sieun-pi", deps.repos.pi, "origin/main"]] as const) {
    await deps.exec("git", trailerArgs(repo, ref, gitSince), { cwd: repo, timeoutMs: GIT_TIMEOUT_MS })
      .then(text => { parseTrailers(name, text, fixes); }).catch(error => { trailersOk = false; fail(`git log ${name} Dream-class`, error); });
  }

  const pageRows = deps.revisions ? await deps.revisions(gitSince).catch(error => fail("wiki.db revisions", error)) : [];
  const pagesRetouched = pageRows ? pageChurn(pageRows) : undefined;

  const listed = health && (() => { try { return parseStale(health.stale); } catch (error) { return fail("wiki-health.mjs stale", error); } })();
  const undated = listed?.some(page => page.staleRefs.some(ref => ref.since === undefined && !Number.isFinite(Date.parse(ref.modified))));
  const datedWiki = listed && undated
    ? await deps.exec("git", ["-C", deps.repos.wiki, "log", "HEAD", "--first-parent", "--diff-filter=D", "--no-renames", `--since-as-filter=${new Date(now - FOLLOW_WINDOW_MS).toISOString()}`,
      "--format=%x1e%ct", "--name-only"], { cwd: deps.repos.wiki, timeoutMs: GIT_TIMEOUT_MS })
      .then(text => dateMissingRefs(listed, parseDeletions(text))).catch(error => { fail("git log deletions", error); return listed; })
    : listed;
  const stalePages = datedWiki && await datePiRefs(datedWiki, now, (ref, after) =>
    deps.exec("git", piRemovalArgs(deps.repos.pi, ref, after), { cwd: deps.repos.pi, timeoutMs: GIT_TIMEOUT_MS })
      .then(text => { const at = Number(text.trim()) * 1000; return at > 0 ? at : undefined; })
      .catch(error => { fail(`git log sieun-pi ${ref.path}`, error); return undefined; }));
  const metrics: Record<string, number> = {};
  for (const key of HEALTH_METRICS) metrics[key] = health?.facts[key] ?? UNMEASURED;
  const following = stalePages?.filter(page => { const fell = behindSince(page); return fell > 0 && now - fell <= FOLLOW_WINDOW_MS; });
  const waiting = new Set(stalePages?.filter(page => waits(behindSince(page), now)).map(page => page.path));
  // The makers of the pages a run hands off, so a run can ask them while the dream's job is held (src/chat-duty-run.ts `handToMakers`).
  const treeOf = deps.treeOf;
  const makers = stalePages && treeOf ? await pageMakers(stalePages.filter(page => !waiting.has(page.path)),
    (files, after) => deps.exec("git", makerLogArgs(deps.repos.wiki, files, after), { cwd: deps.repos.wiki, timeoutMs: GIT_TIMEOUT_MS }), treeOf)
    .catch(error => { fail("git log makers", error); return new Map<string, PageMaker>(); }) : new Map<string, PageMaker>();
  metrics.pages_behind_code = stalePages && following ? stalePages.length - following.length : UNMEASURED;
  if (following) metrics.wiki_problems_following = following.length - waiting.size;
  metrics.wiki_problems = PROBLEM_METRICS.some(key => metrics[key] === UNMEASURED) ? UNMEASURED : PROBLEM_METRICS.reduce((sum, key) => sum + metrics[key]!, 0);
  const lintFailing = health?.facts.lint_failing_pages;
  metrics.lint_over_glide = lintFailing === undefined ? UNMEASURED : lintFailing - glide(LINT_GLIDE, now);
  const unjudged = health && ledger ? unjudgedPairs(health.dupPairs, ledger) : undefined;
  metrics.dup_unjudged = unjudged?.length ?? UNMEASURED;
  metrics.memory_rules_over_glide = harness ? harness.repoFacts - glide(MEMORY_GLIDE, now) : UNMEASURED;
  const classes = ledger ? classStates(ledger, now, since, fixes) : undefined;
  metrics.open_mistakes = classes?.due.length ?? UNMEASURED;
  metrics.mistakes_back = trailersOk ? classes?.back.length ?? UNMEASURED : UNMEASURED;
  const dream = churn(commits);
  metrics.dream_reverts = gitOk ? dream.reverts.length : UNMEASURED;
  metrics.pages_retouched = gitOk && pagesRetouched ? dream.retouched.length + pagesRetouched.length : UNMEASURED;
  for (const input of health?.errors ?? []) fail("wiki-health.mjs", new Error(`could not read ${input}`));
  if (health && !health.errors.length) {
    for (const key of [...HEALTH_METRICS, "lint_failing_pages"]) if (health.facts[key] === undefined) fail("wiki-health.mjs", new Error(`no fact ${key}`));
  }
  metrics.source_errors = errors.length;

  const info: Record<string, number> = {
    since, curated_pages: health?.curatedPages ?? UNMEASURED, lint_failing_pages: lintFailing ?? UNMEASURED, lint_glide_plan: glide(LINT_GLIDE, now),
    repo_fact_memories: harness?.repoFacts ?? UNMEASURED, memory_glide_plan: glide(MEMORY_GLIDE, now), new_corrections: corrections?.length ?? UNMEASURED,
    new_memories: harness?.fresh.length ?? UNMEASURED, trial_memories: harness?.trial.length ?? UNMEASURED, new_refinements: harness?.refinements.length ?? UNMEASURED, signals: health?.signals.length ?? UNMEASURED,
    open_session_logs: health?.facts.open_session_logs ?? UNMEASURED, open_classes: classes?.open.length ?? UNMEASURED,
    recurred_7d: classes?.recurred.length ?? UNMEASURED, dream_commits_7d: commits.filter(commit => !isRevert(commit.subject)).length,
    pages_waiting: stalePages ? waiting.size : UNMEASURED,
  };

  const slices: FlaggedSlice[] = [...errors];
  // Only a class back after its current fix is work: one that came back before it already has that fix, and recurred_7d counts it.
  for (const [slug, row] of classes?.back ?? []) {
    const fix = currentFix(row, fixes.get(slug));
    const when = fix.iso ? `after its current fix (${fix.iso})` : "with no fix date";
    slices.push({ kind: "recurred", item: slug, excerpt: clip(`${row.title ?? slug} came back on ${(row.recurred ?? []).slice(-1)[0]}, ${when} ${fix.commit ?? "?"}; skill ${row.skill ?? "?"}`) });
  }
  for (const commit of dream.reverts) slices.push({ kind: "revert", item: `${commit.repo}:${commit.sha.slice(0, 10)}`, excerpt: clip(commit.subject) });
  for (const row of pagesRetouched ?? []) slices.push({ kind: "retouched", item: row.file, excerpt: `${row.file} changed by ${row.revisions} wiki-dream page revisions in 7 days` });
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
  for (const { entry, session } of harness?.trial ?? []) {
    slices.push({ kind: "trial_memory", item: entry.id ?? "?", at: ms(entry.created_at),
      excerpt: clip(`written by clean-room trial session ${session}, so it is trial output: move none of it into a skill: ${entry.title ?? ""} [${entry.path ?? ""}]`) });
  }
  for (const entry of harness?.fresh ?? []) slices.push(memorySlice(entry, "new since last run"));
  for (const entry of (harness?.moves ?? []).filter(entry => !freshIds.has(entry.id)).slice(0, 10)) slices.push(memorySlice(entry, "move into its skill"));
  // The pages that count come first, longest behind first, then the followed ones, so the job takes the oldest work first.
  const behindOrder = (page: StalePage): [number, number] => { const fell = behindSince(page); return [fell > 0 && now - fell <= FOLLOW_WINDOW_MS ? 1 : 0, fell]; };
  const staleOrder = [...stalePages ?? []].sort((a, b) => { const [x, y] = [behindOrder(a), behindOrder(b)]; return x[0] - y[0] || x[1] - y[1]; });
  // The page's check time is its sig, so a run hands the dream job a page again once a writer checked it and a later commit put it behind again.
  for (const page of staleOrder) slices.push({ kind: "stale_vs_code", item: page.path, excerpt: clip(staleExcerpt(page, now)), sig: page.verified_at ?? page.last_verified });
  for (const item of health?.items ?? []) {
    if (item.kind === "signal" || (item.kind === "stale_vs_code" && stalePages)) continue;
    slices.push({ kind: item.kind, item: item.path, excerpt: clip(`${item.excerpt ?? item.path}${item.target ? ` -> ${item.target}` : ""}`) });
  }
  for (const pair of unjudged ?? []) slices.push({ kind: "dup_pair", item: pairKey(pair.a, pair.b), excerpt: `${pair.a} and ${pair.b} look alike (score ${pair.score})` });

  const handOff = (slice: FlaggedSlice): boolean => PROBLEM_KINDS.has(slice.kind) && !(slice.kind === "stale_vs_code" && waiting.has(slice.item ?? ""));
  const marked = (slice: FlaggedSlice): FlaggedSlice => {
    const maker = slice.kind === "stale_vs_code" ? makers.get(slice.item ?? "") : undefined;
    return { ...slice, ...handOff(slice) ? { handOff: true as const } : {}, ...maker ? { maker } : {} };
  };
  return { metrics: { ...metrics }, flagged: pickFlagged(slices).map(marked), info };
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

/**
 * The sieun-pi checkout whose `(wiki-dream)` commits the precheck reads: SIEUN_PI_REPO, else the checkout this script sits in, else the one its
 * release links node_modules to (scripts/release-chat.mjs builds a release from git archive, with no .git). Until 10-18 it was the Mac path
 * ~/Documents/Github/sieun-pi, and on us-metal02, whose checkout is ~/src/sieun-pi, the 04:23Z run failed `git log sieun-pi` with ENOENT.
 */
export function piCheckout(scriptDir: string, fromEnv: string | undefined = process.env.SIEUN_PI_REPO): string {
  if (fromEnv) return fromEnv;
  const root = resolve(scriptDir, "../../../../..");
  if (existsSync(join(root, ".git"))) return root;
  try { return dirname(realpathSync(join(root, "node_modules"))); } catch { return root; }
}

/** The page revisions since `sinceIso`, read from wiki.db opened read-only, so the engine's writes never wait on it. */
async function readRevisions(db: string, sinceIso: string): Promise<PageRevision[]> {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(db, { readOnly: true });
  try {
    return database.prepare("SELECT path, author, summary FROM revisions WHERE ts >= ?").all(sinceIso) as unknown as PageRevision[];
  } finally { database.close(); }
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
    repos: { wiki: process.env.LLM_WIKI_REPO || join(home, "Documents/Github/auto-sns-agent"), pi: piCheckout(dirname(fileURLToPath(import.meta.url))) },
    files: {
      corrections: join(home, ".prime/agent/browser-chat/corrections.json"),
      harness: join(home, ".prime/agent/harness/harness_state.json"),
      agentDir: join(home, ".prime/agent"),
      // The ledger sits in the duty chat's own duties folder, the folder the runner keeps LAST_RUNS_FILE in.
      ledger: process.env.WIKI_DREAM_LEDGER || join(dirname(process.env.LAST_RUNS_FILE || "."), "wiki-dream-ledger.json"),
    },
    revisions: sinceIso => readRevisions(join(wikiContentDir(), ".wiki/wiki.db"), sinceIso),
    treeOf: session => sessionTree(join(home, ".prime/agent"), session),
  };
  const result = await measureDream(deps, Array.isArray(lastRuns) ? lastRuns as DutyRunRecord[] : []);
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  const reason = unmeasuredReason(result);
  if (reason) { process.stderr.write(`wiki-dream: ${reason}\n`); process.exit(1); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
