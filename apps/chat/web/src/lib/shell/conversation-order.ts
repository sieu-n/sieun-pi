import type { ConversationSummary } from "$lib/api";
import { conversationHref, router } from "$lib/router.svelte";
import { laterHref } from "$lib/later.svelte";
import { draftsHref } from "$lib/drafts.svelte";
import { forYouHref } from "$pages/board/chips";
import { sidebar } from "./sidebar.svelte";
import { groupChannels, sidebarSections, visibleRows, type BuiltinSection, type SectionId } from "./sidebar-sections.svelte";

/** One row of the Messages sidebar that Alt+Up and Alt+Down step through. `conversation` is null for Later, Drafts and For you. */
export type SidebarStop = { key: string; href: string; conversation: ConversationSummary | null };

const isUnread = (row: ConversationSummary): boolean => row.unread > 0 || row.hasNew;

/**
 * The Messages sidebar's rows top to bottom, in the order pages/channel/MessagesSidebar.svelte draws them: Later, Drafts, For you, open Solo
 * rooms, the Done fold, each custom section, Channels, then Direct messages. With `asShown`, a folded section keeps only the open and the
 * unread rows, as on the screen; without it every conversation counts, for the next-unread keys. test/shell/conversation-keys.spec.ts
 * checks this order against the drawn rows.
 */
export function sidebarStops(asShown: boolean): SidebarStop[] {
  const current = router.conversationId;
  const shown = (rows: readonly ConversationSummary[], id: BuiltinSection | SectionId): ConversationSummary[] =>
    visibleRows(rows, asShown && sidebarSections.isFolded(id), (row) => row.id === current || isUnread(row));
  const solo = sidebar.solo;
  const channels = groupChannels(sidebar.data.channels, sidebarSections.model);
  const done = !asShown ? solo.done : sidebarSections.isFolded("solo") ? shown(solo.done, "solo") : sidebar.doneOpen ? solo.done : [];
  const rows = [
    ...shown(solo.open, "solo"),
    ...done,
    ...channels.sections.flatMap(({ section, rows }) => shown(rows, section.id)),
    ...shown(channels.rest, "channels"),
    ...shown(sidebar.data.dms, "dms"),
  ];
  return [
    { key: "later", href: laterHref(), conversation: null },
    { key: "drafts", href: draftsHref(), conversation: null },
    { key: "for-you", href: forYouHref(), conversation: null },
    ...rows.map((row) => ({ key: row.id, href: conversationHref(row.id), conversation: row })),
  ];
}

/** The sidebar row the page shows now, or null on a page that is no row, such as Agents or a new message. */
function currentKey(): string | null {
  const view = router.messagesView;
  if (view === "later" || view === "drafts" || view === "for-you") return view;
  return router.conversationId;
}

/**
 * The row `step` rows away from the open one, or null at either end. From a page that is no row, Down starts at the top and Up at the
 * bottom. With `unreadOnly`, it skips to the next unread conversation and wraps around the ends, as Alt+Shift+Down does in Slack.
 */
export function nextStop(step: 1 | -1, unreadOnly: boolean): SidebarStop | null {
  const stops = sidebarStops(!unreadOnly);
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
