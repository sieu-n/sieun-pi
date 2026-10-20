import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { access, chmod, constants, link, mkdir, open, readdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { parsePublicOrigin, parseRemoteFlag, type RemoteSetting } from "./chat-origin.ts";
import { KeepRunning, loginItemCli } from "./chat-autostart.ts";
import { LoginWindow } from "./chat-login-window.ts";
import { remoteChatService } from "./chat-host.ts";
import { openChat } from "./chat-open.ts";
import { RemoteAccess, tailnetOwner, type RemoteControl } from "./chat-remote.ts";
import { runsSlack, SlackBridge, slackChats } from "./chat-slack.ts";
import { takeListenFd } from "./listen-fd.ts";
import type { EarlyShell } from "./early-shell.ts";
import type { RemoteMode } from "./shared/types.ts";

/**
 * `adopt`: which chats a serve acts on. `live` is every chat in its chats.json plus the session-file scan, `own` only the chats it created.
 * Unset: `live` for the main instance, `own` for any other, so a test or scratch serve never attaches, steers or reloads a live chat.
 * `scratch`: the serve only reads (`isScratch`); `--scratch` sets it, and a serve outside the live data dir is one without the flag.
 * `liveReadsOnly`: a scratch serve may read the live daemon socket (`--live-reads-only`); without it the serve refuses that socket.
 * `replayDaemon`: a scratch serve on a recorded fake daemon (`--replay-daemon`) attaches and pins the chats of its chats.json as a live start does,
 * when that daemon's hello carries `replay: true` (src/read-only-daemon.ts). Its other loops stay off, and the live socket stays refused.
 */
type Options = { port?: number; socketPath?: string; dataDir?: string; remote?: RemoteSetting; supervised?: boolean; adopt?: "live" | "own"; scratch?: boolean; liveReadsOnly?: boolean; replayDaemon?: boolean };
type Configuration = {
  port: number; socketPath: string; capability: string; csrfToken: string; stopToken: string;
  /** The remote HTTPS origin: fixed for `custom`, the last tailnet name seen for `tailscale`. */
  publicOrigin: string | null; remoteAccess: RemoteMode; keepRunning: boolean;
  /** Settings > Phone access > "Open the app at login". On unless turned off. */
  openAppAtLogin: boolean;
};
type Instance = { pid: number; instanceId: string; url: string };
type Service = { directory: string; config: Configuration; url: string; primary: boolean };

/** Loading prime-agent costs about a CPU second (10 s at a load of 80), so only a command that needs its paths or the daemon loads it. */
const defaultSocket = async (): Promise<string> => (await import("prime-agent")).defaultDaemonSocketPath();
const secret = () => randomBytes(32).toString("hex");
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isSecret = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const hasCode = (error: unknown, code: string) => isRecord(error) && error.code === code;
function validPort(port: number): number {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Use a port from 1 to 65535.");
  return port;
}
/**
 * Phone access through Tailscale and the login item are on by default only for the main instance: the default data
 * directory under the account's real home. Test and extra instances (`--data-dir`, a changed HOME or agent dir) start
 * with both off, so they never touch Tailscale Serve or launchd unless asked.
 */
async function isPrimary(directory: string): Promise<boolean> {
  if (process.env.SIEUN_PI_CHAT_AUTOMATIC === "0") return false;
  return isLiveDirectory(directory);
}
/** The live data dir is the one the service unit and the login item serve: browser-chat under the account's real home. */
async function isLiveDirectory(directory: string): Promise<boolean> {
  return await realpath(join(userInfo().homedir, ".prime", "agent", "browser-chat")).catch(() => null) === directory;
}
/**
 * A scratch serve, such as a CPU profile on a copy of the live data dir, only reads: its wakes, briefs, duties and archive queue are the live
 * service's copies, and its socket is the live daemon's. From 08:25:10Z to 08:25:47Z on 10-18 a profile serve on port 44357 with a copy of
 * browser-chat woke 3 jobs, reopened 01a1180e to relay a wake, and ran pi-pool priority on 2 live trees.
 */
async function isScratch(options: Options, directory: string): Promise<boolean> {
  return options.scratch === true || !await isLiveDirectory(directory);
}
/** The live daemon's socket is the default one, which the service unit passes as `--socket /tmp/prime-agent-%U/daemon.sock`. */
async function isLiveSocket(socketPath: string): Promise<boolean> {
  const real = (path: string) => realpath(path).catch(() => resolve(path));
  return await real(socketPath) === await real(await defaultSocket());
}
/**
 * The main instance starts the Prime Agent daemon when its socket does not answer (after a reboot nothing else starts it). Test and extra
 * instances leave the daemon alone. SIEUN_PI_CHAT_START_DAEMON=1 or 0 overrides that for one process.
 */
function startsDaemon(primary: boolean): boolean {
  const flag = process.env.SIEUN_PI_CHAT_START_DAEMON;
  return flag === "1" ? true : flag === "0" ? false : primary;
}
/**
 * The main instance has the "Open the app at login" switch, and its login start (`serve --supervised`) opens the app window once per boot.
 * SIEUN_PI_CHAT_OPEN_AT_LOGIN=1 gives another instance the switch and makes its `serve` act as a login start (the isolated check uses it); 0 turns it off.
 */
function opensAppAtLogin(primary: boolean): boolean {
  const flag = process.env.SIEUN_PI_CHAT_OPEN_AT_LOGIN;
  return flag === "1" ? true : flag === "0" ? false : primary;
}
function configuration(value: unknown, primary: boolean): Configuration {
  if (!isRecord(value) || typeof value.port !== "number" || typeof value.socketPath !== "string" || !value.socketPath.startsWith("/") ||
    !isSecret(value.capability) || !isSecret(value.csrfToken) || !isSecret(value.stopToken)) throw new Error("Invalid private chat configuration. Refusing to replace it.");
  const publicOrigin = parsePublicOrigin(value.publicOrigin ?? null);
  const saved = value.remoteAccess;
  const remoteAccess: RemoteMode = saved === "tailscale" || saved === "custom" || saved === "off" ? saved
    : publicOrigin ? primary && new URL(publicOrigin).hostname.endsWith(".ts.net") ? "tailscale" : "custom" : primary ? "tailscale" : "off";
  if (remoteAccess === "custom" && !publicOrigin) throw new Error("Invalid private chat configuration: custom remote access needs publicOrigin.");
  const keepRunning = typeof value.keepRunning === "boolean" ? value.keepRunning : primary && process.platform === "darwin";
  const openAppAtLogin = typeof value.openAppAtLogin === "boolean" ? value.openAppAtLogin : true;
  return { port: validPort(value.port), socketPath: value.socketPath, capability: value.capability, csrfToken: value.csrfToken, stopToken: value.stopToken,
    publicOrigin, remoteAccess, keepRunning, openAppAtLogin };
}
async function saveConfiguration(service: Service, patch: Partial<Pick<Configuration, "publicOrigin" | "remoteAccess" | "keepRunning" | "openAppAtLogin">>): Promise<void> {
  Object.assign(service.config, patch);
  await privateWrite(join(service.directory, "configuration.json"), service.config);
}
const sameRemote = (config: Configuration, remote: RemoteSetting) =>
  config.remoteAccess === remote.mode && (remote.mode !== "custom" || config.publicOrigin === remote.origin);
function phoneUrl(service: Service): string | null {
  return service.config.remoteAccess !== "off" && service.config.publicOrigin ? `${service.config.publicOrigin}/${service.config.capability}/` : null;
}
function instance(value: unknown): Instance {
  if (!isRecord(value) || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid < 1 ||
    typeof value.instanceId !== "string" || !/^[a-f0-9-]{36}$/.test(value.instanceId) || typeof value.url !== "string") throw new Error("Invalid private chat instance record.");
  return { pid: value.pid, instanceId: value.instanceId, url: value.url };
}
async function readJson(path: string): Promise<unknown> { return JSON.parse(await readFile(path, "utf8")); }
async function privateWrite(path: string, value: unknown, exclusive = false): Promise<void> {
  const temporary = path + "." + randomUUID();
  await writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
  try {
    if (exclusive) await link(temporary, path);
    else await rename(temporary, path);
  } finally { await unlink(temporary).catch(error => { if (!hasCode(error, "ENOENT")) throw error; }); }
}
async function loadService(options: Options, create: boolean): Promise<Service | null> {
  const directoryPath = resolve(options.dataDir ?? join((await import("prime-agent")).getAgentDir(), "browser-chat"));
  if (create) { await mkdir(directoryPath, { recursive: true, mode: 0o700 }); await chmod(directoryPath, 0o700); }
  let directory: string;
  try { directory = await realpath(directoryPath); }
  catch (error) { if (!create && hasCode(error, "ENOENT")) return null; throw error; }
  const path = join(directory, "configuration.json");
  const primary = await isPrimary(directory);
  let config: Configuration;
  try { config = configuration(await readJson(path), primary); }
  catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    if (!create) return null;
    const proposed = { port: validPort(options.port ?? 5182), socketPath: resolve(options.socketPath ?? await defaultSocket()),
      capability: secret(), csrfToken: secret(), stopToken: secret(), publicOrigin: options.remote?.origin ?? null,
      ...(options.remote ? { remoteAccess: options.remote.mode } : {}) };
    try { await privateWrite(path, proposed, true); }
    catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
    config = configuration(await readJson(path), primary);
  }
  if ((options.port !== undefined && validPort(options.port) !== config.port) ||
    (options.socketPath !== undefined && resolve(options.socketPath) !== config.socketPath)) {
    throw new Error(`Chat configuration uses port ${config.port} and socket ${config.socketPath}. Use those settings, or stop it and choose a separate --data-dir for the new configuration.`);
  }
  const service: Service = { directory, config, url: `http://127.0.0.1:${config.port}/${config.capability}/`, primary };
  if (create && options.remote !== undefined && !sameRemote(config, options.remote)) {
    if (await running(service)) throw new Error("Stop chat before changing --public-origin, or change Phone access in Settings. Native sessions keep running.");
    await saveConfiguration(service, { remoteAccess: options.remote.mode, publicOrigin: options.remote.origin });
  }
  return service;
}
async function running(service: Service): Promise<Instance | null> {
  let response: Response;
  try { response = await fetch(service.url + "api/identity", { signal: AbortSignal.timeout(1200), redirect: "error" }); }
  catch (error) {
    if (isRecord(error) && error.name === "TimeoutError") throw new Error(`Port ${service.config.port} did not answer the chat identity check. Refusing to attach or stop it.`);
    return null;
  }
  if (!response.ok) throw new Error(`Port ${service.config.port} is occupied by an unverified service. Leave it running and choose --port with a separate --data-dir.`);
  let value: unknown;
  try { value = await response.json(); }
  catch { throw new Error(`Port ${service.config.port} returned an invalid chat identity. Refusing to attach or stop it.`); }
  let record: Instance;
  try { record = instance(await readJson(join(service.directory, "instance.json"))); }
  catch (error) { if (hasCode(error, "ENOENT")) return null; throw error; }
  if (!isRecord(value) || value.service !== "sieun-pi-chat" || value.instanceId !== record.instanceId || value.pid !== record.pid ||
    value.socketPath !== service.config.socketPath || record.url !== service.url) {
    // A restart keeps the last serve's record until the new serve rewrites it; that record of a dead process counts as no record.
    if (!alive(record.pid)) return null;
    throw new Error(`Port ${service.config.port} does not match the private chat instance. Refusing to attach or stop it.`);
  }
  return record;
}

