import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The Twitch gaps chat's Twitch gap tracking duty's precheck (twitch-gaps.duty.json). No model call. It runs the gap scripts
 * `node scripts/twitch-gaps/run.mjs --out <file>` in the auto-sns-agent checkout, keeps their JSON as twitch-gaps.latest.json in the chat's
 * duty folder (the folder of OUTPUT_FILE) for the duty job, and reads two wiki pages the way the owner would open them:
 * the top 10 page (twitch-index-gaps), which shows its run time in `<time data-measured datetime>` and one `<tr data-gap>` row per gap with
 * its number in a `data-size` cell, and the risk page (twitch-risks), which has one `<tr data-risk>` row per standing risk.
 * A risk id with no check in RISK_CHECKS counts as firing, so a new risk row needs its check here in the same change.
 * When the scripts are missing or give no JSON, every gap counts as failed and every risk as firing, because an unread check is no pass.
 *
 *   OUTPUT_FILE=<file> node --import tsx scripts/duties/twitch-gaps.ts
 */

const REPO = process.env.AUTO_SNS_REPO || join(homedir(), "Documents/Github/auto-sns-agent");
const ENTRY = "scripts/twitch-gaps/run.mjs";
const TOP_PAGE = "apps/llm-wiki/content/domains/platform-apis/twitch-index-gaps/index.html";
const RISK_PAGE = "apps/llm-wiki/content/domains/platform-apis/twitch-risks/index.html";
/** The owner's top 10: the page lists the 10 biggest Twitch index gaps. */
export const GAP_COUNT = 10;
/** The owner asked to keep the page fresh every day, so a page measured over 24 h ago counts no gap. */
export const FRESH_MS = 24 * 60 * 60_000;

export interface Reads { requests: number; status429: number; zero: number }
export interface GapRun { key: string; size: number | null; unit: string; ok: boolean; error: string | null; reads: Reads }
export interface Run { measuredAt: string; gaps: GapRun[]; reads: Reads }

/** Each risk row id on the risk page and the reason it fires on a run, or null when it does not. */
export const RISK_CHECKS: Record<string, (run: Run) => string | null> = {
  "twitch-rate-limit": run => run.reads.status429 > 0
    ? `${run.reads.status429} of ${run.reads.requests} Twitch reads got HTTP 429 (${perGap(run, "status429")})` : null,
  "twitch-zero-read": run => run.reads.zero > 0
    ? `${run.reads.zero} of ${run.reads.requests} Twitch reads answered 200 with nothing usable (${perGap(run, "zero")})` : null,
};

function perGap(run: Run, field: "status429" | "zero"): string {
  return run.gaps.filter(gap => gap.reads[field] > 0).map(gap => `${gap.key} ${gap.reads[field]}`).join(", ");
}

export interface TopPage { measuredAt: number | null; rows: { key: string; size: number | null }[] }

export function parseTopPage(html: string): TopPage {
  const time = /<time\b[^>]*\bdata-measured\b[^>]*>/.exec(html)?.[0];
  const datetime = time ? /\bdatetime="([^"]+)"/.exec(time)?.[1] : undefined;
  const parsed = datetime ? Date.parse(datetime) : NaN;
  const rows = [...html.matchAll(/<tr\b[^>]*\bdata-gap="([^"]+)"[^>]*>([\s\S]*?)<\/tr>/g)].map(([, key, body]) => {
    const cell = /<td\b[^>]*\bdata-size\b[^>]*>([\s\S]*?)<\/td>/.exec(body!)?.[1]?.replace(/<[^>]+>/g, "").replace(/[,\s]/g, "") ?? "";
    return { key: key!, size: cell !== "" && Number.isFinite(Number(cell)) ? Number(cell) : null };
  });
  return { measuredAt: Number.isNaN(parsed) ? null : parsed, rows };
}

export function riskIds(html: string): string[] {
  return [...html.matchAll(/<tr\b[^>]*\bdata-risk="([^"]+)"/g)].map(match => match[1]!);
}

export interface Inputs { now: number; run: Run | null; runProblem: string | null; topPage: string | null; riskPage: string | null }

