/**
 * What the page does when the server says a reminder fell due (`later_due`, server/later-due.ts): a toast in every open tab, and one
 * system notification, in the browser or the Mac app, from the tab that holds the lock, so three open tabs make one notification.
 */
import { live } from "./api/live.svelte";
import type { LaterRow } from "./api/types";
import { later, laterHref } from "./later.svelte";
import { remindPresets } from "./remind";
import { conversationHref, router } from "./router.svelte";
import { notifyOnce, notifySystem, onNotifyAction } from "./remind-notify";
import type { MenuEntry } from "./ui/menu";
import { toast } from "./ui/toast.svelte";

const SNIPPET = 140;

function snippet(row: LaterRow): string {
  const text = row.gone ? "This message was deleted." : row.text.replace(/\s+/g, " ").trim() || (row.images ? "Image" : "");
  return text.length > SNIPPET ? `${text.slice(0, SNIPPET - 1)}…` : text;
}

/** Opens the reminded post where it sits: in its thread when it is a reply, else in its room; a /remind reminder opens Later. */
export function openReminded(row: LaterRow): void {
  if (row.room === undefined) return router.navigate(laterHref());
  router.navigate(conversationHref(row.room, row.threadRoot ? { thread: row.threadRoot, messageId: row.post } : { messageId: row.post }));
}

export function laterDue(row: LaterRow): void {
  const mine = row.author?.kind === "owner";
  const from = row.room === undefined ? "" : row.roomKind === "dm"
    ? (mine ? `Your message to ${row.roomName}` : row.author?.name ?? row.roomName)
    : mine ? `Your message in ${row.roomName}` : row.author ? `${row.author.name} in ${row.roomName}` : row.roomName;
  // A post he marked unread and has not handled comes back each morning (server/keep-unread.ts).
  const title = row.unread ? `Still unread: ${from}` : row.room === undefined ? "Reminder" : `Reminder: ${from}`;
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
  notifyOnce(`later-due:${row.id}:${row.remindAt ?? 0}`, () => void notifySystem(title, body, `later:${row.id}:${row.remindAt ?? 0}`, () => openReminded(row), { type: REMINDER, extra: { row } }));
}

/** The Mac app notification's buttons for a due reminder; Snooze 20 minutes leads, since a click on macOS's Options button picks the first. */
const REMINDER = "reminder";
const NATIVE: { id: string; title: string; preset?: "20m" | "1h" | "tomorrow" }[] = [
  { id: "snooze-20m", title: "Snooze 20 minutes", preset: "20m" },
  { id: "snooze-1h", title: "Snooze 1 hour", preset: "1h" },
  { id: "snooze-tomorrow", title: "Snooze until tomorrow", preset: "tomorrow" },
  { id: "complete", title: "Mark complete" },
];

/** A click on the Mac app's reminder notification: on the notification it opens the post, and on a button it snoozes or completes it. */
function nativeAction(actionId: string, extra: Record<string, unknown>): void {
  const row = extra.row as LaterRow | undefined;
  if (!row?.id) return;
  if (actionId === "tap") return openReminded(row);
  if (actionId === "complete") return void later.setState(row, "done");
  const preset = NATIVE.find((a) => a.id === actionId)?.preset;
  const at = remindPresets().find((p) => p.id === preset)?.at;
  if (at !== undefined) void later.remind(row, at);
}

/** Listens for due reminders for the life of the page. */
export function watchReminders(): () => void {
  void onNotifyAction(REMINDER, NATIVE.map(({ id, title }) => ({ id, title })), nativeAction);
  return live.on(event => {
    if (event.type === "later_due") laterDue(event.row);
  });
}
