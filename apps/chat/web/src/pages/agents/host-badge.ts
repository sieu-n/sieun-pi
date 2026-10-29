/**
 * Where an agent runs, as the web shows it (agent-model.md phase 6). An agent on another box than the chat's own gets a badge beside its
 * name, which dims and says "away" while the chat server has no live link to that box. A post to an away box waits as
 * "queued, <box> is offline" and goes when the box comes back.
 */
import type { AgentHost, AgentHostState, ProjectList } from "$lib/api";

/** The word a box shows as: "Mac" for the owner's Mac, and the box name for any other box. */
export const boxLabel = (box: string): string => (box === "mac" ? "Mac" : box);

export interface HostBadgeView {
  label: string;
  away: boolean;
  title: string;
}

/** The badge beside an agent's name, or null when the agent runs on the chat's own box or the page does not know that box yet. */
export function hostBadge(agent: { host: string; hostState?: AgentHostState }, self: string | null | undefined): HostBadgeView | null {
  if (!self || !agent.host || agent.host === self) return null;
  const label = boxLabel(agent.host);
  const away = agent.hostState === "away";
  return { label, away, title: away ? `Runs on ${label}, which is offline. Posts to it wait until it is back.` : `Runs on ${label}` };
}

const OFFLINE = /^queued, (.+) is offline$/;

/** The line under the owner's post while its delivery waits on an away box, or null for any other state or error. */
export function offlineText(error: string | null | undefined): string | null {
  const box = error?.match(OFFLINE)?.[1];
  return box ? `Queued, ${boxLabel(box)} is offline` : null;
}

export interface HostOption {
  value: string;
  label: string;
  /** An away box is listed but cannot take a new agent, since its pi-host makes the agent's work thread. */
  disabled: boolean;
}

/** The host picker's rows: the chat's own box first, then the rest by name, each away box marked. */
export function hostOptions(hosts: readonly AgentHost[]): HostOption[] {
  return [...hosts]
    .sort((a, b) => Number(b.self) - Number(a.self) || a.box.localeCompare(b.box))
    .map((host) => {
      const away = host.state === "away" && !host.self;
      return { value: host.box, label: `${host.label || boxLabel(host.box)}${host.self ? " (this box)" : ""}${away ? " · away" : ""}`, disabled: away };
    });
}

/** The box a new agent starts on: the chat's own box, or the first listed box when the list has no self row. */
export function defaultHost(hosts: readonly AgentHost[]): string {
  return (hosts.find((host) => host.self) ?? hosts[0])?.box ?? "";
}

/** The project folders the create form offers on a box other than the chat's own, from that box's row of `GET /api/agent-hosts`. */
export function hostProjects(host: AgentHost): ProjectList {
  const paths = host.projects ?? [];
  return {
    projects: paths.map((path) => ({ path, name: path.split("/").filter(Boolean).at(-1) ?? path })),
    default: paths[0] ?? host.home ?? null,
    home: host.home ?? "",
  };
}
