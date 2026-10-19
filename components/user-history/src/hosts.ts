import { chmod, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { Agent, request as httpRequest } from "node:http";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { homedir, hostname as osHostname } from "node:os";
import { isAbsolute, join } from "node:path";
import { DELTA_HEADER, decodeLineDeltas } from "../../prime-relay/line-delta.ts";

/**
 * The hosts registry, ~/.config/sieun-pi/hosts.json: every box sieun-pi drives, its relay and the services it holds.
 * The same file is copied to every box, so "this machine" is the host whose hostname matches os.hostname().
 */
export type HostRole = "pool" | "wiki" | "chat";
export type Host = {
  name: string;
  hostname: string;
  address: string;
  relayPort: number;
  /** "file:<path>", relative to ~/.config/sieun-pi or absolute; the file holds the relay's bearer token. */
  token: string;
  daemonSocket: string;
  ssh: string | null;
  /** `url` is set for a service behind tailscale serve; without it the service answers on http://<address>:<port>. */
  roles: Partial<Record<HostRole, { port: number; url?: string }>>;
  /** The tools agents on this box are meant to have, which Settings > Tools and skills checks there; absent, every tool in HOST_TOOLS. */
  tools?: HostTool[];
};
export type HostsRegistry = { version: 1; hosts: Host[] };

const ROLES: readonly HostRole[] = ["pool", "wiki", "chat"];
/**
 * The tools a box can be meant to have: the websearch skill, a headless Chromium on the box (aside-browser's box runner), the Aside CLI and MCP
 * for the owner's logged-in sites, and cua-driver for computer use. Boxes differ on purpose, so each host's `tools` lists its own.
 */
export const HOST_TOOLS = ["websearch", "headless-browser", "aside", "cua-driver"] as const;
export type HostTool = (typeof HOST_TOOLS)[number];
const NAME = /^[a-z0-9][a-z0-9-]*$/;
export const CONFIG_DIR = join(homedir(), ".config/sieun-pi");
export const HOSTS_FILE = join(CONFIG_DIR, "hosts.json");
export const BRIDGE_DIR = join(homedir(), ".local/state/sieun-pi/hosts");
const UPGRADE = "prime-daemon";
/** The relay's opt-in for slim attach snapshots (SLIM_HEADER in components/prime-relay/slim-snapshot.mjs). */
const SLIM_HEADER = "x-prime-slim-snapshot";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function parseHost(value: unknown, at: string): Host {
  if (!isRecord(value)) throw new Error(`${at}: a host is an object`);
  const text = (key: string) => {
    const field = value[key];
    if (typeof field !== "string" || !field) throw new Error(`${at}.${key}: needs a non-empty string`);
    return field;
  };
  const name = text("name");
  if (!NAME.test(name)) throw new Error(`${at}.name: ${name} is not [a-z0-9-]+`);
  const relayPort = value.relayPort;
  if (typeof relayPort !== "number" || !Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65535) throw new Error(`${at}.relayPort: needs a port number`);
  const token = text("token");
  if (!token.startsWith("file:")) throw new Error(`${at}.token: needs a "file:<path>" reference`);
  const daemonSocket = text("daemonSocket");
  if (!isAbsolute(daemonSocket)) throw new Error(`${at}.daemonSocket: needs an absolute path`);
  const ssh = value.ssh ?? null;
  if (ssh !== null && typeof ssh !== "string") throw new Error(`${at}.ssh: needs a string or null`);
  const rolesValue = value.roles ?? {};
  if (!isRecord(rolesValue)) throw new Error(`${at}.roles: needs an object keyed by role`);
  const roles: Host["roles"] = {};
  for (const [role, spec] of Object.entries(rolesValue)) {
    if (!(ROLES as readonly string[]).includes(role)) throw new Error(`${at}.roles.${role}: unknown role (${ROLES.join(", ")})`);
    const port = isRecord(spec) ? spec.port : undefined;
    if (typeof port !== "number" || !Number.isInteger(port)) throw new Error(`${at}.roles.${role}.port: needs a port number`);
    const url = isRecord(spec) ? spec.url : undefined;
    if (url !== undefined && (typeof url !== "string" || !/^https?:\/\//.test(url))) throw new Error(`${at}.roles.${role}.url: needs an http(s) URL`);
    roles[role as HostRole] = url === undefined ? { port } : { port, url: url.replace(/\/+$/, "") };
  }
  const tools = value.tools;
  if (tools !== undefined && (!Array.isArray(tools) || tools.some(tool => !(HOST_TOOLS as readonly unknown[]).includes(tool))))
    throw new Error(`${at}.tools: needs a list of ${HOST_TOOLS.join(", ")}`);
  return { name, hostname: text("hostname"), address: text("address"), relayPort, token, daemonSocket, ssh, roles, ...(tools ? { tools: [...new Set(tools as HostTool[])] } : {}) };
}

/** The tools `host` is meant to have, in HOST_TOOLS order; a host without a `tools` list gets every one. */
export const hostTools = (host: Host | null): HostTool[] => HOST_TOOLS.filter(tool => !host?.tools || host.tools.includes(tool));

export function parseHosts(value: unknown, source = "hosts.json"): HostsRegistry {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.hosts)) throw new Error(`${source}: needs {"version": 1, "hosts": [...]}`);
  const hosts = value.hosts.map((host, index) => parseHost(host, `${source}.hosts[${index}]`));
  const names = new Set<string>();
  for (const host of hosts) {
    if (names.has(host.name)) throw new Error(`${source}: host ${host.name} is listed twice`);
    names.add(host.name);
  }
  for (const role of ROLES) {
    const holders = hosts.filter(host => host.roles[role]).map(host => host.name);
    if (holders.length > 1) throw new Error(`${source}: role ${role} is on ${holders.join(" and ")}; one host holds it`);
  }
  return { version: 1, hosts };
}

export async function loadHosts(file = process.env.SIEUN_PI_HOSTS ?? HOSTS_FILE): Promise<HostsRegistry> {
  return parseHosts(JSON.parse(await readFile(file, "utf8")), file);
}

const shortName = (name: string) => name.split(".")[0]!.toLowerCase();

/** The host this process runs on, matched by short hostname; null when this machine is not in the registry. */
export function selfHost(registry: HostsRegistry, name = osHostname()): Host | null {
  return registry.hosts.find(host => shortName(host.hostname) === shortName(name)) ?? null;
}

export function hostNamed(registry: HostsRegistry, name: string): Host {
  const host = registry.hosts.find(candidate => candidate.name === name);
  if (!host) throw new Error(`no host ${name} in hosts.json (${registry.hosts.map(candidate => candidate.name).join(", ")})`);
  return host;
}

/** The URL of the service that holds `role`: its roles entry's url when set, else http://<address>:<port>, such as the pool holder's :7781. */
export function roleUrl(registry: HostsRegistry, role: HostRole): string | null {
  const host = registry.hosts.find(candidate => candidate.roles[role]);
  const spec = host?.roles[role];
  return host && spec ? spec.url ?? `http://${host.address}:${spec.port}` : null;
}

export async function hostToken(host: Host, configDir = CONFIG_DIR): Promise<string> {
  const path = host.token.slice("file:".length);
  return (await readFile(isAbsolute(path) ? path : join(configDir, path), "utf8")).trim();
}

/** A relay's watch answer: the box's usability reading, and its workers' footprints or why they are missing. */
export type RelayWatch = { usable: unknown; footprints: import("./mac-usable-watch.ts").Footprints; error?: undefined } | { usable: unknown; footprints: null; error: string };

async function relayJson(host: Host, path: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<unknown> {
  const response = await fetch(`http://${host.address}:${host.relayPort}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${await hostToken(host)}` },
    signal: AbortSignal.timeout(35_000) });
  if (!response.ok) throw new Error(`relay ${host.name} answered ${response.status} to ${path}`);
  return await response.json() as unknown;
}

