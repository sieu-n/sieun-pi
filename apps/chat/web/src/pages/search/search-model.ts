/**
 * Turns what the owner typed, the conversation and agent lists, and the server's message hits into the groups and
 * rows the palette shows. Rows carry their action as data, so the dialog runs it and tests can read it.
 */
import { avatarOf } from "../channel/present.ts";
import { author, locationText, what, type Hit } from "./hit-view.ts";
import { leadIn, matchName, snippetPieces, type Piece } from "./match.ts";
import { datePresets, filters, prompt, searchText, type Operator } from "./operators.ts";

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
};

export type Sort = "relevance" | "recent";

export type Messages =
  | { state: "idle" }
  | { state: "loading" }
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
  | { type: "open"; conversation: string; messageId?: string }
  | { type: "scope"; conversation: string }
  | { type: "operator"; operator: Operator }
  | { type: "more" }
  /** Opens the full results page for what is typed. */
  | { type: "page" };

export type Icon = "chat" | "channel" | "calendar" | "search" | "more";
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
  operators: readonly Operator[];
  scope?: string | undefined;
  current?: string | undefined;
  sort: Sort;
  conversations: readonly Conversation[];
  people: readonly Person[];
  messages: Messages;
  now: Date;
};

/** At most 3 name matches across chats, agents and channels, so the messages show without a scroll; the full results page holds every message. */
const NAMED_ROWS = 3;
const RECENT_ROWS = 4;

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

export function formatDay(at: number, now: Date): string {
  const date = new Date(at);
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

function messageRows(input: SearchInput): Row[] {
  if (input.messages.state !== "ready") return [];
  const rows: Row[] = input.messages.hits.map(hit => ({
    key: `hit:${hit.id}`,
    label: snippetPieces(hit.snippet).map(piece => piece.text).join(""),
    snippet: leadIn(snippetPieces(hit.snippet)),
    detail: [author(hit).name, input.scope ? undefined : locationText(hit.conversation), what(hit), formatDay(hit.at, input.now)].filter(Boolean).join(" · "),
    icon: "chat",
    hit,
    action: { type: "open", conversation: hit.conversation.id, messageId: hit.messageId },
  }));
  if (input.messages.more)
    rows.push({ key: "more-messages", label: input.messages.loadingMore ? "Loading more messages…" : "Show more messages", icon: "more", action: { type: "more" } });
  return rows;
}

/** The first row once something is typed: Enter on it, the default, opens the full results page. */
function seeAll(input: SearchInput): Group {
  const q = filters(input.text, input.operators).q;
  const total = input.messages.state === "ready" ? input.messages.total : undefined;
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

function messageEmpty(input: SearchInput, hasText: boolean): string | undefined {
  const messages = input.messages;
  if (messages.state === "loading") return "Searching messages…";
  if (messages.state === "error") return "Message search is unavailable.";
  if (!hasText) return input.scope ? "Type to search messages in this conversation." : "Type to search messages.";
  return "No matching messages in accessible conversations.";
}

/** Global search lists "Messages"; a search in one conversation names its sort, which it can change. */
export const messageGroupLabel = (sort: Sort, scoped = false) => (!scoped ? "Messages" : sort === "recent" ? "Most recent" : "Most relevant");

export function buildGroups(input: SearchInput): Group[] {
  const open = prompt(input.text);
  const needle = open?.needle.replace(/^[@#]/, "") ?? "";

  if (open?.kind === "from") {
    const choices = needle ? ranked(input.people, person => [person.name, ...(person.aliases ?? [])], needle, (a, b) => a.name.localeCompare(b.name)) : [...input.people];
    const row = (person: Person) => personRow(person, needle, { type: "operator", operator: { kind: "from", id: person.id, label: person.name } }, person.kind === "owner" ? "You" : "Agent");
    return [
      { label: "People", rows: choices.filter(person => person.kind === "owner").map(row), empty: choices.length ? undefined : "No matching people. Try a different name." },
      { label: "Agents", rows: choices.filter(person => person.kind === "agent").slice(0, 12).map(row) },
    ];
  }
  if (open?.kind === "in") {
    const live = input.conversations.filter(conversation => !conversation.archived);
    const choices = needle ? ranked(live, conversation => conversation.name, needle, (a, b) => activity(b) - activity(a)) : [...live].sort((a, b) => activity(b) - activity(a));
    return [
      {
        label: "Conversations",
        rows: choices.slice(0, 12).map(conversation => ({
          ...conversationRow(conversation, needle),
          action: { type: "operator", operator: { kind: "in", id: conversation.id, label: conversation.name.replace(/^#/, "") } },
        })),
        empty: "No matching conversations.",
      },
    ];
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
  const hasQuery = !!text || input.operators.length > 0;
  const messages: Group = {
    label: messageGroupLabel(input.sort, !!input.scope),
    rows: messageRows(input),
    empty: messageEmpty(input, hasQuery),
    count: input.messages.state === "ready" && hasQuery ? input.messages.total : undefined,
  };
  if (input.scope) return hasQuery ? [seeAll(input), messages] : [messages];

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

  if (!hasQuery) {
    const recent = input.conversations
      .filter(conversation => !conversation.archived)
      .sort((a, b) => activity(b) - activity(a))
      .slice(0, RECENT_ROWS)
      .map(conversation => ({ ...conversationRow(conversation, ""), ...(conversation.preview ? { detail: conversation.preview } : {}) }));
    return [...thisConversation, { label: "Recent activity", rows: recent, empty: "No recent activity yet." }];
  }

  if (input.operators.length) return [seeAll(input), ...thisConversation, messages];

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
      archived: false,
      at: lastAt.get(person.conversationId!) ?? 0,
    }));
  const named = ranked([...listed, ...agents], one => one.name, text, (a, b) => b.at - a.at)
    .sort((a, b) => Number(a.archived) - Number(b.archived))
    .slice(0, NAMED_ROWS)
    .map(one => one.row);
  return [seeAll(input), ...thisConversation, ...(named.length ? [{ label: "Conversations", rows: named }] : []), messages];
}
