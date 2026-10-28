import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Whether the module at `url` is the script node was started with, read through links (04b5dc19). Inside Prime's compiled binary
 * process.argv[1] is "/$bunfs/root/prime-agent", which no disk path holds, so realpathSync threw at import and from 23:37Z on 10-27 the
 * whole user-history extension failed to load: no session or kernel got the agent message check, and cross-host sends failed with a plain
 * "No sibling matches". A path that does not resolve is never the main module.
 */
export function isMain(url: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}
