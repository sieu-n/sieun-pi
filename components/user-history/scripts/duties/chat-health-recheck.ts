import { spawnSync } from "node:child_process";
import type { FlaggedSlice } from "../../src/shared/chat-duties.ts";

/** A sieun-pi chat fix: its short sha, commit time (ms) and subject. */
export interface FixCommit { sha: string; at: number; subject: string }

const FIX_SUBJECT = "fix(user-history)";
/** The metric a fix's subject names, by the words it uses; a subject can name several. */
const TARGETS: readonly (readonly [string, RegExp])[] = [
  ["long_replies", /\b(?:long (?:owner )?repl(?:y|ies)|60 words|reply rule|reply cap)\b/i],
  ["slop_replies", /\b(?:slop|reply lint|reply check)\b/i],
  ["off_brief", /\b(?:wakes?|wake-ups?|off[- ]brief|repeat(?:s|ed)?|notices?|tell_owner)\b/i],
  ["stalls_2h", /\b(?:stall(?:s|ed)?|stuck|quiet steps?|waitUntil|waitFor)\b/i],
  ["corrections", /\bcorrections?\b/i],
  ["unretried_errors", /\b(?:retr(?:y|ies)|failed turns?|restarts?)\b/i],
  ["sieun_pi_breaks", /\b(?:pi-pool|token hook|sieun-pi breaks?)\b/i],
];

/** The metrics a fix targets, in TARGETS order. */
export const fixTargets = (subject: string): string[] => TARGETS.filter(([, words]) => words.test(subject)).map(([key]) => key);

/** The `fix(user-history)` commits under `cwd` with a commit time in [since, until), newest first. Empty when git fails. */
export function fixCommits(cwd: string, since: number, until: number): FixCommit[] {
  const log = spawnSync("git", ["log", `--since=${new Date(since).toISOString()}`, `--until=${new Date(until).toISOString()}`, "--format=%h%x09%ct%x09%s", "--", "."], { cwd, encoding: "utf8" });
  if (log.status !== 0) return [];
  return log.stdout.split("\n").flatMap(line => {
    const [sha, seconds, subject] = line.split("\t");
    const at = Number(seconds) * 1000;
    return sha && subject?.startsWith(FIX_SUBJECT) && at >= since && at < until ? [{ sha, at, subject }] : [];
  });
}

/**
 * The "fixed yesterday, recheck today" section: one slice per fix, with today's value of each metric it targets, so the run shows whether the
 * fix held. A fix whose subject names no metric is listed for a person to judge.
 */
export function recheckSlices(commits: readonly FixCommit[], metrics: Readonly<Record<string, number>>): FlaggedSlice[] {
  return commits.map(commit => {
    const targets = fixTargets(commit.subject).filter(key => key in metrics);
    const today = targets.length ? targets.map(key => `${key} ${metrics[key]} today`).join(", ") : "no metric named; judge it by hand";
    return { at: commit.at, kind: "recheck", excerpt: `fixed yesterday, recheck today: ${today}; ${commit.sha} ${commit.subject.slice(FIX_SUBJECT.length + 2)}` };
  });
}
