import { execFileSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { isInsideRepo } from '../../repo-hooks/project.mjs';
import { lex, effective, parseGit } from './agent-git-guard.mjs';

export function stripHeredocs(str) {
  const lines = str.split('\n');
  const out = [];
  let endTag = null;
  for (const line of lines) {
    if (endTag !== null) {
      if (line.trim() === endTag || line.trim() === `\t${endTag}`) endTag = null;
      continue;
    }
    const m = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (m) endTag = m[2];
    out.push(line);
  }
  return out.join('\n');
}

const isConvex = (w) => w === 'convex' || w.endsWith('/convex') || w.endsWith('/convex.mjs');
const RUNNERS = new Set(['npx', 'pnpx', 'bunx']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash']);
const PKG_MANAGERS = new Set(['pnpm', 'npm', 'yarn']);

export const CHECKS_RUN_IN_CI =
  '⛔ agent guard: checks run in GitHub Actions, not on this machine.\n' +
  '1. Commit: node scripts/repo/agent/commit.mjs -m "<type>(<scope>): <what>" <files>\n' +
  '2. Push: git push origin sieun/dev\n' +
  '3. Read the run: gh run list --workflow verify-dev.yml --branch sieun/dev --limit 3\n' +
  '   then: gh run view <run-id> --log-failed\n' +
  'Never run svelte-check, vitest, tsc, turbo run lint|check|test, pnpm check|test|lint, ' +
  'pnpm ci:guards, pnpm verify, or local-ci on this machine.\n' +
  'The Python rung is the same: no pytest, no ruff check, no ruff format --check, no ty, ' +
  'no mypy or basedpyright, with or without `uv run`. Formatting your own files ' +
  '(`uv run ruff format <files>`) is fine.\n' +
  'The live dev server (pnpm dev) is the only local writer of generated state ' +
  '(src/lib/paraglide, .svelte-kit); do not run i18n:compile or svelte-kit sync by hand while it is up.';

const UV_VALUE_FLAGS = new Set(['--project', '--directory', '--python', '-p', '--with', '--extra', '--group']);

export function canonical(eff) {
  let k = 0;
  if (RUNNERS.has(eff[k])) { k++; while (k < eff.length && eff[k].startsWith('-')) k++; return eff.slice(k).join(' '); }
  if (eff[k] === 'uv' && eff[k + 1] === 'run') {
    k += 2;
    while (k < eff.length && eff[k].startsWith('-')) k += UV_VALUE_FLAGS.has(eff[k]) ? 2 : 1;
    return eff.slice(k).join(' ');
  }
  if (PKG_MANAGERS.has(eff[k])) {
    k++;
    if (eff[k] === 'exec' || eff[k] === 'dlx') { k++; while (k < eff.length && eff[k].startsWith('-')) k++; return eff.slice(k).join(' '); }
    while (k < eff.length && eff[k].startsWith('-')) k += /^(--filter|--dir|-C|--workspace)$/.test(eff[k]) ? 2 : 1;
    if (eff[k] === 'run') k++;
    return eff[k] ? `pnpm ${eff[k]}` : 'pnpm';
  }
  return eff.join(' ');
}

const LOCAL_CHECK_DENIALS = [
  { pattern: /^(?:\S*\/)?svelte-check(?:\s|$)/, message: CHECKS_RUN_IN_CI },
  { pattern: /^(?:\S*\/)?vitest(?:\s|$)/, message: CHECKS_RUN_IN_CI },
  { pattern: /^(?:\S*\/)?tsc(?:\s|$)/, message: CHECKS_RUN_IN_CI },
  { pattern: /^(?:\S*\/)?turbo\s.*\brun\b.*\b(?:lint|check|test)\b/, message: CHECKS_RUN_IN_CI },
  { pattern: /^pnpm (?:check|test|verify|ci:guards)(?::\S+)?$/, message: CHECKS_RUN_IN_CI },
  { pattern: /^pnpm lint$/, message: CHECKS_RUN_IN_CI },
  { pattern: /^(?:node\s+)?\S*scripts\/repo\/agent\/(?:verify|local-ci|check-delta)\.mjs(?:\s|$)/, message: CHECKS_RUN_IN_CI },
  { pattern: /^(?:\S*\/)?pytest(?:\s|$)/, message: CHECKS_RUN_IN_CI },
  { pattern: /^(?:\S*\/)?python[\d.]*\s+(?:-\S+\s+)*-m\s+pytest(?:\s|$)/, message: CHECKS_RUN_IN_CI },
  { pattern: /^(?:\S*\/)?ruff\s+check(?:\s|$)/, message: CHECKS_RUN_IN_CI },
  { pattern: /^(?:\S*\/)?ruff\s+format\b.*\s--(?:check|diff)\b/, message: CHECKS_RUN_IN_CI },
  { pattern: /^(?:\S*\/)?ty(?:\s|$)/, message: CHECKS_RUN_IN_CI },
  { pattern: /^(?:\S*\/)?mypy(?:\s|$)/, message: CHECKS_RUN_IN_CI },
  { pattern: /^(?:\S*\/)?basedpyright(?:\s|$)/, message: CHECKS_RUN_IN_CI },
];

function skipFlagResidue(eff) {
  let k = 0;
  while (k < eff.length && (eff[k].startsWith('-') || /^\d+$/.test(eff[k]))) k++;
  return eff.slice(k);
}

function envPrefix(argv) {
  const env = {};
  for (const w of argv) {
    const m = w.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) break;
    env[m[1]] = m[2];
  }
  return env;
}

function convexArgs(eff) {
  let k = 0;
  if (RUNNERS.has(eff[k])) { k++; while (k < eff.length && eff[k].startsWith('-')) k++; }
  else if (eff[k] === 'pnpm' || eff[k] === 'npm' || eff[k] === 'yarn') {
    k++;
    if (eff[k] === 'exec' || eff[k] === 'dlx') k++; else return null;
    while (k < eff.length && eff[k].startsWith('-')) k++;
  }
  if (k < eff.length && isConvex(eff[k])) return eff.slice(k + 1);
  return null;
}

function liveConvexWatchers() {
  try {
    const out = execFileSync('ps', ['-axo', 'pgid=,stat=,command='], { encoding: 'utf8' });
    const pgids = new Set();
    for (const row of out.split('\n')) {
      const m = row.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
      if (!m || m[2].startsWith('Z')) continue; // zombies hold no code
      if (/convex dev(\s|$)/.test(m[3]) && !/--once/.test(m[3])) pgids.add(m[1]);
    }
    return pgids.size;
  } catch {
    return 0;
  }
}

export function judge(command, opts) {
  const { commands, nested } = lex(stripHeredocs(command));
  let cwd = opts.cwd;
  for (const argv of commands) {
    const env = envPrefix(argv);
    const eff = skipFlagResidue(effective(argv));
    if (!eff.length) continue;
    if (basename(eff[0]) === 'cd' && eff[1] && !eff[1].startsWith('-')) {
      cwd = resolve(cwd, eff[1]);
      continue;
    }

    if (SHELLS.has(eff[0]) || SHELLS.has(eff[0].split('/').pop())) {
      const ci = eff.findIndex((w, idx) => idx > 0 && /^-[a-z]*c$/.test(w));
      if (ci !== -1 && eff[ci + 1]) {
        const r = judge(eff[ci + 1], { ...opts, cwd });
        if (r) return r;
      }
    }

    const isGit = eff[0] === 'git' || eff[0].endsWith('/git');
    const target = isGit ? parseGit(eff, cwd).targetDir : cwd;
    if (!isInsideRepo(target, opts.repoRoot)) continue;

    const cargs = convexArgs(eff);
    if (cargs && cargs[0] === 'dev' && cargs.includes('--once')) {
      const dep = env.CONVEX_DEPLOYMENT || '';
      return {
        deny: dep.startsWith('prod:')
          ? '⛔ agent guard: `CONVEX_DEPLOYMENT=prod:… convex dev --once` does NOT push to prod — on convex CLI ' +
            '1.34.0 it targets DEV. The manual prod ' +
            'push is `npx convex deploy -y`; confirm the printed host matches the approved production deployment.'
          : '⛔ agent guard: manual `convex dev --once` for LOCAL DEV is banned. ' +
            'the persistent `npx convex dev` watcher auto-syncs on save. Verify via `pnpm exec convex logs`; ' +
            'surface a dead watcher instead of pushing around it.',
      };
    }

    if (isGit) {
      const { sub, args } = parseGit(eff, cwd);
      if (sub === 'add') {
        const rest = args;
        if (rest.some((w) => w === '-A' || w === '--all' || w === '.')) {
          return {
            deny:
              '⛔ agent guard: whole-tree staging (`-A`/`--all`/`.`) is banned in this multi-agent checkout — ' +
              'it absorbs other agents\' uncommitted work. Stage only YOUR named files/hunks.',
          };
        }
      }
    }

    if (cargs && cargs[0] === 'dev' && !cargs.includes('--once')) {
      const live = opts.convexWatchers ?? liveConvexWatchers();
      if (live > 0) {
        return {
          deny:
            '⛔ agent guard: a `convex dev` watcher is ALREADY running and owns the one shared dev ' +
            'deployment. A second watcher pushes the whole convex/ tree too — functions and schema ' +
            'become last-write-wins and the loser gets NO error. ' +
            'Check with `node scripts/repo/agent/convex-watcher.mjs status`; ' +
            'verify sync via `pnpm exec convex logs`.',
        };
      }
    }

    const cmd = canonical(eff);
    const readOnlyTurbo = eff.some((w) => w === '--graph' || w === '--dry' || w === '--dry-run' ||
      w.startsWith('--dry=') || w.startsWith('--graph='));
    if (!readOnlyTurbo) {
      const row = LOCAL_CHECK_DENIALS.find((d) => d.pattern.test(cmd));
      if (row) return { deny: row.message };
    }

  }
  for (const inner of nested) {
    const r = judge(inner, opts);
    if (r) return r;
  }
  return null;
}