const cliPath = fileURLToPath(new URL("./chat-service-cli.mjs", import.meta.url));

/** The node binary for the login item. Inside Prime Agent `process.execPath` is Prime itself, so PATH is searched. */
async function findNode(): Promise<string | null> {
  const candidates = /^node(\.exe)?$/.test(process.execPath.split("/").pop() ?? "") ? [process.execPath]
    : (process.env.PATH ?? "").split(":").filter(Boolean).map(entry => join(entry, "node"));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch { /* next */ }
  }
  return null;
}
function keepRunningFor(service: Service, node: string, supervised = false): KeepRunning {
  return new KeepRunning({
    job: { node, cli: loginItemCli(process.argv[1], cliPath), dataDir: service.directory, port: service.config.port, socketPath: service.config.socketPath, logPath: join(service.directory, "service.log") },
    enabled: service.config.keepRunning, supervised, save: enabled => saveConfiguration(service, { keepRunning: enabled }),
  });
}
async function waitForService(service: Service, timeoutMs: number): Promise<Instance | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = await running(service).catch(() => null);
    if (record) return record;
    await delay(250);
  }
  return null;
}
/** The marker every chat serve process carries on its command line (`chat-service-cli.mjs serve ...`). */
const SERVE = "chat-service-cli.mjs serve";
/**
 * `<data dir>/serves/<pid>`: one empty file per serve process of this data directory, written before the serve opens the usage database
 * and removed when it exits. A serve that dies before it publishes instance.json (a failed start, a hung build) is still found here.
 */
