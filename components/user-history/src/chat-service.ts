import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { access, chmod, constants, link, mkdir, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { defaultDaemonSocketPath, getAgentDir } from "prime-agent";
import { parsePublicOrigin, parseRemoteFlag, type RemoteSetting } from "./chat-origin.ts";
import { KeepRunning } from "./chat-autostart.ts";
import { RemoteAccess, type RemoteControl } from "./chat-remote.ts";
import type { RemoteMode } from "./shared/types.ts";

type Options = { port?: number; socketPath?: string; dataDir?: string; remote?: RemoteSetting; supervised?: boolean };
type Configuration = {
  port: number; socketPath: string; capability: string; csrfToken: string; stopToken: string;
  /** The remote HTTPS origin: fixed for `custom`, the last tailnet name seen for `tailscale`. */
  publicOrigin: string | null; remoteAccess: RemoteMode; keepRunning: boolean;
};
type Instance = { pid: number; instanceId: string; url: string };
type Service = { directory: string; config: Configuration; url: string; primary: boolean };

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
  const main = await realpath(join(userInfo().homedir, ".prime", "agent", "browser-chat")).catch(() => null);
  return main === directory;
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
  return { port: validPort(value.port), socketPath: value.socketPath, capability: value.capability, csrfToken: value.csrfToken, stopToken: value.stopToken,
    publicOrigin, remoteAccess, keepRunning };
}
async function saveConfiguration(service: Service, patch: Partial<Pick<Configuration, "publicOrigin" | "remoteAccess" | "keepRunning">>): Promise<void> {
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
  const directoryPath = resolve(options.dataDir ?? join(getAgentDir(), "browser-chat"));
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
    const proposed = { port: validPort(options.port ?? 5182), socketPath: resolve(options.socketPath ?? defaultDaemonSocketPath()),
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
    job: { node, cli: cliPath, dataDir: service.directory, port: service.config.port, socketPath: service.config.socketPath, logPath: join(service.directory, "service.log") },
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
const withPhone = (service: Service, record: Instance): Instance & { phoneUrl: string | null } => ({ ...record, phoneUrl: phoneUrl(service) });

export async function ensureChatService(options: Options = {}): Promise<Instance & { phoneUrl: string | null }> {
  const service = await loadService({ ...options, socketPath: options.socketPath ?? defaultDaemonSocketPath() }, true);
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
    "--port", String(service.config.port), "--socket", service.config.socketPath], { detached: true, stdio: ["ignore", log.fd, log.fd, "ipc"] });
  await log.close();
  const result = await new Promise<string | null>((accept, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Chat startup timed out. Inspect " + join(service.directory, "service.log"))); }, 60000);
    const finish = (error: string | null) => { clearTimeout(timeout); if (child.connected) child.disconnect(); child.unref(); accept(error); };
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("message", value => {
      if (isRecord(value) && value.ready === true) finish(null);
      else if (isRecord(value) && typeof value.error === "string") finish(value.error);
    });
    child.once("exit", code => finish(`Chat process exited (${code}). Inspect ${join(service.directory, "service.log")}.`));
  });
  // The bind winner can still be publishing its private identity when another starter loses the port race.
  for (let attempt = 0; attempt < 20; attempt++) {
    const record = await running(service);
    if (record) return withPhone(service, record);
    await delay(50);
  }
  throw new Error(result ?? `Chat did not answer on port ${service.config.port}. Inspect ${join(service.directory, "service.log")}.`);
}

