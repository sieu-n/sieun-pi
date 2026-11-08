import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const home = homedir();
export const expand = (p) => (p && p.startsWith('~/') ? path.join(home, p.slice(2)) : p);

export function loadConfig(env = process.env) {
  const file = expand(env.WIKI_CONFIG || '~/.config/sieun-pi/wiki.json');
  const json = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const backup = typeof json.backup === 'object' && json.backup ? json.backup : {};
  return {
    file,
    contentRoot: expand(env.WIKI_CONTENT_ROOT || json.contentRoot || '~/.pi/wiki/content'),
    agentsRoot: expand(env.WIKI_AGENTS_ROOT || json.mounts?.agents || '~/.pi/agent/agents'),
    betterleaks: expand(env.WIKI_BETTERLEAKS || json.betterleaks || '~/.local/bin/betterleaks'),
    remote: env.WIKI_BACKUP_REMOTE || json.backupRepo || 'https://github.com/sieu-n/wiki-content.git',
    gitDir: expand(env.WIKI_BACKUP_GIT_DIR || backup.gitDir || '~/.pi/wiki/backup.git'),
    gitleaksConfig: expand(env.WIKI_BACKUP_GITLEAKS_CONFIG || backup.gitleaksConfig || ''),
  };
}

export const PAGE = /\.(html|md)$/;
const PAGE_NAMES = ['*.html', '*.md'];
/**
 * The curated spaces whose scripts are backed up beside the pages: a page generator such as
 * apps/api-portal/platform/generate-api-endpoints.mjs lives only there since the content left auto-sns-agent's git on
 * 2026-11-03. These spaces held 154 script files, 1.6 MB, on 2026-11-08, while the whole content root held 560,759, 5.8 GB.
 */
export const SCRIPT_SPACES = ['apps', 'domains', 'projects', 'experiments', 'archive'];
const SCRIPT_NAMES = ['*.mjs', '*.cjs', '*.js', '*.ts', '*.py', '*.sh'];

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Files under root named like `names`, skipping node_modules and each folder whose path matches a prune regex (find -regex, whole path). */
export function findFiles(root, prune, names = PAGE_NAMES) {
  if (!existsSync(root)) return [];
  const args = [root, '-regextype', 'posix-extended', '('];
  for (const p of prune) args.push('-regex', p, '-o');
  args.push('-name', 'node_modules', ')', '-prune', '-o', '-type', 'f', '(', ...names.flatMap((n, i) => (i ? ['-o', '-name', n] : ['-name', n])), ')', '-printf', '%s\\t%T@\\t%P\\0');
  const out = execFileSync('find', args, { maxBuffer: 1 << 30 }).toString('utf8');
  return out.split('\0').filter(Boolean).map((line) => {
    const [size, mtime, rel] = line.split('\t');
    return { size: Number(size), mtime: Number(mtime), rel, abs: path.join(root, rel) };
  });
}

/**
 * Every page file the wiki serves, plus the scripts in the curated spaces, keyed by wiki path; the agents mount wins
 * over content/agents, as in the engine.
 */
export function wikiPages(cfg) {
  const pages = new Map();
  for (const f of findFiles(cfg.contentRoot, [`${reEscape(cfg.contentRoot)}/\\.wiki`])) pages.set(f.rel, f);
  for (const space of SCRIPT_SPACES) {
    for (const f of findFiles(path.join(cfg.contentRoot, space), [], SCRIPT_NAMES)) pages.set(`${space}/${f.rel}`, { ...f, rel: `${space}/${f.rel}` });
  }
  for (const f of findFiles(cfg.agentsRoot, [`${reEscape(cfg.agentsRoot)}/[^/]+/harness`])) pages.set(`agents/${f.rel}`, f);
  return pages;
}
