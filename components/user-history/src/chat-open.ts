import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { userInfo } from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Chromium browsers (Chrome, Aside) install a web app on macOS as a small app bundle in `~/Applications/<Browser> Apps.localized/`. Its
 * Info.plist names the start URL under `CrAppModeShortcutURL`; that is how the chat finds the app it installed, whichever browser installed it.
 */
export async function appBundles(home = userInfo().homedir): Promise<string[]> {
  const root = join(home, "Applications");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const bundles: string[] = [];
  for (const entry of entries) {
    if (entry.name.endsWith(".app")) bundles.push(join(root, entry.name));
    else if (entry.isDirectory() && entry.name.endsWith(".localized")) {
      for (const inner of await readdir(join(root, entry.name)).catch(() => [])) if (inner.endsWith(".app")) bundles.push(join(root, entry.name, inner));
    }
  }
  return bundles;
}

async function startUrl(bundle: string): Promise<string | null> {
  try {
    const { stdout } = await run("/usr/bin/plutil", ["-extract", "CrAppModeShortcutURL", "raw", "-o", "-", join(bundle, "Contents", "Info.plist")], { timeout: 5000 });
    return stdout.trim() || null;
  } catch { return null; }
}

/** The installed app whose start URL is the chat URL, if any. */
export async function findInstalledApp(url: string, home?: string): Promise<string | null> {
  for (const bundle of await appBundles(home)) if (await startUrl(bundle) === url) return bundle;
  return null;
}

/**
 * Opens the installed app window, else the URL in the default browser. Returns what it opened. Off macOS it opens nothing and returns null.
 */
export async function openChat(url: string): Promise<{ opened: "app" | "browser"; target: string } | null> {
  if (process.platform !== "darwin") return null;
  const app = await findInstalledApp(url);
  await run("/usr/bin/open", app ? [app] : [url], { timeout: 15000 });
  return app ? { opened: "app", target: app } : { opened: "browser", target: url };
}
