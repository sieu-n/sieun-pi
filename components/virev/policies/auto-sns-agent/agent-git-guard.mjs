import { resolve, dirname, basename } from 'node:path';
import { isInsideRepo } from '../../repo-hooks/project.mjs';
import { SHELLS, effective, lex } from '../../repo-hooks/shell.mjs';

const DENY_ALWAYS = new Set([
  'stash', 'merge', 'rebase', 'pull', 'checkout', 'switch', 'restore',
  'reset', 'filter-branch', 'replace',
]);
const DENY_EXCEPT = {
  stash: (a) => ['list', 'show'].includes(a[0]),
  worktree: (a) => a[0] === 'list',
};

const WHOLE_TREE = new Set(['.', ':/', ':/.', '-A', '--all', '*']);

const JUDGES = {
  add: (a) => a.some((w) => WHOLE_TREE.has(w)) && 'whole-tree staging',
  commit: (a) => a.some((w) => w === '-a' || w === '--all' || /^-[a-z]*a[a-z]*$/.test(w) && w.includes('a')) && 'commit -a (commits other agents\' files)',
  clean: (a) => !a.some((w) => w === '-n' || w === '--dry-run') && 'force clean',
  worktree: (a) => !DENY_EXCEPT.worktree(a) && 'worktree write (worktrees are banned here)',
  branch: (a) => a.some((w) => w === '-D') && 'force branch delete',
  push: (a) => {
    if (a.some((w) => /^-[^-]*f/.test(w) || w === '--force' || w === '--force-with-lease' || w.startsWith('--force-with-lease=') || w.startsWith('+'))) {
      return 'force push (land.sh/promote.sh own forced refs)';
    }
    if (a.some((w) => ['main', 'refs/heads/main'].includes(w.split(':').pop()))) return 'push to main (use ./scripts/repo/promote.sh)';
    return null;
  },
};

function parseGit(eff, cwd) {
  let i = 1, dir = cwd, gitDir = null;
  while (i < eff.length) {
    const a = eff[i];
    if (a === '-C') { dir = resolve(dir, eff[i + 1] ?? '.'); i += 2; continue; }
    if (a === '-c' || a === '--config-env') { i += 2; continue; }
    if (a === '--git-dir') { gitDir = resolve(dir, eff[i + 1] ?? '.'); i += 2; continue; }
    if (a.startsWith('--git-dir=')) { gitDir = resolve(dir, a.slice(10)); i++; continue; }
    if (a === '--work-tree') { dir = resolve(dir, eff[i + 1] ?? '.'); i += 2; continue; }
    if (a.startsWith('--work-tree=')) { dir = resolve(dir, a.slice(12)); i++; continue; }
    if (a.startsWith('-')) { i++; continue; }
    break;
  }
  const targetDir = gitDir ? dirname(gitDir) : dir;
  return { targetDir, sub: eff[i], args: eff.slice(i + 1) };
}

function judgeGit(eff, { cwd, repoRoot }) {
  const { targetDir, sub, args } = parseGit(eff, cwd);
  if (!isInsideRepo(targetDir, repoRoot)) return null;       // different repo → not ours
  if (sub === undefined) return null;              // bare `git` → prints help
  if (DENY_ALWAYS.has(sub)) {
    const except = DENY_EXCEPT[sub];
    try { if (except && except(args)) return null; } catch { /* deny below */ }
    return `\`git ${sub}\` (shared-checkout hazard)`;
  }
  const judge = JUDGES[sub];
  if (judge) { try { const r = judge(args); return r ? `\`git ${sub}\` — ${r}` : null; } catch { return `\`git ${sub}\``; } }
  return null;                                      // everything else → allow
}

function analyze(command, { cwd, repoRoot }) {
  const { commands, nested } = lex(command);
  let runningCwd = cwd;
  for (const argv of commands) {
    const eff = effective(argv);
    if (!eff.length) continue;
    const cmd = basename(eff[0]);
    if (cmd === 'cd' && eff[1] && !eff[1].startsWith('-')) { runningCwd = resolve(runningCwd, eff[1]); continue; }
    if (cmd === 'git' || eff[0].endsWith('/git')) {
      const bad = judgeGit(eff, { cwd: runningCwd, repoRoot });
      if (bad) return bad;
      continue;
    }
    if (SHELLS.has(cmd)) {
      const ci = eff.findIndex((w, idx) => idx > 0 && /^-[a-z]*c$/.test(w));
      if (ci !== -1 && eff[ci + 1]) { const bad = analyze(eff[ci + 1], { cwd: runningCwd, repoRoot }); if (bad) return bad; }
    }
  }
  for (const inner of nested) { const bad = analyze(inner, { cwd, repoRoot }); if (bad) return bad; }
  return null;
}

export { analyze, judgeGit, parseGit };
