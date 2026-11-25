import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Whether the module at `url` is the script node started. A duty precheck runs through the `current` symlink of a release, and node resolves
 * the main module to the release folder's real path, so `import.meta.url === \`file://${process.argv[1]}\`` read false and the script
 * exited 0 with no output: every agent's Area review on 11-26 05:39 KST failed with "no valid JSON in OUTPUT_FILE".
 */
export function isMain(url: string): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return url === pathToFileURL(realpathSync(script)).href;
  } catch {
    return false;
  }
}
