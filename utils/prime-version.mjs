import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The Prime Agent version this checkout is locked to: the release in the root package.json `prime-agent` tarball URL. scripts/sync-prime-agent.mjs moves it. */
export function lockedPrimeVersion(root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const match = /\/v(\d+\.\d+\.\d+)\/prime-agent-\1\.tgz$/.exec(pkg.dependencies?.["prime-agent"] ?? "");
  if (!match) throw new Error("package.json does not name an official prime-agent release tarball.");
  return match[1];
}
