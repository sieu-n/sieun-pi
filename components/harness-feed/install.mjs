#!/usr/bin/env node
// Install harness-feed from one commit and keep it running: launchd com.sieun.harness-feed on macOS, and on Linux (us-metal02) the
// container box-sieun-pi-harness-feed-1 of the Komodo Stack box-sieun-pi (auto-sns-agent apps/infra/box/compose.sieun-pi.yml).
//   node components/harness-feed/install.mjs --ref <commit>
//   node components/harness-feed/install.mjs uninstall      (macOS; on Linux remove the service from the compose file)
// It unpacks the feed and the app files its readers import (components/prime-relay, legacy/prime/user-history/src) from <commit> into
// ~/.local/share/harness-feed/release-<sha7>, points `current` at it with one rename and restarts the service, so a later checkout
// change cannot alter the running copy. On the Mac the feed logs to ~/.local/share/harness-feed/feed.log, and on Linux to the
// container's stdout (`docker logs box-sieun-pi-harness-feed-1`).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { restart } from "../../deploy/linux/komodo-stack.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const home = homedir();
const share = join(home, ".local/share/harness-feed");
const log = join(share, "feed.log");
const label = "com.sieun.harness-feed";
const plist = join(home, "Library/LaunchAgents", `${label}.plist`);
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
const PATHS = ["package.json", "components/harness-feed", "components/prime-relay", "legacy/prime/user-history/package.json", "legacy/prime/user-history/src"];

function write(path, text, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + ".tmp", text, { mode });
  renameSync(path + ".tmp", path);
}

const launchdPlist = script => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${script}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;

const stop = () => spawnSync("launchctl", ["bootout", `gui/${userInfo().uid}/${label}`]);

function start(script) {
  write(plist, launchdPlist(script));
  for (let attempt = 1; ; attempt++) {
    const result = spawnSync("launchctl", ["bootstrap", `gui/${userInfo().uid}`, plist], { encoding: "utf8" });
    if (result.status === 0) return;
    // A bootout ends asynchronously, so the bootstrap right after it can fail with an I/O error until the old job is gone.
    if (attempt === 20) throw new Error(`launchctl bootstrap failed: ${result.stderr.trim()}`);
    spawnSync("sleep", ["0.5"]);
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "uninstall") {
    if (platform() === "linux") throw new Error("on Linux the feed is a service of the Komodo Stack box-sieun-pi; remove it from auto-sns-agent apps/infra/box/compose.sieun-pi.yml");
    stop();
    rmSync(plist, { force: true });
    console.log(`harness-feed removed; log kept in ${log}`);
    return;
  }
  const ref = argv[argv.indexOf("--ref") + 1];
  if (!argv.includes("--ref") || !ref) throw new Error("usage: install.mjs --ref <commit> | uninstall");
  const sha = execFileSync("git", ["-C", repo, "rev-parse", "--verify", `${ref}^{commit}`], { encoding: "utf8", env: gitEnv }).trim();
  const release = join(share, `release-${sha.slice(0, 7)}`);
  if (!existsSync(release)) {
    const staging = `${release}.tmp-${process.pid}`;
    mkdirSync(staging, { recursive: true });
    const tar = execFileSync("git", ["-C", repo, "archive", "--format=tar", sha, "--", ...PATHS], { env: gitEnv, maxBuffer: 256 * 1024 * 1024 });
    execFileSync("tar", ["-x", "-C", staging], { input: tar });
    write(join(staging, "release.json"), `${JSON.stringify({ sha, installedAt: new Date().toISOString() })}\n`);
    renameSync(staging, release);
  }
  const link = join(share, "current");
  const next = `${link}.${process.pid}`;
  rmSync(next, { force: true });
  symlinkSync(release, next);
  renameSync(next, link);
  if (platform() === "linux") {
    restart("harness-feed");
    console.log(`harness-feed ${sha.slice(0, 7)} installed; the Komodo container box-sieun-pi-harness-feed-1 runs it`);
    return;
  }
  stop();
  start(join(link, "components/harness-feed/feed.ts"));
  console.log(`harness-feed ${sha.slice(0, 7)} installed as ${label}; log in ${log}`);
}

try { main(); } catch (error) { process.stderr.write(`harness-feed install: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
