import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CountedRepeat } from "../../src/chat-corrections.ts";

/**
 * Splits the repeats repeat_corrections_7d counts by when the correction's current fix landed. On 10-20 the headline read 21 through five d10
 * runs, and 19 of the 21 came before the fix their entry names now landed (c79's 10-19 05:32Z "NONONO" before 95af01d5 at 22:40Z, c18's two
 * 10-19 lines before 06aa1dfb at 22:42Z), so the count could only fall as those lines aged out of the 7 days. `after_fix` lines are the ones
 * where a fix was in place and the owner still had to say it again; `no_fix` lines have an entry whose ref names nothing that landed.
 */
export const REPEAT_SIDES = ["before_fix", "after_fix", "no_fix"] as const;
export type RepeatSide = (typeof REPEAT_SIDES)[number];
export interface SplitRepeat extends CountedRepeat { side: RepeatSide; /** When the newest fix the entry's ref names landed, in ms. */ fixed?: number }

/** A commit hash in a ref: 7 to 40 hex characters with at least one digit and one letter, so a word or a plain number is no hash. */
const HASH = /(?<![\w./-])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![\w])/g;
/** A chat message id: the send time in ms, base 36, such as mvfilflf for 10-19 17:14:48Z. */
const MESSAGE = /(?<![\w./-])m[0-9a-z]{7}(?![\w])/g;

/**
 * What a ref names that landed: commit hashes, and chat message ids sent after the correction was given and by `now`. A message id from before
 * the correction is the owner's own message, as c118's ref mvex7ik9 is his 07:16:06Z words, so it is no fix.
 */
export function fixMarks(ref: string, given: number, now: number): { commits: string[]; messages: number[] } {
  const commits = [...new Set(ref.match(HASH) ?? [])];
  const messages = (ref.match(MESSAGE) ?? []).map(id => parseInt(id, 36)).filter(at => at >= given && at <= now);
  return { commits, messages };
}

/** When the newest fix a ref names landed: the latest commit time (`commitTime`, undefined for a commit no repo knows) or message id time. */
export async function fixLanded(ref: string, given: number, now: number, commitTime: (hash: string) => Promise<number | undefined>): Promise<number | undefined> {
  const { commits, messages } = fixMarks(ref, given, now);
  const times = [...messages, ...(await Promise.all(commits.map(commitTime))).filter((at): at is number => at !== undefined)];
  return times.length ? Math.max(...times) : undefined;
}

/**
 * When the first fix a ref names landed: the earliest commit or message id time at or after the correction (`given`), for the chase rule in
 * repeatsBetween; undefined while none has. A commit from before the correction was no fix for it.
 */
export async function firstFixLanded(ref: string, given: number, now: number, commitTime: (hash: string) => Promise<number | undefined>): Promise<number | undefined> {
  const { commits, messages } = fixMarks(ref, given, now);
  const times = [...messages, ...(await Promise.all(commits.map(commitTime))).filter((at): at is number => at !== undefined && at >= given && at <= now)];
  return times.length ? Math.min(...times) : undefined;
}

/** A repeat the owner wrote after the fix landed is `after_fix`; at or before it, `before_fix`; with no landed fix, `no_fix`. */
export const repeatSide = (said: number, fixed: number | undefined): RepeatSide => fixed === undefined ? "no_fix" : said > fixed ? "after_fix" : "before_fix";

export async function splitRepeats(repeats: readonly CountedRepeat[], now: number, commitTime: (hash: string) => Promise<number | undefined>): Promise<SplitRepeat[]> {
  return Promise.all(repeats.map(async repeat => {
    const fixed = await fixLanded(repeat.entry.ref, Date.parse(repeat.entry.at), now, commitTime);
    return { ...repeat, side: repeatSide(repeat.said, fixed), ...(fixed === undefined ? {} : { fixed }) };
  }));
}

/** The split as d10 metrics, every side present: repeats_before_fix_7d, repeats_after_fix_7d and repeats_no_fix_7d. */
export function splitMetrics(split: readonly SplitRepeat[]): Record<`repeats_${RepeatSide}_7d`, number> {
  const count = (side: RepeatSide) => split.filter(repeat => repeat.side === side).length;
  return { repeats_before_fix_7d: count("before_fix"), repeats_after_fix_7d: count("after_fix"), repeats_no_fix_7d: count("no_fix") };
}

/**
 * `lastEventAt` for repeat_corrections_7d and its split: the time of the newest change to a counted line's state. A before_fix line changed last
 * when its fix landed (`fixed`), so a headline of only such lines reads quiet once a run has passed since the newest fix and starts no job, while
 * its lines age out of the 7 days. On 10-20 d10 missed 8 runs in a row on 21 before_fix lines and two fix jobs (p770, p793) could not move it.
 * An after_fix or no_fix line is open: the owner said it again after any fix, and it needs work until a new fix lands and turns it before_fix.
 * Its `said` would read quiet a run later with the work still undone, so an open line dates its count `now` and keeps it live. An empty count
 * has no event and no `lastEventAt`.
 */
