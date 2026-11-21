/**
 * Turns what the owner typed, the conversation and agent lists, and the server's message hits into the groups and
 * rows the palette shows. Rows carry their action as data, so the dialog runs it and tests can read it.
 */
import { avatarOf } from "../channel/present.ts";
import { author, locationText, shortDay, what, type Hit } from "./hit-view.ts";
import { leadIn, matchName, snippetPieces, type Piece } from "./match.ts";
import { dateLabel, hasFilters, MARKS, NO_FILTERS, PLACES, type Filters } from "./filters.ts";
import { datePresets, DURING_CHOICES, duringRange, MARK_CHOICES, markOperator, prompt, searchText, type Operator } from "./operators.ts";
import { pagePlace } from "../wiki/wiki-pages.ts";
import type { WikiPageRow } from "../../lib/api/types.ts";

export type { Hit } from "./hit-view.ts";

export type ConversationKind = "solo" | "channel" | "dm" | "job";
export type Conversation = {
  id: string;
  kind: ConversationKind;
  name: string;
  lastActivityAt?: number | undefined;
  preview?: string | undefined;
  archived?: boolean | undefined;
};
export type Person = {
  id: string;
  name: string;
  kind: "owner" | "agent";
  avatar?: string | undefined;
  conversationId?: string | undefined;
  /** The row's second line, such as "Agent · working now". */
  detail?: string | undefined;
  /** Other names the picker matches, such as "owner" and "me" for the owner. */
  aliases?: readonly string[] | undefined;
  /** An archived agent, which the pickers list after the live ones so a search can still name it. */
  archived?: boolean | undefined;
};

export type Sort = "relevance" | "recent";

export type Messages =
  | { state: "idle" }
  /** The server has not answered yet; `hits` are the page's own matches (local-index.ts), which the answer replaces. */
  | { state: "loading"; hits: readonly Hit[] }
  | { state: "error"; message: string }
  | { state: "ready"; hits: readonly Hit[]; total: number; more: boolean; loadingMore: boolean };
export type Ready = Extract<Messages, { state: "ready" }>;

/** A search answer as the palette reads it: SearchResult in lib/api/types.ts. */
export type Answer = { hits: readonly Hit[]; total: number; nextCursor?: string | undefined };

/** The messages an answer shows. `before` holds the hits already on screen when the answer is a next page. */
export function answered(answer: Answer, before: readonly Hit[] = []): Ready {
  // A conversation that grows between two pages shifts the offsets, so a hit can come twice.
  const seen = new Set(before.map(hit => hit.id));
  return { state: "ready", hits: [...before, ...answer.hits.filter(hit => !seen.has(hit.id))], total: answer.total, more: !!answer.nextCursor, loadingMore: false };
}

export type Action =
  /** A hit's `link` is its own route (hit-view.ts `Hit.link`), which opens a reply in its thread pane and a job's entry in the job. */
  | { type: "open"; conversation: string; messageId?: string; link?: string }
  | { type: "scope"; conversation: string }
  | { type: "operator"; operator: Operator }
  | { type: "more" }
  /** Puts other filters in place, such as none after a search with no hits. */
  | { type: "filters"; filters: Filters }
  /** Opens a wiki page in the viewer; `pages` opens the Wiki view with every page that matches. */
  | { type: "wiki"; path: string }
  | { type: "pages"; q: string }
  /** Puts a recent search back in the field and the chips. */
  | { type: "recall"; search: RecentSearch }
  /** Opens the full results page for what is typed. */
  | { type: "page" };

export type Icon = "chat" | "channel" | "calendar" | "search" | "more" | "page" | "recent" | "link" | "smile" | "pin" | "bookmark" | "thread" | "filter";
export type Row = {
  key: string;
  label: string;
  positions?: number[] | undefined;
  snippet?: Piece[] | undefined;
  detail?: string | undefined;
  icon: Icon;
  avatar?: { src?: string | undefined; name: string; shape: "circle" | "squircle" } | undefined;
  /** A message row's hit, which the dialog draws with its author, place and time. */
  hit?: Hit | undefined;
  action: Action;
};
export type Group = { label: string; rows: Row[]; empty?: string | undefined; count?: Ready["total"] | undefined; hideLabel?: boolean | undefined };

/** The key of the "See all results" row, which leads the list and is the default choice, so Enter opens the full page. */
export const SEE_ALL = "see-all";

