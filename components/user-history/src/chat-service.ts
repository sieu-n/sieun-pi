import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { defaultDaemonSocketPath, getAgentDir } from "prime-agent";
import { parsePublicOrigin } from "./chat-origin.ts";

type Options = { port?: number; socketPath?: string; dataDir?: string; publicOrigin?: string | null };
type Configuration = { port: number; socketPath: string; capability: string; csrfToken: string; stopToken: string; publicOrigin: string | null };
type Instance = { pid: number; instanceId: string; url: string };
type Service = { directory: string; config: Configuration; url: string };
const secret = () => randomBytes(32).toString("hex");
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isSecret = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const hasCode = (error: unknown, code: string) => isRecord(error) && error.code === code;
function validPort(port: number): number {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Use a port from 1 to 65535.");
  return port;
}
function configuration(value: unknown): Configuration {
  if (!isRecord(value) || typeof value.port !== "number" || typeof value.socketPath !== "string" || !value.socketPath.startsWith("/") ||
    !isSecret(value.capability) || !isSecret(value.csrfToken) || !isSecret(value.stopToken)) throw new Error("Invalid private chat configuration. Refusing to replace it.");
  return { port: validPort(value.port), socketPath: value.socketPath, capability: value.capability, csrfToken: value.csrfToken, stopToken: value.stopToken, publicOrigin: parsePublicOrigin(value.publicOrigin ?? null) };
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
  let config: Configuration;
  try { config = configuration(await readJson(path)); }
  catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    if (!create) return null;
    const proposed: Configuration = { port: validPort(options.port ?? 5182), socketPath: resolve(options.socketPath ?? defaultDaemonSocketPath()),
      capability: secret(), csrfToken: secret(), stopToken: secret(), publicOrigin: options.publicOrigin ?? null };
    try { await privateWrite(path, proposed, true); }
    catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
    config = configuration(await readJson(path));
  }
  if ((options.port !== undefined && validPort(options.port) !== config.port) ||
    (options.socketPath !== undefined && resolve(options.socketPath) !== config.socketPath)) {
    throw new Error(`Chat configuration uses port ${config.port} and socket ${config.socketPath}. Use those settings, or stop it and choose a separate --data-dir for the new configuration.`);
  }
  const service = { directory, config, url: `http://127.0.0.1:${config.port}/${config.capability}/` };
  if (create && options.publicOrigin !== undefined && options.publicOrigin !== config.publicOrigin) {
    if (await running(service)) throw new Error("Stop chat before changing --public-origin. Native sessions keep running.");
    config.publicOrigin = parsePublicOrigin(options.publicOrigin);
    await privateWrite(path, config);
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

export async function ensureChatService(options: Options = {}): Promise<Instance> {
  const service = await loadService({ ...options, socketPath: options.socketPath ?? defaultDaemonSocketPath() }, true);
  if (!service) throw new Error("Could not create chat configuration.");
  const existing = await running(service);
  if (existing) return existing;
  const log = await open(join(service.directory, "service.log"), "a", 0o600);
  await log.chmod(0o600);
  const child = spawn("node", [fileURLToPath(new URL("./chat-service-cli.mjs", import.meta.url)), "serve", "--data-dir", service.directory,
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
    if (record) return record;
    await delay(50);
  }
  throw new Error(result ?? `Chat did not answer on port ${service.config.port}. Inspect ${join(service.directory, "service.log")}.`);
}

async function serve(options: Options): Promise<void> {
  const service = await loadService({ ...options, socketPath: options.socketPath ?? defaultDaemonSocketPath() }, true);
  if (!service) throw new Error("Could not create chat configuration.");
  const existing = await running(service);
  if (existing) throw new Error(`Chat already runs at ${existing.url}. Use chat start to reuse it.`);
  const instancePath = join(service.directory, "instance.json");
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
      finally { await server.close(); }
    })().finally(() => { process.off("SIGTERM", stop); process.off("SIGINT", stop); stopped(); });
    return closing;
  }
  const stop = () => { void close().catch(error => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; }); };
  let publishIdentity: () => void = () => {};
  const identityReady = new Promise<void>(resolve => { publishIdentity = resolve; });
  const server = await startChatServer({ backend, bundle, port: service.config.port, capability: service.config.capability, csrfToken: service.config.csrfToken,
    identity, identityReady, publicOrigin: service.config.publicOrigin, stopToken: service.config.stopToken, onStop: close }).catch(error => {
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
  await done;
}

export async function runChatCommand(args: string[]): Promise<void> {
  const [command = "help", ...flags] = args;
  const options: Options = {};
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index], value = flags[index + 1];
    if (!value || value.startsWith("--")) throw new Error("Chat options require values: --port, --socket, --data-dir, --public-origin.");
    if (flag === "--port") options.port = validPort(Number(value));
    else if (flag === "--socket") options.socketPath = resolve(value);
    else if (flag === "--data-dir") options.dataDir = resolve(value);
    else if (flag === "--public-origin") options.publicOrigin = parsePublicOrigin(value);
    else throw new Error("Unknown chat option: " + flag);
  }
  if (options.publicOrigin !== undefined && command !== "start" && command !== "serve") throw new Error("Use --public-origin with chat start or serve.");
  if (command === "start") { process.stdout.write((await ensureChatService(options)).url + "\n"); return; }
  if (command === "serve") { await serve(options); return; }
  if (!["url", "status", "stop"].includes(command)) {
    if (!["help", "--help", "-h"].includes(command)) throw new Error("Unknown chat command: " + command);
    process.stdout.write("sieun-pi chat start|serve|status|url|stop [--port 5182] [--socket PATH] [--data-dir PATH] [--public-origin https://HOST|none]\nNo browser opens. Keep the URL private: it grants chat access.\n"); return;
  }
  const service = await loadService(options, false);
  if (!service) {
    if (command === "url") throw new Error("Chat is not configured. Run sieun-pi chat start.");
    process.stdout.write("Chat is stopped.\n"); return;
  }
  if (command === "url") { process.stdout.write(service.url + "\n"); return; }
  const record = await running(service);
  if (command === "status") { process.stdout.write((record ? `Chat is running (PID ${record.pid}).` : "Chat is stopped.") + "\n" + service.url + "\n"); return; }
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
