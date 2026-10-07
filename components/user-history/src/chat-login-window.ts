import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import { findInstalledApp } from "./chat-open.ts";
import { runCommand, type Runner } from "./chat-remote.ts";
import type { RemoteAccessView } from "./shared/types.ts";

/**
 * "Open the app at login". launchd starts the chat at login, but nothing opened its window, so after a reboot the service was up and no window
 * showed. The first login start of each boot (a `serve --supervised` that owns the port) opens the installed app once the server answers.
 * The boot is `kern.boottime`, kept in a small marker in the data dir: a crash restart, an exit-75 update restart or `chat start` later in the
 * same boot reads the same boot time and opens nothing. That first start decides for the whole boot, so turning the switch on later in a boot
 * opens nothing until the next login.
 */

export type LoginWindowView = RemoteAccessView["openAppAtLogin"];
export type LoginWindowResult = "opened" | "same-boot" | "off" | "no-app" | "no-boot-time" | "failed";
/** What the marker keeps: the boot it decided for, when, and what it did. */
type Marker = { bootTime: number; at: string; result: LoginWindowResult };

/**
 * macOS moves kern.boottime when the clock is stepped (an NTP correction keeps the uptime fixed), so two readings in one boot can differ by a
 * second or so. Two boots are at least a login, a shutdown and a power-on apart, which is far more than this.
 */
export const BOOT_SLACK_SECONDS = 10;

/** `sysctl -n kern.boottime` prints `{ sec = 1791358485, usec = 354826 } Wed Oct  7 16:34:45 2026`. Returns seconds, or null. */
export function parseBootTime(text: string): number | null {
  const match = /\bsec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)/.exec(text);
  if (!match) return null;
  const seconds = Number(match[1]) + Number(match[2]) / 1e6;
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) / 1000 : null;
}

export async function readBootTime(run: Runner = runCommand): Promise<number | null> {
  const result = await run("/usr/sbin/sysctl", ["-n", "kern.boottime"], 5000);
  return result.code === 0 ? parseBootTime(result.stdout) : null;
}

export const sameBoot = (a: number, b: number) => Math.abs(a - b) <= BOOT_SLACK_SECONDS;

function parseMarker(value: unknown): Marker | null {
  if (typeof value !== "object" || value === null) return null;
  const { bootTime, at, result } = value as Record<string, unknown>;
  return typeof bootTime === "number" && Number.isFinite(bootTime) && typeof at === "string" && typeof result === "string" ? { bootTime, at, result: result as LoginWindowResult } : null;
}

type Options = {
  /** The local chat URL; the installed app is the one whose start URL is exactly this. */
  url: string;
  /** `<data dir>/login-window.json`. */
  markerPath: string;
  enabled: boolean;
  save(enabled: boolean): Promise<void>;
  /** True when launchd starts this chat at login ("Keep the chat running"); without that nothing runs at login to open the window. */
  startsAtLogin(): boolean;
  platform?: NodeJS.Platform;
  bootTime?: () => Promise<number | null>;
  findApp?: (url: string) => Promise<string | null>;
  open?: (app: string) => Promise<void>;
  log?: (line: string) => void;
  now?: () => Date;
};

const openApp = async (app: string) => {
  const result = await runCommand("/usr/bin/open", [app], 15_000);
  if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim().slice(0, 300) || `open exited ${result.code}`);
};

/** The switch, its Settings text, and the once-per-boot open. Only the main chat instance has one. */
export class LoginWindow {
  private enabled: boolean;
  /** The installed app found by the last look, and when that look ran. */
  private app: string | null = null;
  private lookedAt = 0;
  private looking: Promise<void> | null = null;

  constructor(private readonly options: Options) { this.enabled = options.enabled; }

  available(): boolean { return (this.options.platform ?? process.platform) === "darwin"; }

  /** The Settings view. Looks for the installed app again in the background when the last look is more than 5 s old. */
  status(): LoginWindowView {
    if (this.available() && Date.now() - this.lookedAt > 5000) void this.refresh();
    return this.view();
  }

  /** Looks for the installed app now. */
  async refresh(): Promise<LoginWindowView> {
    if (!this.available()) return this.view();
    this.looking ??= (async () => {
      try { this.app = await (this.options.findApp ?? (url => findInstalledApp(url, homedir())))(this.options.url); }
      catch { this.app = null; }
      finally { this.lookedAt = Date.now(); this.looking = null; }
    })();
    await this.looking;
    return this.view();
  }

  async setEnabled(enabled: boolean): Promise<LoginWindowView> {
    this.enabled = enabled;
    await this.options.save(enabled);
    return this.refresh();
  }

  private view(): LoginWindowView {
    const appName = this.app ? basename(this.app, ".app") : null;
    if (!this.available()) return { available: false, enabled: false, appName: null, message: "Opening the app at login works on macOS only." };
    const message = !this.enabled ? `Off. After a login, open ${appName ?? "the app"} from the Dock or with sieun-pi open.`
      : !appName ? "Install the chat as an app from Chrome first (Install page as app). Until then nothing opens at login."
      : !this.options.startsAtLogin() ? `Turn on "Keep the chat running" too. Without it nothing starts the chat at login to open ${appName}.`
      : `Opens ${appName} once after each login.`;
    return { available: true, enabled: this.enabled, appName, message };
  }

  /**
   * Called once by a login start after its server answered. The first call in a boot writes the marker, then opens the app if the switch is on
   * and an app is installed. Any later call in the same boot does nothing. Off macOS it does nothing.
   */
  async atLogin(): Promise<LoginWindowResult> {
    const log = this.options.log ?? (() => {});
    if (!this.available()) return "off";
    const boot = await (this.options.bootTime ?? readBootTime)().catch(() => null);
    if (boot === null) { log("open at login: could not read kern.boottime, nothing opened."); return "no-boot-time"; }
    // A missing or broken marker counts as no marker: the window opens rather than staying shut.
    const marker = parseMarker(await readFile(this.options.markerPath, "utf8").then(text => JSON.parse(text) as unknown).catch(() => null));
    if (marker && sameBoot(marker.bootTime, boot)) {
      // Follow small clock steps, so the slack is measured from the latest reading.
      if (marker.bootTime !== boot) await this.write({ ...marker, bootTime: boot }).catch(() => {});
      return "same-boot";
    }
    const app = this.enabled ? await this.refresh().then(() => this.app) : null;
    const result: LoginWindowResult = !this.enabled ? "off" : app ? "opened" : "no-app";
    // Written before the open, so a crash while the window opens cannot open a second one.
    await this.write({ bootTime: boot, at: (this.options.now ?? (() => new Date()))().toISOString(), result });
    if (result === "off") { log("open at login: the switch is off, nothing opened."); return result; }
    if (!app) { log("open at login: no installed app for this chat, nothing opened. Install it from Chrome (Install page as app)."); return result; }
    try { await (this.options.open ?? openApp)(app); }
    catch (error) {
      log(`open at login: could not open ${app}: ${error instanceof Error ? error.message : String(error)}`);
      await this.write({ bootTime: boot, at: (this.options.now ?? (() => new Date()))().toISOString(), result: "failed" }).catch(() => {});
      return "failed";
    }
    log(`open at login: opened ${app}.`);
    return result;
  }

  private async write(marker: Marker): Promise<void> {
    await mkdir(dirname(this.options.markerPath), { recursive: true });
    const temporary = `${this.options.markerPath}.tmp-${process.pid}`;
    await writeFile(temporary, JSON.stringify(marker) + "\n", { mode: 0o600 });
    await rename(temporary, this.options.markerPath);
  }
}
