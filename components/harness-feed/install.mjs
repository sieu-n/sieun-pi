#!/usr/bin/env node
// Install harness-feed from one commit and keep it running: systemd harness-feed.service on Linux, launchd com.sieun.harness-feed on macOS.
//   node components/harness-feed/install.mjs --ref <commit>
//   node components/harness-feed/install.mjs uninstall
// It unpacks the feed and the app files its readers import (components/prime-relay, components/user-history/src) from <commit> into
// ~/.local/share/harness-feed/release-<sha7>, points `current` at it with one rename and restarts the service, so a later checkout
// change cannot alter the running copy. `uninstall` stops the service and keeps the log.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const home = homedir();
const share = join(home, ".local/share/harness-feed");
const log = join(share, "feed.log");
const label = "com.sieun.harness-feed";
const unit = "harness-feed.service";
const plist = join(home, "Library/LaunchAgents", `${label}.plist`);
const unitFile = join(home, ".config/systemd/user", unit);
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
const PATHS = ["package.json", "components/harness-feed", "components/prime-relay", "components/user-history/package.json", "components/user-history/src"];

function write(path, text, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + ".tmp", text, { mode });
  renameSync(path + ".tmp", path);
}

const systemdUnit = script => `[Unit]
Description=harness-feed: coding harness health as OTLP metrics to the box's Alloy (sieun-pi components/harness-feed)

[Service]
Type=simple
ExecStart=${process.execPath} ${script}
Restart=always
RestartSec=10
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;

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

function stop() {
  if (platform() === "linux") spawnSync("systemctl", ["--user", "stop", unit]);
  else spawnSync("launchctl", ["bootout", `gui/${userInfo().uid}/${label}`]);
}

function start(script) {
  if (platform() === "linux") {
    write(unitFile, systemdUnit(script));
    execFileSync("systemctl", ["--user", "daemon-reload"]);
    execFileSync("systemctl", ["--user", "enable", unit]);
    execFileSync("systemctl", ["--user", "restart", unit]);
    return;
  }
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
    stop();
    if (platform() === "linux") { spawnSync("systemctl", ["--user", "disable", unit]); rmSync(unitFile, { force: true }); spawnSync("systemctl", ["--user", "daemon-reload"]); }
    else rmSync(plist, { force: true });
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
  stop();
  start(join(link, "components/harness-feed/feed.ts"));
  console.log(`harness-feed ${sha.slice(0, 7)} installed as ${platform() === "linux" ? unit : label}; log in ${log}`);
}

try { main(); } catch (error) { process.stderr.write(`harness-feed install: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
