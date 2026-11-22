/**
 * Full-text search over every thread entry and room post, with the filters from:, in:, after: and before:
 * (~/work/slack-layer-design/search.md section 5). Every box's entries and every post live in one Meilisearch index (search-engine.ts), so
 * a search asks no other box; `total` is the exact count for the same filters (c191), and `missing` says when a box's newest rows may lack.
 *
 * A comm thread (phase 4) has no rows of its own: its entries are left out, and the DM posts whose words it holds are searched as the DM's
 * posts instead, so a hit opens the DM at the post. Channel and Solo room posts are searched as posts of their room (phase 5).

 */
import type { ConversationKind, ConversationSummary, Principal, SearchHit, SearchMissing, SearchPlace, SearchResult, SearchWhere } from "../web/src/lib/api/types.ts";
import { CHANNEL_COPY_LIKE, type GroupRooms } from "./group-rooms.ts";
import { describe, fullText, searchTerms, snippet, SYSTEM_AUTHOR } from "./search-snippet.ts";
import { safeSnippet } from "./search-snippet.ts";
import type { LinkState } from "./host/relay-host.ts";
import type { SearchHit as HostHit } from "./host/types.ts";
import { conversationIdOf, parseConversationId, type Threads } from "./threads.ts";
import type { AgentRecord, RoomPost } from "./agent-store.ts";
import { isAgentId, isRoomId } from "./agents.ts";
import { reactionList, reactionsLine } from "./reactions.ts";
import { and, eq, isIn, not, or, type BoxIndexState, type Cond, type EntryDoc, type PostDoc, type PostHas, type SearchDoc, type SearchEngine, type SearchSplit } from "./search-engine.ts";

/** The owner reads dates in KST. */
export const OWNER_ZONE_OFFSET_MS = 9 * 3600_000;

/**
 * `from` holds `owner`, `agents`, agent ids and agent names, `where` holds `root`, `thread` and `tool` (all three when empty), and `place`
 * the six places of SEARCH_PLACES (all six when empty); many values of one filter are OR-ed, and filters are AND-ed. `in` is a conversation
 * id, a channel or Solo room name, or an agent name for its DM.
 */
export interface SearchParams {
  q: string; from?: readonly string[]; in?: string; where?: readonly string[]; place?: readonly string[]; after?: string; before?: string; sort?: "relevance" | "recent"; limit?: number; cursor?: string;
  /** `link`, `reaction`, `pin` and `saved`, AND-ed as Slack's `has:` and `is:saved` are; each keeps room posts only. */
  has?: readonly string[];
  /** Leaves each hit's longer `text` out: the Cmd K rows show only the snippet, and the 20 hits of "kimchi" were 52.0 KB with it on 11-19. */
  brief?: boolean;
}

/**
 * How many messages `recent` gives at most. On 11-20 every room post and every input of the owner's, 2,397 documents over 32 days, came to
 * 327 KB of text cut at 2,000 characters each and 72 KB gzipped.
 */
export const RECENT_LIMIT = 3000;

/** Root chats' first conversations and the threads agents work in, for `where` (Search `rootChats`). */
interface RootChats { convs: string[]; held: string[] }
type RootSets = { [K in keyof RootChats]: ReadonlySet<string> };

/** The entry authors that are no agent: the owner, and the turns the chat or Prime wrote as his (search-snippet.ts `indexedAuthor`). */
const NOT_AGENTS = ["owner", SYSTEM_AUTHOR];

/** Tool output ranks after every message by relevance, and in a root chat it is the root chat's `tool` part. */
const TOOL_KINDS = ["pi.tool-result"];

/** A post's `kind` in the index (app.ts `postDoc`): a thread reply, or a top-level post. */
export const POST_KINDS = { root: "room.post", reply: "room.reply" } as const;

export const SEARCH_WHERE: readonly SearchWhere[] = ["root", "thread", "tool"];

/**
 * The places every hit sits in exactly one of, in the order the search page's pills show them (owner, #sw-factory-build p126: "Where하고 이
 * 카테고리하고 합쳐서,dropdown 말고 그냥 아이템들 list되어있는 pill들로"). `channels`, `dms` and `solo` are top-level posts of their rooms, and
 * `solo` also a root chat's own words; `threads` are replies in any room; `jobs` are the entries of agents' work and of root chats' jobs, and
 * `tools` tool output anywhere.
 */
export const SEARCH_PLACES: readonly SearchPlace[] = ["channels", "dms", "solo", "threads", "jobs", "tools"];

