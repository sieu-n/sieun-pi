import type { AgentSummary, ModelCatalog, RunStatus } from "$lib/api";
import type { ModelOption } from "$lib/ui";

export type AgentsTab = "yours" | "jobs";
export const TABS: readonly { id: AgentsTab; label: string }[] = [
  { id: "yours", label: "Your agents" },
  { id: "jobs", label: "Jobs" },
];
/**
 * `#/agents` and `#/agents/jobs` are the two tabs; `#/agents/<id>` opens that agent's configuration over the tab it belongs to, so a link
 * names one agent and back closes it.
 */
export const agentFromRoute = (rest: readonly string[]): string | null => (rest[0] && rest[0] !== "jobs" ? rest[0] : null);
export function tabFromRoute(rest: readonly string[], agent?: AgentSummary | null): AgentsTab {
  if (rest[0] === "jobs") return "jobs";
  return agent ? tabOf(agent) : "yours";
}

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
  open: "Message",
  model: "Change model",
  stop: "Stop",
  archive: "Archive",
};

/**
 * Where Message goes: an agent's DM, or a job's pane beside its agent's DM. `room` names the DM of an agent id (the `agents` store's
 * `room`), and the agent's own `room` wins when the summary has one.
 */
export function openTarget(agent: AgentSummary, room: (id: string) => string = (id) => id): { id: string; thread?: string } {
  if (agent.kind === "job" && agent.parent) return { id: room(agent.parent.id), thread: agent.id };
  return { id: agent.room ?? room(agent.id) };
}

/** The Jobs tab: each agent's jobs under it, the agent with the newest job first, and in each group working jobs first. */
export function jobGroups(agents: readonly AgentSummary[]): { parent: { id: string; name: string } | null; jobs: AgentSummary[] }[] {
  const groups = new Map<string, { parent: { id: string; name: string } | null; jobs: AgentSummary[] }>();
  for (const job of agentsIn(agents, "jobs")) {
    const key = job.parent?.id ?? "";
    const group = groups.get(key) ?? { parent: job.parent, jobs: [] };
    group.jobs.push(job);
    groups.set(key, group);
  }
  const newest = (jobs: readonly AgentSummary[]) => Math.max(...jobs.map((job) => job.updatedAt));
  return [...groups.values()].sort((a, b) => (a.parent ? 0 : 1) - (b.parent ? 0 : 1) || newest(b.jobs) - newest(a.jobs));
}

/** How many live jobs each agent runs, and how many of them work now, for the line on its card. */
export function jobCounts(agents: readonly AgentSummary[]): Map<string, { total: number; working: number }> {
  const counts = new Map<string, { total: number; working: number }>();
  for (const job of agents) {
    if (job.kind !== "job" || job.archived || !job.parent) continue;
    const count = counts.get(job.parent.id) ?? { total: 0, working: 0 };
    count.total++;
    if (job.status === "working") count.working++;
    counts.set(job.parent.id, count);
  }
  return counts;
}

export function jobsLabel(count: { total: number; working: number } | undefined): string | null {
  if (!count?.total) return null;
  const jobs = `${count.total} ${count.total === 1 ? "job" : "jobs"}`;
  return count.working ? `${jobs}, ${count.working} working` : jobs;
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

/** Archive takes a root thread; a job inside a thread goes with its thread. */
export const canArchive = (agent: AgentSummary): boolean => agent.conversation === 1;

export type ConfigSection = "overview" | "runs" | "board" | "memory" | "instructions" | "swarm";
/** Short labels so all six fit the 420 px side panel; the Host section reads as "Where it runs" inside. */
export const SECTIONS: readonly { id: ConfigSection; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "runs", label: "Host" },
  { id: "board", label: "Board" },
  { id: "memory", label: "Memory" },
  { id: "instructions", label: "Instructions" },
  { id: "swarm", label: "Swarm" },
];
export const sectionFromParams = (params: Record<string, string>): ConfigSection =>
  SECTIONS.some((section) => section.id === params.section) ? (params.section as ConfigSection) : "overview";

export function bytesLabel(size: number | null): string {
  if (size === null) return "";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** A home-relative path for display, so /home/sieun/x reads ~/x; the copy button keeps the full path. */
export function shortPath(path: string): string {
  const home = /^\/home\/[^/]+/.exec(path);
  return home ? `~${path.slice(home[0].length)}` : path;
}

export function everyLabel(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes % 60 === 0) return `every ${minutes / 60} h`;
  return `every ${minutes} min`;
}

export const JOB_KIND_LABEL: Record<"job" | "duty" | "root job", string> = { job: "job", duty: "duty run", "root job": "root job" };
