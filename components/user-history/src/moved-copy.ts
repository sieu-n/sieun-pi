import { existsSync, readdirSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

/*
 * A chat that moved to another box leaves its old files in `<agent dir>/moved-to-<host>/` on the box it left (the move job's folder). At 05:35Z
 * on 10-18 the Mac daemon reopened its old copy of 'tiktok shop' for a message, before the move job had moved that copy aside, and the copy ran
 * tool calls until 05:39Z. Prime knows nothing of moves, so sieun-pi's extension refuses the tools of a session whose tree is in such a folder.
 */
const MOVED = /^moved-to-(.+)$/;

/** The root session id of a session file under the agent dir: sessions/<root>.jsonl or session-artifacts/<root>/...; else null. */
export function treeRoot(agentDir: string, sessionFile: string): string | null {
  const parts = relative(agentDir, sessionFile).split(sep);
  if (parts[0] === "sessions" && parts.length === 2) return basename(parts[1]!, ".jsonl");
  if (parts[0] === "session-artifacts" && parts.length > 2) return parts[1]!;
  return null;
}

/** The host a session's chat moved to, when its root's file sits in a moved-to-<host> folder of the agent dir; null for a session that lives here. */
export function movedTo(agentDir: string, sessionFile: string | undefined): string | null {
  const root = sessionFile ? treeRoot(agentDir, sessionFile) : null;
  if (!root) return null;
  let names: string[];
  try { names = readdirSync(agentDir); } catch { return null; }
  for (const name of names) {
    const host = MOVED.exec(name)?.[1];
    if (host && existsSync(join(agentDir, name, "sessions", `${root}.jsonl`))) return host;
  }
  return null;
}

/** The reason a moved session's tool call is refused, read by the agent in that copy. */
export const movedReason = (host: string): string =>
  `This chat moved to ${host}, and this is its old copy on the box it left, so its tools are off. Reply in one line that this copy is stale and end the turn. The live chat runs on ${host}.`;