/** The names `place` reads, singular forms and "tool calls" included. */
const PLACE_NAMES: Readonly<Record<string, SearchPlace>> = {
  channels: "channels", channel: "channels", dms: "dms", dm: "dms", solo: "solo", threads: "threads", thread: "threads",
  jobs: "jobs", job: "jobs", tools: "tools", tool: "tools", "tool calls": "tools", toolcalls: "tools",
};

/** The places each `where` value covers, so `where` and `place` together keep the places both name. */
const WHERE_PLACES: Readonly<Record<SearchWhere, readonly SearchPlace[]>> = { root: ["channels", "dms", "solo"], thread: ["threads"], tool: ["jobs", "tools"] };

/** What `has` reads: a post's marks in the index (app.ts `postDoc`), and `saved` for the owner's open Later items. */
export type SearchHas = PostHas | "saved";
const HAS_NAMES: Readonly<Record<string, SearchHas>> = {
  link: "link", links: "link", reaction: "reaction", reactions: "reaction", pin: "pin", pins: "pin", pinned: "pin", saved: "saved", save: "saved",
};

/** A bare web address or a markdown link, as a post's text holds a link. */
const LINK_RE = /\bhttps?:\/\/\S|\bwww\.\S+\.\S|\]\([^)\s]+\)/i;

/** The marks of a post's search document: a link in its text, a reaction under it, and the owner's pin. */
export function postHas(post: RoomPost, principal: (id: string) => Principal): PostHas[] {
  return [
    ...(LINK_RE.test(post.text) ? ["link" as const] : []),
    ...(reactionList(principal, post) ? ["reaction" as const] : []),
    ...(post.pinned?.pinned ? ["pin" as const] : []),
  ];
}

/** The `has` values, singular and plural forms read alike; an unknown value is refused by name. */
export function parseHas(values: readonly string[] | undefined): Set<SearchHas> {
  const out = new Set<SearchHas>();
  for (const value of values ?? []) {
    const has = HAS_NAMES[value.trim().toLowerCase()];
    if (!has) throw new SearchFilterError(`No has value "${value}"; use link, reaction, pin or saved.`);
    out.add(has);
  }
  return out;
}

/** A filter value search cannot read, such as an unknown agent name; the API answers 400 with its message. */
export class SearchFilterError extends Error {}

/**
 * Pulls `from:x in:y after:2026-10-01 before:2026-10-28` out of the text; explicit params win. Each `from:` adds a value, and a comma list
 * in one token adds each of its values.
 */
export function parseQuery(params: SearchParams): Required<Pick<SearchParams, "q">> & Omit<SearchParams, "q"> {
  const out: SearchParams = { ...params, q: "" };
  const words: string[] = [];
  const lists = { from: [] as string[], place: [] as string[], has: [] as string[] };
  for (const token of params.q.match(/"[^"]*"|\S+/g) ?? []) {
    const match = /^(from|place|has|is|in|after|before):(.+)$/.exec(token);
    if (!match) words.push(token);
    else if (match[1] === "is") {
      // `is:thread` is the Threads place; `is:saved` and `is:pinned` are marks, as `has:` reads them.
      const value = match[2]!.toLowerCase();
      if (value === "thread") lists.place.push("threads");
      else lists.has.push(value);
    } else if (match[1] === "from" || match[1] === "place" || match[1] === "has") lists[match[1]].push(...listValues([match[2]!.replace(/^"|"$/g, "")]));
    else out[match[1] as "in" | "after" | "before"] ??= match[2]!.replace(/^"|"$/g, "");
  }
  if (!out.from?.length && lists.from.length) out.from = lists.from;
  if (!out.place?.length && lists.place.length) out.place = lists.place;
  if (!out.has?.length && lists.has.length) out.has = lists.has;
  out.q = words.join(" ");
  return out as Required<Pick<SearchParams, "q">> & Omit<SearchParams, "q">;
}

/** Repeated params and comma lists as one list of values, with blanks dropped. */
export function listValues(values: readonly string[]): string[] {
  return values.flatMap(value => value.split(",")).map(value => value.trim()).filter(Boolean);
}

/** The `where` values, all three when none is given; an unknown value is refused by name. */
export function parseWhere(values: readonly string[] | undefined): Set<SearchWhere> {
  if (!values?.length) return new Set(SEARCH_WHERE);
  const out = new Set<SearchWhere>();
  for (const value of values) {
    const where = SEARCH_WHERE.find(w => w === value.toLowerCase());
    if (!where) throw new SearchFilterError(`No where value "${value}"; use root, thread or tool.`);
    out.add(where);
  }
  return out;
}

/**
 * The places a search keeps: the `place` values, all six when none is given, less those `where` leaves out. An unknown value is refused by
 * name.
 */
