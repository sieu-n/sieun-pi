import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The SEO guy's Search visits grow precheck (`node --import tsx scripts/duties/seo-search-visits.ts`): blog and tool visits a day from
 * PostHog, Google clicks a day from Search Console and sign-ups whose first page was blog or tools, against the owner's 10-12 goal of
 * 10,000 blog and tool visits a day and 300 sign-ups a day from them. No model call and no write to the program's metrics file: it runs
 * seo-sources.py in auto-sns-agent's SEO CLI project (scripts/seo), which calls virev_seo.traffic, virev_seo.gsc and virev_seo.signups.
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
 * The duty targets in seo-search-visits.duty.json and where they come from:
 * goal_visits_d28 and goal_visits_d7 >= 10000 are the owner's 10-12 words "our goal is 10,000 blog/tool visits/day".
 * signups_goal_d28 >= 300 is his "300 sign ups from that" with his answer "300 a day" on SEO guy todo t9.
 * google_clicks_d7 >= 20 is the 2026-10-09 milestone of program/brief.md (clicks/day, 7d avg); the brief sets 500 for 11-01.
 * source_errors <= 0: every source is read each day.
 * The 28 and 7 day windows are the ones virev_seo.traffic and virev_seo.gsc report (traffic.collect windows d7 and d28, gsc.windows).
 */
export const GOAL_SECTIONS = ["blog", "tools"] as const;

type Err = { error: string };
interface Window { start: string; end: string; per_day: Record<string, number>; goal_by_source_per_day: Record<string, number> }
export interface TrafficRead { windows: Record<string, Window>; last_day: Record<string, unknown> & { date: string }; sessions_read: number; top_goal_entries_d28?: { path: string; visits: number }[] }
interface Totals { start: string; end: string; clicks: number; impressions: number; position: number | null }
export interface GscRead { today: string; last_final: string | null; d7?: Totals; d7_prior?: Totals }
export interface SignupsRead { clerk_users: number; d28: number; attribution: string; attribution_error?: string; matched?: number; by_section?: Record<string, number> }
export interface VisitsRead { traffic?: TrafficRead | Err; gsc?: GscRead | Err; signups?: SignupsRead | Err }

const isErr = (value: unknown): value is Err => typeof value === "object" && value !== null && "error" in value;
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
const round = (value: number, places = 2): number => Math.round(value * 10 ** places) / 10 ** places;

/** The metrics and flagged slices of one read. `at` is the run time for the slices. */
export function visitsOutput(read: VisitsRead, at: number): PrecheckOutput {
  const flagged: FlaggedSlice[] = [];
  const metrics: Record<string, number> = { goal_visits_d28: -UNMEASURED, goal_visits_d7: -UNMEASURED, google_clicks_d7: -UNMEASURED, signups_goal_d28: -UNMEASURED, source_errors: 0 };
  const fail = (source: string, why: string, keys: string[]): void => {
    metrics.source_errors! += 1;
    flagged.push({ at, kind: "source_error", excerpt: `${source}: ${why}. Not measured this run, so ${keys.join(", ")} read -${UNMEASURED}.` });
  };

  const traffic = read.traffic;
  if (!traffic || isErr(traffic)) fail("PostHog visits (virev_seo.traffic)", traffic?.error ?? "no answer", ["goal_visits_d28", "goal_visits_d7"]);
  else {
    const day = traffic.last_day;
    const seen = ["blog", "tools", "landing", "app", "bot", "internal"].reduce((sum, key) => sum + (Number(day[key]) || 0), 0);
    if (seen === 0) fail("PostHog visits (virev_seo.traffic)", `no session at all on virev.ai on ${day.date}, so PostHog events stopped arriving`, ["goal_visits_d28", "goal_visits_d7"]);
    else {
      const d7 = traffic.windows.d7!, d28 = traffic.windows.d28!;
      metrics.goal_visits_d28 = d28.per_day.goal ?? 0;
      metrics.goal_visits_d7 = d7.per_day.goal ?? 0;
      const sources = Object.entries(d7.goal_by_source_per_day).filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]).map(([key, value]) => `${key} ${value}`);
      flagged.push({ at, kind: "visits", excerpt: `Blog and tool visits a day: ${metrics.goal_visits_d7} over ${d7.start}..${d7.end}, ${metrics.goal_visits_d28} over ${d28.start}..${d28.end}. 7-day sources a day: ${sources.join(", ")}. ${day.date}: ${day.goal} visits.` });
      const top = (traffic.top_goal_entries_d28 ?? []).slice(0, 5).map(entry => `${entry.path} ${entry.visits}`);
      if (top.length) flagged.push({ at, kind: "top_pages", excerpt: `Top blog and tool entry pages, 28 days: ${top.join(", ")}` });
    }
  }

  const gsc = read.gsc;
  if (!gsc || isErr(gsc)) fail("Search Console (virev_seo.gsc)", gsc?.error ?? "no answer", ["google_clicks_d7"]);
  else if (!gsc.last_final || !gsc.d7) fail("Search Console (virev_seo.gsc)", `no final day in the 10 days before ${gsc.today}`, ["google_clicks_d7"]);
  else if (daysBetween(gsc.last_final, gsc.today) > GSC_STALE_DAYS) fail("Search Console (virev_seo.gsc)", `the last final day is ${gsc.last_final}, ${daysBetween(gsc.last_final, gsc.today)} days before ${gsc.today}`, ["google_clicks_d7"]);
  else {
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
  return { metrics, flagged };
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
  const read = await readSources(REPO).catch((error: unknown): VisitsRead => {
    const failed = { error: `seo-sources.py visits failed: ${error instanceof Error ? error.message : String(error)}` };
    return { traffic: failed, gsc: failed, signups: failed };
  });
  await writeFile(output, JSON.stringify(visitsOutput(read, Date.now()), null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