async function recordServe(service: Service): Promise<void> {
  const directory = join(service.directory, "serves");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, String(process.pid));
  await writeFile(path, "", { mode: 0o600 });
  process.once("exit", () => { try { unlinkSync(path); } catch { /* already gone */ } });
}
async function isServe(pid: number): Promise<boolean> {
  try { return (await promisify(execFile)("ps", ["-ww", "-o", "command=", "-p", String(pid)])).stdout.includes(SERVE); }
  catch { return false; }
}
/** Live serve processes recorded for this data directory, other than `except`. A record whose process is gone, or is no serve now, is removed. */
async function recordedServes(service: Service, except?: number): Promise<number[]> {
  const directory = join(service.directory, "serves");
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) { if (hasCode(error, "ENOENT")) return []; throw error; }
  const live: number[] = [];
  for (const name of names) {
    const pid = Number(name);
    if (!Number.isSafeInteger(pid) || pid < 1 || String(pid) !== name || pid === except) continue;
    if (await isServe(pid)) live.push(pid);
    else await unlink(join(directory, name)).catch(() => {});
  }
  return live;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return hasCode(error, "EPERM"); } };
/** SIGTERM, then SIGKILL after 5 s. Resolves once the process is gone or 2 s after the SIGKILL. */
async function terminate(pid: number): Promise<void> {
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  for (let waited = 0; waited < 5000 && alive(pid); waited += 100) await delay(100);
  if (!alive(pid)) return;
  try { process.kill(pid, "SIGKILL"); } catch { return; }
  for (let waited = 0; waited < 2000 && alive(pid); waited += 100) await delay(100);
}
const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;
/** The start timeout, 60 s. SIEUN_PI_CHAT_START_TIMEOUT_MS shortens it for one process (the failed-start test uses it). */
export const START_TIMEOUT_MS = 60_000;
function startTimeoutMs(): number {
  const value = Number(process.env.SIEUN_PI_CHAT_START_TIMEOUT_MS);
  return Number.isSafeInteger(value) && value > 0 ? value : START_TIMEOUT_MS;
}
const adoptFlag = (options: Options): string[] => options.adopt === "own" ? ["--no-adopt"] : options.adopt === "live" ? ["--adopt-live"] : [];
/**
 * The other boxes of hosts.json; null without the file. `primary` opens the bridge sockets, and another instance lists the boxes through the
 * main instance's sockets. A bad file or a socket that cannot open is logged and leaves the chat running on this box alone.
 */
