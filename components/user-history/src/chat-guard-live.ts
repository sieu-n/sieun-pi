import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import * as loaded from "./chat-guard.ts";

/**
 * The tell_owner rules a chat follows on each call come from the live release, not from the build it loaded, so a change to the check reaches
 * every chat at once (10-20: Crawler VP and CI and RepoOps ran a build hours old, since their turns never left a gap for a reload, c117).
 * The live release is the one the extension link points at when that is a release (the Mac's runtime), else the chat service's current/ (the
 * server, whose link points at the working checkout). Any failure falls back to the rules the chat loaded.
 */
export type Guard = Pick<typeof loaded, "tellTurn" | "tellOwner"> & Partial<Pick<typeof loaded, "askedTodos">>;

export function liveRulesFile(agentDir: string, home = homedir()): string {
  const linked = realpathSync(join(agentDir, "extensions", "user-history"));
  const dir = linked.split(sep).includes("releases") ? linked : realpathSync(join(home, ".local", "share", "sieun-pi-chat", "current", "components", "user-history"));
  return realpathSync(join(dir, "src", "chat-guard.ts"));
}

/**
 * One load per rules file version, shared by every call that asks while it runs. Prime loads the extension through jiti, which evaluates the
 * file again on each import and hands a second import that starts mid-load the half-evaluated module. On 10-22 two chats sent two tell_owner
 * calls in one step as their first after release-03705d8 went live, and the second failed with "Cannot access 'TELL_CASES' before
 * initialization", so the chat sent it again (chats 01a1636f and 01a16379, 11:50:48Z and 11:59:16Z).
 */
const cache = new Map<string, Promise<Guard>>();
export async function liveGuard(agentDir: string, home = homedir()): Promise<Guard> {
  let key: string;
  let file: string;
  try {
    file = liveRulesFile(agentDir, home);
    key = `${file}@${statSync(file).mtimeMs}`;
  } catch {
    return loaded;
  }
  const hit = cache.get(key);
  if (hit) return hit;
  const load = import(file).then((module: Partial<Guard>): Guard => {
    if (typeof module.tellTurn !== "function" || typeof module.tellOwner !== "function") return loaded;
    return { tellTurn: module.tellTurn, tellOwner: module.tellOwner, ...(typeof module.askedTodos === "function" ? { askedTodos: module.askedTodos } : {}) };
  }, () => {
    cache.delete(key);
    return loaded;
  });
  cache.clear();
  cache.set(key, load);
  return load;
}
