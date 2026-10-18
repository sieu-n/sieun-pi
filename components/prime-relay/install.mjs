#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `usage: node components/prime-relay/install.mjs --ref <commit> [--listen <tailnet ip>] [--port 7790] [--daemon-socket <path>]

Copies relay.mjs, host-stats.ts, slim-snapshot.mjs, line-delta.ts and sieun-pi's worker-footprint.py from <commit> to ~/.local/share/prime-relay, writes ~/.config/prime-relay/relay.json and a token file when they are missing, adds the default read roots (sessions, session-artifacts, logs) to it,
and (re)starts the service: prime-relay.service (systemd --user) on Linux, com.sieun.prime-relay (launchd) on macOS.
Flags given on the command line overwrite the matching relay.json keys. Prints the health of the running relay.`;

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const home = homedir();
const share = join(home, ".local/share/prime-relay");
const configDir = join(home, ".config/prime-relay");
const configFile = join(configDir, "relay.json");
const tokenFile = join(configDir, "token");
/**
 * The folders another box may read, GET only. The daemon logs let the chat host's resume pass (resume_paused.py) see this box's daemon restarts
 * and worker stops, which archive and abort turns no one asked to stop. A root a relay.json already lists stays.
 */
const ROOTS = ["~/.prime/agent/sessions", "~/.prime/agent/session-artifacts", "~/.prime/agent/logs"];
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));

function args(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "-h" || flag === "--help") { console.log(USAGE); process.exit(0); }
    const value = argv[++index];
    if (!value) throw new Error(`${flag} needs a value\n${USAGE}`);
    if (flag === "--ref") options.ref = value;
    else if (flag === "--listen") options.listen = value;
    else if (flag === "--port") options.port = Number(value);
    else if (flag === "--daemon-socket") options.daemonSocket = value;
    else throw new Error(`unknown flag ${flag}\n${USAGE}`);
  }
  if (!options.ref) throw new Error(`name the commit with --ref\n${USAGE}`);
  return options;
}

function writeAtomic(file, body, mode) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, body, { mode });
  renameSync(`${file}.tmp`, file);
  chmodSync(file, mode);
}

const tailscaleIp = () => {
  for (const bin of ["tailscale", "/usr/bin/tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
    const result = spawnSync(bin, ["ip", "-4"], { encoding: "utf8" });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim().split("\n")[0];
  }
  throw new Error("no tailscale ip -4; pass --listen");
};

/** The socket Prime's defaultDaemonSocketPath picks: <tmpdir>/prime-agent-<uid>/daemon.sock, with /tmp on Linux. */
const defaultSocket = () => join(platform() === "linux" ? "/tmp" : tmpdir(), `prime-agent-${userInfo().uid}`, "daemon.sock");

function systemdUnit(node, script) {
  return `[Unit]
Description=prime-relay: the Prime daemon socket and session reads over the tailnet, token checked
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=${node} ${script} ${configFile}
Restart=always
RestartSec=5
UMask=0077
StandardOutput=append:${join(share, "relay.log")}
StandardError=append:${join(share, "relay.log")}

[Install]
WantedBy=default.target
`;
}

function launchdPlist(node, script) {
  const log = join(share, "relay.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.sieun.prime-relay</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${script}</string><string>${configFile}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}

function main() {
  const options = args(process.argv.slice(2));
  const sha = execFileSync("git", ["-C", repo, "rev-parse", "--verify", `${options.ref}^{commit}`], { encoding: "utf8", env: gitEnv }).trim();
  const show = file => execFileSync("git", ["-C", repo, "show", `${sha}:components/prime-relay/${file}`], { encoding: "utf8", env: gitEnv, maxBuffer: 16 * 1024 * 1024 });
  const script = join(share, "relay.mjs");
  writeAtomic(join(share, "host-stats.ts"), show("host-stats.ts"), 0o644);
  writeAtomic(join(share, "slim-snapshot.mjs"), show("slim-snapshot.mjs"), 0o644);
  writeAtomic(join(share, "line-delta.ts"), show("line-delta.ts"), 0o644);
  // POST /v1/watch runs sieun-pi's worker footprint helper on this box for the chat service on another box.
  writeAtomic(join(share, "worker-footprint.py"), execFileSync("git", ["-C", repo, "show", `${sha}:components/user-history/src/worker-footprint.py`], { encoding: "utf8", env: gitEnv, maxBuffer: 16 * 1024 * 1024 }), 0o644);
  writeAtomic(script, show("relay.mjs"), 0o644);
  writeAtomic(join(share, "release.json"), `${JSON.stringify({ sha, installedAt: new Date().toISOString() })}\n`, 0o644);
  if (!existsSync(tokenFile)) writeAtomic(tokenFile, `${randomBytes(32).toString("hex")}\n`, 0o600);
  const current = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {};
  const config = {
    listen: options.listen ?? current.listen ?? tailscaleIp(), port: options.port ?? current.port ?? 7790,
    daemonSocket: options.daemonSocket ?? current.daemonSocket ?? defaultSocket(),
    roots: [...new Set([...(current.roots ?? []), ...ROOTS])], tokenFile: current.tokenFile ?? tokenFile,
  };
  writeAtomic(configFile, `${JSON.stringify(config, null, 2)}\n`, 0o600);
  const node = process.execPath;
  if (platform() === "linux") {
    writeAtomic(join(home, ".config/systemd/user/prime-relay.service"), systemdUnit(node, script), 0o644);
    execFileSync("systemctl", ["--user", "daemon-reload"]);
    execFileSync("systemctl", ["--user", "enable", "prime-relay.service"]);
    execFileSync("systemctl", ["--user", "restart", "prime-relay.service"]);
  } else {
    const plist = join(home, "Library/LaunchAgents/com.sieun.prime-relay.plist");
    writeAtomic(plist, launchdPlist(node, script), 0o644);
    const domain = `gui/${userInfo().uid}`;
    if (spawnSync("launchctl", ["print", `${domain}/com.sieun.prime-relay`]).status === 0) spawnSync("launchctl", ["bootout", `${domain}/com.sieun.prime-relay`]);
    for (let attempt = 1; ; attempt++) {
      const result = spawnSync("launchctl", ["bootstrap", domain, plist], { encoding: "utf8" });
      if (result.status === 0) break;
      // A bootout finishes asynchronously, so the bootstrap right after it can fail with an I/O error until the old job is gone.
      if (attempt === 20) throw new Error(`launchctl bootstrap failed: ${result.stderr.trim()}`);
      spawnSync("sleep", ["0.5"]);
    }
  }
  console.log(`prime-relay ${sha.slice(0, 7)} installed: ${config.listen}:${config.port} -> ${config.daemonSocket}, token in ${config.tokenFile}`);
}

try { main(); } catch (error) { process.stderr.write(`prime-relay install: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
