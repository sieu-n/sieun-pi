import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * The artifact dir of one session, which holds its kernel snapshot, harness store and children, in Prime's layout.
 *
 * A child's session file lives in its own `sub-xxxxxxxx` dir under the parent's artifact dir, so that dir is the child's artifact dir.
 * A root's artifact dir is `<agent dir>/session-artifacts/<session id>`, which is where Prime keeps it for `<agent dir>/sessions/<id>.jsonl`.
 * A session with no file has none, and the caller picks a temporary dir.
 */
export function sessionArtifactDir(sessionId: string, sessionFile: string | undefined, agentDir: string = getAgentDir()): string | undefined {
  if (!sessionFile) return undefined;
  const dir = dirname(sessionFile);
  if (/^sub-[0-9a-f]{8}$/.test(basename(dir))) return dir;
  return join(agentDir, "session-artifacts", sessionId);
}
