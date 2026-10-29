import type { AgentSummary, ModelCatalog, RunStatus } from "$lib/api";
import type { ModelOption } from "$lib/ui";

/**
 * `#/agents` shows the card grid; `#/agents/<id>` opens one agent's page in its place, or a job's page from its agent's Jobs tab, so a link
 * names one and back returns to the grid.
 */
export const agentFromRoute = (rest: readonly string[]): string | null => rest[0] ?? null;

/** The registered agent a route id names: the id itself, or the agent a job works for, so the sidebar marks the agent while its job is open. */
export function agentOfRoute(id: string | null, jobs: readonly AgentSummary[]): string | null {
  if (!id) return null;
  return jobs.find((job) => job.id === id)?.agent?.id ?? id;
}

export type AgentGroup = "working" | "failed" | "idle";

/**
 * The Agents sidebar's blocks: Working (working or waiting for a slot), Failed only when one failed, then Idle. Each block lists live agents
 * by name, so a row keeps its place while its agent stays in that state.
 */
export function agentGroups(agents: readonly AgentSummary[]): { id: AgentGroup; label: string; agents: AgentSummary[] }[] {
  const live = agents.filter((agent) => !agent.archived).sort((a, b) => a.name.localeCompare(b.name));
  const of = (group: AgentGroup) => live.filter((agent) => groupOf(agent.status) === group);
  const failed = of("failed");
  return [
    { id: "working", label: "Working", agents: of("working") },
    ...(failed.length ? [{ id: "failed" as const, label: "Failed", agents: failed }] : []),
    { id: "idle", label: "Idle", agents: of("idle") },
  ];
}
const groupOf = (status: RunStatus): AgentGroup => (status === "working" || status === "sleeping" ? "working" : status === "failed" ? "failed" : "idle");

/** The status dot an agent's avatar shows: green while working, away while waiting, red when failed, none when idle. */
export const dotOf = (status: RunStatus): "online" | "away" | "busy" | null =>
  status === "working" ? "online" : status === "sleeping" ? "away" : status === "failed" ? "busy" : null;

export type CardAction = "open" | "model" | "stop" | "archive";

/** Live agents by newest activity. */
export function agentsShown(agents: readonly AgentSummary[]): AgentSummary[] {
  return agents.filter((agent) => !agent.archived).sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
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
 * Where Message goes: an agent's DM, or a job's pane beside the DM of the agent it works for, also for a job a job started. `room` names
 * the DM of an agent id (the `agents` store's `room`), and the agent's own `room` wins when the summary has one.
 */
export function openTarget(agent: AgentSummary, room: (id: string) => string = (id) => id): { id: string; thread?: string } {
  const owner = agent.kind === "job" ? (agent.agent ?? agent.parent) : null;
  if (owner) return { id: room(owner.id), thread: agent.id };
  return { id: agent.room ?? room(agent.id) };
}

/** How many live jobs each registered agent runs, and how many of them work now, for the line on its card. */
export function jobCounts(jobs: readonly AgentSummary[]): Map<string, { total: number; working: number }> {
  const counts = new Map<string, { total: number; working: number }>();
  for (const job of jobs) {
    if (job.archived || !job.agent) continue;
    const count = counts.get(job.agent.id) ?? { total: 0, working: 0 };
    count.total++;
    if (job.status === "working") count.working++;
    counts.set(job.agent.id, count);
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

/** The tabs of an agent's page, as apps/chat/docs/agent-model.md names them. */
export type ConfigSection = "overview" | "work" | "jobs" | "board" | "memory" | "instructions";
export const SECTIONS: readonly { id: ConfigSection; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "work", label: "Work" },
  { id: "jobs", label: "Jobs" },
  { id: "board", label: "Board" },
  { id: "memory", label: "Memory" },
  { id: "instructions", label: "Instructions" },
];
/** Old `?section=` ids from the side panel: Host became Work and Swarm became Jobs. */
const RENAMED: Record<string, ConfigSection> = { runs: "work", swarm: "jobs" };
/** The new id an old `?section=` link names, so the page rewrites the address once; null when the link is current. */
export const renamedSection = (params: Record<string, string>): ConfigSection | null => (params.section ? (RENAMED[params.section] ?? null) : null);
export const sectionFromParams = (params: Record<string, string>): ConfigSection =>
  renamedSection(params) ?? (SECTIONS.some((section) => section.id === params.section) ? (params.section as ConfigSection) : "overview");

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
