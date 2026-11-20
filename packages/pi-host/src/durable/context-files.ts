/**
 * The instruction files each folder gives a pi thread. Prime's resource loader (`loadContextFileFromDir` in prime-agent
 * `core/resource-loader.js`) takes only the first of AGENTS.md, AGENTS.MD, CLAUDE.md and CLAUDE.MD in a folder, so a repo whose
 * CLAUDE.md sits beside a shorter AGENTS.md lost its CLAUDE.md. The owner wrote in #sw-factory-build p99: "whatever happens it should
 * load into prompt instead of just mention". pi-host loads both, the AGENTS file first and then the CLAUDE file, and drops one whose
 * text the other already holds. apps/chat's config page and the agent relay list the files through `folderContextFiles` too, so the page
 * shows what the prompt holds.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface ContextFile { path: string; content: string }

const AGENTS_NAMES = ["AGENTS.md", "AGENTS.MD"] as const;
const CLAUDE_NAMES = ["CLAUDE.md", "CLAUDE.MD"] as const;

/** The first of `names` in `dir` that can be read, as Prime's loader picks it. */
function firstFile(dir: string, names: readonly string[]): ContextFile | undefined {
  for (const name of names) {
    const path = resolve(dir, name);
    if (!existsSync(path)) continue;
    try {
      return { path, content: readFileSync(path, "utf8") };
    } catch {
      // Prime's loader warns and moves on to the next name.
    }
  }
  return undefined;
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * True when `outer` already says everything `inner` says: `inner` is the same file through a link, is blank, has its whole text inside
 * `outer`, or holds only Claude Code import lines (`@AGENTS.md`) that name `outer`, as sieun-pi's own CLAUDE.md does.
 */
export function holds(outer: ContextFile, inner: ContextFile): boolean {
  const text = inner.content.trim();
  if (!text || realPath(outer.path) === realPath(inner.path) || outer.content.includes(text)) return true;
  const target = realPath(outer.path);
  return text.split("\n").map(line => line.trim()).filter(Boolean)
    .every(line => line.startsWith("@") && realPath(resolve(dirname(inner.path), line.slice(1).trim())) === target);
}

/** The files a folder gives the prompt, in load order: its AGENTS file, then its CLAUDE file, less one the other holds. */
export function folderContextFiles(dir: string): ContextFile[] {
  const agents = firstFile(dir, AGENTS_NAMES);
  const claude = firstFile(dir, CLAUDE_NAMES);
  if (!agents || !claude) return agents ? [agents] : claude ? [claude] : [];
  if (holds(agents, claude)) return [agents];
  if (holds(claude, agents)) return [claude];
  return [agents, claude];
}

/** Prime's context files with each folder's whole set in place of the one file Prime's loader took from it, in Prime's folder order. */
export function withFolderFiles(files: readonly ContextFile[]): ContextFile[] {
  const out: ContextFile[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const own = folderContextFiles(dirname(file.path));
    for (const item of own.length ? own : [file]) {
      if (seen.has(item.path)) continue;
      seen.add(item.path);
      out.push(item);
    }
  }
  return out;
}
