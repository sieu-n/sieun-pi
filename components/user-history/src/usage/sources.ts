import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import type { UsageSource } from "../shared/usage.ts";
import { claudeCode, codex, piFormat, type ParserSpec } from "./parsers.ts";

/**
 * The clients read on this Mac, in tokscale's scope (crates/tokscale-core/src/scanner.rs and clients.rs): each root is
 * watched recursively and `accepts` decides which files under it are transcripts. Database sources (Hermes, OpenCode)
 * are small SQLite files read whole when they change.
 */
/** `sweepMs`: how often the safety sweep lists this root; unset means every sweep (5 min). Archives change rarely. */
export type FileRoot = { source: UsageSource; root: string; spec: ParserSpec; accepts(path: string): boolean; sweepMs?: number };
const archiveSweepMs = 6 * 60 * 60_000;
export type DatabaseSource = { source: UsageSource; path: string; watch: string };

const jsonl = (path: string) => path.endsWith(".jsonl");

export function fileRoots(home = homedir()): FileRoot[] {
  const prime = join(home, ".prime", "agent");
  const artifacts = join(prime, "session-artifacts");
  return [
    // Root sessions sit flat in sessions/.
    { source: "prime-agent", root: join(prime, "sessions"), spec: piFormat, accepts: path => jsonl(path) && !relative(join(prime, "sessions"), path).includes(sep) },
    // Root sessions the owner moved out of sessions/ (tokscale does not read this folder). Call ids do not depend on the
    // path, so a moved file merges with the rows it already gave and counts once.
    { source: "prime-agent", root: join(prime, "sessions-archive"), spec: piFormat, accepts: jsonl, sweepMs: archiveSweepMs },
    // RLM children: session-artifacts/<root id>/sub-<id>/[sub-<id>/...]<session>.jsonl. tokscale reads every .jsonl in the
    // tree but rlm-subagents.jsonl and keeps only files that open with a session header; requiring the sub-* chain skips
    // the artifact files agents write there without opening them.
    { source: "prime-agent", root: artifacts, spec: piFormat, accepts: path => {
      if (!jsonl(path)) return false;
      const parts = relative(artifacts, path).split(sep);
      return parts.length >= 3 && parts.slice(1, -1).every(part => part.startsWith("sub-")) && parts.at(-1) !== "rlm-subagents.jsonl";
    } },
    // Claude Code: projects/<project>/<session>.jsonl and subagents/**; workflow journal.jsonl files are metadata.
    { source: "claude-code", root: join(process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "projects"), spec: claudeCode,
      accepts: path => jsonl(path) && !(path.endsWith(`${sep}journal.jsonl`) && path.includes(`${sep}subagents${sep}`)) },
    { source: "codex", root: join(home, ".codex", "sessions"), spec: codex, accepts: path => jsonl(path) && path.split(sep).at(-1)!.startsWith("rollout-") },
    { source: "codex", root: join(home, ".codex", "archived_sessions"), spec: codex, accepts: path => jsonl(path) && path.split(sep).at(-1)!.startsWith("rollout-"), sweepMs: archiveSweepMs },
    { source: "pi", root: join(home, ".pi", "agent", "sessions"), spec: piFormat, accepts: jsonl },
  ];
}

export function databaseSources(home = homedir()): DatabaseSource[] {
  return [
    { source: "hermes", path: join(process.env.HERMES_HOME ?? join(home, ".hermes"), "state.db"), watch: process.env.HERMES_HOME ?? join(home, ".hermes") },
    { source: "opencode", path: join(home, ".local", "share", "opencode", "opencode.db"), watch: join(home, ".local", "share", "opencode") },
  ];
}