export function parsePlace(values: readonly string[] | undefined, where: ReadonlySet<SearchWhere> = new Set(SEARCH_WHERE)): Set<SearchPlace> {
  const named = new Set<SearchPlace>();
  for (const value of values ?? []) {
    const place = PLACE_NAMES[value.trim().toLowerCase().replace(/\s+/g, " ")];
    if (!place) throw new SearchFilterError(`No place "${value}"; use ${SEARCH_PLACES.join(", ")}.`);
    named.add(place);
  }
  const kept = new Set([...where].flatMap(w => WHERE_PLACES[w]));
  return new Set(SEARCH_PLACES.filter(place => kept.has(place) && (!named.size || named.has(place))));
}

/**
 * The post filter for rooms whose top-level posts and whose replies a search keeps, or undefined when it keeps none. `replies` is either
 * empty or every room `tops` is drawn from, so equal lengths mean one room list with no kind filter.
 */
function postRooms(tops: readonly string[], replies: readonly string[]): Cond | undefined {
  if (tops.length && tops.length === replies.length) return isIn("room", tops);
  const conds = [
    ...(tops.length ? [and(not(eq("kind", POST_KINDS.reply)), isIn("room", tops))] : []),
    ...(replies.length ? [and(eq("kind", POST_KINDS.reply), isIn("room", replies))] : []),
  ];
  return conds.length ? (conds.length === 1 ? conds[0] : or(...conds)) : undefined;
}

/** The web hash route that opens a hit, written as web/src/lib/router.svelte.ts `conversationHref` writes it. */
export function hitLink(conversation: string, messageId: string, threadRoot?: string): string {
  const params = new URLSearchParams({ ...(threadRoot ? { thread: threadRoot } : {}), m: messageId });
  return `#/c/${encodeURIComponent(conversation)}?${params}`;
}

