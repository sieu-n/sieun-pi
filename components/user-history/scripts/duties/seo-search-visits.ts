import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The SEO guy's Search traffic precheck (`node --import tsx scripts/duties/seo-search-visits.ts`), an upkeep duty: the pages Google sends
 * people to keep their impressions, every blog change on the sieun/dev tip reaches GitHub within a day, no article carries copy brief.md bans,
 * and every source reads. The owner's growth goals (10,000 blog and tool visits a day, 300 sign-ups a day) live on the plan as goals p56 and p71 (owner 10-18: "plan -> achieved ->
 * cleared & written on duty for maintanence only"), so goal_visits_d7, google_clicks_d7 and signups_goal_d28 stay in the output and its
 * flagged lines for the run to write into those goals' targets, and the duty file counts none of them.
 * No model call and no write to the program's metrics file: it runs seo-sources.py in auto-sns-agent's SEO CLI project (scripts/seo), which
 * calls virev_seo.traffic, virev_seo.gsc and virev_seo.signups, and reads git in the same checkout.
 * A source that fails or is stale counts in source_errors and gives its metrics the miss value, never a made-up good number.
 */

const REPO = process.env.LLM_WIKI_REPO || join(homedir(), "Documents/Github/auto-sns-agent");
const SOURCES_PY = join(import.meta.dirname, "seo-sources.py");
/** A precheck value for a metric whose source failed: past its target either way, the convention of auto-sns-agent scripts/duties/ci/duty-sources.mjs. */
export const UNMEASURED = 999_999;
/**
 * Search Console marks a day final 2 to 3 days late (virev_seo/gsc.py: "GSC data lags 2-3 days"; on 10-12 the last final day was 10-10),
 * so a last final day more than 3 days old means the read is stale.
 */
export const GSC_STALE_DAYS = 3;
/**
 * dropped_pages: a page with at least DROP_MIN_DAILY impressions a day over the 14 days before the last 7 final days, whose last 7 days
 * average under DROP_SHARE of that. On 10-13 /ja/blog/how-much-does-youtube-pay-per-view went from 136 to 2 impressions a day and
 * /blog/instagram-algorithm to about 0, and nobody saw it for days.
 */
export const DROP_MIN_DAILY = 20;
export const DROP_SHARE = 0.2;
/**
 * unshipped_blog_changes: a commit under apps/blog on the sieun/dev tip that is not on GitHub's sieun/dev UNSHIPPED_AFTER_MS after its commit
 * time. On 10-16 and 10-17 35 creator pages waited about 25 h unpushed, and on 10-18 five blog changes waited 7 h.
 */
export const UNSHIPPED_AFTER_MS = 24 * 3_600_000;
export const BLOG_PATH = "apps/blog";
/**
 * The shared sieun/dev tip. Since 2026-10-18 11:24Z it lives in the us-metal02 checkout's local branch and the release owner pushes origin
 * from there; the Mac copy (refs/remotes/mac/sieun/dev) went stale at that move.
 */
export const TIP_REF = "refs/heads/sieun/dev";
export const SHIPPED_REF = "refs/remotes/origin/sieun/dev";
/**
 * banned_copy: program/brief.md rule 4, "Articles say 180M+ creators (owner: \"no it's 180M+ tho still\"), never 200M+ or 12M", and rule 5,
 * "Articles never promise \"no credit card\" or free search", the same claims apps/blog's next-step-copy.test.ts and hero-next-step.test.ts
 * keep out of the CTA copy (200M, 12M, 2억, 2億, no credit card, free). Each phrase names what it catches. A creator count is a count of
 * creators or influencers, so a 12M follower row in a creator table and a 2億 like total stay out; a free calculator link stays out, because
 * the rule is about search and sign-up.
 */
