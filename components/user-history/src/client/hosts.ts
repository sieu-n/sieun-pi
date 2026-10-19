import type { HostCard, HostRole } from "../shared/types.ts";

const ROLE_TEXT: Record<HostRole, string> = { pool: "the account pool", wiki: "the wiki", chat: "the chat app" };

/** The line under a host's name: which shared services it holds, or that it runs agents only. */
export function hostRoles(host: Pick<HostCard, "roles">): string {
  const held = host.roles.map(role => ROLE_TEXT[role]);
  if (!held.length) return "Runs agents and borrows accounts from the pool.";
  const list = held.length === 1 ? held[0] : `${held.slice(0, -1).join(", ")} and ${held.at(-1)}`;
  return `Runs agents and holds ${list}.`;
}

const gb = (bytes: number): string => (bytes / 1024 ** 3).toFixed(0);

/**
 * A host's one-line state for its card head and the New chat host menu. Working counts the sessions that stream or run a tool, and waiting the
 * ones that hold a turn open while they wait on the provider, the pool or a subagent (src/agent-states.ts).
 */
export function hostGlance(host: HostCard): string {
  if (host.state === "unreachable") return "Not answering";
  const cpu = `${Math.round(host.machine.cpu.percent)}% CPU`;
  const memory = `${gb(host.machine.memory.usedBytes)} of ${gb(host.machine.memory.totalBytes)} GB`;
  const sessions = host.sessions ? `${host.sessions.working} working, ${host.sessions.retry + host.sessions.children} waiting` : "sessions not read";
  return [cpu, memory, ...host.daemon === "down" ? ["daemon down"] : [sessions]].join(" · ");
}

/** The glance's session counts in full, for its tooltip; empty before the sessions are read. */
export function hostSessions(host: HostCard): string {
  if (host.state === "unreachable" || !host.sessions) return "";
  const { working, retry, children, idle } = host.sessions;
  return `${working} streaming or running a tool, ${retry} waiting on the provider or the pool, ${children} waiting on their subagents, ${idle} idle.`;
}

/** The host a new chat starts on: the owner's last pick while it is listed and answering, else this box. */
export function defaultHost(hosts: HostCard[], lastHost: string | null): string | null {
  const last = hosts.find(host => host.name === lastHost && host.state === "up");
  return last?.name ?? hosts.find(host => host.self)?.name ?? hosts[0]?.name ?? null;
}