export type SearchInput = {
  text: string;
  /** The chips' filters; `filters.in` scopes the search to one conversation. */
  filters: Filters;
  current?: string | undefined;
  sort: Sort;
  conversations: readonly Conversation[];
  people: readonly Person[];
  messages: Messages;
  now: Date;
  /** The wiki pages that match what is typed, a title match first (GET /api/pages); empty until they are in. */
  pages?: readonly WikiPageRow[] | undefined;
  /** Past searches, newest first, which an empty field lists above the recent activity (recent-searches.svelte.ts). */
  recent?: readonly RecentSearch[] | undefined;
};

/** A search the owner ran: its words and filters, as the full results page's address holds them. */
export type RecentSearch = { q: string; filters: Filters };
/** One key per distinct search, so running it again moves it to the top instead of listing it twice. */
export const recentKey = (search: RecentSearch): string => JSON.stringify([search.q.trim().toLowerCase(), search.filters.from, search.filters.place, search.filters.in ?? "", search.filters.after ?? "", search.filters.before ?? "", search.filters.has]);
export const RECENT_SEARCHES = "Recent searches";
const RECENT_SEARCH_ROWS = 5;

/** The filters of a recent search in words, such as "from Vent · in #pi-cutover · Threads · Last 7 days". */
function filterWords(filters: Filters, input: SearchInput): string {
  const person = (id: string) => (id === "agents" ? "agents" : id === "owner" ? "you" : (input.people.find(one => one.id === id)?.name ?? id));
  const place = input.conversations.find(conversation => conversation.id === filters.in);
  return [
    filters.from.length ? `from ${filters.from.map(person).join(", ")}` : undefined,
    filters.in ? `in ${place ? (place.kind === "channel" ? `#${place.name.replace(/^#/, "")}` : place.name) : filters.in}` : undefined,
    ...filters.place.map(id => PLACES.find(one => one.id === id)?.label),
    dateLabel(filters, input.now),
    ...filters.has.map(id => MARKS.find(one => one.id === id)?.label),
  ]
    .filter(Boolean)
    .join(" · ");
}

function recentSearchRows(input: SearchInput): Row[] {
  return (input.recent ?? []).slice(0, RECENT_SEARCH_ROWS).map(search => {
    const words = filterWords(search.filters, input);
    return {
      key: `recent:${recentKey(search)}`,
      label: search.q || words,
      detail: search.q ? words || undefined : undefined,
      icon: "recent",
      action: { type: "recall", search },
    };
  });
}

/** At most 3 name matches across chats, agents and channels, so the messages show without a scroll; the full results page holds every message. */
const NAMED_ROWS = 3;
const RECENT_ROWS = 4;
/** At most 3 pages, so the messages still show; "See all N pages" opens the Wiki view with every match. */
const PAGE_ROWS = 3;
/** The pages the palette asks GET /api/pages for, which the "See all" row counts up to. */
export const PAGES_ASKED = 20;

/** The Pages group: the wiki pages whose title or words match, as Slack lists the canvases a search finds above its messages. */
function pagesGroup(input: SearchInput, text: string): Group[] {
  const pages = input.pages ?? [];
  if (!pages.length) return [];
  const rows: Row[] = pages.slice(0, PAGE_ROWS).map(page => ({
    key: `page:${page.path}`,
    label: page.title,
    positions: matchName(page.title, text)?.positions,
    detail: pagePlace(page.path) || "Wiki",
    icon: "page",
    action: { type: "wiki", path: page.path },
  }));
  if (pages.length > PAGE_ROWS)
    rows.push({ key: "all-pages", label: `See all ${pages.length >= PAGES_ASKED ? `${PAGES_ASKED}+` : pages.length} pages`, icon: "more", action: { type: "pages", q: text } });
  return [{ label: "Pages", rows }];
}

const activity = (conversation: Conversation) => conversation.lastActivityAt ?? 0;
const kindDetail: Record<ConversationKind, string> = { solo: "Chat", channel: "Channel", dm: "Direct message", job: "Job" };

