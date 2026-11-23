import type { AgentSummary, ForMeItem, ForMeList, ForMeReason, ForMeStatus, HarnessEntryView, ModelCatalog, RunStatus } from "$lib/api";
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

/** The Agents page's two lists: live agents, and the archived ones Unarchive brings back. */
export type AgentsFilter = "active" | "archived";
export const agentsFilterFromParams = (params: Record<string, string>): AgentsFilter => (params.show === "archived" ? "archived" : "active");

/** The agents a filter shows, by newest activity. */
export function agentsShown(agents: readonly AgentSummary[], filter: AgentsFilter = "active"): AgentSummary[] {
  return agents.filter((agent) => !!agent.archived === (filter === "archived")).sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
}

export const STATUS_LABEL: Record<RunStatus, string> = {
  working: "Working",
  sleeping: "Waiting",
  failed: "Failed",
  idle: "Idle",
};

export type AgentAction = "open" | "model" | "rename" | "stop" | "archive" | "unarchive";

/**
 * The one menu of an agent or a job, on its card, its page's header and its sidebar row. `model` adds Change model where a picker sits
 * beside the menu, and `message: false` drops Message where a Message button sits beside it. Stop shows only while it runs or waits for a
 * slot, and an archived one offers Unarchive.
 */
export function actionsFor(agent: Pick<AgentSummary, "status" | "archived" | "conversation">, opts: { model?: boolean; message?: boolean } = {}): AgentAction[] {
  const rename: AgentAction[] = canRename(agent) ? ["rename"] : [];
  if (agent.archived) return ["unarchive", ...rename];
  const actions: AgentAction[] = [];
  if (opts.message !== false) actions.push("open");
  if (opts.model) actions.push("model");
  actions.push(...rename);
  if (agent.status === "working" || agent.status === "sleeping") actions.push("stop");
  actions.push("archive");
  return actions;
}

export const ACTION_LABEL: Record<AgentAction, string> = {
  open: "Message",
  model: "Change model",
  rename: "Rename",
  stop: "Stop",
  archive: "Archive",
  unarchive: "Unarchive",
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

/** pi-host names root threads only, so an agent or a root job takes a new name and a job inside a thread keeps its thread's. */
export const canRename = (agent: Pick<AgentSummary, "conversation">): boolean => agent.conversation === 1;

/** The tabs of an agent's page, as apps/chat/docs/agent-model.md names them; each tab is its own component file (agent-tab.ts). */
export type ConfigSection = "brief" | "knowledge" | "board" | "duties" | "threads" | "for" | "prompt";
/** `for` is the agent's For list; its tab reads "For <agent name>" (forLabel) and shows only for a registered agent (hasForList). */
export const SECTIONS: readonly { id: ConfigSection; label: string }[] = [
  { id: "brief", label: "Brief" },
  { id: "knowledge", label: "Knowledge" },
  { id: "board", label: "Board" },
  { id: "duties", label: "Duties" },
  { id: "threads", label: "Threads" },
  { id: "for", label: "For" },
  { id: "prompt", label: "Prompt" },
];
/** Only a registered agent (`ag_<slug>`) has a For list; a job or a root thread with no agent record has none. */
export const hasForList = (id: string): boolean => id.startsWith("ag_");
export const forLabel = (name: string): string => `For ${name}`;

export type ForFilter = ForMeStatus | "all";
export const FOR_FILTERS: readonly ForFilter[] = ["pending", "completed", "all"];
export const FOR_FILTER_LABEL: Record<ForFilter, string> = { pending: "Pending", completed: "Completed", all: "All" };
export const forCount = (list: Pick<ForMeList, "pending" | "completed"> | null, filter: ForFilter): number | null =>
  list ? (filter === "all" ? list.pending + list.completed : list[filter]) : null;
export const forEmpty = (name: string, filter: ForFilter): string =>
  filter === "pending" ? `Nothing waits for ${name}.` : filter === "completed" ? `${name} has completed nothing yet.` : `No messages involve ${name} yet.`;

export const REASON_LABEL: Record<ForMeReason, string> = { dm: "DM", mention: "Mention", member: "Member", thread: "Thread reply", reaction: "Reaction" };
/** The reason chips of a row; a DM row's room already reads DM, so it shows no `dm` chip. */
export const reasonChips = (item: Pick<ForMeItem, "roomKind" | "reasons">): ForMeReason[] =>
  item.roomKind === "dm" ? item.reasons.filter((reason) => reason !== "dm") : item.reasons;

/**
 * Where a row opens, as a search hit opens its post: the room at the post. A channel reply opens its thread beside the room, with the room
 * at the thread's root post.
 */
export function forTarget(item: Pick<ForMeItem, "room" | "post" | "threadRoot">): { id: string; messageId: string; thread?: string } {
  return item.threadRoot ? { id: item.room, messageId: item.threadRoot, thread: item.threadRoot } : { id: item.room, messageId: item.post };
}

/** A post's text as plain lines for a short preview: markdown marks out, link text kept, code blocks named, blank runs folded. */
export function previewText(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, "[code]")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+)/gm, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** Old `?section=` ids: Overview became Brief, Memory and Instructions became Knowledge, and Work, Jobs, Host and Swarm became Threads. */
const RENAMED: Record<string, ConfigSection> = {
  overview: "brief", memory: "knowledge", instructions: "knowledge", work: "threads", jobs: "threads", runs: "threads", swarm: "threads",
};
/** The new id an old `?section=` link names, so the page rewrites the address once; null when the link is current. */
export const renamedSection = (params: Record<string, string>): ConfigSection | null => (params.section ? (RENAMED[params.section] ?? null) : null);
export const sectionFromParams = (params: Record<string, string>): ConfigSection =>
  renamedSection(params) ?? (SECTIONS.some((section) => section.id === params.section) ? (params.section as ConfigSection) : "brief");

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