/**
 * Another box's watch numbers through its relay: its usability reading (GET /v1/usable, a file read on macOS) and the footprints of `pids`, its
 * Prime workers (POST /v1/watch, which runs src/worker-footprint.py with a 30 s kill). The two reads run side by side, so a slow or failed helper
 * leaves the reading: at load 440 on the Mac on 10-18 the helper passed its 30 s kill in each of 4 reads from 11:14Z, and the watch answered in
 * 34 to 37 s, while /v1/health answered in 2 to 9 s. A relay from before /v1/usable answers 404 there, and its reading then comes from the watch.
 */
export async function relayWatch(host: Host, pids: readonly number[]): Promise<RelayWatch> {
  const [reading, watch] = await Promise.allSettled([relayJson(host, "/v1/usable"),
    relayJson(host, "/v1/watch", { method: "POST", body: pids.join("\n") + "\n", headers: { "content-type": "text/plain" } })]);
  const answer = watch.status === "fulfilled" && isRecord(watch.value) ? watch.value : null;
  const usable = reading.status === "fulfilled" ? reading.value : answer?.usable;
  if (usable === undefined) throw watch.status === "rejected" ? watch.reason : new Error(`relay ${host.name} sent no reading`);
  const footprints = answer?.footprints;
  if (isRecord(footprints) && isRecord(footprints.workers)) return { usable, footprints: footprints as unknown as import("./mac-usable-watch.ts").Footprints };
  const error = watch.status === "rejected" ? (watch.reason instanceof Error ? watch.reason.message : String(watch.reason))
    : typeof answer?.footprintsError === "string" ? `relay ${host.name} footprints: ${answer.footprintsError}` : `relay ${host.name} sent no footprints`;
  return { usable, footprints: null, error };
}