function conversationRow(conversation: Conversation, needle: string): Row {
  const label = conversation.kind === "channel" ? conversation.name.replace(/^#?/, "") : conversation.name;
  return {
    key: `conversation:${conversation.id}`,
    label,
    positions: needle ? matchName(label, needle)?.positions : undefined,
    detail: conversation.archived ? `Archived ${kindDetail[conversation.kind].toLowerCase()}` : kindDetail[conversation.kind],
    icon: conversation.kind === "channel" ? "channel" : "chat",
    action: { type: "open", conversation: conversation.id },
  };
}

function personRow(person: Person, needle: string, action: Action, detail: string): Row {
  return {
    key: `person:${person.id}`,
    label: person.name,
    positions: needle ? matchName(person.name, needle)?.positions : undefined,
    detail,
    icon: "chat",
    avatar: { src: person.avatar, name: avatarOf(person).name, shape: person.kind === "agent" ? "squircle" : "circle" },
    action,
  };
}

function ranked<T>(rows: readonly T[], name: (row: T) => string | readonly string[], needle: string, tie: (a: T, b: T) => number): T[] {
  return rows
    .flatMap(row => {
      const names = name(row);
      const ranks = (typeof names === "string" ? [names] : names).flatMap(one => matchName(one, needle)?.rank ?? []);
      return ranks.length ? [{ row, rank: Math.min(...ranks) }] : [];
    })
    .sort((a, b) => a.rank - b.rank || tie(a.row, b.row))
    .map(({ row }) => row);
}

function messageRows(input: SearchInput): Row[] {
  if (input.messages.state !== "ready" && input.messages.state !== "loading") return [];
  const rows: Row[] = input.messages.hits.map(hit => {
    const pieces = snippetPieces(hit.snippet);
    return {
      key: `hit:${hit.id}`,
      label: pieces.map(piece => piece.text).join(""),
      snippet: leadIn(pieces),
      detail: [author(hit).name, input.filters.in ? undefined : locationText(hit.conversation), what(hit), shortDay(hit.at, input.now)].filter(Boolean).join(" · "),
      icon: "chat",
      hit,
      action: { type: "open", conversation: hit.conversation.id, messageId: hit.messageId, link: hit.link },
    };
  });
  if (input.messages.state === "ready" && input.messages.more)
    rows.push({ key: "more-messages", label: input.messages.loadingMore ? "Loading more messages…" : "Show more messages", icon: "more", action: { type: "more" } });
  return rows;
}

/**
 * The first row once something is typed or filtered: Enter on it, the default, opens the full results page. A search with no hits leads
 * with the ways to widen it instead, as Slack's does: search everywhere, then without the other filters.
 */
function seeAll(input: SearchInput): Group {
  const q = searchText(input.text);
  const total = input.messages.state === "ready" ? input.messages.total : undefined;
  if (total === 0 && input.messages.state === "ready" && !input.messages.hits.length) return { label: "Widen the search", hideLabel: true, rows: widenRows(input.filters) };
  const count = total === undefined ? undefined : `${total.toLocaleString("en-US")} ${total === 1 ? "result" : "results"}`;
  return {
    label: "All results",
    hideLabel: true,
    rows: [{
      key: SEE_ALL,
      label: q ? `See all results for “${q}”` : "See all results",
      detail: count,
      icon: "search",
      action: { type: "page" },
    }],
  };
}

/** What a search with no hits can drop: the conversation it is in, and the other filters. */
export function widenRows(filters: Filters): Row[] {
  const { in: scope, ...rest } = filters;
  const others = hasFilters({ ...rest, in: undefined });
  return [
    ...(scope ? [{ key: "widen:in", label: "Search everywhere", detail: "Every conversation, with the other filters kept", icon: "search" as const, action: { type: "filters" as const, filters: { ...filters, in: undefined } } }] : []),
    ...(others ? [{ key: "widen:filters", label: "Remove filters", detail: scope ? "Keep only this conversation" : "Search with no filters", icon: "filter" as const, action: { type: "filters" as const, filters: { ...NO_FILTERS, in: scope } } }] : []),
  ];
}

/** The line under a search with no hits, as Slack's: what to check, and what the rows above it drop. */
export const NO_HITS = "No messages match. Check the spelling, or try fewer or other words.";

function messageEmpty(input: SearchInput, hasText: boolean): string | undefined {
  const messages = input.messages;
  if (messages.state === "loading") return "Searching messages…";
  if (messages.state === "error") return "Message search is unavailable.";
  if (!hasText && !hasFilters(input.filters)) return "Type to search messages.";
  return hasText ? NO_HITS : "No messages match these filters.";
}

const liveFirst = <T extends { archived?: boolean | undefined }>(rows: readonly T[]): T[] => [...rows].sort((a, b) => Number(!!a.archived) - Number(!!b.archived));

/**
 * The results page's Channels tab: the channels and Solo rooms whose name matches, live before archived, then by how well the name
 * matches and by activity; every one of them by activity when nothing is typed.
 */
export function channelMatches(conversations: readonly Conversation[], text: string): Conversation[] {
  const rooms = conversations.filter(conversation => conversation.kind === "channel" || conversation.kind === "solo");
  const byActivity = (a: Conversation, b: Conversation) => activity(b) - activity(a);
  return liveFirst(text ? ranked(rooms, conversation => conversation.name.replace(/^#/, ""), text, byActivity) : [...rooms].sort(byActivity));
}

/** The results page's People tab: the agents whose name matches, live before archived; every agent by name when nothing is typed. */
export function peopleMatches(people: readonly Person[], text: string): Person[] {
  const agents = people.filter(person => person.kind === "agent");
  const byName = (a: Person, b: Person) => a.name.localeCompare(b.name);
  return liveFirst(text ? ranked(agents, person => [person.name, ...(person.aliases ?? [])], text, byName) : [...agents].sort(byName));
}

/** Global search lists "Messages"; a search in one conversation names its sort, which it can change. */
export const messageGroupLabel = (sort: Sort, scoped = false) => (!scoped ? "Messages" : sort === "recent" ? "Most recent" : "Most relevant");

const nonEmpty = (group: Group): Group[] => (group.rows.length ? [group] : []);

export function buildGroups(input: SearchInput): Group[] {
  const open = prompt(input.text);
  const needle = open?.needle.replace(/^[@#]/, "") ?? "";

  if (open?.kind === "from" || open?.kind === "to" || open?.kind === "with") {
    const kind = open.kind;
    // `to:` and `with:` name an agent by its DM, so they list the agents that have one.
    const named = kind === "from" ? input.people : input.people.filter(person => person.kind === "agent" && person.conversationId);
    const choices = needle ? ranked(named, person => [person.name, ...(person.aliases ?? [])], needle, (a, b) => a.name.localeCompare(b.name)) : [...named];
    const row = (person: Person) =>
      personRow(person, needle, { type: "operator", operator: { kind, id: kind === "from" ? person.id : person.conversationId! } }, person.kind === "owner" ? "You" : person.archived ? "Archived agent" : "Agent");
    const agents = choices.filter(person => person.kind === "agent");
    return [
      ...(kind === "from" ? [{ label: "People", rows: choices.filter(person => person.kind === "owner").map(row) }] : []),
      { label: "Agents", rows: agents.filter(person => !person.archived).slice(0, 12).map(row), empty: choices.length ? undefined : "No matching people. Try a different name." },
      ...nonEmpty({ label: "Archived agents", rows: agents.filter(person => person.archived).slice(0, 6).map(row) }),
    ];
  }
  if (open?.kind === "in") {
    const byActivity = (list: readonly Conversation[]) =>
      needle ? ranked(list, conversation => conversation.name, needle, (a, b) => activity(b) - activity(a)) : [...list].sort((a, b) => activity(b) - activity(a));
    const row = (conversation: Conversation): Row => ({ ...conversationRow(conversation, needle), action: { type: "operator", operator: { kind: "in", id: conversation.id } } });
    const live = byActivity(input.conversations.filter(conversation => !conversation.archived)).slice(0, 12);
    // Archived conversations stay searchable, as Slack's archived channels do, so they list after the live ones.
    const archived = byActivity(input.conversations.filter(conversation => conversation.archived)).slice(0, needle ? 6 : 3);
    return [
      { label: "Conversations", rows: live.map(row), empty: live.length || archived.length ? undefined : "No matching conversations." },
      ...nonEmpty({ label: "Archived", rows: archived.map(row) }),
    ];
  }
  if (open?.kind === "has" || open?.kind === "is") {
    const kind = open.kind;
    const choices = MARK_CHOICES[kind].filter(choice => choice.value.startsWith(open.needle.toLowerCase()));
    const icon = (value: string): Icon => (value === "link" ? "link" : value === "reaction" ? "smile" : value === "pin" ? "pin" : value === "saved" ? "bookmark" : "thread");
    return [{
      label: "Filters",
      rows: choices.flatMap(choice => {
        const operator = markOperator(kind, choice.value);
        return operator ? [{ key: `mark:${kind}:${choice.value}`, label: `${kind}:${choice.value}`, detail: choice.detail, icon: icon(choice.value), action: { type: "operator" as const, operator } }] : [];
      }),
      empty: `No ${kind}: filter starts with “${open.needle}”.`,
    }];
  }
  if (open?.kind === "during") {
    const typed = open.needle.toLowerCase();
    const listed = DURING_CHOICES.filter(choice => choice.value.startsWith(typed) || choice.label.toLowerCase().startsWith(typed));
    // A month, a year or YYYY-MM typed in full is a choice of its own, such as "during:nov" for November.
    const own = !listed.length && duringRange(typed, input.now) ? [{ value: typed, label: typed.replace(/^\w/, c => c.toUpperCase()) }] : [];
    const choices = [...listed, ...own];
    return [{
      label: "Dates",
      rows: choices.flatMap(choice => {
        const range = duringRange(choice.value, input.now);
        return range ? [{ key: `during:${choice.value}`, label: choice.label, detail: `during:${choice.value}`, icon: "calendar" as const, action: { type: "operator" as const, operator: range } }] : [];
      }),
      empty: "Type a month, such as during:november, or a year.",
    }];
  }
  if (open?.kind === "on" && !/^\d{4}-\d{2}-\d{2}$/.test(open.needle)) {
    return [{
      label: "Dates",
      rows: datePresets(input.now).slice(0, 2).map(preset => ({
        key: `on:${preset.label}`,
        label: preset.label,
        detail: preset.date,
        icon: "calendar",
        action: { type: "operator", operator: { kind: "on", date: preset.date } },
      })),
    }];
  }
  if ((open?.kind === "after" || open?.kind === "before") && !/^\d{4}-\d{2}-\d{2}$/.test(open.needle)) {
    const kind = open.kind;
    return [
      {
        label: "Dates",
        rows: datePresets(input.now).map(preset => ({
          key: `date:${preset.label}`,
          label: preset.label,
          detail: preset.date,
          icon: "calendar",
          action: { type: "operator", operator: { kind, date: preset.date } },
        })),
      },
    ];
  }

  const text = searchText(input.text);
  const filtered = hasFilters(input.filters);
  const messages: Group = {
    label: messageGroupLabel(text ? input.sort : "recent", !!input.filters.in),
    rows: messageRows(input),
    empty: messageEmpty(input, !!text),
    count: input.messages.state === "ready" && (text || filtered) ? input.messages.total : undefined,
  };
  // Filters with no words list every message they keep, newest first, as Slack's `from:@vent` alone does.
  if (input.filters.in || (filtered && !text)) return [seeAll(input), messages];

  const current = input.current ? input.conversations.find(conversation => conversation.id === input.current) : undefined;
  // One slim row with no heading, under See all results when something is typed.
  const thisConversation: Group[] = current
    ? [{
        label: "This conversation",
        hideLabel: true,
        rows: [{
          key: `scope:${current.id}`,
          label: `Search in ${current.kind === "channel" ? `#${current.name.replace(/^#/, "")}` : current.name}`,
          detail: "This conversation only",
          icon: "search",
          action: { type: "scope", conversation: current.id },
        }],
      }]
    : [];

  if (!text) {
    const recent = input.conversations
      .filter(conversation => !conversation.archived)
      .sort((a, b) => activity(b) - activity(a))
      .slice(0, RECENT_ROWS)
      .map(conversation => ({ ...conversationRow(conversation, ""), ...(conversation.preview ? { detail: conversation.preview } : {}) }));
    const searches = recentSearchRows(input);
    return [...thisConversation, ...(searches.length ? [{ label: RECENT_SEARCHES, rows: searches }] : []), { label: "Recent activity", rows: recent, empty: "No recent activity yet." }];
  }

  if (filtered) return [seeAll(input), ...thisConversation, messages];

  // Chats, DMs, channels and agents rank together: live before archived, then by how well the name matches, then by activity.
  type Named = { row: Row; name: string; archived: boolean; at: number };
  const listed: Named[] = input.conversations
    .filter(conversation => conversation.kind !== "job")
    .map(conversation => ({ row: conversationRow(conversation, text), name: conversation.name, archived: !!conversation.archived, at: activity(conversation) }));
  const listedIds = new Set(input.conversations.filter(conversation => conversation.kind !== "job").map(conversation => conversation.id));
  const lastAt = new Map(input.conversations.map(conversation => [conversation.id, activity(conversation)]));
  const agents: Named[] = input.people
    .filter(person => person.kind === "agent" && person.conversationId && !listedIds.has(person.conversationId))
    .map(person => ({
      row: personRow(person, text, { type: "open", conversation: person.conversationId! }, person.detail ?? "Agent"),
      name: person.name,
      archived: !!person.archived,
      at: lastAt.get(person.conversationId!) ?? 0,
    }));
  const named = ranked([...listed, ...agents], one => one.name, text, (a, b) => b.at - a.at)
    .sort((a, b) => Number(a.archived) - Number(b.archived))
    .slice(0, NAMED_ROWS)
    .map(one => one.row);
  return [seeAll(input), ...thisConversation, ...(named.length ? [{ label: "Conversations", rows: named }] : []), ...pagesGroup(input, text), messages];
}
