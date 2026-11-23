// Prunes old release folders of an app home, such as ~/.local/share/sieun-pi-apps-chat, and keeps each one a live process still runs in.
import { readdirSync, readlinkSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * The release folders under `home` that a live process has as its working directory, read from /proc (an empty set where /proc is absent).
 * A duty precheck runs from `current/apps/chat`, so its cwd is the release that was current when it started. On 11-23 at 07:50Z the release of
 * 0799d1a removed release-66951ec while agent factory's d4 after-job precheck still ran in it, and its next blind set failed with
 * MODULE_NOT_FOUND, which d4 scored as 5 failed notes of 10.
 */
export function releasesInUse(home, proc = "/proc") {
  const used = new Set();
  let pids = [];
  try { pids = readdirSync(proc).filter(entry => /^\d+$/.test(entry)); } catch { return used; }
  for (const pid of pids) {
    let cwd;
    try { cwd = readlinkSync(join(proc, pid, "cwd")); } catch { continue; }
    if (cwd.startsWith(`${home}/`)) used.add(cwd.slice(home.length + 1).split("/")[0]);
  }
  return used;
}

/** Removes each folder of `home` whose name matches `pattern`, except those in `keep` and those a live process runs in. Returns the names kept for use. */
export function prune(home, pattern, keep, used = releasesInUse(home)) {
  const held = [];
  for (const entry of readdirSync(home)) {
    if (!pattern.test(entry) || keep.includes(entry)) continue;
    if (used.has(entry)) { held.push(entry); continue; }
    rmSync(join(home, entry), { recursive: true, force: true });
  }
  return held;
}
