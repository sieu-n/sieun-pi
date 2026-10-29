#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join } from "node:path";

const USAGE = `usage: node components/prime-relay/agents/install.mjs [--root <pi-host tree>] [--node <node binary>] [--listen <tailnet ip>] [--port 7791]
                                                   [--pi-host-socket <path>] [--box <name>] [--chat-proxy-port 7792]

Runs the agent relay (relay.mjs's v1 routes plus /v2/agents and the local chat proxy) from the pi-host release tree:
  node <root>/components/prime-relay/agents/main.ts ~/.config/pi-host-relay/relay.json
<root> defaults to ~/.local/share/pi-host/current, so the relay runs the release pi-host runs. Flags overwrite the matching relay.json keys,
and a missing token file gets a new 0600 token. On Linux it rewrites ~/.config/systemd/user/pi-host-relay.service and restarts that unit only;
on macOS it writes and loads the launchd job com.sieun.pi-host-relay. It never touches pi-host itself. Prints the relay's health after.`;

const home = homedir();
const configDir = join(home, ".config/pi-host-relay");
const configFile = join(configDir, "relay.json");
const LABEL = "com.sieun.pi-host-relay";

function args(argv) {
  const options = {};
  const keys = { "--root": "root", "--node": "node", "--listen": "listen", "--port": "port", "--pi-host-socket": "piHostSocket", "--box": "box", "--chat-proxy-port": "chatProxyPort" };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "-h" || flag === "--help") { console.log(USAGE); process.exit(0); }
    const value = argv[++index];
    if (!keys[flag] || !value) throw new Error(`${keys[flag] ? `${flag} needs a value` : `unknown flag ${flag}`}\n${USAGE}`);
    options[keys[flag]] = flag === "--port" || flag === "--chat-proxy-port" ? Number(value) : value;
  }
  return options;
}

function writeAtomic(file, body, mode) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, body, { mode });
  renameSync(`${file}.tmp`, file);
  chmodSync(file, mode);
}

/** pi-host's socket where its own install puts it: $XDG_RUNTIME_DIR/pi-host/host.sock on Linux, ~/.local/state/pi-host/host.sock on macOS. */
const defaultPiHostSocket = () => platform() === "linux"
  ? join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${userInfo().uid}`, "pi-host", "host.sock")
  : join(home, ".local/state/pi-host/host.sock");

/** The PATH a check wake's command sees: node's own folder first, then the user's tools. */
const servicePath = node => [dirname(node), join(home, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");

function systemdUnit(node, script) {
  return `# The agent relay in front of pi-host (components/prime-relay/agents): relay.mjs's v1 routes, /v2/agents for the chat server, and the
# local chat proxy. Written by components/prime-relay/agents/install.mjs. Rollback: run relay.mjs here again, or systemctl --user disable --now pi-host-relay.
[Unit]
Description=agent relay in front of pi-host (/v1 routes and /v2/agents)
After=pi-host.service network-online.target

[Service]
Type=simple
Environment=PATH=${servicePath(node)}
ExecStart=${node} ${script} ${configFile}
Restart=always
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
`;
}

function launchdPlist(node, script, log) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${script}</string><string>${configFile}</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${servicePath(node)}</string></dict>
  <key>WorkingDirectory</key><string>${home}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}

async function health(config, token) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await fetch(`http://${config.listen}:${config.port}/v1/health`, { headers: { authorization: `Bearer ${token}` } });
      return `${response.status} ${await response.text()}`;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  return "no answer after 10 s";
}

async function main() {
  const options = args(process.argv.slice(2));
  const root = options.root ?? join(home, ".local/share/pi-host/current");
  const script = join(root, "components/prime-relay/agents/main.ts");
  if (!existsSync(script)) throw new Error(`${script} does not exist; install a pi-host release that has the agent relay first`);
  const node = options.node ?? process.execPath;
  const features = execFileSync(node, ["-p", "process.features.typescript"], { encoding: "utf8" }).trim();
  if (features !== "strip" && features !== "transform") throw new Error(`${node} cannot run .ts files (process.features.typescript is ${features}); pass a newer --node`);

  const current = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {};
  const tokenFile = current.tokenFile ?? join(configDir, "token");
  if (!existsSync(tokenFile)) writeAtomic(tokenFile, `${randomBytes(32).toString("hex")}\n`, 0o600);
  const piHostSocket = options.piHostSocket ?? current.piHostSocket ?? current.daemonSocket ?? defaultPiHostSocket();
  const config = {
    ...current,
    listen: options.listen ?? current.listen, port: options.port ?? current.port ?? 7791,
    daemonSocket: current.daemonSocket ?? piHostSocket, piHostSocket,
    roots: current.roots ?? ["~/.prime/agent/pi-sessions"], tokenFile,
    box: options.box ?? current.box, chatProxyPort: options.chatProxyPort ?? current.chatProxyPort ?? 7792,
  };
  if (!config.listen) throw new Error(`relay.json has no listen address; pass --listen <tailnet ip>\n${USAGE}`);
  if (!config.box) throw new Error(`relay.json has no box name; pass --box <name in ~/.config/sieun-pi/hosts.json>\n${USAGE}`);
  writeAtomic(configFile, `${JSON.stringify(config, null, 2)}\n`, 0o600);

  if (platform() === "linux") {
    writeAtomic(join(home, ".config/systemd/user/pi-host-relay.service"), systemdUnit(node, script), 0o644);
    execFileSync("systemctl", ["--user", "daemon-reload"]);
    execFileSync("systemctl", ["--user", "enable", "pi-host-relay.service"]);
    execFileSync("systemctl", ["--user", "restart", "pi-host-relay.service"]);
  } else {
    const log = join(home, ".local/share/pi-host/relay.log");
    mkdirSync(dirname(log), { recursive: true });
    const plist = join(home, `Library/LaunchAgents/${LABEL}.plist`);
    writeAtomic(plist, launchdPlist(node, script, log), 0o644);
    const domain = `gui/${userInfo().uid}`;
    if (spawnSync("launchctl", ["print", `${domain}/${LABEL}`]).status === 0) spawnSync("launchctl", ["bootout", `${domain}/${LABEL}`]);
    for (let attempt = 1; ; attempt++) {
      const result = spawnSync("launchctl", ["bootstrap", domain, plist], { encoding: "utf8" });
      if (result.status === 0) break;
      // A bootout finishes asynchronously, so the bootstrap right after it can fail with an I/O error until the old job is gone.
      if (attempt === 20) throw new Error(`launchctl bootstrap failed: ${result.stderr.trim()}`);
      spawnSync("sleep", ["0.5"]);
    }
  }
  const token = readFileSync(tokenFile, "utf8").trim();
  console.log(`agent relay for ${config.box} installed from ${script}: ${config.listen}:${config.port}/v2/agents, chat proxy 127.0.0.1:${config.chatProxyPort}, pi-host ${piHostSocket}, token in ${tokenFile}`);
  console.log(`health: ${await health(config, token)}`);
}

main().catch(error => { process.stderr.write(`agent relay install: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
