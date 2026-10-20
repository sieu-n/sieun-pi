import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The Listings import speed duty's precheck (`node --import tsx scripts/duties/listings-import-speed.ts`). No model call, nothing sent outside.
 * The owner (10-20): "i need at least 20x more rows a minute, get it there and keep the rows/min on the board". The baseline is the old import,
 * commit fb843e4, at 91,344 rows/min on 10-20.
 * One absolute reading flaps with the box's load: at 02:00Z on 10-20, at load average 200 to 250, the current import read 1.38M to 3.98M rows/min
 * and the old one 72,568. So each run times the old import and the repo's HEAD back to back on the same box, as new, old, new, and judges the
 * ratio. The headline `rows_per_min` is that ratio times the 91,344 baseline: the current import's rows a minute at the baseline's load, so its
 * target of 20 x 91,344 = 1,826,880 is the owner's 20x. The raw rates stay in the output as `rows_per_min_now`, `old_rows_per_min` and
 * `speedup_x`, which are not declared.
 * Each timed run is `python3 importer/run.py --fresh --seconds 60` in a `git archive` export of importer/ and config/ under
 * ~/scratch/listings-import-speed/, with data/listings.jsonl linked from the repo, so it never touches the repo's out/listings.db. The folder is
 * removed at the end. The newest "done:" line in the repo's out/rate.log that loaded more than 0 rows goes in a flagged item for the duty job.
 * A run that fails or prints no "N rows in T s" leaves the headline out with a source_error item, so the run says not measured.
 */

const run = promisify(execFile);
const REPO = process.env.LISTINGS_REPO || join(homedir(), "work/listings-import-r2-6a3fe60");
const SCRATCH = join(homedir(), "scratch/listings-import-speed");
export const OLD = "fb843e4";
export const BASELINE_ROWS_PER_MIN = 91_344;
const SECONDS = "60";

/** Rows a minute from run.py's summary line, "600000 rows in 7.2 s, 5010313 rows/min", or null when it has none. */
export function parseSummary(text: string): number | null {
  const match = /(\d+) rows in ([\d.]+) s/.exec(text);
  if (!match) return null;
  const rows = Number(match[1]);
  const seconds = Number(match[2]);
  return rows > 0 && seconds > 0 ? rows * 60 / seconds : null;
}

/** The newest "done:" line in rate.log that loaded more than 0 rows. */
export function newestDone(log: string): string | undefined {
  return log.split("\n").filter(line => / done: [1-9]\d* rows/.test(line)).at(-1);
}

async function timeRun(base: string, ref: string, label: string): Promise<number> {
  const dir = join(base, label);
  await mkdir(join(dir, "out"), { recursive: true });
  await mkdir(join(dir, "data"));
  await symlink(join(REPO, "data/listings.jsonl"), join(dir, "data/listings.jsonl"));
  await run("sh", ["-c", `git -C "$0" archive "$1" -- importer config | tar -x -C "$2"`, REPO, ref, dir]);
  const { stdout } = await run("python3", ["importer/run.py", "--fresh", "--seconds", SECONDS], { cwd: dir, timeout: 300_000 });
  const rate = parseSummary(stdout);
  if (rate === null) throw new Error(`${label} (${ref}) printed no rows summary: ${stdout.trim().slice(0, 200)}`);
  return rate;
}

async function main(): Promise<void> {
  const flagged: FlaggedSlice[] = [];
  const metrics: Record<string, number> = {};
  await mkdir(SCRATCH, { recursive: true });
  const base = await mkdtemp(join(SCRATCH, "run-"));
  try {
    const head = (await run("git", ["-C", REPO, "rev-parse", "--short", "HEAD"])).stdout.trim();
    const before = await timeRun(base, head, "new-1");
    const old = await timeRun(base, OLD, "old");
    const after = await timeRun(base, head, "new-2");
    const now = (before + after) / 2;
    const speedup = now / old;
    Object.assign(metrics, {
      rows_per_min: Math.round(speedup * BASELINE_ROWS_PER_MIN),
      rows_per_min_now: Math.round(now),
      old_rows_per_min: Math.round(old),
      speedup_x: Math.round(speedup * 100) / 100,
    });
    const load = (await readFile("/proc/loadavg", "utf8")).split(" ")[0];
    flagged.push({ at: Date.now(), kind: "timing", excerpt: `HEAD ${head} ${Math.round(before)} and ${Math.round(after)} rows/min around old ${OLD} ${Math.round(old)} rows/min, ${speedup.toFixed(1)}x, load ${load}` });
  } catch (error) {
    flagged.push({ at: Date.now(), kind: "source_error", excerpt: `timed run failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400) });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
  const done = newestDone(await readFile(join(REPO, "out/rate.log"), "utf8").catch(() => ""));
  if (done) flagged.push({ kind: "last_real_run", excerpt: `newest real run in out/rate.log: ${done}` });
  const output: PrecheckOutput = { metrics, flagged };
  const text = JSON.stringify(output, null, 2);
  if (process.env.OUTPUT_FILE) await writeFile(process.env.OUTPUT_FILE, text);
  else process.stdout.write(`${text}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
