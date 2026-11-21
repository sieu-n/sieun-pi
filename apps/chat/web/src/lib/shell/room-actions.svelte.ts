/**
 * What the owner can do to a room from a sidebar row's menu or a room header's menu, as Slack's row menu does: Star, Mute, Close
 * conversation for a DM, Leave channel and Archive channel. The server keeps the choices (`PUT /api/c/:id/prefs`, server/sidebar-prefs.ts)
 * and sends the sidebar again; an action that takes a room out of the sidebar shows a toast with Undo.
 */
import { api, isSoloRoom, type ConversationId, type ConversationSummary, type PrefsPatch } from "$lib/api";
import type { MenuEntry } from "$lib/ui/menu";
import { toast } from "$lib/ui/toast.svelte";
import { hrefFor, router } from "$lib/router.svelte";
import { sidebar } from "./sidebar.svelte";

const label = (row: Pick<ConversationSummary, "kind" | "name">): string => (row.kind === "channel" ? `#${row.name}` : row.name);

/** The sidebar row for a room, which carries its star, mute and hidden state; undefined for an archived room or a job. */
export function roomRow(id: ConversationId): ConversationSummary | undefined {
  const { solo, channels, dms } = sidebar.data;
  return [...channels, ...dms, ...solo].find((row) => row.id === id);
}

/** Whether the sidebar lists a row: a hidden one (a closed DM, a left channel) only while it is the open room, as Slack shows a channel you preview. */
export function listed(row: ConversationSummary, current: ConversationId | null): boolean {
  return !row.hidden || row.id === current;
}

/** The Starred section's rows, rooms of every kind by name; each leaves its own section (`unstarred`). */
export function starredRows(current: ConversationId | null): ConversationSummary[] {
  const { solo, channels, dms } = sidebar.data;
  return [...solo, ...channels, ...dms].filter((row) => row.starred && listed(row, current)).sort((a, b) => a.name.localeCompare(b.name));
}

/** A section's rows less the starred and the hidden ones. */
export function unstarred(rows: readonly ConversationSummary[], current: ConversationId | null): ConversationSummary[] {
  return rows.filter((row) => !row.starred && listed(row, current));
}

/** The count and bold a row shows: a muted room shows no bold and a muted DM no count, while a mention in a muted channel still counts. */
export function rowUnread(row: ConversationSummary): { unread: number; fresh: boolean } {
  if (!row.muted) return { unread: row.unread, fresh: row.hasNew };
  return { unread: row.kind === "dm" ? 0 : row.unread, fresh: false };
}

async function setPrefs(row: ConversationSummary, patch: PrefsPatch, failed: string): Promise<boolean> {
  try {
    await api.setPrefs(row.id, patch);
    return true;
  } catch {
    toast.error(`Could not ${failed} ${label(row)}`);
    return false;
  }
}

/** Leaves the room's page when it is open, since the room is no longer in the sidebar. */
function leavePage(id: ConversationId): void {
  if (router.conversationId === id) router.navigate(hrefFor("messages"));
}

/** Hides a room for the owner, a DM as closed and a channel as left, with Undo in the toast. */
async function hide(row: ConversationSummary, kind: "closed" | "left"): Promise<void> {
  if (!(await setPrefs(row, { hidden: kind }, kind === "closed" ? "close" : "leave"))) return;
  leavePage(row.id);
  const text = kind === "closed" ? `Closed your conversation with ${row.name}` : `You left ${label(row)}`;
  toast.show(text, { action: { label: "Undo", run: () => void setPrefs(row, { hidden: null }, "bring back") } });
}

/** Archives a channel for everyone, leaving its page when open, with Undo in the toast. */
export async function archiveChannel(id: ConversationId, name: string): Promise<void> {
  try {
    await api.updateRoom(id, { archived: true });
  } catch (e) {
    toast.error(e instanceof Error ? e.message : `Could not archive #${name}`);
    return;
  }
  leavePage(id);
  toast.show(`Archived #${name}`, { action: { label: "Undo", run: () => void unarchiveChannel(id, name) } });
}

/** Brings an archived channel back. */
export async function unarchiveChannel(id: ConversationId, name: string): Promise<void> {
  try {
    await api.updateRoom(id, { archived: false });
  } catch (e) {
    toast.error(e instanceof Error ? e.message : `Could not unarchive #${name}`);
    return;
  }
  toast.show(`Unarchived #${name}`);
}

/** Closes or reopens a Solo room, which then folds under the Solo section's Done or comes back above it; a close shows Undo in its toast. */
export async function setSoloClosed(id: ConversationId, name: string, closed: boolean): Promise<boolean> {
  try {
    await api.updateRoom(id, { closed });
  } catch (e) {
    toast.error(e instanceof Error ? e.message : `Could not ${closed ? "close" : "reopen"} ${name}`);
    return false;
  }
  if (closed) toast.show(`Closed ${name}`, { action: { label: "Undo", run: () => void setSoloClosed(id, name, false) } });
  else toast.show(`Reopened ${name}`);
  return true;
}

/** Star and Mute for any room, then Close conversation for a DM, Close or Reopen for a Solo room, or Join or Leave and Archive for a channel; none for a room not in the sidebar. */
export function roomActions(id: ConversationId): MenuEntry[] {
  const row = roomRow(id);
  if (!row) return [];
  const noun = row.kind === "channel" ? "channel" : row.kind === "dm" ? "conversation" : "room";
  const items: MenuEntry[] = [
    row.starred
      ? { id: "unstar", label: `Unstar ${noun}`, icon: "star-filled", onselect: () => void setPrefs(row, { starred: false }, "unstar") }
      : { id: "star", label: `Star ${noun}`, icon: "star", onselect: () => void setPrefs(row, { starred: true }, "star") },
    row.muted
      ? { id: "unmute", label: `Unmute ${noun}`, icon: "bell", onselect: () => void setPrefs(row, { muted: false }, "unmute") }
      : { id: "mute", label: `Mute ${noun}`, icon: "bell-off", onselect: () => void setPrefs(row, { muted: true }, "mute") },
  ];
  if (row.kind === "dm" && row.hidden !== "closed") {
    items.push({ type: "separator" }, { id: "close", label: "Close conversation", icon: "close", onselect: () => void hide(row, "closed") });
  }
  if (isSoloRoom(row.id)) {
    items.push(
      { type: "separator" },
      row.closedAt
        ? { id: "reopen", label: "Reopen room", icon: "refresh", onselect: () => void setSoloClosed(row.id, row.name, false) }
        : { id: "close-room", label: "Close room", icon: "check", onselect: () => void setSoloClosed(row.id, row.name, true) },
    );
  }
  if (row.kind === "channel") {
    items.push(
      { type: "separator" },
      row.hidden === "left"
        ? { id: "join", label: "Join channel", icon: "plus", onselect: () => void setPrefs(row, { hidden: null }, "join") }
        : { id: "leave", label: "Leave channel", icon: "leave", onselect: () => void hide(row, "left") },
      { id: "archive", label: "Archive channel", icon: "archive", tone: "danger", onselect: () => void archiveChannel(row.id, row.name) },
    );
  }
  return items;
}
