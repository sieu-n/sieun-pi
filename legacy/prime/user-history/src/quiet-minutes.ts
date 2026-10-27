import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * How long after the last turn on a box ends its agent sessions may still hold memory: the owner's target of 10-19 is that Settings > Hosts'
 * "Agent sessions" falls under QUIET_TARGET_GB within this many minutes once nobody works ("when everybody's asleep it should drop ram").
 * The Whole system duty's quiet_agent_gb judges the minutes past it, and the idle unload can stop sessions by the same number. It is one
 * setting, `{"minutes": N}` in `<dataDir>/quiet-minutes.json`, and QUIET_MINUTES while that file is absent or holds no whole number above 0.
 */
export const QUIET_MINUTES = 15;
export const QUIET_TARGET_GB = 5;
export const QUIET_FILE = "quiet-minutes.json";

export function quietMinutes(dataDir: string): number {
  try {
    const minutes = (JSON.parse(readFileSync(join(dataDir, QUIET_FILE), "utf8")) as { minutes?: unknown }).minutes;
    return typeof minutes === "number" && Number.isInteger(minutes) && minutes > 0 ? minutes : QUIET_MINUTES;
  } catch { return QUIET_MINUTES; }
}