export const BANNED_COPY: readonly { phrase: string; pattern: RegExp }[] = [
  { phrase: "200M+ creators", pattern: /\b200\s?(?:M|million)\+?\s+(?:[\w,]+\s+){0,5}?(?:creators|influencers|profiles)\b/i },
  { phrase: "12M creators", pattern: /\b12\s?(?:M|million)\+?\s+(?:[\w,]+\s+){0,5}?(?:creators|influencers|profiles)\b/i },
  { phrase: "2억 크리에이터", pattern: /2억\s*(?:명의?\s*)?(?:이상의?\s*|넘는\s*)?(?:크리에이터|인플루언서)/ },
  { phrase: "2億 クリエイター", pattern: /2億\s*(?:人の?\s*)?(?:以上の?\s*|の\s*)?(?:クリエイター|インフルエンサー)/ },
  { phrase: "no credit card", pattern: /\bno (?:credit )?card(?: required| needed)?\b|\bwithout a (?:credit )?card\b/i },
  { phrase: "신용카드 없이", pattern: /(?:신용)?카드\s*(?:등록\s*)?(?:없이|불필요|필요\s*없)/ },
  { phrase: "クレジットカード不要", pattern: /(?:クレジット)?カード(?:登録)?(?:不要|なし|無し)/ },
  { phrase: "free search", pattern: /\bfree (?:creator |influencer )?search\b|\bsearch (?:\w+ )?(?:for )?free\b/i },
  { phrase: "무료 검색", pattern: /무료\s*(?:로\s*)?(?:크리에이터\s*|인플루언서\s*)?(?:검색|탐색)/ },
  { phrase: "無料検索", pattern: /無料(?:で)?(?:クリエイター|インフルエンサー)?(?:検索|探せ)/ },
];
export const BLOG_CONTENT = "apps/blog/content";
export interface BannedPage { path: string; phrases: string[] }

/** The pages whose text carries a BANNED_COPY phrase, with the phrases each one carries, in path order. */
export function bannedCopy(pages: readonly { path: string; text: string }[]): BannedPage[] {
  return pages.flatMap(({ path, text }) => {
    const phrases = BANNED_COPY.filter(({ pattern }) => pattern.test(text)).map(({ phrase }) => phrase);
    return phrases.length ? [{ path, phrases }] : [];
  }).sort((a, b) => a.path.localeCompare(b.path));
}

/** Sections whose first-page sign-ups count toward the owner's 300 a day (goal p71), the same sections as goal_visits_d7. */
export const GOAL_SECTIONS = ["blog", "tools"] as const;

type Err = { error: string };
interface Window { start: string; end: string; per_day: Record<string, number>; goal_by_source_per_day: Record<string, number> }
export interface TrafficRead { windows: Record<string, Window>; last_day: Record<string, unknown> & { date: string }; sessions_read: number; top_goal_entries_d28?: { path: string; visits: number }[] }
interface Totals { start: string; end: string; clicks: number; impressions: number; position: number | null }
export interface PageImpressions { page: string; impressions: number }
export interface PagesWindow { start: string; end: string; rows: PageImpressions[] }
export interface GscRead { today: string; last_final: string | null; d7?: Totals; d7_prior?: Totals; pages?: { base: PagesWindow; recent: PagesWindow } }
export interface SignupsRead { clerk_users: number; d28: number; attribution: string; attribution_error?: string; matched?: number; by_section?: Record<string, number> }
export interface TipCommit { sha: string; committedAt: number; subject: string }
export interface ShipRead { tipRef: string; commits: TipCommit[] }
export interface CopyRead { pages: number; banned: BannedPage[] }
export interface VisitsRead { traffic?: TrafficRead | Err; gsc?: GscRead | Err; signups?: SignupsRead | Err; ship?: ShipRead | Err; copy?: CopyRead | Err }
export interface DroppedPage { page: string; baseDaily: number; recentDaily: number }

const isErr = (value: unknown): value is Err => typeof value === "object" && value !== null && "error" in value;
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
const daysIn = (window: Pick<PagesWindow, "start" | "end">): number => daysBetween(window.start, window.end) + 1;
const round = (value: number, places = 2): number => Math.round(value * 10 ** places) / 10 ** places;

