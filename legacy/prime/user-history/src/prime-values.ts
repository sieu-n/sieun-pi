import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The two Prime values the extension's own graph reads, worked out here the way Prime's config.ts and session-manager.ts do. A bundle that imported
 * them from @earendil-works/pi-coding-agent loaded a second copy of Prime from node_modules when Bun imported the .mjs natively, about 1.2 CPU-s of
 * each Mac worker start on 11-08 (p1485). test/prime-values.test.ts checks both against Prime's own exports.
 */
export const CURRENT_SESSION_VERSION = 3;

/** Prime's getAgentDir: PRIME_AGENT_CODING_AGENT_DIR with a leading ~ expanded, else ~/.prime/agent. */
export function getAgentDir(): string {
  const dir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
  if (!dir) return join(homedir(), ".prime/agent");
  if (dir === "~") return homedir();
  return dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir;
}
