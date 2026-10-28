import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fixRefs, type CountedRepeat } from "../../src/chat-corrections.ts";

/**
 * Splits the repeats repeat_corrections_7d counts by when the correction's current fix landed. On 10-20 the headline read 21 through five d10
 * runs, and 19 of the 21 came before the fix their entry names now landed (c79's 10-19 05:32Z "NONONO" before 95af01d5 at 22:40Z, c18's two
 * 10-19 lines before 06aa1dfb at 22:42Z), so the count could only fall as those lines aged out of the 7 days. `after_fix` lines are the ones
 * where a fix was in place and the owner still had to say it again; `no_fix` lines have an entry whose ref names nothing that landed.
 */
export const REPEAT_SIDES = ["before_fix", "after_fix", "no_fix"] as const;
export type RepeatSide = (typeof REPEAT_SIDES)[number];
export interface SplitRepeat extends CountedRepeat {
  side: RepeatSide;
  /** For an after_fix line, when the newest fix in place as the owner said it landed (the fix that failed); otherwise the newest fix any ref names, in ms. */
  fixed?: number;
  /** When the first fix at or after the owner said it landed: when a before_fix line turned before_fix, or an after_fix line was fixed again (`splitLastEvents`). */
  flipped?: number;
}

/** A commit hash in a ref: 7 to 40 hex characters with at least one digit and one letter, so a word or a plain number is no hash. */
const HASH = /(?<![\w./-])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![\w])/g;
/** A chat message id: the send time in ms, base 36, such as mvfilflf for 10-19 17:14:48Z. */
const MESSAGE = /(?<![\w./-])m[0-9a-z]{7}(?![\w])/g;
/**
 * The words before a commit that a test fails on, the old tip a fix was proved against and no fix: c157's ref says its test "fails on fc7490a1",
 * a pi-pool commit of 10-27, and c78's says shared-ui.test.ts "fails at 8883b9521a", a feature commit that landed before the owner's 10-27 repeat.
 */
const OLD_TIP = /\bfail(?:s|ed)? (?:on|at) $/;
/** A /refine id: its UTC time to the ms, such as refine_20261022063009003 for 10-22 06:30:09.003Z. */
const REFINE = /(?<![\w./-])refine_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})(?!\d)/g;

/**
 * What a ref names that landed: commit hashes, and chat message ids and /refine ids from after the correction was given and by `now`. A message
 * id from before the correction is the owner's own message, as c118's ref mvex7ik9 is his 07:16:06Z words, so it is no fix. A refine id is the
 * fix itself: on 10-22 c104's ref named refine_20261022063009003 alone, and d10 read its 06:29:54Z repeat as having no landed fix.
 */
export function fixMarks(ref: string, given: number, now: number): { commits: string[]; messages: number[]; refines: number[] } {
  const inWindow = (at: number) => at >= given && at <= now;
  const commits = [...new Set([...ref.matchAll(HASH)].filter(match => !OLD_TIP.test(ref.slice(0, match.index))).map(([hash]) => hash))];
  const messages = (ref.match(MESSAGE) ?? []).map(id => parseInt(id, 36)).filter(inWindow);
  const refines = [...ref.matchAll(REFINE)].map(([, y, mo, d, h, mi, s, ms]) => Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!, +ms!)).filter(inWindow);
  return { commits, messages, refines };
}

/** When each fix a ref names landed: its message and refine id times and its commit times (`commitTime`, undefined for a commit no repo knows). */
async function fixTimes(ref: string, given: number, now: number, commitTime: (hash: string) => Promise<number | undefined>): Promise<number[]> {
  const { commits, messages, refines } = fixMarks(ref, given, now);
  return [...messages, ...refines, ...(await Promise.all(commits.map(commitTime))).filter((at): at is number => at !== undefined)];
}

/** When the newest fix a ref names landed: the latest message or refine id time or commit time. */
export async function fixLanded(ref: string, given: number, now: number, commitTime: (hash: string) => Promise<number | undefined>): Promise<number | undefined> {
  const times = await fixTimes(ref, given, now, commitTime);
  return times.length ? Math.max(...times) : undefined;
}

/**
 * When the first fix a ref names landed: the earliest commit or message id time at or after the correction (`given`), for the chase rule in
 * repeatsBetween; undefined while none has. A commit from before the correction was no fix for it.
 */
export async function firstFixLanded(ref: string, given: number, now: number, commitTime: (hash: string) => Promise<number | undefined>): Promise<number | undefined> {
  const { commits, messages, refines } = fixMarks(ref, given, now);
  const times = [...messages, ...refines, ...(await Promise.all(commits.map(commitTime))).filter((at): at is number => at !== undefined && at >= given && at <= now)];
  return times.length ? Math.min(...times) : undefined;
}

/** A repeat the owner wrote after the fix landed is `after_fix`; at or before it, `before_fix`; with no landed fix, `no_fix`. */
export const repeatSide = (said: number, fixed: number | undefined): RepeatSide => fixed === undefined ? "no_fix" : said > fixed ? "after_fix" : "before_fix";

/**
 * Each repeat's side against the fixes in place when the owner said it: any fix that landed after the correction and before his words makes it
 * after_fix, however many fixes landed since. Judged against the newest fix alone, every repeat read before_fix once the next fix landed, and
 * d10's onMiss skips before_fix lines as needing no work. At 17:53Z on 10-28 the split read 14 before_fix and 0 after_fix, while 9 of those 14
 * came after a fix that had landed, such as c117's 10-27 18:43Z line after seven tell_owner checks and c78's three 10-27 lines after
 * 0e90bb1421; p1240 then only waited for them to age out.
 */
