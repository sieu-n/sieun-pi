/** The ops the agent relay answers on its own box: a wake's shell check, the box's info, and reads and writes of agent folders. */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { defaultProjects } from "../../../apps/chat/server/config.ts";
import type { BoxInfo } from "./protocol.ts";

/** How much of a check's output comes back; the same tail as legacy wakes.ts CHECK_TAIL. */
const CHECK_TAIL = 1500;
const PATH_WITH_LOCAL = [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", process.env.PATH ?? ""].join(":");

export interface CheckAnswer { ok: boolean; code: number | null; output: string }

/** Runs a check wake's command with sh from home, as legacy wakes.ts runCheck does, and also gives its exit code (null when killed). */
export function runCheck(command: string, timeoutMs: number): Promise<CheckAnswer> {
  return new Promise(resolve => {
    execFile("sh", ["-c", command], { cwd: homedir(), timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PATH: PATH_WITH_LOCAL } }, (error, stdout, stderr) => {
      const output = `${stdout}${stderr}`.slice(-CHECK_TAIL);
      const code = !error ? 0 : typeof error.code === "number" ? error.code : null;
      resolve({ ok: !error, code, output: error && !output.trim() ? error.message : output });
    });
  });
}

export function boxInfo(box: string, home: string, agentsDir: string): BoxInfo {
  return { box, platform: platform(), home, projects: defaultProjects(home).filter(path => existsSync(path)), agentsDir };
}

const expand = (path: string): string => (path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

/**
 * The real path `asked` names when it lies under agentsDir, else an Error. A path that does not exist yet resolves through its nearest existing
 * parent, so a write may make new folders inside an agent folder but a symlink cannot lead out of agentsDir.
 */
async function underAgents(asked: unknown, agentsDir: string): Promise<string> {
  if (typeof asked !== "string" || !isAbsolute(expand(asked))) throw new Error("path must be absolute or start with ~/");
  const base = await realpath(agentsDir).catch(() => agentsDir);
  let probe = expand(asked);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = join(await realpath(probe), ...rest);
      if (real === base || real.startsWith(base + sep)) return real;
      break;
    } catch {
      if (dirname(probe) === probe) break;
      rest.unshift(basename(probe));
      probe = dirname(probe);
    }
  }
  throw new Error(`path is outside ${agentsDir}`);
}

export type FileGet = { exists: false } | { exists: true; text: string; size: number; modifiedAt: number };

export async function fileGet(args: Record<string, unknown>, agentsDir: string): Promise<FileGet> {
  const path = await underAgents(args.path, agentsDir);
  const info = await stat(path).catch(() => null);
  if (!info) return { exists: false };
  if (!info.isFile()) throw new Error(`${path} is not a file`);
  return { exists: true, text: await readFile(path, "utf8"), size: info.size, modifiedAt: info.mtimeMs };
}

/** Writes `text` (or `content`) to the file atomically, making its folders, or removes it on `delete: true`. */
export async function filePut(args: Record<string, unknown>, agentsDir: string): Promise<Record<string, never>> {
  const path = await underAgents(args.path, agentsDir);
  if (args.delete === true) {
    await rm(path, { force: true });
    return {};
  }
  const text = typeof args.text === "string" ? args.text : args.content;
  if (typeof text !== "string") throw new Error("file_put needs text, or delete: true");
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, text);
  await rename(temp, path);
  return {};
}