/** The Jobs tab's filters: Active runs or waits, Finished ended and stays until archived, Archived the owner put away. */
export type JobFilter = "active" | "finished" | "archived";
type FilteredJob = { name: string; status: RunStatus; archived: boolean };

export function jobFilterOfJob(job: FilteredJob): JobFilter {
  if (job.archived) return "archived";
  return job.status === "working" || job.status === "sleeping" ? "active" : "finished";
}

const matches = (job: FilteredJob, query: string): boolean => job.name.toLowerCase().includes(query.trim().toLowerCase());

/** How many jobs each filter holds among those whose name matches the search. */
export function jobFilterCounts(jobs: readonly FilteredJob[], query: string): Record<JobFilter, number> {
  const counts: Record<JobFilter, number> = { active: 0, finished: 0, archived: 0 };
  for (const job of jobs) if (matches(job, query)) counts[jobFilterOfJob(job)]++;
  return counts;
}

/** The filter the URL names, or Active while a job runs and Finished when none does. */
export function jobFilterOf(param: string | undefined, counts: Record<JobFilter, number>): JobFilter {
  if (param === "active" || param === "finished" || param === "archived") return param;
  return counts.active ? "active" : "finished";
}

export function jobsShown<T extends FilteredJob>(jobs: readonly T[], filter: JobFilter, query: string): T[] {
  return jobs.filter((job) => jobFilterOfJob(job) === filter && matches(job, query));
}

export type MemorySort = "updated" | "oldest" | "title";
export const MEMORY_SORTS: { value: MemorySort; label: string }[] = [
  { value: "updated", label: "Recently updated" },
  { value: "oldest", label: "Oldest updated" },
  { value: "title", label: "Title A to Z" },
];
type MemoryEntry = Pick<HarnessEntryView, "id" | "title" | "content" | "source" | "updatedAt">;
/** Whether every word of the query is in the entry's title, text, id or source, ignoring case; an empty query matches all. */
export function memoryMatches(entry: MemoryEntry, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${entry.title}\n${entry.content}\n${entry.id}\n${entry.source}`.toLowerCase();
  return words.every((word) => hay.includes(word));
}
export function sortMemories<T extends MemoryEntry>(entries: readonly T[], sort: MemorySort): T[] {
  const at = (entry: T) => Date.parse(entry.updatedAt) || 0;
  const out = [...entries];
  switch (sort) {
    case "updated":
      return out.sort((a, b) => at(b) - at(a));
    case "oldest":
      return out.sort((a, b) => at(a) - at(b));
    case "title":
      return out.sort((a, b) => a.title.localeCompare(b.title));
    default: {
      const _exhaustive: never = sort;
      return _exhaustive;
    }
  }
}