export async function splitRepeats(repeats: readonly CountedRepeat[], now: number, commitTime: (hash: string) => Promise<number | undefined>): Promise<SplitRepeat[]> {
  return Promise.all(repeats.map(async repeat => {
    const given = Date.parse(repeat.entry.at);
    const times = await fixTimes(fixRefs(repeat.entry), given, now, commitTime);
    const held = times.filter(time => time >= given && time < repeat.said);
    const later = times.filter(time => time >= repeat.said);
    const side: RepeatSide = held.length ? "after_fix" : later.length ? "before_fix" : "no_fix";
    const fixed = held.length ? Math.max(...held) : times.length ? Math.max(...times) : undefined;
    const flipped = later.length ? Math.min(...later) : undefined;
    return { ...repeat, side, ...(fixed === undefined ? {} : { fixed }), ...(flipped === undefined ? {} : { flipped }) };
  }));
}

/** The split as d10 metrics, every side present: repeats_before_fix_7d, repeats_after_fix_7d and repeats_no_fix_7d. */
export function splitMetrics(split: readonly SplitRepeat[]): Record<`repeats_${RepeatSide}_7d`, number> {
  const count = (side: RepeatSide) => split.filter(repeat => repeat.side === side).length;
  return { repeats_before_fix_7d: count("before_fix"), repeats_after_fix_7d: count("after_fix"), repeats_no_fix_7d: count("no_fix") };
}

/**
 * `lastEventAt` for repeat_corrections_7d and its split: the time of the newest change to a counted line's state. A before_fix line changed last
 * when the first fix after the owner said it landed (`flipped`), so a headline of only such lines reads quiet once a run has passed since the
 * newest such flip and starts no job, while its lines age out of the 7 days. On 10-20 d10 missed 8 runs in a row on 21 before_fix lines and two
 * fix jobs (p770, p793) could not move it. A later commit the ref gains is no change to the line: d10's 02:44Z run on 10-28 read 13 before_fix
 * lines dated 01:48Z by db3b622, a wake note touch-up c117's ref gained after 18b73ec8 had flipped its 18:43Z repeat at 22:45Z, and was told to
 * "change approach" for the 118th run in a row, though the newest flip, 22:45Z, came before the 01:44Z run.
 * An after_fix line changed last when a fix after the owner said it landed (`flipped`), the same way, and stays after_fix in the count: the
 * fix in place when he said it failed. A no_fix line, and an after_fix line with no fix since, is open: it needs work until a fix lands. Its
 * `said` would read quiet a run later with the work still undone, so an open line dates its count `now` and keeps it live. An empty count has
 * no event and no `lastEventAt`.
 */
export function splitLastEvents(split: readonly SplitRepeat[], now: number): Partial<Record<"repeat_corrections_7d" | `repeats_${RepeatSide}_7d`, number>> {
  const settled = (repeat: SplitRepeat): number | undefined => repeat.side === "before_fix" ? repeat.flipped ?? repeat.fixed! : repeat.side === "after_fix" ? repeat.flipped : undefined;
  const events: Partial<Record<"repeat_corrections_7d" | `repeats_${RepeatSide}_7d`, number>> = {};
  for (const side of REPEAT_SIDES) {
    const lines = split.filter(repeat => repeat.side === side);
    if (lines.length) events[`repeats_${side}_7d`] = lines.some(repeat => settled(repeat) === undefined) ? now : Math.max(...lines.map(repeat => settled(repeat)!));
  }
  if (split.length) events.repeat_corrections_7d = split.some(repeat => settled(repeat) === undefined) ? now : Math.max(...split.map(repeat => settled(repeat)!));
  return events;
}

const minute = (time: number): string => new Date(time).toISOString().slice(5, 16).replace("T", " ") + "Z";
/** The line's lead in the flagged excerpt, such as "after fix of 10-19 07:16Z" or "after fix of 10-22 12:16Z, fixed again 10-27 18:48Z". */
export function sideLabel(repeat: SplitRepeat): string {
  const fixed = repeat.fixed === undefined ? "" : ` of ${minute(repeat.fixed)}`;
  if (repeat.side === "no_fix") return "no landed fix";
  if (repeat.side === "before_fix") return `before fix${fixed}`;
  return `after fix${fixed}${repeat.flipped === undefined ? "" : `, fixed again ${minute(repeat.flipped)}`}`;
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
    entry => firstFixLanded(fixRefs(entry), Date.parse(entry.at), now, commitTime)), now, commitTime);
  for (const repeat of split) {
    process.stdout.write(`${new Date(repeat.said).toISOString().slice(0, 16)}Z ${repeat.entry.id} ${sideLabel(repeat)} in ${repeat.repeat.chat.name || repeat.repeat.chat.id}: ${repeat.repeat.words.replace(/\s+/g, " ").slice(0, 120)}\n`);
  }
  process.stdout.write(`${JSON.stringify({ repeat_corrections_7d: split.length, ...splitMetrics(split) })}\n`);
  for (const error of errors) process.stderr.write(`no data: ${error}\n`);
}

// Not a top-level await: main imports harness-health.ts, which imports this module, and that import would wait on this one's evaluation.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch((error: unknown) => { process.stderr.write(`${String(error)}\n`); process.exit(1); });