/** The pages that fell, from Search Console impressions per page over the base window and the recent one, biggest base first. */
export function droppedPages(base: PagesWindow, recent: PagesWindow): DroppedPage[] {
  const recentByPage = new Map(recent.rows.map(row => [row.page, row.impressions]));
  return base.rows.flatMap(row => {
    const baseDaily = row.impressions / daysIn(base);
    const recentDaily = (recentByPage.get(row.page) ?? 0) / daysIn(recent);
    return baseDaily >= DROP_MIN_DAILY && recentDaily < DROP_SHARE * baseDaily ? [{ page: row.page, baseDaily: round(baseDaily, 1), recentDaily: round(recentDaily, 1) }] : [];
  }).sort((a, b) => b.baseDaily - a.baseDaily);
}

/** The blog commits on the tip and not on GitHub that are older than UNSHIPPED_AFTER_MS at `now`, oldest first. */
export function unshippedBlogChanges(commits: readonly TipCommit[], now: number): TipCommit[] {
  return commits.filter(commit => now - commit.committedAt > UNSHIPPED_AFTER_MS).sort((a, b) => a.committedAt - b.committedAt);
}

const hoursAgo = (at: number, now: number): number => Math.round((now - at) / 3_600_000);

/** The metrics and flagged slices of one read. `at` is the run time for the slices and the age of unshipped commits. */
export function visitsOutput(read: VisitsRead, at: number): PrecheckOutput {
  const flagged: FlaggedSlice[] = [];
  const metrics: Record<string, number> = { dropped_pages: UNMEASURED, unshipped_blog_changes: UNMEASURED, banned_copy: UNMEASURED, source_errors: 0,
    goal_visits_d7: -UNMEASURED, google_clicks_d7: -UNMEASURED, signups_goal_d28: -UNMEASURED };
  const fail = (source: string, why: string, keys: string[]): void => {
    metrics.source_errors! += 1;
    flagged.push({ at, kind: "source_error", excerpt: `${source}: ${why}. Not measured this run, so ${keys.join(", ")} read the placeholder ${UNMEASURED}.` });
  };
  const traffic = read.traffic;
  if (!traffic || isErr(traffic)) fail("PostHog visits (virev_seo.traffic)", traffic?.error ?? "no answer", ["goal_visits_d7"]);
  else {
    const day = traffic.last_day;
    const seen = ["blog", "tools", "landing", "app", "bot", "internal"].reduce((sum, key) => sum + (Number(day[key]) || 0), 0);
    if (seen === 0) fail("PostHog visits (virev_seo.traffic)", `no session at all on virev.ai on ${day.date}, so PostHog events stopped arriving`, ["goal_visits_d7"]);
    else {
      const d7 = traffic.windows.d7!, d28 = traffic.windows.d28!;
      metrics.goal_visits_d7 = d7.per_day.goal ?? 0;
      const sources = Object.entries(d7.goal_by_source_per_day).filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]).map(([key, value]) => `${key} ${value}`);
      flagged.push({ at, kind: "visits", excerpt: `Blog and tool visits a day: ${metrics.goal_visits_d7} over ${d7.start}..${d7.end}, ${d28.per_day.goal ?? 0} over ${d28.start}..${d28.end} (goal_visits_d28). 7-day sources a day: ${sources.join(", ")}. ${day.date}: ${day.goal} visits.` });
      const top = (traffic.top_goal_entries_d28 ?? []).slice(0, 5).map(entry => `${entry.path} ${entry.visits}`);
      if (top.length) flagged.push({ at, kind: "top_pages", excerpt: `Top blog and tool entry pages, 28 days: ${top.join(", ")}` });
    }
  }

  const gsc = read.gsc;
  const gscKeys = ["dropped_pages", "google_clicks_d7"];
  if (!gsc || isErr(gsc)) fail("Search Console (virev_seo.gsc)", gsc?.error ?? "no answer", gscKeys);
  else if (!gsc.last_final || !gsc.d7 || !gsc.pages) fail("Search Console (virev_seo.gsc)", `no final day in the 10 days before ${gsc.today}`, gscKeys);
  else if (daysBetween(gsc.last_final, gsc.today) > GSC_STALE_DAYS) fail("Search Console (virev_seo.gsc)", `the last final day is ${gsc.last_final}, ${daysBetween(gsc.last_final, gsc.today)} days before ${gsc.today}`, gscKeys);
  else {
    const { base, recent } = gsc.pages;
    const dropped = droppedPages(base, recent);
    metrics.dropped_pages = dropped.length;
    flagged.push({ at, kind: "dropped_pages", excerpt: dropped.length
      ? `Pages whose Google impressions a day fell under ${DROP_SHARE * 100}% (${base.start}..${base.end} against ${recent.start}..${recent.end}): ${dropped.map(page => `${page.page} ${page.baseDaily} to ${page.recentDaily}`).join(", ")}.`
      : `No page with ${DROP_MIN_DAILY}+ Google impressions a day over ${base.start}..${base.end} fell under ${DROP_SHARE * 100}% of that over ${recent.start}..${recent.end}.` });
    metrics.google_clicks_d7 = round(gsc.d7.clicks / 7, 1);
    const prior = gsc.d7_prior;
    flagged.push({ at, kind: "google", excerpt: `Google clicks ${gsc.d7.clicks} and impressions ${gsc.d7.impressions} over ${gsc.d7.start}..${gsc.d7.end}, average position ${gsc.d7.position}` +
      (prior ? `; the 7 days before: clicks ${prior.clicks}, impressions ${prior.impressions}` : "") + "." });
  }

  const signups = read.signups;
  if (!signups || isErr(signups)) fail("Sign-ups (Clerk and PostHog first touch, virev_seo.signups)", signups?.error ?? "no answer", ["signups_goal_d28"]);
  else if (signups.attribution !== "ok" || !signups.by_section) fail("Sign-up first touch (PostHog)", `attribution ${signups.attribution}: ${signups.attribution_error ?? ""}`, ["signups_goal_d28"]);
  else {
    const fromGoal = GOAL_SECTIONS.reduce((sum, section) => sum + (signups.by_section![section] ?? 0), 0);
    metrics.signups_goal_d28 = round(fromGoal / 28);
    flagged.push({ at, kind: "signups", excerpt: `Sign-ups in 28 days: ${signups.d28}, ${signups.matched} matched in PostHog, ${fromGoal} with a blog or tool first page. By first page: ${Object.entries(signups.by_section).map(([key, value]) => `${key} ${value}`).join(", ")}.` });
  }
  const ship = read.ship;
  if (!ship || isErr(ship)) fail("Git (auto-sns-agent tip against origin/sieun/dev)", ship?.error ?? "no answer", ["unshipped_blog_changes"]);
  else {
    const late = unshippedBlogChanges(ship.commits, at);
    metrics.unshipped_blog_changes = late.length;
    flagged.push({ at, kind: "unshipped_blog_changes", excerpt: late.length
      ? `${late.length} of ${ship.commits.length} ${BLOG_PATH} commits on ${ship.tipRef} are not on origin/sieun/dev after 24 h: ${late.slice(0, 10).map(commit => `${commit.sha.slice(0, 10)} ${hoursAgo(commit.committedAt, at)} h "${commit.subject.slice(0, 80)}"`).join(", ")}${late.length > 10 ? ", and more" : ""}.`
      : `${ship.commits.length} ${BLOG_PATH} commits on ${ship.tipRef} are not on origin/sieun/dev yet, none older than 24 h.` });
  }
  const copy = read.copy;
  if (!copy || isErr(copy)) fail(`Git (${BLOG_CONTENT} on sieun/dev)`, copy?.error ?? "no answer", ["banned_copy"]);
  else {
    metrics.banned_copy = copy.banned.length;
    flagged.push({ at, kind: "banned_copy", excerpt: copy.banned.length
      ? `${copy.banned.length} of ${copy.pages} ${BLOG_CONTENT} pages on sieun/dev carry copy brief.md rules 4 and 5 ban: ${copy.banned.slice(0, 20).map(page => `${page.path.slice(BLOG_CONTENT.length + 1)} (${page.phrases.join(", ")})`).join(", ")}${copy.banned.length > 20 ? ", and more" : ""}.`
      : `None of ${copy.pages} ${BLOG_CONTENT} pages on sieun/dev carries copy brief.md rules 4 and 5 ban.` });
  }
  return { metrics, flagged };
}