export function splitLastEvents(split: readonly SplitRepeat[], now: number): Partial<Record<"repeat_corrections_7d" | `repeats_${RepeatSide}_7d`, number>> {
  const fixes = split.filter(repeat => repeat.side === "before_fix").map(repeat => repeat.fixed!);
  const open = split.some(repeat => repeat.side !== "before_fix");
  const events: Partial<Record<"repeat_corrections_7d" | `repeats_${RepeatSide}_7d`, number>> = {};
  if (fixes.length) events.repeats_before_fix_7d = Math.max(...fixes);
  for (const side of ["after_fix", "no_fix"] as const) if (split.some(repeat => repeat.side === side)) events[`repeats_${side}_7d`] = now;
  if (open) events.repeat_corrections_7d = now;
  else if (fixes.length) events.repeat_corrections_7d = Math.max(...fixes);
  return events;
}

/** The line's lead in the flagged excerpt, such as "after fix of 10-19 07:16Z". */
export function sideLabel(repeat: SplitRepeat): string {
  const fixed = repeat.fixed === undefined ? "" : ` of ${new Date(repeat.fixed).toISOString().slice(5, 16).replace("T", " ")}Z`;
  return repeat.side === "no_fix" ? "no landed fix" : `${repeat.side === "after_fix" ? "after" : "before"} fix${fixed}`;
}

/** The checkouts a ref's commits live in: sieun-pi on the box and on the Mac, and auto-sns-agent. */
export const fixRepos = (autoSns: string): string[] =>
  [process.env.SIEUN_PI_REPO, join(homedir(), "src/sieun-pi"), join(homedir(), "Documents/Github/sieun-pi"), autoSns].filter((dir): dir is string => !!dir && existsSync(join(dir, ".git")));

/** A commit's committer time in the first repo that has it, once per hash. */
export function gitCommitTime(repos: readonly string[]): (hash: string) => Promise<number | undefined> {
  const known = new Map<string, Promise<number | undefined>>();
  const show = (repo: string, hash: string) => new Promise<number | undefined>(resolve => execFile("git", ["-C", repo, "show", "-s", "--format=%ct", `${hash}^{commit}`],
    (error, stdout) => { const seconds = Number(stdout.trim()); resolve(!error && seconds > 0 ? seconds * 1000 : undefined); }));
  return hash => {
    if (!known.has(hash)) known.set(hash, (async () => { for (const repo of repos) { const at = await show(repo, hash); if (at !== undefined) return at; } return undefined; })());
    return known.get(hash)!;
  };
}

/** `node --import tsx scripts/duties/repeat-split.ts`: the counted repeats of the last 7 days, one line each with its side, from this box's ledger. */
async function main(): Promise<void> {
  const { CorrectionLedger, repeatsBetween } = await import("../../src/chat-corrections.ts");
  const { chatHistories, macSessionLines, REPEAT_DAYS, AUTO_SNS } = await import("./harness-health.ts");
  const now = process.env.NOW ? Date.parse(process.env.NOW) : Date.now();
  const errors: string[] = [];
  const history = chatHistories(join(homedir(), ".prime/agent/sessions"), process.platform === "darwin" ? null : macSessionLines, errors);
  const ledger = await new CorrectionLedger(process.env.HARNESS_DATA_DIR || join(homedir(), ".prime/agent/browser-chat")).read();
  const commitTime = gitCommitTime(fixRepos(AUTO_SNS));
  const split = await splitRepeats(await repeatsBetween(ledger, now - REPEAT_DAYS * 86_400_000, now, history,
    entry => firstFixLanded(entry.ref, Date.parse(entry.at), now, commitTime)), now, commitTime);
  for (const repeat of split) {
    process.stdout.write(`${new Date(repeat.said).toISOString().slice(0, 16)}Z ${repeat.entry.id} ${sideLabel(repeat)} in ${repeat.repeat.chat.name || repeat.repeat.chat.id}: ${repeat.repeat.words.replace(/\s+/g, " ").slice(0, 120)}\n`);
  }
  process.stdout.write(`${JSON.stringify({ repeat_corrections_7d: split.length, ...splitMetrics(split) })}\n`);
  for (const error of errors) process.stderr.write(`no data: ${error}\n`);
}

// Not a top-level await: main imports harness-health.ts, which imports this module, and that import would wait on this one's evaluation.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error: unknown) => { process.stderr.write(`${String(error)}\n`); process.exit(1); });
