/**
 * stablePath(): a path inside a pi-host release, named through the install's `current` link, as sieun-rules `release-path.py` does for
 * the kernel guard's paths. A kernel keeps the PYTHONPATH and PATH it started with, and every child it starts inherits them, while an
 * install prunes old release folders. On 11-26 every pi-host kernel on us-metal02 named pi-host/release-<sha>/packages/pi-rlm/python/src
 * and the pi-rlm skill folders on its PYTHONPATH, so a prune of that release would break each child Python that imports them.
 * The install swaps `current` by rename, so a path through it stays valid.
 */
import { existsSync } from "node:fs";
import { sep } from "node:path";

/** <share>/pi-host/release-<sha>/<rest> as <share>/pi-host/current/<rest> when that exists under current; any other path stays as it is. */
export function stablePath(path: string): string {
  const parts = path.split(sep);
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] !== "pi-host" || !parts[i + 1]!.startsWith("release-")) continue;
    const rest = parts.slice(i + 2);
    const moved = [...parts.slice(0, i + 1), "current", ...rest].join(sep);
    return rest.length > 0 && existsSync(moved) ? moved : path;
  }
  return path;
}