export function measure({ now, run, runProblem, topPage, riskPage }: Inputs): PrecheckOutput {
  const flagged: FlaggedSlice[] = [];
  let pageGaps = 0;
  if (topPage === null) flagged.push({ at: now, kind: "page", excerpt: `the top 10 page ${TOP_PAGE} does not exist yet` });
  else {
    const page = parseTopPage(topPage);
    const measured = page.rows.filter(row => row.size !== null);
    if (page.measuredAt === null) flagged.push({ at: now, kind: "page", excerpt: `${TOP_PAGE} has no <time data-measured datetime> run time` });
    else if (now - page.measuredAt > FRESH_MS) {
      flagged.push({ at: now, kind: "page", excerpt: `${TOP_PAGE} was measured ${new Date(page.measuredAt).toISOString()}, ${Math.floor((now - page.measuredAt) / 3_600_000)} h ago` });
    } else pageGaps = measured.length;
    const blank = page.rows.filter(row => row.size === null).map(row => row.key);
    if (blank.length) flagged.push({ at: now, kind: "page", excerpt: `gap rows on the page with no number: ${blank.join(", ")}` });
    if (page.rows.length !== GAP_COUNT) flagged.push({ at: now, kind: "page", excerpt: `the page has ${page.rows.length} gap rows, not ${GAP_COUNT}` });
  }

  let failedGaps = GAP_COUNT;
  if (!run) flagged.push({ at: now, kind: "run", excerpt: `the gap scripts gave no run: ${runProblem ?? "unknown"}` });
  else {
    const ok = run.gaps.filter(gap => gap.ok && typeof gap.size === "number");
    failedGaps = Math.max(0, GAP_COUNT - ok.length);
    for (const gap of run.gaps.filter(gap => !ok.includes(gap))) flagged.push({ at: now, kind: "gap", excerpt: `${gap.key} failed: ${gap.error ?? "no size"}` });
    if (run.gaps.length < GAP_COUNT) flagged.push({ at: now, kind: "run", excerpt: `the run measured ${run.gaps.length} gaps, not ${GAP_COUNT}` });
    if (runProblem) flagged.push({ at: now, kind: "run", excerpt: runProblem });
  }

  let risksFiring = 0;
  if (riskPage === null) {
    risksFiring = 1;
    flagged.push({ at: now, kind: "risk", excerpt: `the risk page ${RISK_PAGE} does not exist, so no risk was checked` });
  } else {
    const ids = riskIds(riskPage);
    if (!ids.length) { risksFiring = 1; flagged.push({ at: now, kind: "risk", excerpt: `${RISK_PAGE} has no <tr data-risk> row` }); }
    for (const id of ids) {
      const check = RISK_CHECKS[id];
      const reason = !check ? "it has no check in scripts/duties/twitch-gaps.ts RISK_CHECKS" : !run ? "the gap scripts gave no run to check it on" : check(run);
      if (reason) { risksFiring += 1; flagged.push({ at: now, kind: "risk", item: id, excerpt: `${id} fires: ${reason}` }); }
    }
  }
  if (run) flagged.push({ at: now, kind: "summary", excerpt: `run ${run.measuredAt}: ${run.gaps.length} gaps, ${run.reads.requests} Twitch reads, ` +
    `${run.reads.status429} got 429, ${run.reads.zero} read 0; ` + run.gaps.map(gap => `${gap.key} ${gap.size ?? "failed"}${gap.unit ? ` ${gap.unit}` : ""}`).join(", ") });
  return { metrics: { page_gaps_fresh: pageGaps, failed_gaps: failedGaps, risks_firing: risksFiring }, flagged };
}

function parseRun(text: string): Run {
  const run = JSON.parse(text) as Run;
  if (typeof run.measuredAt !== "string" || !Array.isArray(run.gaps) || typeof run.reads?.requests !== "number") throw new Error("the JSON has no measuredAt, gaps or reads");
  return run;
}

/** Runs the gap scripts into a temp file and moves it over twitch-gaps.latest.json only when it parses, so a crash keeps the last good run. */
async function runGaps(dir: string): Promise<{ run: Run | null; problem: string | null }> {
  if (!existsSync(join(REPO, ENTRY))) return { run: null, problem: `${ENTRY} is not in ${REPO} yet` };
  const temp = join(dir, "twitch-gaps.run.json");
  const latest = join(dir, "twitch-gaps.latest.json");
  rmSync(temp, { force: true });
  const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>(resolve => {
    const child = spawn(process.execPath, [ENTRY, "--out", temp], { cwd: REPO, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", chunk => { err = (err + String(chunk)).slice(-2000); });
    child.on("close", exit => resolve({ code: exit, stderr: err }));
    child.on("error", error => resolve({ code: null, stderr: String(error) }));
  });
  const tail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
  try {
    const run = parseRun(readFileSync(temp, "utf8"));
    renameSync(temp, latest);
    return { run, problem: code === 0 || code === 1 ? null : `${ENTRY} exited ${code}${tail ? `: ${tail}` : ""}` };
  } catch (error) {
    return { run: null, problem: `${ENTRY} exited ${code} with no usable JSON (${error instanceof Error ? error.message : String(error)})${tail ? `: ${tail}` : ""}` };
  }
}

async function main(): Promise<void> {
  const out = process.env.OUTPUT_FILE;
  if (!out) { process.stderr.write("twitch-gaps: OUTPUT_FILE is not set\n"); process.exit(2); }
  const { run, problem } = await runGaps(dirname(out));
  const read = (path: string) => existsSync(join(REPO, path)) ? readFileSync(join(REPO, path), "utf8") : null;
  const output = measure({ now: Date.now(), run, runProblem: problem, topPage: read(TOP_PAGE), riskPage: read(RISK_PAGE) });
  await writeFile(out, JSON.stringify(output, null, 1) + "\n");
  process.stdout.write(`${JSON.stringify(output.metrics)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
