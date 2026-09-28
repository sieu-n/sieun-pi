import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";
import { runCommand, type Runner } from "./chat-remote.ts";

export const AUTOSTART_LABEL = "com.sieun.agent-chat";

export type LaunchJob = { node: string; cli: string; dataDir: string; port: number; socketPath: string; logPath: string };
export type KeepRunningSnapshot = { available: boolean; enabled: boolean; state: "on" | "off" | "problem"; message: string };

const escapeXml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/**
 * RunAtLoad starts chat at login; KeepAlive restarts it after a crash but not after `chat stop`, which exits 0.
 * Interactive lifts launchd's background CPU and I/O limits, which stretched a restart from 1.4 s to 10-40 s on a loaded Mac.
 */
export function launchAgentPlist(job: LaunchJob): string {
  const args = [job.node, job.cli, "serve", "--supervised", "--data-dir", job.dataDir, "--port", String(job.port), "--socket", job.socketPath];
  const path = [dirname(job.node), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].filter((entry, index, all) => all.indexOf(entry) === index).join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AUTOSTART_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(arg => `    <string>${escapeXml(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(job.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(job.logPath)}</string>
</dict>
</plist>
`;
}

type Options = {
  job: LaunchJob; enabled: boolean; save(enabled: boolean): Promise<void>;
  run?: Runner; plistPath?: string; uid?: number; platform?: NodeJS.Platform;
  /** True when launchd started this process for the job, so booting the job out would stop this server. */
  supervised?: boolean;
};

/** The macOS login item that keeps the main chat instance running. Only the main instance under the real home uses it. */
export class KeepRunning {
  private enabled: boolean;
  private snapshot: KeepRunningSnapshot;
  private readonly run: Runner;
  private readonly plistPath: string;
  private readonly domain: string;

  constructor(private readonly options: Options) {
    this.enabled = options.enabled;
    this.run = options.run ?? runCommand;
    this.plistPath = options.plistPath ?? join(userInfo().homedir, "Library", "LaunchAgents", AUTOSTART_LABEL + ".plist");
    this.domain = `gui/${options.uid ?? userInfo().uid}`;
    this.snapshot = { available: this.available(), enabled: this.enabled, state: this.enabled ? "on" : "off", message: "" };
  }

  available(): boolean { return (this.options.platform ?? process.platform) === "darwin"; }
  status(): KeepRunningSnapshot { return this.snapshot; }

  async setEnabled(enabled: boolean): Promise<KeepRunningSnapshot> {
    this.enabled = enabled;
    await this.options.save(enabled);
    return this.reconcile();
  }

  async loaded(): Promise<boolean> {
    return (await this.run("/bin/launchctl", ["print", `${this.domain}/${AUTOSTART_LABEL}`], 5000)).code === 0;
  }

  /** Writes the plist when it differs and loads the job when launchd does not have it. A loaded job keeps its old copy until the next login. */
  async install(): Promise<void> {
    const plist = launchAgentPlist(this.options.job);
    const current = await readFile(this.plistPath, "utf8").catch(() => null);
    if (current !== plist) {
      await mkdir(dirname(this.plistPath), { recursive: true });
      const temporary = this.plistPath + ".tmp-" + process.pid;
      await writeFile(temporary, plist, { mode: 0o644 });
      await rename(temporary, this.plistPath);
    }
    if (await this.loaded()) return;
    const result = await this.run("/bin/launchctl", ["bootstrap", this.domain, this.plistPath], 10_000);
    if (result.code !== 0 && !(await this.loaded())) throw new Error(`launchctl bootstrap failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
  }

  /** Starts the job now if launchd has it but it is not running. */
  async kick(): Promise<boolean> {
    await this.install();
    return (await this.run("/bin/launchctl", ["kickstart", `${this.domain}/${AUTOSTART_LABEL}`], 10_000)).code === 0;
  }

  async reconcile(): Promise<KeepRunningSnapshot> {
    if (!this.available()) return (this.snapshot = { available: false, enabled: false, state: "off", message: "Start at login works on macOS only." });
    try {
      if (this.enabled) {
        await this.install();
        this.snapshot = { available: true, enabled: true, state: "on", message: this.options.supervised
          ? "On. macOS starts the chat at login and restarts it if it crashes."
          : "On. macOS starts the chat at login. The login item takes over when this chat process stops." };
      } else {
        await unlink(this.plistPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
        // Booting out the job that runs this server would stop it mid-request. Removing the plist is enough for the next login.
        if (!this.options.supervised && await this.loaded()) await this.run("/bin/launchctl", ["bootout", `${this.domain}/${AUTOSTART_LABEL}`], 10_000);
        this.snapshot = { available: true, enabled: false, state: "off", message: "Off. Start chat with /agent-chat or sieun-pi chat start after a restart." };
      }
    } catch (error) {
      this.snapshot = { available: true, enabled: this.enabled, state: "problem", message: error instanceof Error ? error.message : String(error) };
    }
    return this.snapshot;
  }
}