/** A thread's title in a reply's row: the root post's first words, markdown marks dropped, cut at a word near 60 characters. */
export function threadTitle(text: string): string {
  const plain = text.replace(/```[\s\S]*?```/g, " ").replace(/[`*_#>|[\]]/g, "").replace(/\s+/g, " ").trim();
  if (plain.length <= 60) return plain;
  const cut = plain.slice(0, 60);
  const space = cut.lastIndexOf(" ");
  return `${space > 30 ? cut.slice(0, space) : cut}…`;
}

/** Who `from` names: the owner, every agent, or one agent with the threads its work runs in. */
type From = { kind: "owner" } | { kind: "agents" } | {
  kind: "agent"; id: string;
  /** The ids its posts and agent messages carry. */
  authors: string[];
  /** The entries of its own work, which it wrote unless the owner did. */
  work: Cond;
};

/** YYYY-MM-DD at 00:00 in the owner's zone, as epoch ms. */
export function dayStart(day: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) throw new Error(`Dates are YYYY-MM-DD, got ${day}.`);
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - OWNER_ZONE_OFFSET_MS;
}

export { safeSnippet } from "./search-snippet.ts";

function terms(q: string): string[] {
  return (q.match(/"[^"]*"|\S+/g) ?? []).map(t => t.replace(/^"|"$/g, "").replace(/\*$/, "").toLowerCase()).filter(t => t && !/^(AND|OR|NOT)$/i.test(t));
}

/** A work-thread input that was a job's test send typed into the owner's DM (rooms.ts `allTestSends`). */
export interface TestSendEntry { thread: string; entry: number; by: string; reason: string }

/**
 * A hit's snippet, and its longer `text` for a text over 240 characters unless `brief` asks for none. The longer text is cut only when it is
 * sent or stands in for an empty snippet: with `brief`, the 20 hits of a search cut it for nothing.
 */
function hitText(text: string, marks: string[], brief: boolean, fallback = ""): Pick<SearchHit, "snippet" | "text"> {
  const shown = snippet(text, marks);
  const sent = !brief && text.length > 240;
  const long = sent || !shown ? fullText(text, marks) : "";
  return { snippet: shown || long || fallback, ...(sent ? { text: long } : {}) };
}

/** Another box whose rows the index reads through its agent relay (`MultiHost`). */
export interface SearchBox { box: string; link(): LinkState }

const clock = (at: number): string => new Date(at).toISOString().slice(11, 16) + "Z";

/** Why some of a box's threads may be missing from the results, or nothing when the index holds every row the box has. */
function boxNote(box: SearchBox, state: BoxIndexState): string | undefined {
  const link = box.link();
  if (state === "indexing") return `${box.box}'s threads are still being indexed, so some are not in these results yet.`;
  if (link.state === "up") return state === "unread" ? `${box.box}'s threads are not indexed yet, so they are not in these results.` : undefined;
  return state === "unread"
    ? `${box.box} is offline since ${clock(link.since)} and was never indexed, so its threads are not in these results.`
    : `${box.box} is offline since ${clock(link.since)}, so its threads show what it wrote until then.`;
}

export class Search {
  /** The test sends: `from:owner` leaves them out, and their hits name the job as the author. Set by the app once it has the rooms. */
  testSends: () => TestSendEntry[] = () => [];
  /** The search documents of the posts the owner has open in Later, for `has` saved. Set by the app. */
  saved: () => string[] = () => [];
  /** The other boxes agents run on. Set by the app when it runs over several boxes. */
  boxes: () => SearchBox[] = () => [];

  constructor(readonly threads: Threads, readonly groups: GroupRooms, readonly engine: SearchEngine, private readonly posts: (room: string) => readonly RoomPost[]) {}

  async run(params: SearchParams, split?: SearchSplit): Promise<SearchResult> {
    const started = performance.now();
    const query = parseQuery(params);
    const words = terms(query.q);
    const has = parseHas(query.has);
    // A filter with no words lists every message it keeps, newest first, as Slack's `from:@vent` alone does.
    const filtered = !!(query.from?.length || query.in || query.where?.length || query.place?.length || query.after || query.before || has.size);
    if (!words.length && !filtered) return { hits: [], total: 0 };
    const marks = searchTerms(query.q);
    const after = query.after ? dayStart(query.after) : undefined;
    const before = query.before ? dayStart(query.before) : undefined;
    const sort = words.length ? query.sort ?? "relevance" : "recent";
    const offset = Number(query.cursor ?? 0) || 0;
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const range: Cond[] = [...(after === undefined ? [] : [{ op: "gte", field: "at", value: after } as Cond]), ...(before === undefined ? [] : [{ op: "lt", field: "at", value: before } as Cond])];
    const parts: Cond[] = [];

    const places = parsePlace(query.place, parseWhere(query.where));
    const inId = query.in ? this.resolveIn(query.in) : undefined;
    const inChannel = inId ? this.groups.row(inId) : undefined;
    const inRoom = inId && (isRoomId(inId) || isAgentId(inId)) ? this.threads.agentRecords?.record(inId) : undefined;
    const from = (query.from ?? []).map(value => this.resolveFrom(value));
    const tests = this.testSends();
    const testOf = new Map(tests.map(t => [`${t.thread}:${t.entry}`, t]));
    const scope = !inChannel && inId ? parseConversationId(this.threads.conversationOf(inId)) : undefined;
    const rooms = this.listedRooms();
    const rootChats = this.rootChats();
    const entryWhere = Search.entryPlaces(places, rootChats);
    const groupRows = inChannel ? [inChannel] : undefined;
    const channels = groupRows ? groupRows.filter(row => row.kind === "channel").map(row => row.id) : rooms.channels;
    const solos = groupRows ? groupRows.filter(row => row.kind === "solo").map(row => row.id) : rooms.solos;
    const dms = inRoom ? [inRoom.room] : rooms.dms;
    const groupPosts = postRooms([...(places.has("channels") ? channels : []), ...(places.has("solo") ? solos : [])], places.has("threads") ? [...channels, ...solos] : []);
    const dmPosts = postRooms(places.has("dms") ? dms : [], places.has("threads") ? dms : []);
    const anyOf = (conds: Cond[]): Cond[] => (from.length ? [or(...conds)] : []);
    // Only room posts carry marks, so a `has` search keeps no thread entry.
    const marked: Cond[] = [...has].map(one => (one === "saved" ? isIn("id", this.saved()) : eq("has", one)));
    if (!inChannel && entryWhere && !has.size) {
      parts.push(and(
        eq("source", "entry"), eq("channelCopy", false), ...range, ...entryWhere,
        ...(scope ? [eq("convs", `${scope.thread}:${scope.conversation}`)] : this.engine.hiddenFilter()),
        ...anyOf(from.map(f => f.kind === "owner" ? and(eq("author", "owner"), ...(tests.length ? [not(isIn("keys", tests.map(t => `${t.thread}:${t.entry}`)))] : []))
          : f.kind === "agents" ? not(isIn("author", NOT_AGENTS))
          : or(and(eq("kind", "agent.message"), isIn("author", f.authors)), and(not(eq("kind", "agent.message")), not(isIn("author", NOT_AGENTS)), f.work)))),
      ));
    }
    if ((!inId || inChannel) && groupPosts) {
      parts.push(and(
        eq("source", "post"), eq("dm", false), ...range, ...marked, groupPosts,
        ...anyOf(from.map(f => f.kind === "owner" ? eq("author", "owner") : f.kind === "agents" ? not(eq("author", "owner")) : isIn("author", f.authors))),
      ));
    }
    if ((!inId || inRoom) && dmPosts) {
      parts.push(and(
        eq("source", "post"), eq("dm", true), eq("listed", true), ...range, ...marked, dmPosts,
        ...anyOf(from.map(f => f.kind === "owner" ? eq("ownerPost", true) : f.kind === "agents" ? eq("ownerPost", false) : isIn("author", f.authors))),
      ));
    }

    const asked = performance.now();
    if (split) split.prep = asked - started;
    const mine = parts.length ? await this.engine.search(words.length ? query.q : "", or(...parts), { sort, limit: offset + limit }, split) : { docs: [], total: 0 };
    const answered = performance.now();
    // Only the page's hits need their conversation's summary; every conversation's summaries took tens of ms to build on us-metal02.
    const known = new Map<string, ConversationSummary | undefined>();
    const summaries = { get: (id: string) => (known.has(id) ? known.get(id) : known.set(id, this.threads.conversation(id)).get(id)) };
    const total = mine.total;
    const missing: SearchMissing[] = inChannel ? [] : this.boxes().flatMap(box => {
      const note = boxNote(box, this.engine.boxState(box.box));
      return note ? [{ box: box.box, note }] : [];
    });
    const roots = { convs: new Set(rootChats.convs), held: new Set(rootChats.held) };
    let hits = mine.docs.slice(offset, offset + limit).flatMap(doc => this.docHit(doc, scope?.thread, summaries, marks, testOf, roots, !!query.brief) ?? []);
    // An answer whose match sits only in a tool call's arguments is found by its text, so it sinks below the messages of its own page.
    if (sort === "relevance") hits = [...hits.filter(hit => hit.role !== "tool"), ...hits.filter(hit => hit.role === "tool")];
    if (split) split.hits = performance.now() - answered;
    return {
      hits, total, ...(offset + limit < total ? { nextCursor: String(offset + limit) } : {}), ...(missing.length ? { missing } : {}),
    };
  }

  /**
   * The newest messages people wrote to each other, newest first: every room, channel and DM post an unscoped search finds and the owner's
   * own inputs to a thread, each with up to 2,000 characters of its text as `snippet`. The Cmd K search keeps them in the page and matches
   * each keystroke against them itself, so its first rows wait on no request; `after` (epoch ms) asks only for the ones written since.
   */
  async recent(params: { after?: number; limit?: number } = {}): Promise<SearchResult> {
    const limit = Math.min(Math.max(params.limit ?? RECENT_LIMIT, 1), RECENT_LIMIT);
    const range: Cond[] = params.after === undefined ? [] : [{ op: "gte", field: "at", value: params.after + 1 }];
    const tests = this.testSends();
    const rooms = this.listedRooms();
    const where = or(
      and(eq("source", "entry"), eq("channelCopy", false), eq("author", "owner"), ...range,
        ...this.engine.hiddenFilter(), ...(tests.length ? [not(isIn("keys", tests.map(t => `${t.thread}:${t.entry}`)))] : [])),
      and(eq("source", "post"), eq("dm", false), isIn("room", [...rooms.channels, ...rooms.solos]), ...range),
      and(eq("source", "post"), eq("dm", true), eq("listed", true), isIn("room", rooms.dms), ...range),
    );
    const found = await this.engine.search("", where, { sort: "recent", limit });
    const known = new Map<string, ConversationSummary | undefined>();
    const summaries = { get: (id: string) => (known.has(id) ? known.get(id) : known.set(id, this.threads.conversation(id)).get(id)) };
    const rootChats = this.rootChats();
    const roots = { convs: new Set(rootChats.convs), held: new Set(rootChats.held) };
    const hits = found.docs.flatMap(doc => this.docHit(doc, undefined, summaries, [], new Map(), roots, false) ?? [])
      // An input the chat or Prime wrote as the owner's turn, such as a check-in or a duty push, is no message of his.
      .filter(hit => hit.role !== "system")
      .map(({ text, ...hit }) => ({ ...hit, snippet: text ?? hit.snippet }));
    return { hits, total: hits.length };
  }

  /**
   * The rooms whose posts an unscoped search finds: every channel and Solo room, and every agent's DM, less the ones of a walk's test
   * channels and test agents. app.ts `postDoc` indexes a post only in a channel, Solo room or agent DM, so naming the rooms to keep finds
   * the same posts as naming the test rooms to leave out; the posts of a DM whose record `Agents.dropUntitled` removed have no hit to show
   * and no part in `total`. On 11-21 the test rooms were 409 of 448, and their ids, twice in the filter, cost Meilisearch 7 to 8 ms of a
   * 22 ms search on us-metal02 (~/work/p156-search/search-handler/). Channels and Solo rooms come apart for `place`.
   */
  private listedRooms(): { channels: string[]; solos: string[]; dms: string[] } {
    const rows = this.groups.rows().filter(row => !row.test);
    return {
      channels: rows.filter(row => row.kind === "channel").map(row => row.id),
      solos: rows.filter(row => row.kind === "solo").map(row => row.id),
      dms: (this.threads.agentRecords?.list() ?? []).filter(record => !record.test).map(record => record.room),
    };
  }

  /** An agent's work: the entries of its work thread and its root job threads. A job or thread id names that conversation's entries. */
  private resolveFrom(value: string): From {
    const lower = value.toLowerCase();
    if (lower === "owner" || lower === "agents") return { kind: lower };
    const records = this.threads.agentRecords;
    const named = this.threads.registered(value) ?? this.byName(records?.list() ?? [], value, "from");
    if (named && records) {
      const threads = [named.workThread, ...records.jobThreads(named)];
      return { kind: "agent", id: named.id, authors: [named.id, named.workThread], work: isIn("threads", threads) };
    }
    const job = this.threads.agent(value);
    if (job) {
      const at = parseConversationId(job.id);
      return { kind: "agent", id: job.id, authors: [job.id], work: eq("convs", `${at.thread}:${at.conversation}`) };
    }
    throw new SearchFilterError(`No agent named "${value}" for from; use owner, agents, an agent id or an agent's name.`);
  }

  /**
   * The id `in` names: a room or conversation id, a channel or Solo room by name (`#` optional), an agent by name for its DM, or a job by
   * name, with case ignored. A room or agent wins over a job of the same name, since agents read job names in hits and room names in posts.
   * A name that fits a room and an agent, two rooms, or two jobs that are both open or both archived is refused with the ids to use instead.
   */
  private resolveIn(value: string): string {
    if (this.groups.row(value) || ((isRoomId(value) || isAgentId(value)) && this.threads.agentRecords?.record(value))) return value;
    const name = value.replace(/^#/, "").toLowerCase();
    const rooms = this.groups.rows().filter(row => row.name.toLowerCase() === name);
    const open = rooms.filter(row => !row.archived);
    const room = (open.length ? open : rooms);
    const agent = value.startsWith("#") ? undefined : this.byName(this.threads.agentRecords?.list() ?? [], value, "in");
    if (room.length + (agent ? 1 : 0) > 1) {
      const ids = [...room.map(row => row.id), ...(agent ? [agent.id] : [])].join(", ");
      throw new SearchFilterError(`"${value}" for in names more than one place (${ids}); pass one of those ids.`);
    }
    if (room[0]) return room[0].id;
    if (agent) return agent.id;
    const scope = parseConversationId(this.threads.conversationOf(value));
    if (this.threads.thread(scope.thread)) return value;
    const jobs = this.threads.jobList({ archived: true }).filter(job => job.name.toLowerCase() === name);
    const live = jobs.filter(job => !job.archived);
    const job = live.length ? live : jobs;
    if (job.length > 1) throw new SearchFilterError(`"${value}" for in names ${job.length} jobs (${job.map(j => j.id).join(", ")}); pass one of those ids.`);
    if (job[0]) return job[0].id;
    throw new SearchFilterError(`No channel, Solo room, agent, job or thread named "${value}" for in.`);
  }

  /** The agent whose name, as the app shows it, is `value` with case ignored; two such agents are refused. */
  private byName(records: readonly AgentRecord[], value: string, param: "from" | "in"): AgentRecord | undefined {
    const lower = value.toLowerCase();
    const found = records.filter(r => (this.threads.agent(r.id)?.name ?? r.name).toLowerCase() === lower || r.name.toLowerCase() === lower);
    if (found.length > 1) throw new SearchFilterError(`"${value}" for ${param} names ${found.length} agents (${found.map(r => r.id).join(", ")}); pass one of those ids.`);
    return found[0];
  }

  /**
   * Where the owner talks to a thread himself and where agents work: `convs` is `<thread>:1` of each root chat no agent holds (threads.ts
   * `rootChats`), and `held` every work thread and job thread of an agent that is no walk's test agent.
   */
  private rootChats(): RootChats {
    const records = this.threads.agentRecords;
    const roots = this.threads.rootChats();
    const rootSet = new Set(roots);
    const held = new Set<string>();
    for (const record of records?.list() ?? []) if (!record.test) held.add(record.workThread);
    for (const [thread, id] of Object.entries(records?.store.agents.aliases ?? {})) if (!records?.record(id)?.test) held.add(thread);
    return { convs: roots.map(thread => `${thread}:1`), held: [...held].filter(thread => !rootSet.has(thread)) };
  }

  /**
   * The entry filter for the places, or undefined when it keeps no entry. A root chat's words are `solo` and tool output anywhere is `tools`;
   * every other entry of a work thread or job is `jobs`. An entry copied into a root chat and an agent's thread is the agent's: on 11-20
   * vent's work thread shared its first 9,481 entries, duty pushes included, with a root chat forked from it, and they read as his root
   * messages.
   */
  private static entryPlaces(places: ReadonlySet<SearchPlace>, roots: RootChats): Cond[] | undefined {
    const [solo, jobs, tools] = (["solo", "jobs", "tools"] as const).map(place => places.has(place));
    const words = [isIn("convs", roots.convs), not(isIn("threads", roots.held))];
    const work = [not(isIn("convs", roots.convs)), isIn("threads", roots.held)];
    const tool = isIn("kind", TOOL_KINDS);
    if (solo && jobs && tools) return [];
    if (solo && jobs) return [not(tool)];
    if (jobs && tools) return [or(...work, tool)];
    if (solo && tools) return [or(and(...words), tool)];
    if (solo) return [...words, not(tool)];
    if (jobs) return [or(...work), not(tool)];
    if (tools) return [tool];
    return undefined;
  }

  /** Where an entry sits, by the rule `entryWhere` filters with. */
  private static entryPlace(doc: EntryDoc, roots: RootSets): SearchWhere {
    return !TOOL_KINDS.includes(doc.kind) && doc.convs.some(conv => roots.convs.has(conv)) && !doc.threads.some(thread => roots.held.has(thread)) ? "root" : "tool";
  }

  /** A document's hit: an entry opens in the scope's thread or the unarchived, newest thread that holds it, a post in its room. */
  private docHit(doc: SearchDoc, scopeThread: string | undefined, summaries: { get(id: string): ConversationSummary | undefined }, marks: string[], testOf: Map<string, TestSendEntry>, roots: RootSets, brief: boolean): SearchHit | undefined {
    if (doc.source === "post") return this.postHit(doc, marks, brief);
    const thread = scopeThread ?? this.copyThread(doc);
    const conversation = Number(doc.convs.find(c => c.startsWith(`${thread}:`))?.slice(thread.length + 1) ?? 1);
    const hit: HostHit = { thread, conversation, entryId: doc.entry, kind: doc.kind, author: doc.author, at: doc.at, snippet: "", text: doc.text };
    const test = doc.kind === "pi.user" ? doc.keys.map(key => testOf.get(key)).find(Boolean) : undefined;
    return this.threadHit(hit, summaries.get(conversationIdOf(thread, conversation)), marks, Search.entryPlace(doc, roots), brief, test);
  }

  /** Copies of one entry show from the unarchived, most recently updated thread (pi-host's rule in index-db.ts `searchIndex`). */
  private copyThread(doc: EntryDoc): string {
    const rank = (id: string) => {
      const t = this.threads.thread(id);
      return { archived: t?.archived ? 1 : 0, updated: t?.updatedAt ?? 0 };
    };
    return [...doc.threads].sort((a, b) => rank(a).archived - rank(b).archived || rank(b).updated - rank(a).updated)[0]!;
  }

  private postHit(doc: PostDoc, marks: string[], brief: boolean): SearchHit | undefined {
    const post = this.posts(doc.room).find(p => p.id === doc.post);
    if (!post) return undefined;
    if (doc.dm) {
      const agent = this.threads.agentRecords?.record(doc.room);
      return agent ? this.dmHit(doc.room, agent, post, marks, brief) : undefined;
    }
    const row = this.groups.row(doc.room);
    if (!row) return undefined;
    const author = this.threads.principal(post.author);
    const root = post.threadRoot ? this.posts(doc.room).find(p => p.id === post.threadRoot) : undefined;
    return {
      id: `${row.id}/${post.id}`, ...this.placeOf(row.id, post.id, post.threadRoot, root),
      conversation: { id: row.id, kind: row.kind, name: row.name, ...(row.archived ? { archived: true } : {}) }, messageId: post.id,
      author: { id: author.id, name: author.name, kind: author.kind === "owner" ? "owner" : "agent" }, at: post.at, kind: "post",
      role: author.kind === "owner" ? "owner" : "agent", ...(post.threadRoot ? { threadRoot: post.threadRoot } : {}),
      ...hitText(post.text, marks, brief), ...this.reactionsOf(post),
    };
  }

  /** A post's `where`, `thread` and `link`: a reply opens its room with the thread pane at the reply, a top-level post the room at it. */
  private placeOf(room: string, post: string, threadRoot: string | undefined, root: RoomPost | undefined): Pick<SearchHit, "where" | "thread" | "link"> {
    if (!threadRoot) return { where: "root", link: hitLink(room, post) };
    return { where: "thread", thread: { root: threadRoot, title: root && !root.deletedAt ? threadTitle(root.text) : "" }, link: hitLink(room, post, threadRoot) };
  }

  /** A thread hit opens at its entry: the timeline's `around=e<id>` answers with the item that holds it as `focus`. */
  private threadHit(hit: HostHit, summary: ConversationSummary | undefined, marks: string[], where: SearchWhere, brief: boolean, test?: TestSendEntry): SearchHit {
    const conversationId = conversationIdOf(hit.thread, hit.conversation);
    const kind: ConversationKind = summary?.kind ?? (hit.conversation === 1 ? "solo" : "job");
    const said = hit.text === undefined ? undefined : describe(hit.kind, hit.author, hit.text, marks);
    const role = test ? "agent" : said?.role ?? (hit.kind === "pi.tool-result" ? "tool" : hit.author === "owner" ? "owner" : "agent");
    const parentId = summary?.parent ?? (kind === "solo" ? undefined : this.threads.principal(conversationId).parent);
    return {
      id: `${conversationId}/e${hit.entryId}`, where, link: hitLink(conversationId, `e${hit.entryId}`),
      conversation: {
        id: conversationId, kind, name: summary?.name ?? this.threads.thread(hit.thread)?.name ?? hit.thread,
        ...(parentId && parentId !== conversationId ? { parent: { id: parentId, name: this.threads.principal(parentId).name } } : {}),
        ...(summary?.archived || this.threads.thread(hit.thread)?.archived ? { archived: true } : {}),
      },
      messageId: `e${hit.entryId}`, author: test ? this.testAuthor(test) : this.authorOf(hit, said), at: hit.at, ...(test ? { testSend: { reason: test.reason } } : {}),
      kind: hit.kind === "pi.assistant" ? "turn" : hit.kind === "pi.tool-result" ? "tool" : "message", role,
      ...(said?.tool ? { tool: said.tool } : hit.kind === "pi.tool-result" ? { tool: hit.author.replace(/^tool:/, "") } : {}),
      ...(said?.inCall ? { inCall: true } : {}),
      ...(said ? hitText(said.text, marks, brief, safeSnippet(hit.snippet)) : { snippet: safeSnippet(hit.snippet) }),
    };
  }

  /** A DM post hit opens the DM at the post; a job's test send names the job as its author. */
  private dmHit(room: string, agent: AgentRecord, post: RoomPost, marks: string[], brief: boolean): SearchHit {
    const author = post.testSend ? this.threads.principal(post.testSend.by) : this.threads.principal(post.author);
    const owner = author.kind === "owner";
    const name = this.threads.agent(agent.id)?.name ?? agent.name;
    const root = post.threadRoot ? this.posts(room).find(p => p.id === post.threadRoot) : undefined;
    return {
      id: `${room}/${post.id}`, ...this.placeOf(room, post.id, post.threadRoot, root), conversation: { id: room, kind: "dm", name, ...(agent.archived ? { archived: true } : {}) }, messageId: post.id,
      author: { id: author.id, name: author.name, kind: owner ? "owner" : "agent" }, at: post.at, kind: "post", role: owner ? "owner" : "agent",
      ...(post.testSend ? { testSend: { reason: post.testSend.reason } } : {}),
      ...hitText(post.text, marks, brief), ...this.reactionsOf(post),
    };
  }

  /** A post hit's reactions in the form agents read them. */
  private reactionsOf(post: RoomPost): { reactionsLine?: string } {
    const line = reactionsLine(id => this.threads.principal(id), post);
    return line ? { reactionsLine: line } : {};
  }

  private testAuthor(test: TestSendEntry): SearchHit["author"] {
    const p = this.threads.principal(test.by);
    return { id: p.id, name: p.name, kind: "agent" };
  }

  private authorOf(hit: HostHit, said: ReturnType<typeof describe> | undefined): SearchHit["author"] {
    if (said?.role === "system") return { id: "system", name: said.label ?? "System", kind: "system" };
    if (hit.author === "owner") return { id: "owner", name: "You", kind: "owner" };
    if (said?.from) {
      const p = this.threads.principal(said.from);
      return { id: p.id, name: p.name, kind: p.kind === "owner" ? "owner" : "agent" };
    }
    if (hit.kind === "agent.message" || hit.kind === "pi.user") {
      const p = this.threads.principal(hit.author);
      return { id: p.id, name: p.name, kind: p.kind === "owner" ? "owner" : "agent" };
    }
    const p = this.threads.principal(conversationIdOf(hit.thread, hit.conversation));
    return { id: p.id, name: p.name, kind: "agent" };
  }
}
