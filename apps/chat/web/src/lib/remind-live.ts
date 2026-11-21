/**
 * What the page does when the server says a reminder fell due (`later_due`, server/later-due.ts): a toast in every open tab, and one
 * system notification, in the browser or the Mac app, from the tab that holds the lock, so three open tabs make one notification.
 */
import { live } from "./api/live.svelte";
import type { LaterRow } from "./api/types";
import { later } from "./later.svelte";
import { remindPresets } from "./remind";
import { conversationHref, router } from "./router.svelte";
import { notifyOnce, notifySystem } from "./remind-notify";
import type { MenuEntry } from "./ui/menu";
import { toast } from "./ui/toast.svelte";

const SNIPPET = 140;

function snippet(row: LaterRow): string {
  const text = row.gone ? "This message was deleted." : row.text.replace(/\s+/g, " ").trim() || (row.images ? "Image" : "");
  return text.length > SNIPPET ? `${text.slice(0, SNIPPET - 1)}…` : text;
}

/** Opens the reminded post where it sits: in its thread when it is a reply, else in its room. */
export function openReminded(row: Pick<LaterRow, "room" | "post" | "threadRoot">): void {
  router.navigate(conversationHref(row.room, row.threadRoot ? { thread: row.threadRoot, messageId: row.post } : { messageId: row.post }));
}

export function laterDue(row: LaterRow): void {
  const mine = row.author?.kind === "owner";
  const from = row.roomKind === "dm"
    ? (mine ? `Your message to ${row.roomName}` : row.author?.name ?? row.roomName)
    : mine ? `Your message in ${row.roomName}` : row.author ? `${row.author.name} in ${row.roomName}` : row.roomName;
  // A post he marked unread and has not handled comes back each morning (server/keep-unread.ts).
  const title = row.unread ? `Still unread: ${from}` : `Reminder: ${from}`;
  const body = snippet(row);
  // Slack's reminder message: Mark as complete and a Snooze menu sit on it, so neither needs a trip to Later.
  const snooze = (): MenuEntry[] => remindPresets().map((p): MenuEntry => ({ id: `snooze-${p.id}`, label: p.label, onselect: () => void later.remind(row, p.at) }));
  toast.show(`${title}: ${body}`, {
    duration: 0,
    actions: [
      { label: "View", run: () => openReminded(row) },
      { label: "Mark complete", run: () => void later.setState(row, "done") },
      { label: "Snooze", menu: snooze },
    ],
  });
  notifyOnce(`later-due:${row.id}:${row.remindAt ?? 0}`, () => void notifySystem(title, body, `later:${row.id}:${row.remindAt ?? 0}`, () => openReminded(row)));
}

/** Listens for due reminders for the life of the page. */
export function watchReminders(): () => void {
  return live.on(event => {
    if (event.type === "later_due") laterDue(event.row);
  });
}
