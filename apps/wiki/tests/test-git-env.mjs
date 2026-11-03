// Env and checks for tests that build their own git repo in a temp dir. A copy of auto-sns-agent scripts/repo/test-git-env.mjs.
// Git reads GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and the other variables of `git rev-parse --local-env-vars` before it
// looks at the working directory, so a fixture's `git init` or `git commit` run with an inherited GIT_DIR writes the repo
// that variable names: on 2026-10-14 a ci-scope.test.mjs run with GIT_DIR=<real .git> moved the shared checkout's refs.
// Importing this module removes those variables from process.env, so a spawn that inherits process.env cannot reach
// another repo. scripts/repo/agent/guards/fixture-git-env.test.mjs fails CI when a tracked test runs `git init` or
// `git clone` without assertFixtureRepo.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ENV = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX',
  'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_GRAFT_FILE', 'GIT_SHALLOW_FILE',
  'GIT_REPLACE_REF_BASE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_QUARANTINE_PATH',
  'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM',
];
const repoVar = (key) => REPO_ENV.includes(key) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key);
const withoutRepoVars = (env) => Object.fromEntries(Object.entries(env).filter(([key]) => !repoVar(key)));

for (const key of Object.keys(process.env)) if (repoVar(key)) delete process.env[key];

// `env` minus every repo-locating variable, with discovery stopped at the directory that holds
// `root`, so a git call in `root` before its `git init` cannot climb into an enclosing checkout.
export function fixtureGitEnv(root, env = process.env) {
  return { ...withoutRepoVars(env), GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(root)) };
}

const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);

// The common dir of the checkout this file lives in, found by walking up to `.git` with stat
// calls only: a sandboxed suite may not read the checkout's .git (scripts/ci/ci-scope.mjs).
let checkoutCommonDir;
function checkoutGit() {
  if (checkoutCommonDir !== undefined) return checkoutCommonDir;
  checkoutCommonDir = null;
  for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, '.git');
    if (existsSync(dotGit)) {
      if (statSync(dotGit).isDirectory()) checkoutCommonDir = realpathSync(dotGit);
      else {
        const gitDir = path.resolve(dir, /^gitdir: (.+)$/m.exec(readFileSync(dotGit, 'utf8'))[1].trim());
        const common = path.join(gitDir, 'commondir');
        checkoutCommonDir = realpathSync(existsSync(common) ? path.resolve(gitDir, readFileSync(common, 'utf8').trim()) : gitDir);
      }
      return checkoutCommonDir;
    }
    if (path.dirname(dir) === dir) return checkoutCommonDir;
  }
}

// Throws unless git, run in `repo` with an env from fixtureGitEnv(), resolves the repo inside
// `repo` (its .git, or `repo` itself when bare), and never this checkout's own repo.
export function assertFixtureRepo(repo, env) {
  const ceiling = env.GIT_CEILING_DIRECTORIES;
  if (!ceiling) throw new Error(`fixture git env for ${repo} has no GIT_CEILING_DIRECTORIES; build it with fixtureGitEnv()`);
  const out = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const common = realpathSync(out.trim());
  if (common === checkoutGit()) throw new Error(`fixture git in ${repo} resolves to this checkout's repo ${common}`);
  if (!inside(common, realpathSync(repo))) throw new Error(`fixture git in ${repo} resolves to ${common}, outside the fixture`);
  return common;
}