type RelayResponse = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer };

/**
 * One kept-alive agent per relay, with no idle timeout of its own, so a relay read reuses an open connection. With Node's default agent the
 * sockets closed after 5 s idle, so each burst of mirror reads opened its connections again: at 07:54:35Z on 10-18 one burst opened 70, each
 * paying a TCP handshake, a 185 ms round trip to the Mac, before its request.
 */
const agents = new Map<string, Agent>();
function agentFor(host: Host): Agent {
  const key = `${host.address}:${host.relayPort}`;
  let agent = agents.get(key);
  if (!agent) { agent = new Agent({ keepAlive: true, keepAliveMsecs: 30_000 }); agents.set(key, agent); }
  return agent;
}

async function relayRequest(host: Host, path: string, headers: Record<string, string> = {}, method = "GET", timeoutMs = 15_000): Promise<RelayResponse> {
  const token = await hostToken(host);
  return await new Promise((resolve, reject) => {
    const request = httpRequest({ host: host.address, port: host.relayPort, path, method, agent: agentFor(host), headers: { ...headers, authorization: `Bearer ${token}` }, timeout: timeoutMs }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error(`relay ${host.name} (${host.address}:${host.relayPort}) did not answer in ${timeoutMs} ms`)));
    request.on("error", reject);
    request.end();
  });
}

export type HostHealth = { ok: true; daemon: "answering" | "down"; version: number; ms: number } | { ok: false; error: string; ms: number };

export async function hostHealth(host: Host): Promise<HostHealth> {
  const started = Date.now();
  try {
    const response = await relayRequest(host, "/v1/health", {}, "GET", 5_000);
    const ms = Date.now() - started;
    if (response.status !== 200) return { ok: false, error: `relay answered ${response.status}`, ms };
    const body = JSON.parse(response.body.toString("utf8")) as { daemon: "answering" | "down"; version: number };
    return { ok: true, daemon: body.daemon, version: body.version, ms };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error), ms: Date.now() - started }; }
}

/** A relay's refusal of a file read, with its HTTP status: 404 means the file is not on that host's disk (moved or deleted). */
function relayError(host: Host, path: string, response: { status: number; body: Buffer }): Error & { status: number } {
  return Object.assign(new Error(`relay ${host.name}: ${path}: ${response.status} ${response.body.toString("utf8").slice(0, 200)}`), { status: response.status });
}

/** Bytes of a file on the host's disk from offset `from`, read through its relay. `size` is the whole file, so the next tail starts there. */
export async function readHostFile(host: Host, path: string, options: { from?: number } = {}): Promise<{ bytes: Buffer; size: number; from: number }> {
  const from = options.from ?? 0;
  const response = await relayRequest(host, `/v1/file?path=${encodeURIComponent(path)}`, from > 0 ? { range: `bytes=${from}-` } : {});
  if (response.status === 416) {
    const size = Number(/\/(\d+)$/.exec(String(response.headers["content-range"] ?? ""))?.[1] ?? 0);
    return { bytes: Buffer.alloc(0), size, from: size };
  }
  if (response.status !== 200 && response.status !== 206) throw relayError(host, path, response);
  return { bytes: response.body, size: Number(response.headers["x-file-size"] ?? response.body.length), from };
}

export type HostDirEntry = { name: string; type: "dir" | "file" | "other"; size: number; mtimeMs: number };

export async function listHostDir(host: Host, path: string): Promise<HostDirEntry[]> {
  const response = await relayRequest(host, `/v1/file?path=${encodeURIComponent(path)}`);
  if (response.status !== 200) throw relayError(host, path, response);
  const body = JSON.parse(response.body.toString("utf8")) as { entries?: HostDirEntry[] };
  if (!body.entries) throw new Error(`relay ${host.name}: ${path} is a file`);
  return body.entries;
}

/**
 * A byte stream to the host's daemon socket through its relay. It asks for attach snapshots whose chunks but the last carry no image data
 * (`slimSnapshots`), since this box reads a session's older messages from its copy of the file: frontend bro's snapshot went from 8.7 MB to 1.9 MB.
 * It also asks for each message update as a delta against the one before it (`encodeLineDeltas`), so a reader must pass the stream through
 * `decodeLineDeltas`, as HostBridge does.
 */
