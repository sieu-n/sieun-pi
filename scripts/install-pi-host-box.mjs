#!/usr/bin/env node
/**
 * Installs one commit of pi-host on this box, on Linux as the systemd user unit pi-host.service and on macOS as the launchd job com.sieun.pi-host.
 *
 *   node scripts/install-pi-host-box.mjs [--ref origin/main] [--chat-url <url>] [--prepare-only] [--no-restart]
 *
 * 1. It exports the commit to ~/.local/share/pi-host/release-<sha7>, with its own node_modules in the root, packages and
 *    legacy/prime/user-history. A folder whose package.json and package-lock.json match the current release or the sieun-pi runtime
 *    reuses that node_modules as hard links (Linux) or clones (APFS); any other folder gets `npm ci --ignore-scripts`.
 * 2. It boots the release on a temp socket with temp session, data and durable dirs, and asks `durable_threads` there.
 * 3. It writes the unit or plist, points `current` at the release and restarts the service a few seconds later from a detached process, so
 *    a pi-host thread that runs this command can still answer before its host restarts. Durable threads resume after the restart.
 *
 * The service runs `node --import tsx pi-host/src/main.ts` from current/packages with Prime's agent dir ~/.prime/agent, the sessions in
 * ~/.prime/agent/pi-sessions and the durable threads in ~/.prime/agent/pi-host/durable, as pi-host.service on us-metal02 does. Rollback is
 * the same command with an older --ref, or pointing `current` back at the last release and restarting the service.
 */
import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEP_DIRS = [".", "packages", "legacy/prime/user-history"];
const LABEL = "com.sieun.pi-host";
const UNIT = "pi-host.service";
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "NODE_PATH"].includes(key)));

function run(command, args, cwd, capture = false) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", stdio: ["ignore", capture ? "pipe" : process.stderr, process.stderr] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.signal ?? result.status})`);
  return result.stdout?.trim() ?? "";
}

/** Where the service runs from, its socket and its log on this box. */
export function layout(home = homedir(), platform = process.platform) {
  const root = join(home, ".local/share/pi-host");
  const socket = platform === "darwin" ? join(home, ".local/state/pi-host/host.sock") : `/run/user/${userInfo().uid}/pi-host/host.sock`;
  return {
    root,
    current: join(root, "current"),
    socket,
    agentDir: join(home, ".prime/agent"),
    sessionDir: join(home, ".prime/agent/pi-sessions"),
    log: join(home, ".prime/agent/pi-host/host.log"),
    envFile: join(home, ".config/sieun-pi/agent.env"),
    unitFile: platform === "darwin" ? join(home, "Library/LaunchAgents", `${LABEL}.plist`) : join(home, ".config/systemd/user", UNIT),
  };
}

