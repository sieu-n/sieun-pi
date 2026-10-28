/**
 * Who may see which hits. The owner's calls carry no caller and search everything. An agent's call carries its session id and transcript
 * path. The owner let agents search every chat on 10-28 (board todo t113), so `agentScope` defaults to "all". Set to "family", an agent sees
 * only its own chat family, the set packages/sieun-rules/src/kernel-read.py lets a kernel read (`root_of`, `chat_of`).
 */
import { readFileSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export type AgentScope = "family" | "all";

export interface Settings {
  agentScope: AgentScope;
  /** This box's hosts.json name. */
  box: string;
  /** The hosts.json path, relative to ~/.config/sieun-pi. */
  peers: string;
  durableIndexes: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const expandHome = (path: string): string => path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
export const settingsPath = (): string => process.env.PI_HISTORY_SETTINGS ?? join(homedir(), ".config", "pi-history", "settings.json");
export const sieunPiConfig = (): string => process.env.SIEUN_PI_CONFIG_DIR ?? join(homedir(), ".config", "sieun-pi");

export interface HostEntry { name: string; hostname?: string; address?: string; relayPort?: number; token?: string; roles?: Record<string, { port?: number; url?: string }> }

/** hosts.json's hosts, or none when the file is missing. */
export function readHosts(file: string): HostEntry[] {
  try {
    const hosts = (JSON.parse(readFileSync(file, "utf8")) as { hosts?: unknown }).hosts;
    return Array.isArray(hosts) ? hosts.filter((host): host is HostEntry => !!host && typeof (host as HostEntry).name === "string") : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

const short = (name: string): string => name.split(".")[0]!.toLowerCase();
export const hostsFile = (settings: Pick<Settings, "peers">): string => {
  const path = expandHome(settings.peers);
  return path.startsWith(sep) ? path : join(sieunPiConfig(), path);
};

let cached: { key: string; settings: Settings } | null = null;

/** settings.json with defaults, read again whenever the file changes (one stat per request). */
export function readSettings(path = settingsPath()): Settings {
  let key = "missing";
  try { const stat = statSync(path); key = `${stat.mtimeMs}:${stat.size}`; } catch {}
  if (cached?.key === `${path}:${key}`) return cached.settings;
  let raw: Partial<Settings> = {};
  if (key !== "missing") raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Settings>;
  const peers = typeof raw.peers === "string" ? raw.peers : "hosts.json";
  const box = typeof raw.box === "string" && raw.box ? raw.box
    : readHosts(hostsFile({ peers })).find(host => host.hostname && short(host.hostname) === short(hostname()))?.name ?? short(hostname());
  const settings: Settings = {
    agentScope: raw.agentScope === "family" ? "family" : "all", box, peers,
    durableIndexes: (Array.isArray(raw.durableIndexes) ? raw.durableIndexes.map(String) : ["~/.prime/agent/pi-host/durable/index.sqlite"]).map(expandHome),
  };
  cached = { key: `${path}:${key}`, settings };
  return settings;
}

export interface JobEntry { chat?: string; chatId?: string }
/** chat-jobs.json: which chat started each root job, keyed by session id or by the job's name. */
export interface Registry { jobs: Record<string, JobEntry> }

/** The chat a root belongs to: the root itself, or the chat that started it, followed up the registry (`chat_of` in kernel-read.py). */
/**
 * Each chat name's id, built once per registry object. Built per call, it cost 0.8 ms over 1,746 jobs, and the indexer's 5,876 calls a sweep
 * held us-metal02's main thread for 4.6 to 5.3 s on 10-28.
 */
const chatIds = new WeakMap<Registry, Map<string, string>>();
function chatIdsOf(registry: Registry): Map<string, string> {
  let names = chatIds.get(registry);
  if (!names) {
    names = new Map();
    for (const entry of Object.values(registry.jobs)) if (entry?.chat && entry.chatId) names.set(entry.chat, entry.chatId);
    chatIds.set(registry, names);
  }
  return names;
}

export function chatOf(root: string, registry: Registry, nameOf: (root: string) => string | null): string {
  const names = chatIdsOf(registry);
  const seen = new Set<string>();
  let current = root;
  while (!seen.has(current)) {
    seen.add(current);
    const name = nameOf(current);
    const entry = registry.jobs[current] ?? (name ? registry.jobs[name] : undefined);
    const parent = entry ? entry.chatId ?? (entry.chat ? names.get(entry.chat) : undefined) : undefined;
    if (!parent || !UUID.test(parent)) break;
    current = parent;
  }
  return current;
}

/** Each root on this box and its name, from the index. */
export function localRoots(db: DatabaseSync): Map<string, string | null> {
  const rows = db.prepare("SELECT root, (SELECT name FROM files r WHERE r.session = f.root AND r.depth = 0 LIMIT 1) AS name FROM (SELECT DISTINCT root FROM files) f")
    .all() as { root: string; name: string | null }[];
  return new Map(rows.map(row => [String(row.root), row.name === null ? null : String(row.name)]));
}

/**
 * The roots of the chats in `chats`: those chats, every root on this box whose chat is one of them, and every root job the registry names by
 * id under them. A peer gets the caller box's list as `roots=` and runs the same step, which adds its own roots that the registry names by
 * job name only.
 */
export function familyRoots(chats: Iterable<string>, registry: Registry, roots: Map<string, string | null>): string[] {
  const wanted = new Set(chats);
  const nameOf = (root: string): string | null => roots.get(root) ?? null;
  const out = new Set(wanted);
  for (const root of [...roots.keys(), ...Object.keys(registry.jobs).filter(key => UUID.test(key))]) {
    if (!out.has(root) && wanted.has(chatOf(root, registry, nameOf))) out.add(root);
  }
  return [...out];
}

/** The folder after session-artifacts/ in a transcript path, as kernel-read.py `artifact_root` reads it. */
export function artifactRoot(path: string): string | null {
  const parts = path.split(sep);
  const index = parts.indexOf("session-artifacts");
  return index >= 0 && index + 2 < parts.length && UUID.test(parts[index + 1]!) ? parts[index + 1]! : null;
}

/** The root of the caller's tree: the index's own `files.root` for its session, else the artifact folder in its path, else its id. */
export function callerRoot(db: DatabaseSync, caller: string, callerPath: string | null): string {
  const row = db.prepare("SELECT root FROM files WHERE session = ? LIMIT 1").get(caller) as { root?: string } | undefined;
  if (row?.root) return String(row.root);
  return (callerPath && artifactRoot(callerPath)) || caller;
}

/** Where chat-jobs.json lives: a file on the chat host, the chat service's api/agent/jobs on any other box. */
export type RegistrySource = { kind: "file"; path: string } | { kind: "remote"; url: string };

/** The registry source for this box, from hosts.json's chat role and ~/.config/sieun-pi/chat-access.json, as the board skill finds it. */
export function registrySource(settings: Settings): RegistrySource {
  const holder = readHosts(hostsFile(settings)).find(host => host.roles && "chat" in host.roles);
  const local = { kind: "file", path: join(process.env.AGENT_CHAT_DATA_DIR ?? join(homedir(), ".prime", "agent", "browser-chat"), "chat-jobs.json") } as const;
  if (!holder || holder.name === settings.box || (holder.hostname && short(holder.hostname) === short(hostname()))) return local;
  const role = holder.roles!.chat!;
  const base = (role.url ?? `http://${holder.address}:${role.port}`).replace(/\/+$/, "");
  const access = JSON.parse(readFileSync(join(sieunPiConfig(), "chat-access.json"), "utf8")) as { capability: string };
  return { kind: "remote", url: `${base}/${access.capability}/api/agent/jobs` };
}

const parseRegistry = (raw: string): Registry => {
  const jobs = (JSON.parse(raw) as { jobs?: unknown }).jobs;
  return { jobs: jobs && typeof jobs === "object" ? jobs as Record<string, JobEntry> : {} };
};

/**
 * Reads the registry. A local file is read again when it changes. The chat host's copy is fetched on every agent call, like kernel-read.py's
 * fresh read, so a job the chat started a moment ago counts; when that fetch fails, the last copy stands and a box with none sees an empty
 * registry, so each root is its own chat.
 */
export class RegistryReader {
  private last: { key: string; registry: Registry } | null = null;
  private readonly source: () => RegistrySource;
  private readonly fetcher: typeof fetch;
  constructor(source: () => RegistrySource, fetcher: typeof fetch = fetch) { this.source = source; this.fetcher = fetcher; }

  async read(): Promise<Registry> {
    const source = this.source();
    if (source.kind === "file") {
      let key = "missing";
      try { key = `${source.path}:${statSync(source.path).mtimeMs}`; } catch {}
      if (this.last?.key === key) return this.last.registry;
      const registry = key === "missing" ? { jobs: {} } : parseRegistry(readFileSync(source.path, "utf8"));
      this.last = { key, registry };
      return registry;
    }
    try {
      const response = await this.fetcher(source.url);
      if (!response.ok) throw new Error(`${source.url} answered ${response.status}`);
      const registry = parseRegistry(await response.text());
      this.last = { key: source.url, registry };
      return registry;
    } catch (error) {
      if (this.last) return this.last.registry;
      process.emitWarning(`pi-history: chat job registry unread (${error instanceof Error ? error.message : String(error)}); each root counts as its own chat`);
      return { jobs: {} };
    }
  }
}
