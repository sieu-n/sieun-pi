#!/usr/bin/env node
// Install harness-feed from one commit and keep it running: launchd com.sieun.harness-feed on macOS, and on Linux (us-metal02) the
// container box-sieun-pi-harness-feed-1 of the Komodo Stack box-sieun-pi (auto-sns-agent apps/infra/box/compose.sieun-pi.yml).
//   node components/harness-feed/install.mjs --ref <commit>
//   node components/harness-feed/install.mjs uninstall      (macOS; on Linux remove the service from the compose file)
// It unpacks the feed and the app files its readers import (components/prime-relay, legacy/prime/user-history/src) from <commit> into
// ~/.local/share/harness-feed/release-<sha7>, imports its feed.ts module graph there with the service's loader, and only when every module loads
// points `current` at it with one rename and restarts the service, so a later checkout change cannot alter the running copy and a
// release that cannot load never replaces one that runs. On 11-25 release 39923ec swapped in with apps/chat missing from PATHS and
// the feed was down 14:10:50 to 14:11:06Z on ERR_MODULE_NOT_FOUND. On the Mac the feed logs to ~/.local/share/harness-feed/feed.log, and on Linux to the
// container's stdout (`docker logs box-sieun-pi-harness-feed-1`).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { restart } from "../../deploy/linux/komodo-stack.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const home = homedir();
const share = join(home, ".local/share/harness-feed");
const log = join(share, "feed.log");
const label = "com.sieun.harness-feed";
const plist = join(home, "Library/LaunchAgents", `${label}.plist`);
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
export const PATHS = ["package.json", "components/harness-feed", "components/prime-relay", "legacy/prime/user-history/package.json", "legacy/prime/user-history/src"];

// How the service runs feed.ts on both boxes: `node --import tsx` with the sieun-pi checkout as its working directory, where tsx resolves
// from its node_modules. The user-history files the readers import use TypeScript parameter properties, which plain node refuses
// (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX in chat-handoff.ts). The Komodo container sets the same in compose.sieun-pi.yml, and on the Mac
// launchdPlist writes it, so loadCheck runs the node, loader and directory the service will run.
export const SERVICE = { node: process.execPath, loader: ["--import", "tsx"], cwd: repo };

/**
 * Imports the release's feed.ts module graph with the service's node, loader and working directory, plus the app modules the
 * duties reader loads lazily (its `loadApp`, which a release before this check does not export). feed.ts starts its loop only when it is
 * node's entry script, so the import runs no round. Returns null when every module loads, else node's error.
 */
export function loadCheck(release, service = SERVICE) {
  const feed = pathToFileURL(join(release, "components/harness-feed/feed.ts")).href;
  const duties = pathToFileURL(join(release, "components/harness-feed/readers/duties.ts")).href;
  const code = `await import(${JSON.stringify(feed)}); const duties = await import(${JSON.stringify(duties)}); await duties.loadApp?.();`;
  const result = spawnSync(service.node, [...service.loader, "--input-type=module", "-e", code], { cwd: service.cwd, encoding: "utf8" });
  if (result.status === 0) return null;
  const output = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim();
  const reason = output.split("\n").find(line => /^\w*Error\b/.test(line));
  return reason ?? (output || `exit ${result.status ?? result.signal}`);
}

/** Points `<share>/current` at the release with one rename and restarts the service, only after the release passed loadCheck. */
export function activate(release, share, restartService, check = loadCheck) {
  const failure = check(release);
  if (failure) throw new Error(`${release} does not load, so current and the service stay as they were: ${failure}`);
  const link = join(share, "current");
  const next = `${link}.${process.pid}`;
  rmSync(next, { force: true });
  symlinkSync(release, next);
  renameSync(next, link);
  restartService(link);
}

function write(path, text, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + ".tmp", text, { mode });
  renameSync(path + ".tmp", path);
}

const xml = text => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The launchd job for feed.ts: SERVICE's node, loader and working directory, the same command line loadCheck imports the release with. */
export const launchdPlist = (script, service = SERVICE) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${[service.node, ...service.loader, script].map(arg => `<string>${xml(arg)}</string>`).join("")}</array>
  <key>WorkingDirectory</key><string>${xml(service.cwd)}</string>
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
  if (platform() === "linux") {
    activate(release, share, () => restart("harness-feed"));
    console.log(`harness-feed ${sha.slice(0, 7)} installed; the Komodo container box-sieun-pi-harness-feed-1 runs it`);
    return;
  }
  activate(release, share, link => {
    stop();
    start(join(link, "components/harness-feed/feed.ts"));
  });
  console.log(`harness-feed ${sha.slice(0, 7)} installed as ${label}; log in ${log}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) try { main(); } catch (error) { process.stderr.write(`harness-feed install: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
