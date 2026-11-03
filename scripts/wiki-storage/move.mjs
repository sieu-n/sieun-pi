#!/usr/bin/env node
// Move the wiki content root out of the auto-sns-agent checkout to its own folder, and the old content/agents/*
// into the agents mount. Every wiki path stays the same, so old URLs keep working.
//
//   node scripts/wiki-storage/move.mjs plan     [--from <dir>] [--to <dir>] [--agents <dir>] [--config <file>]
//   node scripts/wiki-storage/move.mjs dry-run  --sandbox <dir> [--sample <wiki path>...]
//   node scripts/wiki-storage/move.mjs run      [--from <dir>] [--to <dir>] [--agents <dir>] [--config <file>]
//
// run converges and can be run again after any stop: it renames the root (one rename on one file system), moves each
// content/agents entry into the agents folder, points contentRoot in the wiki config at the new root, and leaves a
// symlink at the old path once the checkout's HEAD no longer tracks files under it. Until then the symlink waits,
// because land-object.mjs deletes a landed deletion's path on disk and would delete through the symlink.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { expand } from './lib.mjs';

const home = homedir();
const argv = process.argv.slice(2);
const mode = argv[0];
const opt = (name, fallback) => { const i = argv.indexOf(name); return i < 0 ? fallback : argv[i + 1]; };
const opts = (name) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));
const log = (s) => process.stdout.write(`${s}\n`);
const die = (s) => { process.stderr.write(`move: ${s}\n`); process.exit(1); };

const DEFAULT_SAMPLE = [
  'index.html', 'apps/llm-wiki/index.html', 'apps/llm-wiki/search.html', 'domains/architecture/index.html', 'projects/crawl-library', 'archive/clickhouse-vps-migration.html', 'agents',
  'sessions/2026/10/28/0232-vent-model-allowlist', 'sessions/2026/10/29/1112-vent-gemini-402-callers',
  'sessions/2026/10/18/0536-tiktok-index-gaps', '.wiki/skill-metrics.duckdb',
];