/** The environment pi-host.service on us-metal02 sets, plus the chat URL a box reaches apps/chat through. */
export function serviceEnv(home, node, chatUrl) {
  return {
    PATH: [dirname(node), join(home, ".local/bin"), "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    PI_TELEMETRY: "0",
    PI_SKIP_VERSION_CHECK: "1",
    SIEUN_CHAT_BACKEND: "pi-host",
    AGENT_CHAT_DATA_DIR: join(home, ".prime/agent/browser-chat-pi"),
    AGENT_CHAT_SHARED_DIR: join(home, ".prime/agent/browser-chat"),
    PI_AGENT_BUS_BOXES: join(home, ".config/pi-host-relay/boxes.json"),
    ...(chatUrl ? { PI_HOST_CHAT_URL: chatUrl } : {}),
  };
}

function hostArgs(paths) {
  return ["--import", "tsx", "pi-host/src/main.ts", "--socket", paths.socket, "--agent-dir", paths.agentDir, "--session-dir", paths.sessionDir];
}

const xml = text => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const shellQuote = text => `'${text.replace(/'/g, `'\\''`)}'`;

export function plist(paths, node, vars) {
  // launchd has no EnvironmentFile, so a shell reads agent.env (KEY=value lines) before it execs node, as systemd's EnvironmentFile=- does.
  const command = `[ -f ${shellQuote(paths.envFile)} ] && set -a && . ${shellQuote(paths.envFile)} && set +a; mkdir -p ${shellQuote(dirname(paths.socket))}; exec ${[node, ...hostArgs(paths)].map(shellQuote).join(" ")}`;
  const entries = Object.entries(vars).map(([key, value]) => `    <key>${xml(key)}</key><string>${xml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>${xml(command)}</string></array>
  <key>WorkingDirectory</key><string>${xml(join(paths.current, "packages"))}</string>
  <key>EnvironmentVariables</key>
  <dict>
${entries}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>2</integer>
  <key>ExitTimeOut</key><integer>60</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(paths.log)}</string>
  <key>StandardErrorPath</key><string>${xml(paths.log)}</string>
</dict>
</plist>
`;
}

export function systemdUnit(paths, node, vars) {
  const lines = Object.entries(vars).map(([key, value]) => `Environment=${key}=${value}`).join("\n");
  return `# pi-host, written by scripts/install-pi-host-box.mjs. It runs ~/.local/share/pi-host/current with Prime's agent dir for harness, skills and auth,
# its sessions in ~/.prime/agent/pi-sessions and its durable threads in ~/.prime/agent/pi-host/durable.
[Unit]
Description=pi-host, the Pi session host for sieun-pi (beside Prime, own session dir)
After=default.target

[Service]
Type=simple
WorkingDirectory=${join(paths.current, "packages")}
${lines}
EnvironmentFile=-${paths.envFile}
ExecStart=${[node, ...hostArgs({ ...paths, socket: "%t/pi-host/host.sock" })].join(" ")}
RuntimeDirectory=pi-host
RuntimeDirectoryPreserve=restart
KillSignal=SIGTERM
TimeoutStopSec=60
Restart=always
RestartSec=2
UMask=0077
StandardOutput=append:${paths.log}
StandardError=append:${paths.log}

[Install]
WantedBy=default.target
`;
}

const same = (a, b, name) => { try { return readFileSync(join(a, name)).equals(readFileSync(join(b, name))); } catch { return false; } };

/** A node_modules folder whose package.json and package-lock.json match `dir`'s, from the current release or the sieun-pi runtime. */
function donorModules(home, current, dir, staged) {
  for (const base of [current, join(home, ".local/share/sieun-pi-runtime/current")]) {
    const from = join(base, dir);
    if (!existsSync(join(from, "node_modules")) || !same(from, staged, "package.json") || !same(from, staged, "package-lock.json")) continue;
    return realpathSync(join(from, "node_modules"));
  }
  return undefined;
}

function copyModules(from, to) {
  if (process.platform === "darwin") return run("cp", ["-c", "-R", from, to], dirname(to));
  // Hard links cost no space, and no release writes into its node_modules after it is built.
  try { run("cp", ["-al", from, to], dirname(to)); } catch { rmSync(to, { recursive: true, force: true }); run("cp", ["-a", from, to], dirname(to)); }
}

function buildRelease(repo, sha, release, current, home, npmCache) {
  const staging = `${release}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const archive = `${staging}.tar`;
  run("git", ["archive", "--format=tar", "--output", archive, sha], repo);
  run("tar", ["-xf", archive, "-C", staging], repo);
  rmSync(archive);
  for (const dir of DEP_DIRS) {
    const target = join(staging, dir);
    const donor = donorModules(home, current, dir, target);
    if (donor) { process.stderr.write(`node_modules in ${dir}: reused from ${donor}\n`); copyModules(donor, join(target, "node_modules")); }
    else { process.stderr.write(`node_modules in ${dir}: npm ci\n`); run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", npmCache], target); }
  }
  writeFileSync(join(staging, "release.json"), JSON.stringify({ sha, source: repo, builtAt: new Date().toISOString() }, null, 2) + "\n");
  renameSync(staging, release);
}

function request(socket, command, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const conn = createConnection(socket);
    let buffer = "";
    let hello = false;
    const timer = setTimeout(() => { conn.destroy(); reject(new Error(`${command.type} on ${socket} timed out`)); }, timeoutMs);
    conn.setEncoding("utf8");
    conn.on("error", error => { clearTimeout(timer); reject(error); });
    conn.on("data", chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (line.type === "daemon_hello" && !hello) { hello = true; conn.write(`${JSON.stringify({ ...command, id: "boot" })}\n`); }
        else if (line.type === "response" && line.id === "boot") { clearTimeout(timer); conn.end(); resolvePromise({ hello, response: line }); }
      }
    });
  });
}

