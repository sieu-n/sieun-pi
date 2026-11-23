import type { ConversationSummary } from "$lib/api";
import { conversationHref, router } from "$lib/router.svelte";
import { laterHref } from "$lib/later.svelte";
import { draftsHref } from "$lib/drafts.svelte";
import { forYouHref } from "$pages/board/chips";
import { wikiHref } from "$pages/wiki/wiki-pages";
import { unreadsHref } from "$lib/unreads.svelte";
import type { MessagesView } from "$lib/router.svelte";
import { sidebar, soloGroups } from "./sidebar.svelte";
import { rowUnread, sidebarRooms, starredRows, unstarred } from "./room-actions.svelte";
import { groupRows, sidebarSections, visibleRows, type BuiltinSection, type SectionId } from "./sidebar-sections.svelte";

/** One row of the Messages sidebar that Alt+Up and Alt+Down step through. `conversation` is null for a view row such as Later. */
export type SidebarStop = { key: string; href: string; conversation: ConversationSummary | null };

const isUnread = (row: ConversationSummary): boolean => rowUnread(row).unread > 0 || rowUnread(row).fresh;

/**
 * The Messages sidebar's rows top to bottom, as pages/channel/MessagesSidebar.svelte draws them: the view rows, Starred, open Solo rooms,
 * the Done fold, each custom section, Channels, then Direct messages. A folded section keeps only the open and the unread rows, and a closed
 * Done fold only the open room, as on the screen, so no key lands on a row the owner cannot see. test/shell/conversation-keys.spec.ts checks
 * this order against the drawn rows.
 */
export function sidebarStops(): SidebarStop[] {
  const current = router.conversationId;
  const shown = (rows: readonly ConversationSummary[], id: BuiltinSection | SectionId): ConversationSummary[] =>
    visibleRows(rows, sidebarSections.isFolded(id), (row) => row.id === current || isUnread(row));
  const rooms = sidebarRooms();
  const solo = soloGroups(unstarred(rooms.solo, current));
  const groups = groupRows(unstarred(rooms.channels, current), unstarred(rooms.dms, current), sidebarSections.model);
  const done = sidebarSections.isFolded("solo") ? shown(solo.done, "solo") : sidebar.doneOpen ? solo.done : solo.done.filter((row) => row.id === current);
  const rows = [
    ...shown(starredRows(current), "starred"),
    ...shown(solo.open, "solo"),
    ...done,
    ...groups.sections.flatMap(({ section, rows }) => shown(rows, section.id)),
    ...shown(groups.channels, "channels"),
    ...shown(groups.dms, "dms"),
  ];
  return [
    ...VIEW_ROWS.map(([key, href]) => ({ key, href: href(), conversation: null })),
    ...rows.map((row) => ({ key: row.id, href: conversationHref(row.id), conversation: row })),
  ];
}

/** The view rows at the top of the Messages sidebar, in its order. */
const VIEW_ROWS: readonly (readonly [MessagesView, () => string])[] = [
  ["saved", laterHref],
  ["drafts", draftsHref],
  ["for-you", () => forYouHref()],
  ["wiki", wikiHref],
  ["unreads", unreadsHref],
];

/** The sidebar row the page shows now, or null on a page that is no row, such as Agents or a new message. */
function currentKey(): string | null {
  const view = router.messagesView;
  if (view && VIEW_ROWS.some(([key]) => key === view)) return view;
  return router.conversationId;
}

/**
 * The row `step` rows away from the open one, or null at either end. From a page that is no row, Down starts at the top and Up at the
 * bottom. With `unreadOnly`, it skips to the next unread conversation and wraps around the ends, as Alt+Shift+Down does in Slack.
 */
export function nextStop(step: 1 | -1, unreadOnly: boolean): SidebarStop | null {
  const stops = sidebarStops();
  const at = stops.findIndex((s) => s.key === currentKey());
  if (!unreadOnly) {
    const next = at === -1 ? (step === 1 ? 0 : stops.length - 1) : at + step;
    return stops[next] ?? null;
  }
  const n = stops.length;
  const from = at === -1 ? (step === 1 ? -1 : n) : at;
  for (let i = 1; i <= n; i++) {
    const stop = stops[(((from + step * i) % n) + n) % n];
    if (stop && stop.key !== currentKey() && stop.conversation && isUnread(stop.conversation)) return stop;
  }
  return null;
}