function paths(root = '') {
  const r = (p) => (root ? path.join(root, p.replace(/^\//, '')) : p);
  return {
    from: path.resolve(expand(opt('--from', r(path.join(home, 'Documents/Github/auto-sns-agent/apps/llm-wiki/content'))))),
    to: path.resolve(expand(opt('--to', r(path.join(home, '.pi/wiki/content'))))),
    agents: path.resolve(expand(opt('--agents', r(path.join(home, '.pi/agent/agents'))))),
    config: path.resolve(expand(opt('--config', r(path.join(home, '.config/sieun-pi/wiki.json'))))),
  };
}

const kind = (p) => { try { const s = lstatSync(p); return s.isSymbolicLink() ? 'link' : s.isDirectory() ? 'dir' : 'file'; } catch { return 'none'; } };
const deviceOf = (p) => { let d = p; while (!existsSync(d)) d = path.dirname(d); return statSync(d).dev; };

function trackedUnder(dir) {
  const top = spawnSync('git', ['-C', path.dirname(dir), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (top.status !== 0) return 0;
  const rel = path.relative(top.stdout.trim(), dir);
  const out = execFileSync('git', ['-C', top.stdout.trim(), 'ls-tree', '-r', '--name-only', 'HEAD', '--', rel], { maxBuffer: 1 << 30 }).toString();
  return out.split('\n').filter(Boolean).length;
}

// A copy into the root while it moves would land half at the old path, so run waits for it (data integrity).
function writersUnder(dir) {
  const hits = [];
  for (const pid of readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    let cmd;
    try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' '); } catch { continue; }
    if (/(^|\/)(rsync|cp|scp|tar)\b/.test(cmd) && (cmd.includes(dir) || cmd.includes('llm-wiki/content'))) hits.push(`${pid} ${cmd.slice(0, 160)}`);
  }
  return hits;
}

/** The steps still left, from what is on disk now: an empty list means the move is done. */
function pending(p) {
  const steps = [];
  const fromKind = kind(p.from);
  const moved = fromKind === 'none' || (fromKind === 'link' && path.resolve(path.dirname(p.from), readlinkSync(p.from)) === p.to);
  if (!moved) {
    if (fromKind !== 'dir') die(`${p.from} is a ${fromKind}, neither the content root nor a link to ${p.to}`);
    if (kind(p.to) !== 'none') die(`${p.to} already exists while ${p.from} still holds the content; move one aside by hand`);
    if (deviceOf(p.from) !== deviceOf(path.dirname(p.to))) die(`${p.from} and ${p.to} are on different file systems, so the move would be a copy`);
    steps.push({ do: 'rename', from: p.from, to: p.to });
  }
  if (moved && kind(p.to) !== 'dir') die(`${p.from} is gone and ${p.to} is not a folder; the content root is missing`);
  const root = moved ? p.to : p.from;
  const oldAgents = path.join(root, 'agents');
  if (kind(oldAgents) === 'dir') {
    for (const name of readdirSync(oldAgents).sort()) {
      const target = path.join(p.agents, name);
      if (kind(target) !== 'none') die(`${target} exists, so agents/${name} would shadow it; rename one by hand`);
      steps.push({ do: 'agent', from: path.join(p.to, 'agents', name), to: target });
    }
    steps.push({ do: 'rmdir', path: path.join(p.to, 'agents') });
  }
  const cfg = existsSync(p.config) ? JSON.parse(readFileSync(p.config, 'utf8')) : {};
  if (path.resolve(expand(cfg.contentRoot ?? '')) !== p.to) steps.push({ do: 'config', file: p.config, contentRoot: p.to });
  if (kind(p.from) !== 'link') {
    const tracked = trackedUnder(p.from);
    steps.push(tracked ? { do: 'link-waits', tracked, at: p.from } : { do: 'link', at: p.from, to: p.to });
  }
  return steps;
}

function apply(step) {
  if (step.do === 'rename') { mkdirSync(path.dirname(step.to), { recursive: true }); renameSync(step.from, step.to); }
  if (step.do === 'agent') { mkdirSync(path.dirname(step.to), { recursive: true }); renameSync(step.from, step.to); }
  if (step.do === 'rmdir' && kind(step.path) === 'dir') rmdirSync(step.path);
  if (step.do === 'config') {
    const cfg = existsSync(step.file) ? JSON.parse(readFileSync(step.file, 'utf8')) : {};
    mkdirSync(path.dirname(step.file), { recursive: true });
    writeFileSync(`${step.file}.tmp`, `${JSON.stringify({ ...cfg, contentRoot: step.contentRoot }, null, 2)}\n`);
    renameSync(`${step.file}.tmp`, step.file);
  }
  if (step.do === 'link') symlinkSync(step.to, step.at);
}

const describe = (s) => ({
  rename: () => `rename ${s.from} -> ${s.to}`,
  agent: () => `move ${s.from} -> ${s.to}`,
  rmdir: () => `remove the empty ${s.path}`,
  config: () => `set contentRoot in ${s.file} to ${s.contentRoot}`,
  link: () => `symlink ${s.at} -> ${s.to}`,
  'link-waits': () => `symlink at ${s.at} waits: the checkout HEAD still tracks ${s.tracked} files under it; land their removal, then run again`,
}[s.do]());

function run(p, write) {
  const steps = pending(p);
  if (!steps.length) { log('nothing left: the move is done'); return; }
  for (const s of steps) {
    log(`${write && s.do !== 'link-waits' ? 'did' : 'would'}: ${describe(s)}`);
    if (write && s.do !== 'link-waits') apply(s);
  }
  if (write) for (const s of pending(p)) if (s.do !== 'link-waits') die(`still pending after the run: ${describe(s)}`);
}

const tree = (dir) => execFileSync('find', [dir, '-mindepth', '1', '-maxdepth', '14', '(', '-name', '.git', '-o', '-name', '__pycache__', ')', '-prune', '-o', '-printf', '%y\\t%P\\t%l\\n'], { maxBuffer: 1 << 26 })
  .toString().split('\n').filter(Boolean).map((l) => l.split('\t')).filter(([, p]) => !p.endsWith('.git'))
  .sort((a, b) => a[1].localeCompare(b[1])).map(([y, p, to]) => `${'  '.repeat(p.split('/').length - 1)}${path.basename(p)}${y === 'd' ? '/' : ''}${to ? ` -> ${to}` : ''}`).join('\n');

function dryRun() {
  const sandbox = path.resolve(expand(opt('--sandbox') ?? die('dry-run needs --sandbox <dir>')));
  if (kind(sandbox) !== 'none') die(`${sandbox} exists; give a new folder`);
  const live = paths();
  const p = paths(sandbox);
  const sample = opts('--sample').length ? opts('--sample') : DEFAULT_SAMPLE;
  for (const rel of sample) cpSync(path.join(live.from, rel), path.join(p.from, rel), { recursive: true, preserveTimestamps: true });
  mkdirSync(path.join(p.agents, 'vent'), { recursive: true });
  cpSync(path.join(live.agents, 'vent', 'brief.md'), path.join(p.agents, 'vent', 'brief.md'));
  const repo = path.dirname(path.dirname(path.dirname(p.from)));
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: 'dry run', GIT_AUTHOR_EMAIL: 'dry@run', GIT_COMMITTER_NAME: 'dry run', GIT_COMMITTER_EMAIL: 'dry@run' } }).toString();
  g('init', '-q', '-b', 'dev/sieun');
  g('add', '--', path.relative(repo, p.from));
  g('commit', '-q', '-m', 'fixture: sample content tracked like auto-sns-agent');
  mkdirSync(path.dirname(p.config), { recursive: true });
  writeFileSync(p.config, `${JSON.stringify({ contentRoot: p.from, mounts: { agents: p.agents } }, null, 2)}\n`, { flag: 'wx' });
  const top = path.join(sandbox, home.replace(/^\//, ''));
  log(`== before (${top})\n${tree(top)}`);
  log('\n== plan');
  run(p, false);
  log('\n== run 1 (the checkout still tracks the content)');
  run(p, true);
  log('\n== land the untracking commit in the fixture repo');
  g('rm', '-r', '-q', '--cached', '--', path.relative(repo, p.from));
  g('commit', '-q', '-m', 'fixture: content leaves git');
  log('\n== run 2');
  run(p, true);
  log('\n== run 3 (idempotent)');
  run(p, true);
  log(`\n== after\n${tree(top)}`);
  const page = 'sessions/2026/10/28/0232-vent-model-allowlist/index.html';
  log(`\n== old path still reads: ${readFileSync(path.join(p.from, page)).length} bytes at ${path.join(p.from, page)}`);
}

if (mode === 'plan') run(paths(), false);
else if (mode === 'run') {
  const writers = writersUnder(paths().from);
  if (writers.length) die(`a copy is writing under the content root; run again after it ends:\n${writers.join('\n')}`);
  run(paths(), true);
}
else if (mode === 'dry-run') dryRun();
else die('usage: move.mjs plan|dry-run|run [--from <dir>] [--to <dir>] [--agents <dir>] [--config <file>] [--sandbox <dir>] [--sample <wiki path>]');
