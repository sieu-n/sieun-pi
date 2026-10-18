import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { homedir, hostname as osHostname } from "node:os";
import { isAbsolute, join } from "node:path";

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
};
export type HostsRegistry = { version: 1; hosts: Host[] };

const ROLES: readonly HostRole[] = ["pool", "wiki", "chat"];
const NAME = /^[a-z0-9][a-z0-9-]*$/;
export const CONFIG_DIR = join(homedir(), ".config/sieun-pi");
export const HOSTS_FILE = join(CONFIG_DIR, "hosts.json");
export const BRIDGE_DIR = join(homedir(), ".local/state/sieun-pi/hosts");
const UPGRADE = "prime-daemon";

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
  return { name, hostname: text("hostname"), address: text("address"), relayPort, token, daemonSocket, ssh, roles };
}

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

type RelayResponse = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer };

async function relayRequest(host: Host, path: string, headers: Record<string, string> = {}, method = "GET", timeoutMs = 15_000): Promise<RelayResponse> {
  const token = await hostToken(host);
  return await new Promise((resolve, reject) => {
    const request = httpRequest({ host: host.address, port: host.relayPort, path, method, headers: { ...headers, authorization: `Bearer ${token}` }, timeout: timeoutMs }, response => {
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

/** Bytes of a file on the host's disk from offset `from`, read through its relay. `size` is the whole file, so the next tail starts there. */
export async function readHostFile(host: Host, path: string, options: { from?: number } = {}): Promise<{ bytes: Buffer; size: number; from: number }> {
  const from = options.from ?? 0;
  const response = await relayRequest(host, `/v1/file?path=${encodeURIComponent(path)}`, from > 0 ? { range: `bytes=${from}-` } : {});
  if (response.status === 416) {
    const size = Number(/\/(\d+)$/.exec(String(response.headers["content-range"] ?? ""))?.[1] ?? 0);
    return { bytes: Buffer.alloc(0), size, from: size };
  }
  if (response.status !== 200 && response.status !== 206) throw new Error(`relay ${host.name}: ${path}: ${response.status} ${response.body.toString("utf8").slice(0, 200)}`);
  return { bytes: response.body, size: Number(response.headers["x-file-size"] ?? response.body.length), from };
}

export type HostDirEntry = { name: string; type: "dir" | "file" | "other"; size: number; mtimeMs: number };

export async function listHostDir(host: Host, path: string): Promise<HostDirEntry[]> {
  const response = await relayRequest(host, `/v1/file?path=${encodeURIComponent(path)}`);
  if (response.status !== 200) throw new Error(`relay ${host.name}: ${path}: ${response.status} ${response.body.toString("utf8").slice(0, 200)}`);
  const body = JSON.parse(response.body.toString("utf8")) as { entries?: HostDirEntry[] };
  if (!body.entries) throw new Error(`relay ${host.name}: ${path} is a file`);
  return body.entries;
}

/** A raw byte stream to the host's daemon socket through its relay. */
export async function openDaemonTunnel(host: Host, timeoutMs = 10_000): Promise<Socket> {
  const token = await hostToken(host);
  return await new Promise((resolve, reject) => {
    const request = httpRequest({ host: host.address, port: host.relayPort, path: "/v1/daemon", timeout: timeoutMs,
      headers: { connection: "Upgrade", upgrade: UPGRADE, authorization: `Bearer ${token}` } });
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

/**
 * One local socket per remote host, each connection tunneled to that host's relay, so `new DaemonClient(bridge.socketPath(name))`
 * talks to the remote daemon unchanged. The self host maps to its own daemon socket and gets no bridge.
 */
export class HostBridge {
  private readonly servers = new Map<string, Server>();
  constructor(private readonly registry: HostsRegistry, private readonly options: { dir?: string; self?: Host | null; log?: (line: string) => void } = {}) {}

  private get dir(): string { return this.options.dir ?? BRIDGE_DIR; }
  private get self(): Host | null { return this.options.self === undefined ? selfHost(this.registry) : this.options.self; }

  socketPath(name: string): string {
    const host = hostNamed(this.registry, name);
    return host.name === this.self?.name ? host.daemonSocket : join(this.dir, `${host.name}.sock`);
  }

  async start(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    for (const host of this.registry.hosts) {
      if (host.name === this.self?.name || this.servers.has(host.name)) continue;
      const path = join(this.dir, `${host.name}.sock`);
      await rm(path, { force: true });
      const server = createServer(client => {
        client.pause();
        openDaemonTunnel(host).then(remote => {
          client.pipe(remote).pipe(client);
          remote.on("error", () => client.destroy());
          client.on("error", () => remote.destroy());
          remote.on("close", () => client.destroy());
          client.on("close", () => remote.destroy());
        }, error => {
          this.options.log?.(`hosts: ${host.name}: ${error instanceof Error ? error.message : String(error)}`);
          client.destroy();
        });
      });
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, () => { server.off("error", reject); resolve(); }); });
      await chmod(path, 0o600);
      this.servers.set(host.name, server);
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.servers.entries()].map(([name, server]) => new Promise<void>(resolve => server.close(() => resolve())).then(() => rm(join(this.dir, `${name}.sock`), { force: true }))));
    this.servers.clear();
  }
}
