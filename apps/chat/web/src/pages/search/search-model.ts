/**
 * Turns what the owner typed, the conversation and agent lists, and the server's message hits into the groups and
 * rows the palette shows. Rows carry their action as data, so the dialog runs it and tests can read it.
 */
import { matchName, snippetPieces, type Piece } from "./match.ts";
import { datePresets, prompt, searchText, type Operator } from "./operators.ts";

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
  /** The row's second line, such as "Job of Vent". */
  detail?: string | undefined;
  /** Other names the picker matches, such as "owner" and "me" for the owner. */
  aliases?: readonly string[] | undefined;
};

export type Hit = {
  id: string;
  conversation: { id: string; kind: ConversationKind; name: string };
  messageId: string;
  author: { id: string; name: string; kind: "owner" | "agent" };
  at: number;
  kind: "message" | "turn" | "tool" | "post";
  snippet: string;
};
export type Sort = "relevance" | "recent";

export type Messages =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; hits: readonly Hit[]; total: number; more: boolean; loadingMore: boolean };

export type Action =
  | { type: "open"; conversation: string; messageId?: string }
  | { type: "scope"; conversation: string }
  | { type: "operator"; operator: Operator }
  | { type: "more" };

export type Icon = "chat" | "channel" | "calendar" | "search" | "more";
export type Row = {
  key: string;
  label: string;
  positions?: number[] | undefined;
  snippet?: Piece[] | undefined;
  detail?: string | undefined;
  icon: Icon;
  avatar?: { src?: string | undefined; name: string; shape: "circle" | "squircle" } | undefined;
  action: Action;
};
export type Group = { label: string; rows: Row[]; empty?: string | undefined; count?: number | undefined };

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

const NAMED_ROWS = 8;
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
    avatar: { src: person.avatar, name: person.name, shape: person.kind === "agent" ? "squircle" : "circle" },
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
    snippet: snippetPieces(hit.snippet),
    detail: [
      input.scope ? undefined : hit.conversation.name,
      !input.scope && hit.author.name === hit.conversation.name ? undefined : hit.author.name,
      formatDay(hit.at, input.now),
    ].filter(Boolean).join(" · "),
    icon: "chat",
    action: { type: "open", conversation: hit.conversation.id, messageId: hit.messageId },
  }));
  if (input.messages.more)
    rows.push({ key: "more-messages", label: input.messages.loadingMore ? "Loading more messages…" : "Show more messages", icon: "more", action: { type: "more" } });
  return rows;
}

function messageEmpty(input: SearchInput, hasText: boolean): string | undefined {
  const messages = input.messages;
  if (messages.state === "loading") return "Searching messages…";
  if (messages.state === "error") return "Message search is unavailable.";
  if (!hasText) return input.scope ? "Type to search messages in this conversation." : "Type to search messages.";
  return "No matching messages in accessible conversations.";
}

export const messageGroupLabel = (sort: Sort) => (sort === "recent" ? "Most recent" : "Most relevant");

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
    label: messageGroupLabel(input.sort),
    rows: messageRows(input),
    empty: messageEmpty(input, hasQuery),
    count: input.messages.state === "ready" && hasQuery ? input.messages.total : undefined,
  };
  if (input.scope) return [messages];

  const current = input.current ? input.conversations.find(conversation => conversation.id === input.current) : undefined;
  const scopeRows: Row[] = current
    ? [{
        key: `scope:${current.id}`,
        label: `Search ${current.kind === "channel" ? "in" : "conversation with"} ${current.name}`,
        detail: "Search messages in this conversation",
        icon: "search",
        action: { type: "scope", conversation: current.id },
      }]
    : [];
  const thisConversation: Group[] = scopeRows.length ? [{ label: "This conversation", rows: scopeRows }] : [];

  if (!hasQuery) {
    const recent = input.conversations
      .filter(conversation => !conversation.archived)
      .sort((a, b) => activity(b) - activity(a))
      .slice(0, RECENT_ROWS)
      .map(conversation => ({ ...conversationRow(conversation, ""), ...(conversation.preview ? { detail: conversation.preview } : {}) }));
    return [...thisConversation, { label: "Recent activity", rows: recent, empty: "No recent activity yet." }];
  }

  if (input.operators.length) return [...thisConversation, messages];

  const byName = ranked(input.conversations, conversation => conversation.name, text, (a, b) =>
    Number(!!a.archived) - Number(!!b.archived) || activity(b) - activity(a));
  const chats = byName.filter(conversation => conversation.kind === "solo" || conversation.kind === "dm").slice(0, NAMED_ROWS);
  const channels = byName.filter(conversation => conversation.kind === "channel").slice(0, NAMED_ROWS);
  const shown = new Set(chats.map(conversation => conversation.id));
  const agents = ranked(
    input.people.filter(person => person.kind === "agent" && person.conversationId && !shown.has(person.conversationId)),
    person => person.name,
    text,
    (a, b) => a.name.localeCompare(b.name),
  )
    .slice(0, NAMED_ROWS)
    .map(person => personRow(person, text, { type: "open", conversation: person.conversationId! }, person.detail ?? "Agent"));
  const named: Group[] = [
    { label: "Chats", rows: chats.map(conversation => conversationRow(conversation, text)) },
    { label: "Channels", rows: channels.map(conversation => conversationRow(conversation, text)) },
    { label: "Agents", rows: agents },
  ].filter(group => group.rows.length);
  return [...named, ...thisConversation, messages];
}
