#!/usr/bin/env node
// Back up the wiki's page files (.html and .md) to a private GitHub repo, laid out by wiki path:
// the content root at the repo root and the agents mount under agents/. Data files stay on the box.
//
//   node scripts/wiki-storage/backup.mjs [--paths-from <file>] [--no-push] [--dry-run]
//
// It walks both roots each run (8.4 s for 58,839 page files at load 117 on 2026-11-03), commits through a private
// index in its own bare repo, and drops from the commit any file betterleaks flags, which it logs and retries
// when the file changes. wiki-backup.timer runs it every 5 minutes.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, linkSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, wikiPages } from './lib.mjs';

const YOUNG_MS = 30_000;
// A page file over 1 MB is a captured page or a dump, not a written page: 100 files, 257 MB of 1.1 GB on 2026-11-03.
const PAGE_MAX_BYTES = 1_000_000;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; };
const dryRun = flag('--dry-run');
const push = !flag('--no-push') && !dryRun;
const only = opt('--paths-from') ? new Set(readFileSync(opt('--paths-from'), 'utf8').split('\n').filter(Boolean)) : null;

const cfg = loadConfig();
const log = (s) => process.stdout.write(`wiki-backup: ${s}\n`);
const gitEnv = { ...process.env, GIT_DIR: cfg.gitDir, GIT_INDEX_FILE: path.join(cfg.gitDir, 'backup-index') };
const git = (args, input) => execFileSync('git', args, { env: gitEnv, input, maxBuffer: 1 << 30 }).toString('utf8').trim();
const tryGit = (args) => { const r = spawnSync('git', args, { env: gitEnv, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };

function ensureRepo() {
  if (existsSync(path.join(cfg.gitDir, 'HEAD'))) return;
  mkdirSync(cfg.gitDir, { recursive: true });
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', cfg.gitDir]);
  git(['remote', 'add', 'origin', cfg.remote]);
}

const statePath = () => path.join(cfg.gitDir, 'wiki-backup-state.json');
const readState = () => (existsSync(statePath()) ? JSON.parse(readFileSync(statePath(), 'utf8')) : { files: {}, pushed: null });
function writeState(state) {
  const tmp = `${statePath()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, statePath());
}

function scan(files) {
  if (!files.length) return new Map();
  const tmpRoot = path.join(path.dirname(cfg.gitDir), '.wiki-backup-tmp');
  mkdirSync(tmpRoot, { recursive: true });
  const dir = mkdtempSync(path.join(tmpRoot, 'scan-'));
  try {
    for (const [wikiPath, f] of files) {
      const to = path.join(dir, 'files', wikiPath);
      mkdirSync(path.dirname(to), { recursive: true });
      try { linkSync(f.abs, to); } catch { copyFileSync(f.abs, to); }
    }
    const report = path.join(dir, 'report.json');
    const rules = cfg.gitleaksConfig ? ['-c', cfg.gitleaksConfig] : [];
    const run = spawnSync(cfg.betterleaks, ['dir', '--no-banner', '--no-color', '--redact', '--exit-code', '0', '-f', 'json', '-r', report, ...rules, '--', '.'],
      { cwd: path.join(dir, 'files'), encoding: 'utf8', maxBuffer: 1 << 28 });
    if (run.error || run.status !== 0) throw new Error(`betterleaks failed (${run.error?.message ?? `exit ${run.status}`}): ${(run.stderr || '').trim().split('\n').pop()}`);
    const held = new Map();
    for (const x of JSON.parse(readFileSync(report, 'utf8')) ?? []) {
      const p = path.normalize(x.File);
      held.set(p, [...(held.get(p) ?? []), `${x.RuleID}:${x.StartLine}`]);
    }
    return held;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (!existsSync(cfg.contentRoot)) {
  process.stderr.write(`wiki-backup: content root ${cfg.contentRoot} is missing; refusing, since a run would record every page as removed\n`);
  process.exit(1);
}
ensureRepo();
const state = readState();
const now = Date.now();
const pages = wikiPages(cfg);
const changed = [];
const counts = { young: 0, big: 0, held: 0, removed: 0 };
for (const [wikiPath, f] of pages) {
  if (only && !only.has(wikiPath)) continue;
  const old = state.files[wikiPath];
  if (old && old[0] === f.size && old[1] === f.mtime) continue;
  if (now - f.mtime * 1000 < YOUNG_MS) { counts.young++; continue; }
  if (f.size > PAGE_MAX_BYTES) { state.files[wikiPath] = [f.size, f.mtime, 'big']; counts.big++; continue; }
  changed.push([wikiPath, f]);
}
const removed = only ? [] : Object.keys(state.files).filter((p) => !pages.has(p));
const held = scan(changed);
for (const [p, why] of held) log(`held ${p} (${why.join(', ')})`);

const lines = [];
for (const [wikiPath, f] of changed) {
  if (held.has(wikiPath)) { state.files[wikiPath] = [f.size, f.mtime, 'held']; counts.held++; continue; }
  lines.push([wikiPath, f]);
}
const shas = lines.length && !dryRun ? git(['hash-object', '-w', '--stdin-paths'], lines.map(([, f]) => f.abs).join('\n') + '\n').split('\n') : [];
const info = lines.map(([wikiPath], i) => `100644 ${shas[i]}\t${wikiPath}`);
for (const p of removed) {
  if (state.files[p][2] === 'ok') info.push(`0 ${'0'.repeat(40)}\t${p}`);
  delete state.files[p];
  counts.removed++;
}
const head = tryGit(['rev-parse', '-q', '--verify', 'refs/heads/main']);
if (!existsSync(gitEnv.GIT_INDEX_FILE)) git(head ? ['read-tree', head] : ['read-tree', '--empty']);
if (info.length && !dryRun) git(['update-index', '--index-info'], info.join('\n') + '\n');
lines.forEach(([wikiPath, f]) => { state.files[wikiPath] = [f.size, f.mtime, 'ok']; });

log(`${pages.size} page files; ${lines.length} to commit, ${counts.removed} removed, ${counts.held} held by the secret scan, ${counts.big} over 1 MB kept local, ${counts.young} younger than 30 s left for the next run`);
if (dryRun) process.exit(0);

const tree = git(['write-tree']);
let tip = head;
if (!head || tree !== git(['rev-parse', `${head}^{tree}`])) {
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const msg = `backup: ${lines.length} page files written, ${counts.removed} removed, ${stamp} UTC`;
  tip = git(['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', msg]);
  git(['update-ref', 'refs/heads/main', tip, ...(head ? [head] : [])]);
  log(`committed ${tip.slice(0, 10)}`);
  git(['gc', '--auto', '-q']);
}
writeState(state);
if (push && tip && tip !== state.pushed) {
  git(['push', '-q', 'origin', 'main']);
  state.pushed = tip;
  writeState(state);
  log(`pushed ${tip.slice(0, 10)} to ${cfg.remote}`);
}