async function serve(options: Options): Promise<void> {
  const service = await loadService({ ...options, socketPath: options.socketPath ?? defaultDaemonSocketPath() }, true);
  if (!service) throw new Error("Could not create chat configuration.");
  const instancePath = join(service.directory, "instance.json");
  if (options.supervised) {
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
  const existing = await running(service);
  if (existing) throw new Error(`Chat already runs at ${existing.url}. Use chat start to reuse it.`);
  const identity = { pid: process.pid, instanceId: randomUUID(), socketPath: service.config.socketPath };
  const [{ buildClientBundle }, { createChatBackend }, { startChatServer }] = await Promise.all([
    import("./chat-assets.ts"), import("./chat-backend.ts"), import("./chat-server.ts")]);
  const bundle = await buildClientBundle();
  const backend = await createChatBackend({ socketPath: service.config.socketPath, dataDir: service.directory });
  let stopped: () => void = () => {};
  const done = new Promise<void>(resolve => { stopped = resolve; });
  let closing: Promise<void> | undefined;
  async function close(): Promise<void> {
    if (closing) return closing;
    closing = (async () => {
      try { if (instance(await readJson(instancePath)).instanceId === identity.instanceId) await unlink(instancePath); }
      catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
      finally { remote.stop(); await server.close(); }
    })().finally(() => { process.off("SIGTERM", stop); process.off("SIGINT", stop); stopped(); });
    return closing;
  }
  const stop = () => { void close().catch(error => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; }); };
  let publishIdentity: () => void = () => {};
  const identityReady = new Promise<void>(resolve => { publishIdentity = resolve; });
  const remote = new RemoteAccess({ port: service.config.port, capability: service.config.capability, mode: service.config.remoteAccess, origin: service.config.publicOrigin,
    save: value => saveConfiguration(service, { remoteAccess: value.mode, publicOrigin: value.origin }),
    identity: async () => { await identityReady; return identity; } });
  const node = service.primary ? await findNode() : null;
  const keepRunning = node ? keepRunningFor(service, node, options.supervised === true) : null;
  const control: RemoteControl = {
    origin: () => remote.allowedOrigin(),
    view: editable => {
      const snapshot = remote.status();
      return { ...snapshot, phoneUrl: snapshot.origin && snapshot.mode !== "off" ? `${snapshot.origin}/${service.config.capability}/` : null, editable,
        keepRunning: keepRunning?.status() ?? { available: false, enabled: false, state: "off", message: "Only the main chat instance in ~/.prime/agent/browser-chat starts at login." } };
    },
    set: async input => {
      if (input.keepRunning !== undefined) {
        if (!keepRunning?.available()) throw new Error("Start at login is not available for this chat instance.");
        await keepRunning.setEnabled(input.keepRunning);
      }
      if (input.tailscale !== undefined) await remote.setMode(input.tailscale ? "tailscale" : "off");
    },
    check: async () => { await Promise.all([remote.check(), keepRunning?.reconcile()]); },
  };
  const server = await startChatServer({ backend, bundle, port: service.config.port, capability: service.config.capability, csrfToken: service.config.csrfToken,
    identity, identityReady, remote: control, stopToken: service.config.stopToken, onStop: close }).catch(error => {
      if (hasCode(error, "EADDRINUSE")) throw new Error(`Port ${service.config.port} is already in use. No process was stopped. Choose --port with a separate --data-dir.`);
      throw error;
    });
  try { await privateWrite(instancePath, { pid: identity.pid, instanceId: identity.instanceId, url: server.url }); }
  catch (error) { await server.close(); throw error; }
  publishIdentity();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.stdout.write(server.url + "\n");
  process.send?.({ ready: true });
  remote.start();
  void keepRunning?.reconcile();
  await done;
}

export async function runChatCommand(args: string[]): Promise<void> {
  const [command = "help", ...flags] = args;
  const options: Options = {};
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index], value = flags[index + 1];
    if (flag === "--supervised") { options.supervised = true; index--; continue; }
    if (!value || value.startsWith("--")) throw new Error("Chat options require values: --port, --socket, --data-dir, --public-origin.");
    if (flag === "--port") options.port = validPort(Number(value));
    else if (flag === "--socket") options.socketPath = resolve(value);
    else if (flag === "--data-dir") options.dataDir = resolve(value);
    else if (flag === "--public-origin") options.remote = parseRemoteFlag(value);
    else throw new Error("Unknown chat option: " + flag);
  }
  if (options.remote !== undefined && command !== "start" && command !== "serve") throw new Error("Use --public-origin with chat start or serve.");
  if (options.supervised && command !== "serve") throw new Error("Use --supervised with chat serve.");
  if (command === "start") { process.stdout.write((await ensureChatService(options)).url + "\n"); return; }
  if (command === "serve") { await serve(options); process.exit(process.exitCode ?? 0); }
  if (!["url", "status", "stop"].includes(command)) {
    if (!["help", "--help", "-h"].includes(command)) throw new Error("Unknown chat command: " + command);
    process.stdout.write("sieun-pi chat start|serve|status|url|stop [--port 5182] [--socket PATH] [--data-dir PATH] [--public-origin tailscale|https://HOST|none]\nNo browser opens. Keep the URL private: it grants chat access.\n"); return;
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
    process.stdout.write((record ? `Chat is running (PID ${record.pid}).` : "Chat is stopped.") + "\n" + service.url + "\n" + (phone ? `Phone: ${phone}\n` : "")); return;
  }
  if (record) {
    const response = await fetch(service.url + "api/service-stop", { method: "POST", signal: AbortSignal.timeout(3000), redirect: "error",
      headers: { Origin: new URL(service.url).origin, "Content-Type": "application/json", "X-Chat-Stop-Token": service.config.stopToken },
      body: JSON.stringify({ instanceId: record.instanceId }) });
    if (!response.ok) throw new Error(`Chat stop returned HTTP ${response.status}. No PID was signaled.`);
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = await running(service);
      if (!current) { process.stdout.write("Chat is stopped. Native sessions keep running.\n"); return; }
      if (current.instanceId !== record.instanceId) throw new Error("Another chat instance started. It was left running.");
      await delay(50);
    }
    throw new Error("Chat stop was accepted but the listener has not closed.");
  }
  process.stdout.write("Chat is stopped.\n");
}