export async function openDaemonTunnel(host: Host, timeoutMs = 10_000): Promise<Socket> {
  const token = await hostToken(host);
  return await new Promise((resolve, reject) => {
    const request = httpRequest({ host: host.address, port: host.relayPort, path: "/v1/daemon", timeout: timeoutMs,
      headers: { connection: "Upgrade", upgrade: UPGRADE, authorization: `Bearer ${token}`, [SLIM_HEADER]: "images", [DELTA_HEADER]: "1" } });
    request.on("upgrade", (response, socket, head) => {
      socket.setTimeout(0);
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    request.on("response", response => { response.resume(); reject(new Error(`relay ${host.name} refused the daemon tunnel: ${response.statusCode}`)); });
    request.on("timeout", () => request.destroy(new Error(`relay ${host.name} (${host.address}:${host.relayPort}) did not answer in ${timeoutMs} ms`)));
    request.on("error", reject);
    request.end();
  });
}

/** Whether a process answers at the unix socket `path`; a file left behind by a dead process refuses the connection. */
function answers(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createConnection(path);
    probe.once("connect", () => { probe.destroy(); resolve(true); });
    probe.once("error", () => resolve(false));
  });
}

/**
 * One local socket per remote host, each connection tunneled to that host's relay, so `new DaemonClient(bridge.socketPath(name))`
 * talks to the remote daemon unchanged. The self host maps to its own daemon socket and gets no bridge.
 * Start leaves a socket that answers to its owner unless `replaceLive` is set, as the chat service sets it, and close removes only a socket
 * this bridge put there: `sieun-pi hosts bridge` run while the chat service was up would have deleted the live mac.sock on start and on exit.
 */
export class HostBridge {
  private readonly servers = new Map<string, { server: Server; ino: number }>();
  /** Open tunnels; close ends them, since a server's close waits for every connection and an attached thread's never ends on its own. */
  private readonly sockets = new Set<Socket>();
  constructor(private readonly registry: HostsRegistry, private readonly options: { dir?: string; self?: Host | null; replaceLive?: boolean; log?: (line: string) => void } = {}) {}

  private get dir(): string { return this.options.dir ?? BRIDGE_DIR; }
  private get self(): Host | null { return this.options.self === undefined ? selfHost(this.registry) : this.options.self; }

  socketPath(name: string): string {
    const host = hostNamed(this.registry, name);
    return host.name === this.self?.name ? host.daemonSocket : join(this.dir, `${host.name}.sock`);
  }

  /** Opens a socket for every other host and returns the hosts it left to a live socket, which another process serves. */
  async start(): Promise<{ live: string[] }> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const live: string[] = [];
    for (const host of this.registry.hosts) {
      if (host.name === this.self?.name || this.servers.has(host.name)) continue;
      const path = join(this.dir, `${host.name}.sock`);
      if (!this.options.replaceLive && await answers(path)) { live.push(host.name); continue; }
      // The server listens on a name of its own and is renamed into place, since Node unlinks the path a server listened on when it closes.
      const own = `${path}.${process.pid}`;
      await rm(own, { force: true });
      const server = createServer(client => {
        this.sockets.add(client);
        client.once("close", () => this.sockets.delete(client));
        client.pause();
        openDaemonTunnel(host).then(remote => {
          if (client.destroyed) { remote.destroy(); return; }
          const decoder = decodeLineDeltas();
          client.pipe(remote);
          remote.pipe(decoder).pipe(client);
          decoder.on("error", error => {
            this.options.log?.(`hosts: ${host.name}: ${error.message}`);
            client.destroy();
          });
          remote.on("error", () => client.destroy());
          client.on("error", () => remote.destroy());
          // The client ends once the decoder has passed on every byte the relay sent; destroying it at once dropped the tail of a stream.
          remote.on("close", () => { if (!decoder.writableEnded) decoder.end(); });
          client.on("close", () => remote.destroy());
        }, error => {
          this.options.log?.(`hosts: ${host.name}: ${error instanceof Error ? error.message : String(error)}`);
          client.destroy();
        });
      });
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(own, () => { server.off("error", reject); resolve(); }); });
      await chmod(own, 0o600);
      const { ino } = await stat(own);
      await rename(own, path);
      this.servers.set(host.name, { server, ino });
    }
    return { live };
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await Promise.all([...this.servers.entries()].map(async ([name, { server, ino }]) => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      const path = join(this.dir, `${name}.sock`);
      if ((await stat(path).catch(() => null))?.ino === ino) await rm(path, { force: true });
    }));
    this.servers.clear();
  }
}
