import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The sieun-pi commit report chat's Main commits report duty precheck (`node --import tsx scripts/duties/sieun-pi-commits.ts`). No model call,
 * reads only. It counts the commits explained on the top-10 report page (the h3 sections under "What each commit changed" in its report.html on
 * disk, served on 5176) and the hours from the newest sieun-pi origin/main commit the page names to the newest commit on origin/main. It runs
 * `git log origin/main` and never fetches, so it writes nothing to the shared checkout.
 */

const REPO = process.env.SIEUN_PI_REPO || join(homedir(), "Documents/Github/sieun-pi");
const REPORT = process.env.COMMITS_REPORT ||
  join(homedir(), "Documents/Github/auto-sns-agent/apps/llm-wiki/content/sessions/2026/10/18/0907-sieun-pi-top10-commits/report.html");
const SECTION = "What each commit changed";

export interface MainCommit { sha: string; at: number; subject: string }

/** The h3 sections between the "What each commit changed" heading and the next h2; 0 when the page has no such heading. */
export function explainedCount(html: string): number {
  const start = html.search(new RegExp(`<h2[^>]*>\\s*${SECTION}\\s*</h2>`));
  if (start < 0) return 0;
  const rest = html.slice(start + 1);
  const end = rest.search(/<h2[\s>]/);
  return (end < 0 ? rest : rest.slice(0, end)).match(/<h3[\s>]/g)?.length ?? 0;
}

/** The newest commit of `log` (newest first) whose hash a `<code>` span of the page names, by prefix of 7 or more hex digits. */
export function newestCovered(html: string, log: readonly MainCommit[]): MainCommit | undefined {
  const named = [...html.matchAll(/<code>([0-9a-f]{7,40})<\/code>/g)].map(match => match[1]!);
  return log.find(commit => named.some(prefix => commit.sha.startsWith(prefix)));
}

export function measure(html: string | undefined, log: readonly MainCommit[] | Error, at: number): PrecheckOutput {
  const metrics: Record<string, number> = { commits_explained: html === undefined ? 0 : explainedCount(html) };
  const flagged: FlaggedSlice[] = [];
  if (html === undefined) flagged.push({ at, kind: "source_error", item: "p1", excerpt: `the report page ${REPORT} is missing or unreadable` });
  if (log instanceof Error) {
    flagged.push({ at, kind: "source_error", item: "p1", excerpt: `git log origin/main in ${REPO} failed: ${log.message}` });
    return { metrics, flagged };
  }
  const tip = log[0];
  const covered = html === undefined ? undefined : newestCovered(html, log);
  if (tip && covered) metrics.report_lag_h = Math.round((tip.at - covered.at) / 36_000) / 100;
  else if (tip) flagged.push({ at, kind: "uncovered", item: "p1", excerpt: "the report names no commit on sieun-pi origin/main, so its freshness is not measured" });
  const behind = covered ? log.findIndex(commit => commit === covered) : -1;
  flagged.push({ at, kind: "summary", item: "p1", excerpt: `${metrics.commits_explained} commits explained on ${REPORT}; newest covered commit ` +
    `${covered ? `${covered.sha.slice(0, 7)} (${new Date(covered.at).toISOString()})` : "none"}; origin/main tip ` +
    `${tip ? `${tip.sha.slice(0, 7)} (${new Date(tip.at).toISOString()}) ${tip.subject}` : "none"}; ${behind >= 0 ? `${behind} commits after the covered one` : "commits after it unknown"}` });
  return { metrics, flagged };
}

function gitLog(repo: string): Promise<MainCommit[]> {
  return new Promise((resolve, reject) => execFile("git", ["-C", repo, "log", "origin/main", "--format=%H%x09%ct%x09%s"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    (error, stdout, stderr) => error ? reject(new Error(String(stderr).trim() || error.message)) : resolve(stdout.split("\n").flatMap(line => {
      const [sha, seconds, subject] = line.split("\t");
      return sha && seconds ? [{ sha, at: Number(seconds) * 1000, subject: subject ?? "" }] : [];
    }))));
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("sieun-pi-commits: OUTPUT_FILE is not set\n"); process.exit(2); }
  const html = await readFile(REPORT, "utf8").catch(() => undefined);
  const log = await gitLog(REPO).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
  await writeFile(output, JSON.stringify(measure(html, log, Date.now()), null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
