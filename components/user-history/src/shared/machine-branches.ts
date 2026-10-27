/**
 * Owner rule c119: each machine has one checkout and one dev branch, dev/sieun on us-metal02 and dev/sieun-mac on the Mac, and no chat or
 * job makes its own branch, clone or worktree. The owner, 2026-10-27: "NO one machine should have one worktree. dev/sieun for metal-02,
 * dev/sieun-mac for mac". The rule came back because a Mac brief of 10-22 gave each job its own dev/sieun-mac-<job> branch through
 * ~/work/virev-dev/new-job-checkout.sh, and 34 such branches reached origin while the c119 ledger line and the board skill still said "any
 * dev/<name>" and named the Mac's old dev/sieun-mac-a.
 */

/** Each machine's one dev branch in auto-sns-agent. */
export const MACHINE_BRANCHES = { "us-metal02": "dev/sieun", mac: "dev/sieun-mac" } as const;
export type MachineBranch = (typeof MACHINE_BRANCHES)[keyof typeof MACHINE_BRANCHES];

const MACHINE = new Set<string>(Object.values(MACHINE_BRANCHES));
/** A dev/sieun-* name, a dev/<name> placeholder or the per-job worktree script, not inside a path such as routes/dev/<area>. */
const BRANCH_LIKE = /(?<![\w/.-])dev\/(?:sieun-[\w.<>-]+|<[^>\s]+>[\w-]*)|new-job-checkout\.sh/g;
/** A sentence that names an old branch to retire, refuse or replace it, not to work on it. */
const RETIRING = /\b(?:retir\w*|old|former|stale|delet\w*|fold\w*|refus\w*|bans?|banned|renam\w*|no longer|instead of|replac\w*)\b/i;
/** A sentence: punctuation followed by a non-space, as in new-job-checkout.sh or 10.5, stays inside it. */
const SENTENCE = /(?:[^.!?\n]|[.!?](?=\S))+[.!?]*/g;

/**
 * The branch names in a text that break c119: a dev/sieun-* branch other than the two machine branches (dev/sieun-mac-a, dev/sieun-mac-<job>,
 * dev/sieun-metal-02), a dev/<name> placeholder, and new-job-checkout.sh, which makes a per-job branch. A sentence that retires, refuses or
 * renames the name passes. Each name once, in text order.
 */
export function strayBranches(text: string, options: { retiredShared?: boolean } = {}): string[] {
  const found = new Set<string>();
  for (const sentence of text.match(SENTENCE) ?? []) {
    if (RETIRING.test(sentence)) continue;
    for (const match of sentence.matchAll(BRANCH_LIKE)) {
      const name = match[0].replace(/[.-]+$/, "");
      if (!MACHINE.has(name)) found.add(name);
    }
    if (options.retiredShared && RETIRED_SHARED.test(sentence)) found.add("sieun/dev");
  }
  return [...found];
}

/**
 * us-metal02's branch before dev/sieun. Its checkout moved to dev/sieun at 08:17Z on 2026-10-27, so a duty that reads or names sieun/dev as
 * today's branch reads a branch nothing pushes. Dated history ("fixed it on sieun/dev on 10-19") passes when its sentence says so with "old".
 */
const RETIRED_SHARED = /(?<![\w/.-])sieun\/dev\b/;

/**
 * What in a duty definition names a branch c119 retired: its goal, onMiss, metric and reading labels and precheck command, with the old
 * sieun/dev too. ownerWords stay out, because they quote the owner verbatim.
 */
export function dutyStrayBranches(definition: { goal?: unknown; onMiss?: unknown; metrics?: unknown; readings?: unknown; precheck?: unknown }): string[] {
  const parts = [definition.goal, definition.onMiss, JSON.stringify(definition.metrics ?? []), JSON.stringify(definition.readings ?? []),
    JSON.stringify(definition.precheck ?? {})];
  return [...new Set(parts.flatMap(part => typeof part === "string" ? strayBranches(part, { retiredShared: true }) : []))];
}

/** The fix line a check prints next to stray branch names. */
export const STRAY_BRANCH_FIX = "Each machine has one checkout and one dev branch (c119): dev/sieun on us-metal02 and dev/sieun-mac on the Mac. " +
  "Name the machine's branch, and never give a job its own branch, clone or worktree.";
