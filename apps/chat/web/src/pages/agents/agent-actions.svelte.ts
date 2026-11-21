import { agents, api, type AgentSummary } from "$lib/api";
import { hrefFor, router } from "$lib/router.svelte";
import { renameDialog } from "$lib/shell/rename-dialog.svelte";
import type { MenuEntry } from "$lib/ui/menu";
import { toast } from "$lib/ui/toast.svelte";
import { ACTION_LABEL, actionsFor, openTarget, type AgentAction } from "./agents-model";

type Named = Pick<AgentSummary, "id" | "name">;
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Lists that hold archived agents, such as the Agents page's Archived tab, read again after an archive, an unarchive or a rename. */
const listeners = new Set<() => void>();
export function onAgentsChanged(run: () => void): () => void {
  listeners.add(run);
  return () => listeners.delete(run);
}
const changed = () => listeners.forEach((run) => run());

const pageOf = (id: string): boolean => router.route.page === "agents" && router.route.rest[0] === id;

/**
 * Archives an agent or a job with no confirm, and its toast's Undo brings it back, as a channel's archive does. When its page was open,
 * the page goes back to the list, and Undo opens the page again.
 */
export async function archiveAgent(agent: Named): Promise<void> {
  try {
    await api.archiveAgent(agent.id, true);
  } catch (error) {
    toast.error(`Could not archive ${agent.name}: ${reason(error)}`);
    return;
  }
  const left = pageOf(agent.id);
  if (left) router.navigate(hrefFor("agents", []));
  changed();
  toast.show(`Archived ${agent.name}`, {
    action: { label: "Undo", run: () => void unarchiveAgent(agent, { quiet: true }).then((ok) => ok && left && router.navigate(hrefFor("agents", [agent.id]))) },
  });
}

/** Brings an archived agent or job back; `quiet` skips the toast, for an Undo. */
export async function unarchiveAgent(agent: Named, opts: { quiet?: boolean } = {}): Promise<boolean> {
  try {
    await api.archiveAgent(agent.id, false);
  } catch (error) {
    toast.error(`Could not unarchive ${agent.name}: ${reason(error)}`);
    return false;
  }
  changed();
  if (!opts.quiet) toast.success(`Unarchived ${agent.name}`);
  return true;
}

export function stopAgent(agent: Named): void {
  api.stopAgent(agent.id).then(
    () => toast.success(`Stopped ${agent.name}`),
    (error: unknown) => toast.error(`Could not stop ${agent.name}: ${reason(error)}`),
  );
}

export function renameAgent(agent: Named): void {
  renameDialog.open(agent.id, agent.name, "agent");
}
/** For the rename dialog, which lives with the channel's and calls this after an agent's rename. */
export const agentsChanged = changed;

export function messageAgent(agent: AgentSummary): void {
  const target = openTarget(agent, (id) => agents.room(id));
  router.openConversation(target.id, target.thread ? { thread: target.thread } : {});
}

const ICON: Record<AgentAction, string> = { open: "chat", model: "cpu", rename: "edit", stop: "stop", archive: "archive", unarchive: "unarchive" };

/** `actionsFor` as menu entries; `model` opens the picker that sits beside the menu. */
export function agentMenu(agent: AgentSummary, opts: { model?: () => void; message?: boolean } = {}): MenuEntry[] {
  const run: Record<AgentAction, () => void> = {
    open: () => messageAgent(agent),
    model: () => opts.model?.(),
    rename: () => renameAgent(agent),
    stop: () => stopAgent(agent),
    archive: () => void archiveAgent(agent),
    unarchive: () => void unarchiveAgent(agent),
  };
  return actionsFor(agent, { model: !!opts.model, ...(opts.message === false ? { message: false } : {}) }).flatMap((action): MenuEntry[] => {
    const item = { id: action, label: ACTION_LABEL[action], icon: ICON[action], onselect: run[action] };
    return action === "archive" ? [{ type: "separator" }, { ...item, tone: "danger" as const }] : [item];
  });
}