async function startHosts(primary: boolean): Promise<{ bridge: { close(): Promise<void> } | null; catalogs: import("./host-catalogs.ts").HostCatalogs } | null> {
  const log = (line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);
  const [{ HOSTS_FILE, HostBridge, loadHosts }, { HostCatalogs }, { BridgeThread }] = await Promise.all([import("./hosts.ts"), import("./host-catalogs.ts"), import("./host-bridge-thread.ts")]);
  if (!(await access(HOSTS_FILE).then(() => true, () => false))) return null;
  try {
    const registry = await loadHosts();
    const bridge = new HostBridge(registry, { log, replaceLive: true });
    // The sockets run on their own thread (src/host-bridge-thread.ts), so a busy main thread does not hold up the Mac's reads and prompts.
    const thread = primary ? new BridgeThread(registry, { log, replaceLive: true }) : null;
    await thread?.start();
    log(`hosts: ${registry.hosts.map(host => host.name).join(", ")} from ${HOSTS_FILE}${primary ? ", bridges open" : ""}`);
    return { bridge: thread, catalogs: new HostCatalogs(registry, bridge, undefined, log, primary) };
  } catch (error) { log(`hosts: ${error instanceof Error ? error.message : String(error)}`); return null; }
}

const withPhone = (service: Service, record: Instance): Instance & { phoneUrl: string | null } => ({ ...record, phoneUrl: phoneUrl(service) });

export async function ensureChatService(options: Options = {}): Promise<Instance & { phoneUrl: string | null }> {
  const service = await loadService({ ...options, socketPath: options.socketPath ?? await defaultSocket() }, true);
  if (!service) throw new Error("Could not create chat configuration.");
  const existing = await running(service);
  if (existing) return withPhone(service, existing);
  // The main instance runs as a macOS login item, so launchd restarts it after a crash and starts it at login.
  const node = service.primary && service.config.keepRunning && process.platform === "darwin" ? await findNode() : null;
  if (node) {
    const kicked = await keepRunningFor(service, node).kick().catch(error => {
      process.stderr.write(`Could not start the chat login item, starting chat directly: ${error instanceof Error ? error.message : String(error)}\n`);
      return false;
    });
    const record = kicked ? await waitForService(service, 60_000) : null;
    if (record) return withPhone(service, record);
  }
  const log = await open(join(service.directory, "service.log"), "a", 0o600);
  await log.chmod(0o600);
  const child = spawn("node", [cliPath, "serve", "--data-dir", service.directory,
    "--port", String(service.config.port), "--socket", service.config.socketPath, ...adoptFlag(options)], { detached: true, stdio: ["ignore", log.fd, log.fd, "ipc"] });
  await log.close();
  const timeoutMs = startTimeoutMs();
  const result = await new Promise<string | null>(accept => {
    let settled = false;
    const finish = (error: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (child.connected) child.disconnect();
      child.unref();
      accept(error);
    };
    const timeout = setTimeout(() => finish(`Chat startup timed out after ${Math.round(timeoutMs / 1000)} s. Inspect ${join(service.directory, "service.log")}.`), timeoutMs);
    child.once("error", error => finish(error.message));
    child.once("message", value => {
      if (isRecord(value) && value.ready === true) finish(null);
      else if (isRecord(value) && typeof value.error === "string") finish(value.error);
    });
    child.once("exit", code => finish(`Chat process exited (${code}). Inspect ${join(service.directory, "service.log")}.`));
  });
  // A serve that failed or timed out may already hold the usage database lock; it never outlives the start that spawned it.
  if (result !== null && child.pid !== undefined && !exited(child)) await terminate(child.pid);
  // The bind winner can still be publishing its private identity when another starter loses the port race.
  for (let attempt = 0; attempt < 20; attempt++) {
    const record = await running(service);
    if (record) return withPhone(service, record);
    await delay(50);
  }
  throw new Error(result ?? `Chat did not answer on port ${service.config.port}. Inspect ${join(service.directory, "service.log")}.`);
}

