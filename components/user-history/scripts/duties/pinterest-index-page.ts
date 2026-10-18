import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { readWikiPage } from "../../src/chat-wiki.ts";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The Pinterest index duty's precheck (pinterest-index-page.duty.json), the daily refresh of the top 10 page and its check, with no model call:
 * 1. it runs auto-sns-agent's `python -m pinterest_index_gaps --page <page>` in apps/crawler-v3/scripts, which reruns the measure of each
 *    ranked row (<tr data-gap>) read-only on prod and patches the row's size cell and <time datetime> on the live page;
 * 2. it then reads the page the way the owner opens it (`readWikiPage`) and reads the measure times from the page's own rows.
 * page_age_hours, the headline, is the hours since the oldest measure time of a ranked row, so one stale number shows. A missing page, a page
 * with no ranked rows or a row with no time reads UNMEASURED. gaps_fresh counts ranked rows with a number measured in the last FRESH_H hours.
 * refresh_errors counts the gaps whose measure failed today, plus 1 when the refresh did not run.
 *
 *   OUTPUT_FILE=<file> node --import tsx scripts/duties/pinterest-index-page.ts [--page <wiki page>] [--no-refresh]
 */
const REPO = process.env.LLM_WIKI_REPO || join(homedir(), "Documents/Github/auto-sns-agent");
const SCRIPTS = join(REPO, "apps/crawler-v3/scripts");
/** The miss value of a metric whose source failed, the convention of auto-sns-agent scripts/duties/ci/duty-sources.mjs (UNMEASURED). */
const UNMEASURED = 999_999;
/** The owner's "Keep the page fresh every day": a number older than a day is stale. */
const FRESH_H = 24;
const ROW = /<tr\b[^>]*\bdata-gap="([^"]+)"[^>]*>([\s\S]*?)<\/tr>/g;
const SIZE = /<td\b[^>]*\bdata-cell="size"[^>]*>([\s\S]*?)<\/td>/;
const TIME = /<time\b[^>]*\bdatetime="([^"]+)"/;

const args = process.argv.slice(2);
const page = args.includes("--page") ? args[args.indexOf("--page") + 1]! : "projects/pinterest-index-gaps/index.html";
const out = process.env.OUTPUT_FILE;
if (!out) { process.stderr.write("OUTPUT_FILE is not set\n"); process.exit(2); }

const flagged: FlaggedSlice[] = [];
let refreshErrors = 0;
if (!args.includes("--no-refresh")) {
  try {
    const { stdout } = await promisify(execFile)("uv", ["run", "--no-project", "--with", "requests", "--with", "python-dotenv", "python", "-m",
      "pinterest_index_gaps", "--page", page], { cwd: SCRIPTS });
    const summary = JSON.parse(stdout.trim().split("\n").at(-1)!) as { errors: Record<string, string> };
    for (const [gap, error] of Object.entries(summary.errors)) {
      refreshErrors++;
      flagged.push({ kind: "source_error", excerpt: `${gap}: ${error}`.slice(0, 400), item: gap });
    }
  } catch (error) {
    refreshErrors++;
    const text = error instanceof Error ? `${error.message} ${(error as { stderr?: string }).stderr ?? ""}` : String(error);
    flagged.push({ kind: "refresh_failed", excerpt: `python -m pinterest_index_gaps in ${SCRIPTS} failed: ${text.trim().slice(-400)}` });
  }
}

const now = Date.now();
let ages: number[] = [];
try {
  const view = await readWikiPage(page);
  const html = view.kind === "html" ? view.html : view.text;
  for (const [, gap, row] of html.matchAll(ROW)) {
    const at = Date.parse(TIME.exec(row!)?.[1] ?? "");
    const size = SIZE.exec(row!)?.[1]?.replace(/<[^>]+>/g, "") ?? "";
    const age = Number.isNaN(at) || !/\d/.test(size) ? UNMEASURED : (now - at) / 3_600_000;
    ages.push(age);
    if (age > FRESH_H) {
      flagged.push({ kind: "stale_gap", item: gap, excerpt: age === UNMEASURED ? `${gap} has no measured size or time on ${view.url}`
        : `${gap} was last measured ${new Date(at).toISOString()}, ${age.toFixed(1)} h ago, on ${view.url}` });
    }
  }
  if (!ages.length) flagged.push({ kind: "no_rows", excerpt: `${view.url} has no ranked row marked <tr data-gap>` });
} catch (error) {
  ages = [];
  flagged.push({ kind: "page_missing", excerpt: `${page}: ${error instanceof Error ? error.message : String(error)}` });
}

const metrics = {
  page_age_hours: ages.length ? Math.round(Math.max(...ages) * 10) / 10 : UNMEASURED,
  gaps_fresh: ages.filter(age => age <= FRESH_H).length,
  refresh_errors: refreshErrors,
};
writeFileSync(out, JSON.stringify({ metrics, flagged } satisfies PrecheckOutput, null, 1));
process.stdout.write(`${JSON.stringify(metrics)}\n`);
