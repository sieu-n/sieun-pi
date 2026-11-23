import { agents, conversations, type AgentConfig, type AgentFolder, type AgentSummary, type RunStatus } from "$lib/api";
import type { ConfigSection } from "./agents-model";

/**
 * What the agent page's shell (AgentConfigPanel.svelte) hands each tab: the agent's live card, its configuration, and the calls that read
 * it again, keep a new answer, switch tab and open its DM. Each tab is its own component file, so one builder owns one tab.
 */
export type AgentTabProps = {
  agentId: string;
  agent: AgentSummary | null;
  config: AgentConfig;
  reload: () => void | Promise<void>;
  onconfig: (next: AgentConfig) => void;
  onsection: (section: ConfigSection) => void;
  onmessage: (agent: AgentSummary) => void;
};

/** The config with a saved folder in place, its memory sent as a count as the config sends it. */
export function withFolder(config: AgentConfig, next: AgentFolder): AgentConfig {
  if (next.agent !== config.folder?.agent) return config;
  const { entries, ...memory } = next.memory;
  return { ...config, folder: { ...next, memory: { ...memory, count: entries.length } } };
}

/** Whether the folder is the agent's own, and the name of the agent whose folder it loads, which may sit above a job that started it. */
export function folderOwner(config: AgentConfig, agent: AgentSummary | null, agentId: string): { own: boolean; name: string } {
  const folder = config.folder;
  const own = !!folder && folder.agent === agentId;
  const name = own ? (agent?.name ?? "") : (agent?.agent?.name ?? (folder ? agents.byId(folder.agent)?.name : undefined) ?? "its agent");
  return { own, name };
}

export const statusDot = (status: RunStatus): "online" | "away" | "busy" | "offline" =>
  status === "working" ? "online" : status === "sleeping" ? "away" : status === "failed" ? "busy" : "offline";

/** A comm thread is named by its room, never as an agent or a job; an archived room keeps its name. */
export function commLabel(config: AgentConfig, room: string): string {
  if (room.startsWith("dm_")) return "DM comm thread";
  const known = conversations.byId(room);
  const row = config.swarm.commRooms?.find((r) => r.id === room);
  const name = known?.name ?? row?.name ?? room;
  const kind = known?.kind ?? row?.kind ?? (room.startsWith("ch_") ? "channel" : "solo");
  return `Comm thread in ${kind === "channel" ? "#" : ""}${name}`;
}

export const commArchived = (config: AgentConfig, room: string): boolean => !!config.swarm.commRooms?.find((r) => r.id === room)?.archived;

/** Its comm threads with those in archived rooms last, as Slack lists an archived channel after the open ones. */
export const commThreadsOf = (config: AgentConfig, agent: AgentSummary | null) =>
  [...(agent?.comm ?? [])].sort((a, b) => Number(commArchived(config, a.room)) - Number(commArchived(config, b.room)));

export const hostLineOf = (config: AgentConfig): string =>
  config.runs.hostVersion && config.runs.hostVersion !== config.runs.hostKind ? `${config.runs.hostKind} ${config.runs.hostVersion}` : config.runs.hostKind;

export const plural = (n: number, word: string, many = `${word}s`): string => `${n.toLocaleString("en-US")} ${n === 1 ? word : many}`;
export const money = (n: number): string => `$${n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString("en-US")}`;
