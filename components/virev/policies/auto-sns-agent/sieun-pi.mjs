import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isForcePush, parseGit } from './agent-git-guard.mjs';

// sieun-pi has one contributor, so its local checkout is ground truth (owner, 2026-10-09).
// Rewriting commits that no remote branch holds needs no ask; history on a remote is never rewritten.
const ORIGIN = /[/:]sieu-n\/sieun-pi(?:\.git)?\/?$/;
const REBASE_STEP = new Set(['--continue', '--abort', '--skip', '--quit', '--edit-todo', '--show-current-patch']);
const REBASE_VALUE_OPTS = new Set(['--onto', '-s', '--strategy', '-X', '--strategy-option', '-x', '--exec']);

export const SIEUN_PI_TAIL =
  'sieun-pi has one contributor, so its local checkout is ground truth: rebase and amend are fine while ' +
  'no remote branch holds the commits they rewrite. History already on a remote is never rewritten, and ' +
  '`git reset --hard` would drop uncommitted work in the checkout.';

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
  }).trim();
}

function isSieunPi(dir) {
  let top;
  try { top = realpathSync(git(dir, 'rev-parse', '--show-toplevel')); } catch { return false; }
  try { if (top === realpathSync(join(homedir(), 'Documents/Github/sieun-pi'))) return true; } catch { /* no home checkout */ }
  try { return ORIGIN.test(git(dir, 'remote', 'get-url', 'origin')); } catch { return false; }
}

/** The revisions `git rebase <args>` rewrites: `<upstream>..<branch>`, or all of `<branch>` with --root. */
function rebaseRange(args) {
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (REBASE_VALUE_OPTS.has(args[i])) i++;
    else if (!args[i].startsWith('-')) positional.push(args[i]);
  }
  if (args.includes('--root')) return [positional[0] ?? 'HEAD'];
  const [upstream = '@{upstream}', branch = 'HEAD'] = positional;
  return [`${upstream}..${branch}`];
}

function onRemote(dir, range) {
  const all = git(dir, 'rev-list', '--count', ...range);
  return all !== git(dir, 'rev-list', '--count', ...range, '--not', '--remotes');
}

/** Reason to block a history rewrite in the sieun-pi checkout, or null. Other repos return null. */
export function judgeSieunPi(eff, cwd) {
  const { targetDir, sub, args } = parseGit(eff, cwd);
  const rebase = sub === 'rebase' && !args.some((a) => REBASE_STEP.has(a));
  const amend = sub === 'commit' && args.includes('--amend');
  const force = sub === 'push' && isForcePush(args);
  const hard = sub === 'reset' && args.includes('--hard');
  if (!(rebase || amend || force || hard) || !isSieunPi(targetDir)) return null;
  if (force) return '`git push --force` in sieun-pi';
  if (hard) return '`git reset --hard` in sieun-pi';
  try {
    if (amend) return git(targetDir, 'branch', '-r', '--contains', 'HEAD') ? '`git commit --amend`: HEAD is already on a remote branch' : null;
    return onRemote(targetDir, rebaseRange(args)) ? '`git rebase`: it rewrites commits already on a remote branch' : null;
  } catch {
    return `\`git ${sub}\`: could not prove the rewritten commits are on no remote branch`;
  }
}