type Git = (args: string[]) => Promise<string>;
const runGit = (repo: string): Git => args => new Promise((resolve, reject) => {
  execFile("git", args, { cwd: repo, encoding: "utf8", timeout: 60_000, maxBuffer: 64 << 20, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } },
    (error, stdout, stderr) => error ? reject(new Error(`git ${args[0]}: ${`${error.message} ${stderr}`.trim().slice(0, 300)}`)) : resolve(stdout));
});

/** Fetches GitHub's sieun/dev, then lists the apps/blog commits on the local sieun/dev tip (`TIP_REF`) that GitHub lacks. */
export async function readShip(git: Git): Promise<ShipRead> {
  await git(["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/sieun/dev:${SHIPPED_REF}`]);
  const log = await git(["log", "--format=%H%x09%ct%x09%s", TIP_REF, `^${SHIPPED_REF}`, "--", BLOG_PATH]);
  const commits = log.split("\n").filter(Boolean).map(line => {
    const [sha, seconds, ...subject] = line.split("\t");
    return { sha: sha!, committedAt: Number(seconds) * 1000, subject: subject.join("\t") };
  });
  return { tipRef: "sieun/dev", commits };
}

/** Reads every Markdown page under BLOG_CONTENT on the sieun/dev tip (`TIP_REF`) and finds its banned copy. Run after readShip's fetch or alone. */
export async function readCopy(git: Git): Promise<CopyRead> {
  const paths = (await git(["ls-tree", "-r", "--name-only", TIP_REF, "--", `${BLOG_CONTENT}/`])).split("\n").filter(path => path.endsWith(".md"));
  const pages = await Promise.all(paths.map(async path => ({ path, text: await git(["show", `${TIP_REF}:${path}`]) })));
  return { pages: pages.length, banned: bannedCopy(pages) };
}

/** Runs the reads in auto-sns-agent's SEO CLI project and parses the one JSON line it prints. */
export function readSources(repo: string): Promise<VisitsRead> {
  return new Promise((resolve, reject) => {
    execFile("uv", ["run", "--project", "scripts/seo", "--frozen", "python", SOURCES_PY, "visits"], { cwd: repo, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) { reject(new Error(`${error.message} ${stderr.trim()}`.trim())); return; }
        try { resolve(JSON.parse(stdout.trim().split("\n").at(-1)!) as VisitsRead); } catch (parseError) { reject(parseError); }
      });
  });
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("seo-search-visits: OUTPUT_FILE is not set\n"); process.exit(2); }
  const why = (error: unknown): string => error instanceof Error ? error.message : String(error);
  const [read, ship, copy] = await Promise.all([
    readSources(REPO).catch((error: unknown): VisitsRead => {
      const failed = { error: `seo-sources.py visits failed: ${why(error)}` };
      return { traffic: failed, gsc: failed, signups: failed };
    }),
    readShip(runGit(REPO)).catch((error: unknown): Err => ({ error: why(error) })),
    readCopy(runGit(REPO)).catch((error: unknown): Err => ({ error: why(error) })),
  ]);
  await writeFile(output, JSON.stringify(visitsOutput({ ...read, ship, copy }, Date.now()), null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
