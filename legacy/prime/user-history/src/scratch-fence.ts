import fs from "node:fs";
import fsp from "node:fs/promises";
import { realpathSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { userInfo } from "node:os";
import { join, resolve, sep } from "node:path";

/**
 * The live agent dirs a scratch serve must never write: ~/.prime/agent of the account (by the passwd home, not HOME), and each dir that
 * SIEUN_PI_FENCED_AGENT_DIRS adds (colon-separated, for tests). The variable only adds roots, so it cannot open the real one.
 */
export function fencedAgentDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [join(userInfo().homedir, ".prime", "agent"), ...(env.SIEUN_PI_FENCED_AGENT_DIRS ?? "").split(":").filter(Boolean)];
  return [...new Set(roots.flatMap(root => { const at = resolve(root); try { return [at, realpathSync(at)]; } catch { return [at]; } }))];
}

/** The fenced root `path` sits in, or null; the path and its real path both count, so a symlink into the root is caught. */
export function fencedRoot(path: string, roots: readonly string[]): string | null {
  const at = resolve(path);
  let real = at;
  try { real = realpathSync(at); } catch { /* not there yet: its parent decides below */ }
  for (const candidate of [at, real]) for (const root of roots) if (candidate === root || candidate.startsWith(root + sep)) return root;
  return null;
}

const WRITE_FLAGS = /[wa+]/;
type Target = string | Buffer | URL | number | undefined;
const asPath = (target: Target): string | null => typeof target === "string" ? target : target instanceof URL ? target.pathname : Buffer.isBuffer(target) ? target.toString() : null;

/**
 * Makes every file write of this process under `roots` fail: on 10-19 between 01:26Z and 02:24Z replay serves on a copy of browser-chat wrote
 * session_state active into 7 real session files the live service had archived, through threads.setSessionState after their fake daemon took
 * a kill. The node:fs and node:fs/promises calls that create, change, move or delete a file throw EACCES for such a path, and
 * `syncBuiltinESMExports` carries the change to every module's named imports. `log` gets the first refusal of each root.
 */
export function fenceWrites(roots: readonly string[], log: (line: string) => void): void {
  const told = new Set<string>();
  const refuse = (target: Target, call: string): void => {
    const path = asPath(target);
    const root = path === null ? null : fencedRoot(path, roots);
    if (root === null) return;
    if (!told.has(root)) { told.add(root); log(`scratch serve: refused ${call} of ${path}; a scratch serve writes nothing under ${root}`); }
    throw Object.assign(new Error(`EACCES: a scratch serve writes nothing under ${root}: ${call} ${path}`), { code: "EACCES" });
  };
  const wrap = (target: Record<string, unknown>, name: string, paths: (args: unknown[]) => Target[]): void => {
    const original = target[name];
    if (typeof original !== "function") return;
    target[name] = function (this: unknown, ...args: unknown[]) {
      try { for (const path of paths(args)) refuse(path, name); }
      catch (error) {
        const callback = args[args.length - 1];
        if (typeof callback === "function" && !name.endsWith("Sync") && target === fs as unknown) { process.nextTick(() => (callback as (error: unknown) => void)(error)); return undefined; }
        if (target === fsp as unknown) return Promise.reject(error);
        throw error;
      }
      return (original as (...rest: unknown[]) => unknown).apply(this, args);
    };
  };
  const first = (args: unknown[]): Target[] => [args[0] as Target];
  const both = (args: unknown[]): Target[] => [args[0] as Target, args[1] as Target];
  const second = (args: unknown[]): Target[] => [args[1] as Target];
  const opened = (args: unknown[]): Target[] => {
    const flags = args[1];
    return typeof flags === "string" && WRITE_FLAGS.test(flags) || typeof flags === "number" && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_TRUNC)) !== 0
      ? [args[0] as Target] : [];
  };
  const stream = (args: unknown[]): Target[] => [args[0] as Target];
  const syncs = fs as unknown as Record<string, unknown>;
  for (const name of ["writeFile", "appendFile", "truncate", "rm", "rmdir", "unlink", "mkdir", "mkdtemp", "chmod", "chown", "utimes", "symlink", "link"]) {
    const paths = name === "symlink" || name === "link" ? second : first;
    wrap(syncs, name, paths); wrap(syncs, `${name}Sync`, paths);
    wrap(fsp as unknown as Record<string, unknown>, name, paths);
  }
  for (const name of ["rename", "copyFile", "cp"]) {
    const paths = name === "rename" ? both : second;
    wrap(syncs, name, paths); wrap(syncs, `${name}Sync`, paths);
    wrap(fsp as unknown as Record<string, unknown>, name, paths);
  }
  wrap(syncs, "open", opened); wrap(syncs, "openSync", opened);
  wrap(fsp as unknown as Record<string, unknown>, "open", opened);
  wrap(syncs, "createWriteStream", stream);
  syncBuiltinESMExports();
}
