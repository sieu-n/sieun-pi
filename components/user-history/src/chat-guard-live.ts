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

const cache = new Map<string, Guard>();
export async function liveGuard(agentDir: string, home = homedir()): Promise<Guard> {
  try {
    const file = liveRulesFile(agentDir, home);
    const key = `${file}@${statSync(file).mtimeMs}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const module = await import(file) as Partial<Guard>;
    if (typeof module.tellTurn !== "function" || typeof module.tellOwner !== "function") return loaded;
    const guard: Guard = { tellTurn: module.tellTurn, tellOwner: module.tellOwner, ...(typeof module.askedTodos === "function" ? { askedTodos: module.askedTodos } : {}) };
    cache.clear();
    cache.set(key, guard);
    return guard;
  } catch {
    return loaded;
  }
}
