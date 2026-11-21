/**
 * What the page does with new messages, as Slack's desktop app does: a system notification for each new post his setting asks for
 * (notify-prefs.svelte.ts), the unread count on the Dock icon, and the open place and that count in the window title.
 *
 * The server sends each new post someone else wrote as a `notice` (server/notices.ts). One tab notifies, unless the owner is looking at
 * that post's room or thread in a focused window. A muted room notifies only when it mentions him, and a channel he left never does.
 */
import { live } from "./api/live.svelte";
import { conversations, sidebar } from "./api/stores.svelte";
import type { ConversationSummary, Notice } from "./api/types";
import { notificationsPaused, notifyPermission, notifyPrefs } from "./notify-prefs.svelte";
import { askNotifyPermission, notifyOnce, notifySystem, readNotifyPermission, setDockBadge, setWindowTitle } from "./remind-notify";
import { conversationHref, PAGES, router } from "./router.svelte";
import { inDesktopShell } from "./shell/desktop";
import { rowUnread } from "./shell/room-actions.svelte";
import { toast } from "./ui/toast.svelte";

const APP = "sw factory";
const ASKED = "chat.notify.asked";

export function openNotice(notice: Pick<Notice, "room" | "post" | "threadRoot">): void {
  router.navigate(conversationHref(notice.room, notice.threadRoot ? { thread: notice.threadRoot, messageId: notice.post } : { messageId: notice.post }));
}

/** Whether the owner sees the post now: his focused window shows its room, and its thread pane for a thread reply that is not in the room. */
function inView(notice: Notice): boolean {
  if (document.visibilityState !== "visible" || !document.hasFocus() || router.conversationId !== notice.room) return false;
  return !notice.threadRoot || router.route.params.thread === notice.threadRoot;
}

export function wantsNotice(notice: Notice, now = Date.now()): boolean {
  if (notifyPrefs.level === "off" || notificationsPaused(now)) return false;
  const row = conversations.byId(notice.room);
  if (row?.hidden === "left") return false;
  if (row?.muted) return notice.reason === "mention";
  return notifyPrefs.level === "all" || notice.reason !== "post";
}

export function noticeTitle(notice: Notice): string {
  const who = notice.author.name;
  if (notice.roomKind === "dm") return who;
  return notice.threadRoot ? `${who} replied in ${notice.roomName}` : `${who} in ${notice.roomName}`;
}

function onNotice(notice: Notice): void {
  if (!wantsNotice(notice) || inView(notice)) return;
  const body = notice.text || (notice.images ? (notice.images > 1 ? `${notice.images} images` : "Image") : "");
  const tag = `notice:${notice.room}:${notice.post}`;
  notifyOnce(tag, () => void notifySystem(noticeTitle(notice), body, tag, () => openNotice(notice)).then(sent => sent || offerPermission()));
}

/** The unread count Slack's Dock badge shows: the sum of the sidebar's counts (DMs, Solo rooms and mentions), less channels he left. */
export function unreadCount(rows: readonly ConversationSummary[]): number {
  return rows.reduce((sum, row) => (row.archived || row.hidden === "left" ? sum : sum + rowUnread(row).unread), 0);
}

const VIEW_LABELS: Record<string, string> = { new: "New message", "for-you": "For you", later: "Later" };

/** The open place, as the title names it: `#channel`, the agent of a DM, a Messages view or a top bar page. */
function placeLabel(): string {
  const id = router.conversationId;
  if (id) {
    const row = conversations.byId(id);
    return row ? (row.kind === "channel" ? `#${row.name}` : row.name) : "Messages";
  }
  const view = router.messagesView;
  if (view) return VIEW_LABELS[view] ?? "Messages";
  const page = router.route.page;
  return PAGES.find(p => p.id === page)?.label ?? page.charAt(0).toUpperCase() + page.slice(1);
}

/**
 * On a browser with the permission not asked yet, offers it once per device from a toast, since the prompt must come from a click. It comes
 * with the first message that would have notified, so it names a reason, and never in an automated browser, where it would cover the
 * composer in every fresh Playwright context.
 */
function offerPermission(): void {
  if (inDesktopShell || navigator.webdriver || notifyPermission.value !== "default") return;
  try {
    if (localStorage.getItem(ASKED)) return;
    localStorage.setItem(ASKED, "1");
  } catch {
    return;
  }
  toast.show("Turn on desktop notifications to hear about new DMs and mentions.", {
    duration: 15_000, action: { label: "Turn on", run: () => void askNotifyPermission() },
  });
}

/** Listens for new messages and keeps the Dock badge and the title for the life of the page. */
export function watchNotices(): () => void {
  void (inDesktopShell ? askNotifyPermission() : readNotifyPermission());
  const off = live.on(event => {
    if (event.type === "notice") onNotice(event.notice);
  });
  let shown = { title: "", count: -1 };
  const stop = $effect.root(() => {
    $effect(() => {
      const rows = sidebar.value;
      const count = notifyPrefs.badge && rows ? unreadCount([...rows.solo, ...rows.channels, ...rows.dms]) : 0;
      const title = `${count ? `(${count}) ` : ""}${placeLabel()} - ${APP}`;
      if (title !== shown.title) {
        document.title = title;
        setWindowTitle(title);
      }
      if (count !== shown.count) setDockBadge(count);
      shown = { title, count };
    });
  });
  return () => {
    off();
    stop();
  };
}