async function serve(options: Options): Promise<void> {
  const service = await loadService({ ...options, socketPath: options.socketPath ?? await defaultSocket() }, true);
  if (!service) throw new Error("Could not create chat configuration.");
  const instancePath = join(service.directory, "instance.json");
  // Under socket activation systemd owns the port and queues connections while this process starts, so the identity check below would wait on
  // this process itself; only one service of the unit runs, so no other chat can hold the port.
  const listenFd = takeListenFd();
  if (options.supervised && listenFd === null) {
    if (!service.primary || !service.config.keepRunning) { process.stdout.write("Keep running is off for this chat. The login item exits.\n"); return; }
    // Another chat process owns the port. Wait for it: take over after a crash, stay idle after chat stop.
    let waited = false;
    for (;;) {
      const current = await running(service).catch(() => "unverified" as const);
      if (!current) break;
      waited = true;
      await delay(5000);
    }
    if (waited && !(await access(instancePath).then(() => true, () => false))) {
      process.stdout.write("The chat stopped cleanly. The login item stays idle until chat start or the next login.\n"); return;
    }
  }
  const scratch = await isScratch(options, service.directory);
  if (scratch && options.adopt === "live") throw new Error("A scratch serve only reads, so it cannot adopt the live chats. Drop --adopt-live, or serve the live data dir without --scratch.");
  if (options.liveReadsOnly && !scratch) throw new Error("--live-reads-only is for a scratch serve: add --scratch, or serve a copy of the data dir.");
  if (options.replayDaemon && (!scratch || options.liveReadsOnly)) throw new Error("--replay-daemon is for a scratch serve on a recorded fake daemon: add --scratch, and drop --live-reads-only.");
  // At 12:17Z on 10-18 a --scratch serve on a copy of browser-chat and the live socket opened 01a14d31, which its copied own-chats.json named,
  // and reloaded its extension, which rebuilt the chat's Python kernel. The live socket takes an explicit flag, and even then only reads.
  // These refusals read only the flags and the socket, so they come before the port's identity check, which a busy port or a slow box can fail.
  if (scratch && !options.liveReadsOnly && await isLiveSocket(service.config.socketPath)) {
    throw new Error(`A scratch serve refuses the live daemon socket ${service.config.socketPath}. Point --socket at a fake daemon, or pass --live-reads-only to read the live sessions; the serve then still sends only reads (no attach, reload, restart, setting or message).`);
  }
  const existing = listenFd === null ? await running(service) : null;
  if (existing) throw new Error(`Chat already runs at ${existing.url}. Use chat start to reuse it.`);
  // A scratch serve on the live dir still keeps off everything the main instance owns: the daemon, the bridges, Slack, Tailscale and login.
  const primary = service.primary && !scratch;
  if (scratch) process.stderr.write(`${new Date().toISOString()} scratch serve: it only reads; no wakes, briefs, check-ins, duties, job cleanup, archives, resumes, reopens, adopts or pool writes (${service.directory})\n`);
  // A scratch serve writes nothing under the live agent dir (src/scratch-fence.ts): it refuses to run on it, and every file write of the
  // process under it fails. On 10-19 replay serves with the live agent dir wrote session_state into 7 real session files.
  if (scratch) {
    const { fencedAgentDirs, fencedRoot, fenceWrites } = await import("./scratch-fence.ts");
    const roots = fencedAgentDirs();
    const agentDir = (await import("prime-agent")).getAgentDir();
    const live = fencedRoot(agentDir, roots);
    if (live) throw new Error(`A scratch serve refuses the agent dir ${agentDir}, which is under the live one ${live}. Set PRIME_AGENT_CODING_AGENT_DIR to a copy, such as one under --data-dir.`);
    fenceWrites(roots, line => process.stderr.write(`${new Date().toISOString()} ${line}\n`));
  }
  // Every daemon command of a scratch serve goes through a socket that passes only reads (src/read-only-daemon.ts).
  const replay = scratch && options.replayDaemon === true;
  const readOnly = scratch ? await (await import("./read-only-daemon.ts")).readOnlyDaemon(service.config.socketPath, line => process.stderr.write(`${new Date().toISOString()} ${line}\n`), { replay }) : null;
  // While <data dir>/cpu-profiles exists at start, the run's CPU profile is saved at stop (src/run-profile.ts).
  const runProfile = await (await import("./run-profile.ts")).startRunProfile({ dataDir: service.directory, log: line => process.stderr.write(`${new Date().toISOString()} ${line}\n`) });
  await recordServe(service);
  const identity = { pid: process.pid, instanceId: randomUUID(), socketPath: service.config.socketPath };
  // The port answers page shells from disk while the rest loads (src/early-shell.ts): a shell during a restart waited 12.1 s at 12:42Z on 10-18.
  // On systemd's socket chat-service-cli.mjs starts it before this module loads; a serve that binds its own port starts it here.
  const started = (globalThis as { __chatEarlyShell?: EarlyShell | null }).__chatEarlyShell;
  const early = started && listenFd !== null ? started : await (await import("./early-shell.ts")).startEarlyShell({ listenFd,
    port: service.config.port, capability: service.config.capability, csrfToken: service.config.csrfToken, dataDir: service.directory }).catch(error => {
    if (hasCode(error, "EADDRINUSE")) throw new Error(`Port ${service.config.port} is already in use. No process was stopped. Choose --port with a separate --data-dir.`);
    throw error;
  });
  const { DaemonKeeper } = await import("./chat-daemon.ts");
  // Started first, so the daemon boots while the rest loads. The catalog and threads reconnect on their own once it answers.
  const keeper = !scratch && startsDaemon(primary)
    ? new DaemonKeeper({ socketPath: service.config.socketPath, log: line => process.stderr.write(`${new Date().toISOString()} ${line}\n`) }) : null;
  void keeper?.start();
  const [{ buildClientBundle }, { createChatBackend }, { startChatServer }, { SdkSync, loadedClientVersion }, { startPromptPrune }, { getAgentDir }] = await Promise.all([
    import("./chat-assets.ts"), import("./chat-backend.ts"), import("./chat-server.ts"), import("./chat-sdk.ts"), import("./prompt-prune.ts"), import("prime-agent")]);
  // A release reads its prebuilt page bundle from disk. A checkout without one compiles it in a worker while the server listens (17 s at a
  // load of 90); the page and app.js wait for it, the API answers at once.
  const bundle = buildClientBundle();
  bundle.catch(error => { process.stderr.write(`${new Date().toISOString()} client bundle: ${error instanceof Error ? error.message : String(error)}\n`); });
  const adopt = scratch ? "own" : options.adopt ?? (primary ? "live" : "own");
  if (adopt === "own") process.stderr.write(`${new Date().toISOString()} chats: this serve acts only on the chats it created (${join(service.directory, "own-chats.json")})\n`);
  // The other boxes in ~/.config/sieun-pi/hosts.json: the main instance opens a local socket per box, tunneled to its relay (src/hosts.ts), and
  // the catalog lists every box's sessions through them (src/host-catalogs.ts).
  const hosts = await startHosts(primary);
  const backend = await createChatBackend({ socketPath: readOnly?.socketPath ?? service.config.socketPath, dataDir: service.directory,
    ownChatsOnly: adopt === "own", scratch, replay, hosts: hosts?.catalogs ?? null, copyFile: primary ? join(service.directory, "session-copy.json") : null });
  // The Slack bridge stays off until Settings turns it on with tokens in the Keychain; without them the service runs as before.
  const slack = !scratch && runsSlack(primary) ? new SlackBridge({ path: join(service.directory, "slack.json"), chats: slackChats(backend),
    log: line => process.stderr.write(`${new Date().toISOString()} ${line}\n`) }) : null;
  void slack?.start().catch(error => { process.stderr.write(`slack: ${error instanceof Error ? error.message : String(error)}\n`); });
  // Every chat in the index is pinned again, so a saved one resumes on the first catalog update. The daemon may be down here; the pin waits for it.
  const adopted = scratch && !replay ? Promise.resolve() : backend.chats.adopt().then(({ pinned, forgotten }) => { if (pinned.length || forgotten.length) process.stderr.write(`chats: pinned ${pinned.length}, forgot ${forgotten.length}\n`); },
    error => { process.stderr.write(`chats: ${error instanceof Error ? error.message : String(error)}\n`); });
  // The prompt captures of ended sessions go once the adopt pass has the daemon's list, then once a day (src/prompt-prune.ts). A serve that
  // does not own the live chats leaves the folder alone.
  let stopPromptPrune: () => void = () => {};
  if (adopt === "live") void adopted.then(() => {
    if (closing) return;
    stopPromptPrune = startPromptPrune({ dataDir: service.directory, agentDir: getAgentDir(), log: line => process.stderr.write(`${new Date().toISOString()} ${line}\n`),
      rows: async () => { if (!backend.catalog.daemonRows().length) await backend.catalog.refresh(); return backend.catalog.daemonRows(); } });
  });
  // Exit 75 after an SDK update: launchd's KeepAlive starts a crashed (non-zero) login item again, now on the new packages.
  const sdk = new SdkSync(join(service.directory, "sdk.json"), { client: loadedClientVersion(), build: bundle.then(built => built.version, () => "build failed"),
    canRestart: options.supervised === true && primary, restart: () => { process.exitCode = 75; stop(); } });
  // The SDK update rewrites the checkout's node_modules, which the live service runs from.
  if (!scratch) backend.catalog.onDaemonVersion = version => { void sdk.daemonVersion(version); };
  let stopped: () => void = () => {};
  const done = new Promise<void>(resolve => { stopped = resolve; });
  let closing: Promise<void> | undefined;
  // Only chat stop removes instance.json, so a supervised start after it stays idle. A restart (SIGTERM from a release or systemd) keeps it,
  // and the next serve rewrites it in place.
  async function close(removeInstance = true): Promise<void> {
    if (closing) return closing;
    closing = (async () => {
      try { if (removeInstance && instance(await readJson(instancePath)).instanceId === identity.instanceId) await unlink(instancePath); }
      catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
      finally {
        // Sends still out get their answers before the links close, so a refusal is recorded as one (Outbox.close with drain).
        // Each part's time goes in the log, so a slow stop names what it waited on: 5 of 97 stops from 10-15 to 10-18 reached systemd's 90 s.
        const began = Date.now();
        const parts: string[] = [];
        const timed = async (name: string, part: () => Promise<unknown> | unknown) => { const at = Date.now(); await part(); parts.push(`${name} ${Date.now() - at} ms`); };
        await timed("sends", () => backend.drainSends?.().catch(error => process.stderr.write(`drain sends: ${error instanceof Error ? error.message : String(error)}\n`)));
        stopPromptPrune(); keeper?.close(); remote.stop(); slack?.close();
        await timed("bridges", () => hosts?.bridge?.close());
        await timed("server", () => server.close());
        await timed("read-only", () => readOnly?.close());
        await timed("cpu profile", () => runProfile.stop().catch(error => process.stderr.write(`cpu profile: ${error instanceof Error ? error.message : String(error)}\n`)));
        process.stderr.write(`${new Date().toISOString()} stop: ${Date.now() - began} ms: ${parts.join(", ")}\n`);
      }
    })().finally(() => { process.off("SIGTERM", stop); process.off("SIGINT", stop); stopped(); });
    return closing;
  }
  const stop = () => { void close(false).catch(error => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; }); };
  let publishIdentity: () => void = () => {};
  const identityReady = new Promise<void>(resolve => { publishIdentity = resolve; });
  // A copied configuration.json keeps the live chat's Tailscale mode, and its check would point https://<box>/ at this port.
  const remote = new RemoteAccess({ port: service.config.port, capability: service.config.capability, mode: scratch ? "off" : service.config.remoteAccess, origin: scratch ? null : service.config.publicOrigin,
    save: value => saveConfiguration(service, { remoteAccess: value.mode, publicOrigin: value.origin }),
    identity: async () => { await identityReady; return identity; } });
  const node = primary ? await findNode() : null;
  const keepRunning = node ? keepRunningFor(service, node, options.supervised === true) : null;
  const loginStart = options.supervised === true || process.env.SIEUN_PI_CHAT_OPEN_AT_LOGIN === "1";
  const loginWindow = !scratch && opensAppAtLogin(primary) ? new LoginWindow({ url: service.url, markerPath: join(service.directory, "login-window.json"),
    enabled: service.config.openAppAtLogin, save: enabled => saveConfiguration(service, { openAppAtLogin: enabled }),
    // On a test instance the variable stands in for the login item.
    startsAtLogin: () => keepRunning?.status().enabled === true || process.env.SIEUN_PI_CHAT_OPEN_AT_LOGIN === "1",
    log: line => process.stderr.write(`${new Date().toISOString()} ${line}\n`) }) : null;
  const control: RemoteControl = {
    origin: () => remote.allowedOrigin(),
    view: editable => {
      const snapshot = remote.status();
      return { ...snapshot, phoneUrl: snapshot.origin && snapshot.mode !== "off" ? `${snapshot.origin}/${service.config.capability}/` : null, editable,
        keepRunning: keepRunning?.status() ?? { available: false, enabled: false, state: "off", message: "Only the main chat instance in ~/.prime/agent/browser-chat starts at login." },
        openAppAtLogin: loginWindow?.status() ?? { available: false, enabled: false, appName: null, message: "Only the main chat instance in ~/.prime/agent/browser-chat opens at login." } };
    },
    set: async input => {
      if (input.keepRunning !== undefined) {
        if (!keepRunning?.available()) throw new Error("Start at login is not available for this chat instance.");
        await keepRunning.setEnabled(input.keepRunning);
      }
      if (input.openAppAtLogin !== undefined) {
        if (!loginWindow?.available()) throw new Error("Opening the app at login is not available for this chat instance.");
        await loginWindow.setEnabled(input.openAppAtLogin);
      }
      if (input.tailscale !== undefined) await remote.setMode(input.tailscale ? "tailscale" : "off");
    },
    check: async () => { await Promise.all([remote.check(), keepRunning?.reconcile(), loginWindow?.refresh()]); },
  };
  const server = await startChatServer({ backend, bundle, port: service.config.port, listenFd, early, capability: service.config.capability, csrfToken: service.config.csrfToken,
    identity, identityReady, remote: control, slack, sdk, stopToken: service.config.stopToken, onStop: close, tailnetOwner: () => tailnetOwner() }).catch(error => {
      if (hasCode(error, "EADDRINUSE")) throw new Error(`Port ${service.config.port} is already in use. No process was stopped. Choose --port with a separate --data-dir.`);
      throw error;
    });
  try { await privateWrite(instancePath, { pid: identity.pid, instanceId: identity.instanceId, url: server.url }); }
  catch (error) { await server.close(); throw error; }
  publishIdentity();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.stdout.write(server.url + "\n");
  // What a start cost before the port served its pages: wall time since the process began, and this thread's CPU in it.
  const startCpu = process.threadCpuUsage();
  process.stderr.write(`${new Date().toISOString()} serve: listening ${Math.round(performance.now())} ms after start, main thread CPU ${Math.round((startCpu.user + startCpu.system) / 1000)} ms, ` +
    `from ${import.meta.url.endsWith(".bundle.mjs") ? "the bundle" : "source"}\n`);
  process.send?.({ ready: true });
  remote.start();
  void keepRunning?.reconcile();
  void loginWindow?.refresh();
  // A login start opens the app window once per boot, and only after this server answers its identity check.
  if (loginWindow && loginStart) {
    void (async () => {
      if (await waitForService(service, 30_000)) await loginWindow.atLogin();
      else process.stderr.write(`${new Date().toISOString()} open at login: the chat did not answer within 30 s, nothing opened.\n`);
    })().catch(error => { process.stderr.write(`open at login: ${error instanceof Error ? error.message : String(error)}\n`); });
  }
  await done;
}

