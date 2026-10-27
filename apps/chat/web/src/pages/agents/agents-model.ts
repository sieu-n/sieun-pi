import type { AgentSummary, ModelCatalog, RunStatus } from "$lib/api";
import type { ModelOption } from "$lib/ui";

export type AgentsTab = "yours" | "jobs";
export const TABS: readonly { id: AgentsTab; label: string }[] = [
  { id: "yours", label: "Your agents" },
  { id: "jobs", label: "Jobs" },
];
export const tabFromRoute = (rest: readonly string[]): AgentsTab => (rest[0] === "jobs" ? "jobs" : "yours");

export type CardAction = "open" | "model" | "stop" | "archive";

const STATUS_RANK: Record<RunStatus, number> = { working: 0, sleeping: 1, failed: 2, idle: 3 };

export const tabOf = (agent: AgentSummary): AgentsTab => (agent.kind === "chat" ? "yours" : "jobs");

/** Chats by newest activity; jobs working first, then by newest activity. */
export function agentsIn(agents: readonly AgentSummary[], tab: AgentsTab): AgentSummary[] {
  const shown = agents.filter((agent) => !agent.archived && tabOf(agent) === tab);
  return shown.sort((a, b) =>
    tab === "jobs" && STATUS_RANK[a.status] !== STATUS_RANK[b.status]
      ? STATUS_RANK[a.status] - STATUS_RANK[b.status]
      : b.updatedAt - a.updatedAt || a.name.localeCompare(b.name),
  );
}

export function countsByTab(agents: readonly AgentSummary[]): Record<AgentsTab, number> {
  const counts: Record<AgentsTab, number> = { yours: 0, jobs: 0 };
  for (const agent of agents) if (!agent.archived) counts[tabOf(agent)]++;
  return counts;
}

export const STATUS_LABEL: Record<RunStatus, string> = {
  working: "Working",
  sleeping: "Waiting",
  failed: "Failed",
  idle: "Idle",
};

/** Stop shows only while the agent runs or waits for a slot. */
export function actionsFor(agent: AgentSummary): CardAction[] {
  const actions: CardAction[] = ["open", "model"];
  if (agent.status === "working" || agent.status === "sleeping") actions.push("stop");
  actions.push("archive");
  return actions;
}

export const ACTION_LABEL: Record<CardAction, string> = {
  open: "Open thread",
  model: "Change model",
  stop: "Stop",
  archive: "Archive",
};

/** Where a card opens: a chat's own channel view, or a job's pane beside its parent chat. */
export function openTarget(agent: AgentSummary): { id: string; thread?: string } {
  if (agent.kind === "job" && agent.parent) return { id: agent.parent.id, thread: agent.id };
  return { id: agent.id };
}

/** The catalog keys models as "provider/id", the form the server takes back. */
export const modelKey = (model: { provider: string; id: string }): string => `${model.provider}/${model.id}`;

export function modelOptions(catalog: ModelCatalog | null): ModelOption[] {
  return (catalog?.models ?? []).map((model) => ({ id: modelKey(model), label: model.label, family: familyLabel(model.family) }));
}

const FAMILY: Record<string, string> = { claude: "Claude", gpt: "GPT", gemini: "Gemini" };
const familyLabel = (family: string): string => FAMILY[family] ?? family.charAt(0).toUpperCase() + family.slice(1);

/** The thinking levels the agent's model takes; empty when the catalog does not list the model. */
export function levelsFor(catalog: ModelCatalog | null, key: string): string[] {
  return catalog?.models.find((model) => modelKey(model) === key)?.levels ?? [];
}
