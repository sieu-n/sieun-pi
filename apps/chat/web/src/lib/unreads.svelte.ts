import { api, type ConversationSummary } from "$lib/api";
import { hrefFor } from "$lib/router.svelte";
import { rowUnread } from "$lib/shell/room-actions.svelte";
import { sidebar } from "$lib/shell/sidebar.svelte";
import { toast } from "$lib/ui/toast.svelte";

/**
 * A room whose sidebar row is bold or counted: posts past the owner's read point, or a post that names him. A closed DM or a left channel
 * is out, and a muted room counts only its mentions, as in Slack (room-actions.svelte.ts `rowUnread`).
 */
export function isUnread(row: ConversationSummary): boolean {
  if (row.hidden) return false;
  const { unread, fresh } = rowUnread(row);
  return unread > 0 || fresh;
}

/** The rooms with something new, in sidebar order: open Solo rooms, channels, then DMs. All unreads lists them and Shift+Esc reads them all. */
export function unreadRooms(): ConversationSummary[] {
  const { channels, dms } = sidebar.data;
  return [...sidebar.solo.open, ...channels, ...dms].filter(isUnread);
}

export const unreadsHref = (): string => hrefFor("messages", ["unreads"]);

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * Mark all as read, from All unreads, a section's menu or Shift+Esc: each room reads to its newest post, and the toast's Undo puts back
 * where each read from, a post he marked unread included (POST /api/read).
 */
export async function markAllRead(rows: readonly ConversationSummary[] = unreadRooms()): Promise<void> {
  if (!rows.length) {
    toast.show("You're all caught up");
    return;
  }
  const label = rows.length === 1 ? (rows[0]!.kind === "channel" ? `#${rows[0]!.name}` : rows[0]!.name) : plural(rows.length, "conversation");
  try {
    const { before } = await api.readAll(rows.map((row) => row.id));
    toast.show(`Marked ${label} as read`, {
      action: { label: "Undo", run: () => void api.restoreReads(before).catch(() => toast.error(`Could not mark ${label} unread again`)) },
    });
  } catch {
    toast.error(`Could not mark ${label} as read`);
  }
}