export async function runChatCommand(args: string[]): Promise<void> {
  const [command = "help", ...flags] = args;
  const options: Options = {};
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index], value = flags[index + 1];
    if (flag === "--supervised") { options.supervised = true; index--; continue; }
    if (flag === "--scratch") { options.scratch = true; index--; continue; }
    if (flag === "--live-reads-only") { options.liveReadsOnly = true; index--; continue; }
    if (flag === "--replay-daemon") { options.replayDaemon = true; index--; continue; }
    if (flag === "--no-adopt" || flag === "--adopt-live") {
      const adopt = flag === "--no-adopt" ? "own" : "live";
      if (options.adopt && options.adopt !== adopt) throw new Error("Use --no-adopt or --adopt-live, not both.");
      options.adopt = adopt; index--; continue;
    }
    if (!value || value.startsWith("--")) throw new Error("Chat options require values: --port, --socket, --data-dir, --public-origin.");
    if (flag === "--port") options.port = validPort(Number(value));
    else if (flag === "--socket") options.socketPath = resolve(value);
    else if (flag === "--data-dir") options.dataDir = resolve(value);
    else if (flag === "--public-origin") options.remote = parseRemoteFlag(value);
    else throw new Error("Unknown chat option: " + flag);
  }
  if (options.remote !== undefined && command !== "start" && command !== "serve") throw new Error("Use --public-origin with chat start or serve.");
  if (options.supervised && command !== "serve") throw new Error("Use --supervised with chat serve.");
  if (options.adopt && command !== "start" && command !== "serve") throw new Error("Use --no-adopt or --adopt-live with chat start or serve.");
  if (options.scratch && command !== "serve") throw new Error("Use --scratch with chat serve.");
  if (options.liveReadsOnly && command !== "serve") throw new Error("Use --live-reads-only with chat serve --scratch.");
  if (options.replayDaemon && command !== "serve") throw new Error("Use --replay-daemon with chat serve --scratch.");
  if (command === "start") { process.stdout.write((await ensureChatService(options)).url + "\n"); return; }
  if (command === "open") {
    // When hosts.json puts the chat role on another box, the app is that box's chat; nothing starts here.
    const url = (await remoteChatService())?.base ?? (await ensureChatService(options)).url;
    const opened = await openChat(url);
    process.stdout.write(opened?.opened === "app" ? `Opened the installed app ${opened.target}.\n`
      : opened ? `Opened ${url} in the default browser. Install it as an app from the browser menu (Install page as app, or Open in app) for a Dock icon.\n`
      : url + "\n");
    return;
  }
  if (command === "serve") { await serve(options); process.exit(process.exitCode ?? 0); }
  if (!["url", "status", "stop"].includes(command)) {
    if (!["help", "--help", "-h"].includes(command)) throw new Error("Unknown chat command: " + command);
    process.stdout.write("sieun-pi chat start|open|serve|status|url|stop [--port 5182] [--socket PATH] [--data-dir PATH] [--public-origin tailscale|https://HOST|none] [--no-adopt|--adopt-live] [--scratch [--live-reads-only|--replay-daemon]]\nOnly open starts a window: the installed app, else the default browser. Keep the URL private: it grants chat access.\n" +
      "A serve outside ~/.prime/agent/browser-chat, or with --scratch, only reads: it sends no wake, check-in, duty, reopen, attach, reload or pool write, and it refuses the live daemon socket unless --live-reads-only. --no-adopt keeps any serve to its own chats.\n"); return;
  }
  const service = await loadService(options, false);
  if (!service) {
    if (command === "url") throw new Error("Chat is not configured. Run sieun-pi chat start.");
    process.stdout.write("Chat is stopped.\n"); return;
  }
  if (command === "url") { process.stdout.write(service.url + "\n"); return; }
  const record = await running(service);
  if (command === "status") {
    const phone = phoneUrl(service);
    const { daemonAnswers } = await import("./chat-daemon.ts");
    const daemon = await daemonAnswers(service.config.socketPath) ? "answering" : "not running";
    const strays = await recordedServes(service, record?.pid);
    process.stdout.write((record ? `Chat is running (PID ${record.pid}).` : "Chat is stopped.") + "\n" + service.url + "\n" + (phone ? `Phone: ${phone}\n` : "") +
      `Daemon: ${daemon} on ${service.config.socketPath}\n` +
      (strays.length ? `A chat process that never answered runs as PID ${strays.join(", ")}. sieun-pi chat stop ends it.\n` : "")); return;
  }
  if (record) {
    const response = await fetch(service.url + "api/service-stop", { method: "POST", signal: AbortSignal.timeout(3000), redirect: "error",
      headers: { Origin: new URL(service.url).origin, "Content-Type": "application/json", "X-Chat-Stop-Token": service.config.stopToken },
      body: JSON.stringify({ instanceId: record.instanceId }) });
    if (!response.ok) throw new Error(`Chat stop returned HTTP ${response.status}. No PID was signaled.`);
    let closed = false;
    for (let attempt = 0; attempt < 100 && !closed; attempt++) {
      const current = await running(service);
      if (!current) closed = true;
      else if (current.instanceId !== record.instanceId) throw new Error("Another chat instance started. It was left running.");
      else await delay(50);
    }
    if (!closed) throw new Error("Chat stop was accepted but the listener has not closed.");
  }
  // A serve that never published instance.json (a failed or hung start) answers no stop request; it is found by its record and signaled.
  const strays = await recordedServes(service, record?.pid);
  for (const pid of strays) await terminate(pid);
  const ended = strays.length ? ` Ended a chat process that never answered (PID ${strays.join(", ")}).` : "";
  process.stdout.write(`Chat is stopped.${ended}${record ? " Native sessions keep running." : ""}\n`);
}
