/**
 * An agent's scripts for its Knowledge tab: the script files kept in its folder, the ones its brief names, and the ones its duties run as their
 * precheck. Only files that exist on this box are listed, each once, by the first place that names it.
 */
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import type { AgentScript } from "../web/src/lib/api/types.ts";
import type { Duty } from "../web/src/lib/api/shared/chat-duties.ts";

const SCRIPT_EXT = new Set([".py", ".mjs", ".cjs", ".js", ".ts", ".sh", ".bash", ".rb", ".go"]);
/** Folder parts that hold data, not tools: the harness stores, the jobs' workspaces, installed packages and dot folders. */
const SKIP_DIRS = /^(harness.*|jobs|node_modules|\..*)$/;
/** A path in prose: `~/`, `/`, `./` or a bare relative path, ending in a script extension. */
const PATH_IN_TEXT = /(?<![\w./~-])(~\/|\/|\.{1,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.(?:py|mjs|cjs|js|ts|sh|bash|rb|go)(?![\w/-])/g;

export type ScriptInput = { folderDir: string | null; brief: string; cwd: string; home: string; duties: readonly Duty[] };

const isScript = (path: string): boolean => SCRIPT_EXT.has(extname(path));

function fileAt(path: string): { real: string; modifiedAt: number } | null {
  try {
    const stat = statSync(path);
    return stat.isFile() ? { real: realpathSync(path), modifiedAt: stat.mtimeMs } : null;
  } catch {
    return null;
  }
}

/** Script files in the folder and its subfolders, less the data folders, in name order. */
function folderScripts(dir: string, depth = 0): string[] {
  let names: { name: string; dir: boolean; file: boolean }[];
  try {
    names = readdirSync(dir, { withFileTypes: true }).map(entry => ({ name: entry.name, dir: entry.isDirectory(), file: entry.isFile() }));
  } catch {
    return [];
  }
  names.sort((a, b) => a.name.localeCompare(b.name));
  return names.flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.file) return isScript(entry.name) ? [path] : [];
    return entry.dir && depth < 3 && !SKIP_DIRS.test(entry.name) ? folderScripts(path, depth + 1) : [];
  });
}

/** Each script path the brief names, resolved from home (`~/`), as written (`/`), or from the agent's cwd. */
function briefScripts(brief: string, cwd: string, home: string): string[] {
  return [...brief.matchAll(PATH_IN_TEXT)].map(([text]) => (text.startsWith("~/") ? join(home, text.slice(2)) : isAbsolute(text) ? text : resolve(cwd, text)));
}

/** The script a precheck runs: the first argument of its command that names a script file, from the precheck's cwd. */
export function precheckScript(command: readonly string[], cwd: string): string | null {
  const arg = command.find(part => !part.startsWith("-") && isScript(part));
  return arg ? resolve(cwd, arg) : null;
}

export function agentScripts(input: ScriptInput): AgentScript[] {
  const found: [string, AgentScript["from"]][] = [
    ...(input.folderDir && existsSync(input.folderDir) ? folderScripts(input.folderDir) : []).map((path): [string, AgentScript["from"]] => [path, { kind: "folder" }]),
    ...briefScripts(input.brief, input.cwd, input.home).map((path): [string, AgentScript["from"]] => [path, { kind: "brief" }]),
    ...input.duties.flatMap((duty): [string, AgentScript["from"]][] => {
      const path = precheckScript(duty.precheck.command, duty.precheck.cwd);
      return path ? [[path, { kind: "duty", duty: duty.id, name: duty.name }]] : [];
    }),
  ];
  const seen = new Set<string>();
  const out: AgentScript[] = [];
  for (const [path, from] of found) {
    const file = fileAt(path);
    if (!file || seen.has(file.real)) continue;
    seen.add(file.real);
    out.push({ path, from, modifiedAt: file.modifiedAt });
  }
  return out;
}