/** Starts the release on a temp socket with its own session, data and durable dirs, so it touches no thread, schedule or kernel of the live host. */
async function bootCheck(release, node, home, chatUrl) {
  const dir = mkdtempSync(join(tmpdir(), "pi-host-boot-"));
  const socket = join(dir, "s.sock");
  const log = join(dir, "boot.log");
  const args = ["--import", "tsx", "pi-host/src/main.ts", "--socket", socket, "--agent-dir", join(home, ".prime/agent"), "--session-dir", join(dir, "sessions"),
    "--data-dir", join(dir, "data"), "--durable-dir", join(dir, "durable")];
  const fd = openSync(log, "a");
  const child = spawn(node, args, { cwd: join(release, "packages"), env: { ...env, ...serviceEnv(home, node, chatUrl), PI_HOST_RLM: "0" }, stdio: ["ignore", fd, fd] });
  const started = Date.now();
  try {
    let lastError;
    while (Date.now() - started < 120_000) {
      if (child.exitCode !== null) throw new Error(`pi-host exited ${child.exitCode} during the boot check:\n${readFileSync(log, "utf8").slice(-3000)}`);
      if (existsSync(socket)) {
        try {
          const { response } = await request(socket, { type: "durable_threads" }, 30_000);
          if (!response.success) throw new Error(`durable_threads failed: ${response.error}`);
          return { ms: Date.now() - started, threads: response.data.threads.length };
        } catch (error) { lastError = error; }
      }
      await new Promise(done => setTimeout(done, 250));
    }
    throw new Error(`pi-host did not answer on ${socket} within 120 s: ${lastError?.message ?? "no socket"}\n${readFileSync(log, "utf8").slice(-3000)}`);
  } finally {
    child.kill("SIGTERM");
    await new Promise(done => { if (child.exitCode !== null) done(); else { child.once("exit", done); setTimeout(() => { child.kill("SIGKILL"); done(); }, 15_000); } });
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
}

const present = path => { try { lstatSync(path); return true; } catch { return false; } };

function flip(paths, release) {
  if (present(paths.current) && !lstatSync(paths.current).isSymbolicLink()) throw new Error(`Refusing to replace a non-symlink: ${paths.current}`);
  const next = `${paths.current}.next`;
  rmSync(next, { force: true });
  symlinkSync(release.split("/").pop(), next);
  renameSync(next, paths.current);
}

/** Restarts the service a few seconds after this process ends, from a process in its own session, so a caller inside pi-host still answers. */
function delayedRestart(platform, sha7, unitFile, delaySec = 5) {
  if (platform === "darwin") {
    const domain = `gui/${userInfo().uid}`;
    const script = `sleep ${delaySec}; launchctl print ${domain}/${LABEL} >/dev/null 2>&1 && launchctl kickstart -k ${domain}/${LABEL} || launchctl bootstrap ${domain} ${shellQuote(unitFile)}`;
    spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" }).unref();
    return `launchctl kickstart -k ${domain}/${LABEL} in ${delaySec} s`;
  }
  run("systemctl", ["--user", "daemon-reload"], "/");
  run("systemctl", ["--user", "enable", UNIT], "/");
  run("systemd-run", ["--user", `--unit=pi-host-restart-${sha7}-${Date.now()}`, "--collect", `--on-active=${delaySec}`, "systemctl", "--user", "restart", UNIT], "/");
  return `systemctl --user restart ${UNIT} in ${delaySec} s`;
}

export async function installPiHost({ repo = checkout, ref = "origin/main", home = homedir(), node = process.execPath, chatUrl, prepareOnly = false, restart = true } = {}) {
  const platform = process.platform;
  if (platform !== "darwin" && platform !== "linux") throw new Error(`pi-host installs on Linux and macOS, not ${platform}`);
  if (ref.startsWith("origin/")) run("git", ["fetch", "--quiet", "origin"], repo);
  const sha = run("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], repo, true);
  const sha7 = sha.slice(0, 7);
  const paths = layout(home, platform);
  mkdirSync(paths.root, { recursive: true });
  const release = join(paths.root, `release-${sha7}`);
  const lock = join(paths.root, ".installing");
  try { mkdirSync(lock); } catch (error) {
    if (error.code === "EEXIST") throw new Error(`pi-host install is locked at ${lock}; remove it only after the process in ${join(lock, "owner.json")} has exited.`);
    throw error;
  }
  try {
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, sha, startedAt: new Date().toISOString() }) + "\n");
    const npmCache = join(home, ".npm");
    if (!existsSync(release)) buildRelease(repo, sha, release, paths.current, home, npmCache);
    const boot = await bootCheck(release, node, home, chatUrl);
    process.stderr.write(`boot check: answered durable_threads in ${boot.ms} ms\n`);
    if (prepareOnly) return { sha, release, boot, prepared: true };
    const vars = serviceEnv(home, node, chatUrl);
    mkdirSync(dirname(paths.unitFile), { recursive: true });
    mkdirSync(dirname(paths.log), { recursive: true });
    mkdirSync(dirname(paths.socket), { recursive: true });
    const unit = platform === "darwin" ? plist(paths, node, vars) : systemdUnit(paths, node, vars);
    const previous = present(paths.current) ? readlinkSync(paths.current) : undefined;
    writeFileSync(paths.unitFile, unit);
    flip(paths, release);
    const restarted = restart ? delayedRestart(platform, sha7, paths.unitFile) : "not restarted (--no-restart)";
    return { sha, release, previous, unitFile: paths.unitFile, socket: paths.socket, boot, restarted };
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    ref: { type: "string", default: "origin/main" }, repo: { type: "string", default: checkout }, home: { type: "string", default: homedir() }, node: { type: "string", default: process.execPath },
    "chat-url": { type: "string" }, "prepare-only": { type: "boolean", default: false }, "no-restart": { type: "boolean", default: false }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log("usage: node scripts/install-pi-host-box.mjs [--ref origin/main] [--repo <checkout>] [--home <dir>] [--node <node>] [--chat-url <url>] [--prepare-only] [--no-restart]");
  } else {
    try {
      console.log(JSON.stringify(await installPiHost({ ref: values.ref, repo: values.repo, home: values.home, node: values.node, chatUrl: values["chat-url"], prepareOnly: values["prepare-only"], restart: !values["no-restart"] }), null, 2));
    } catch (error) {
      console.error(`install-pi-host-box: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
