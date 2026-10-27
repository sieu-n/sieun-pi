/**
 * The process-wide agent registry that pi-rlm, pi-agent-bus and pi-host share.
 *
 * Pi loads each extension through its own loader, so a plain module-level Map could exist once per extension path. The registry therefore
 * lives on `globalThis` under one symbol, which gives exactly one store per Node process: one per pi-host, one per plain `pi` CLI.
 *
 * pi-rlm calls `assignIdentity` before it creates a child session, so the child's own extensions find their name, parent and depth at
 * `session_start`. pi-agent-bus registers every session it is loaded into and supplies `deliver`. pi-host reads the registry for its roster.
 */

export type AgentRole = "root" | "child";
export type AgentActivity = "idle" | "working" | "ended";
export type DeliveryMode = "auto" | "steer" | "follow_up";
export type Delivery = "started" | "queued";

export interface Identity {
  name: string;
  role: AgentRole;
  parentId?: string;
  depth: number;
}

export interface BusMessage {
  id: string;
  from: { id: string; name: string; role: AgentRole | "host" | "owner" };
  text: string;
  mode: DeliveryMode;
  sentAt: number;
}

export interface MessagePreview {
  role: string;
  text: string;
  timestamp?: number;
}

export interface AgentEntry extends Identity {
  id: string;
  cwd: string;
  sessionFile?: string;
  activity(): AgentActivity;
  deliver(message: BusMessage): Promise<Delivery>;
  preview(limit: number): MessagePreview[];
}

interface Store {
  identities: Map<string, Identity>;
  agents: Map<string, AgentEntry>;
  listeners: Set<(event: { type: "registered" | "unregistered"; id: string }) => void>;
}

const KEY = Symbol.for("sieun-pi.pi-stack.registry");

function store(): Store {
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  return (g[KEY] ??= { identities: new Map(), agents: new Map(), listeners: new Set() });
}

/** Names the session that is about to open. A session with no assigned identity is a root at depth 0. */
export function assignIdentity(sessionId: string, identity: Identity): void {
  store().identities.set(sessionId, identity);
}

export function identityOf(sessionId: string, fallbackName: string): Identity {
  return store().identities.get(sessionId) ?? { name: fallbackName, role: "root", depth: 0 };
}

export function register(entry: AgentEntry): void {
  const s = store();
  s.agents.set(entry.id, entry);
  for (const listener of s.listeners) listener({ type: "registered", id: entry.id });
}

export function unregister(sessionId: string): void {
  const s = store();
  if (!s.agents.delete(sessionId)) return;
  s.identities.delete(sessionId);
  for (const listener of s.listeners) listener({ type: "unregistered", id: sessionId });
}

export function get(sessionId: string): AgentEntry | undefined {
  return store().agents.get(sessionId);
}

export function list(): AgentEntry[] {
  return [...store().agents.values()];
}

export function childrenOf(parentId: string): AgentEntry[] {
  return list().filter(agent => agent.parentId === parentId);
}

export function onChange(listener: (event: { type: "registered" | "unregistered"; id: string }) => void): () => void {
  store().listeners.add(listener);
  return () => store().listeners.delete(listener);
}

/**
 * A family member that is known but not loaded, such as a closed RLM child or a root that pi-host unloaded.
 * pi-rlm and pi-host register these rows. `wake()` opens the session and resolves with its entry once pi-agent-bus has registered it.
 * While an entry with the same id is registered, `dormant()` and `dormantOf()` hide the row, and the owner replaces or removes it with `registerDormant` and `unregisterDormant`.
 */
export interface DormantAgent extends Identity {
  id: string;
  cwd: string;
  sessionFile?: string;
  firstMessage?: string;
  wake(): Promise<AgentEntry>;
}

const DORMANT_KEY = Symbol.for("sieun-pi.pi-stack.registry.dormant");

function dormantStore(): Map<string, DormantAgent> {
  const g = globalThis as unknown as Record<symbol, Map<string, DormantAgent> | undefined>;
  return (g[DORMANT_KEY] ??= new Map());
}


export function registerDormant(row: DormantAgent): void {
  dormantStore().set(row.id, row);
}

export function unregisterDormant(sessionId: string): void {
  dormantStore().delete(sessionId);
}

export function dormant(): DormantAgent[] {
  return [...dormantStore().values()].filter(row => !store().agents.has(row.id));
}

export function dormantOf(sessionId: string): DormantAgent | undefined {
  return store().agents.has(sessionId) ? undefined : dormantStore().get(sessionId);
}
