/**
 * Full-text search over every thread entry and room post, with the filters from:, in:, after: and before:
 * (~/work/slack-layer-design/search.md section 5). This box's entries and every post live in one Meilisearch index (search-engine.ts); each
 * other box's threads come through its relay's `durable_search`. `total` is the exact count for the same filters (c191).
 *
 * A comm thread (phase 4) has no rows of its own: its entries are left out, and the DM posts whose words it holds are searched as the DM's
 * posts instead, so a hit opens the DM at the post. Channel and Solo room posts are searched as posts of their room (phase 5).
 *
 * With `local`, the answer leaves the other boxes out and names them in `pending`: on 11-03 the Mac's relay was 190 ms away, and the popup
 * shows this box's rows first, then the full answer with the exact count.
 */
import type { ConversationKind, ConversationSummary, SearchHit, SearchMissing, SearchResult } from "../web/src/lib/api/types.ts";
import { CHANNEL_COPY_LIKE, type GroupRooms } from "./group-rooms.ts";
import { describe, fullText, searchTerms, snippet } from "./search-snippet.ts";
import { safeSnippet } from "./search-snippet.ts";
import type { LinkState } from "./host/relay-host.ts";
import { HostAway, isHostAway, type SearchHit as HostHit, type SearchPage, type SearchQuery } from "./host/types.ts";
import { conversationIdOf, parseConversationId, type Threads } from "./threads.ts";
import type { AgentRecord, RoomPost } from "./agent-store.ts";
import { isAgentId, isRoomId } from "./agents.ts";
import { reactionsLine } from "./reactions.ts";
import { and, eq, isIn, not, or, type Cond, type EntryDoc, type PostDoc, type SearchDoc, type SearchEngine } from "./search-engine.ts";

/** The owner reads dates in KST. */
export const OWNER_ZONE_OFFSET_MS = 9 * 3600_000;

/** `from` is `owner`, `agents` or one agent id, and `type` keeps messages only or tool output only; `local` leaves the other boxes for later. */
export interface SearchParams {
  q: string; from?: string; in?: string; after?: string; before?: string; sort?: "relevance" | "recent"; type?: "messages" | "tools"; limit?: number; cursor?: string;
  local?: boolean;
}

/** Tool output ranks after every message by relevance and is what `type` keeps or leaves out. */
const TOOL_KINDS = ["pi.tool-result"];

/** Pulls `from:x in:y after:2026-10-01 before:2026-10-28` out of the text; explicit params win. */
export function parseQuery(params: SearchParams): Required<Pick<SearchParams, "q">> & Omit<SearchParams, "q"> {
  const out: SearchParams = { ...params, q: "" };
  const words: string[] = [];
  for (const token of params.q.match(/"[^"]*"|\S+/g) ?? []) {
    const match = /^(from|in|after|before):(.+)$/.exec(token);
    if (match) {
      const key = match[1] as "from" | "in" | "after" | "before";
      out[key] ??= match[2]!.replace(/^"|"$/g, "");
    } else words.push(token);
  }
  out.q = words.join(" ");
  return out as Required<Pick<SearchParams, "q">> & Omit<SearchParams, "q">;
}

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

/** Another box whose threads search reads through its agent relay (`MultiHost`). */
export interface SearchBox { box: string; link(): LinkState; search(query: SearchQuery): Promise<SearchPage> }

const clock = (at: number): string => new Date(at).toISOString().slice(11, 16) + "Z";

/** Why a box's threads are not in the results. */
function missingNote(box: string, error: unknown): string {
  if (isHostAway(error)) return `${box} is offline since ${clock(error.since)}, so its threads are not in these results.`;
  return `${box} did not answer the search (${error instanceof Error ? error.message : String(error)}), so its threads are not in these results.`;
}

/** One ranked list of rows, this box's documents or one other box's page, merged by rank or by time. */
type Row = { at: number; tier: number; build: () => SearchHit | undefined };

export class Search {
  /** The test sends: `from:owner` leaves them out, and their hits name the job as the author. Set by the app once it has the rooms. */
  testSends: () => TestSendEntry[] = () => [];
  /** Every agent's comm threads and every thread of a walk's test agent, whose entries search leaves out. */
  commThreads: () => string[] = () => [];
  /** The rooms of a walk's test agents and test channels, whose posts an unscoped search leaves out. */
  testRooms: () => string[] = () => [];
  /** The other boxes agents run on. Set by the app when it runs over several boxes. */
  boxes: () => SearchBox[] = () => [];

  constructor(readonly threads: Threads, readonly groups: GroupRooms, readonly engine: SearchEngine, private readonly posts: (room: string) => readonly RoomPost[]) {}

  /**
   * Each other box's page through its relay, with its comm threads' own count asked at the same time and taken off. A box that is away or
   * fails gives no hits and a `missing` note instead.
   */
  private async boxSearch(box: SearchBox, query: SearchQuery, comms: string[]): Promise<{ ok: true; page: SearchPage } | { ok: false; error: unknown }> {
    try {
      if (box.link().state !== "up") throw new HostAway(box.box, box.link().since);
      const [skipped, page] = await Promise.all([
        comms.length ? box.search({ ...query, threads: comms, limit: 0 }).then(p => p.total) : Promise.resolve(0),
        box.search(query),
      ]);
      const commSet = new Set(comms);
      return { ok: true, page: { hits: page.hits.filter(hit => !commSet.has(hit.thread)), total: page.total - skipped } };
    } catch (error) {
      return { ok: false, error };
    }
  }

  async run(params: SearchParams): Promise<SearchResult> {
    const query = parseQuery(params);
    const words = terms(query.q);
    if (!words.length) return { hits: [], total: 0 };
    const marks = searchTerms(query.q);
    const after = query.after ? dayStart(query.after) : undefined;
    const before = query.before ? dayStart(query.before) : undefined;
    const sort = query.sort ?? "relevance";
    const offset = Number(query.cursor ?? 0) || 0;
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const range: Cond[] = [...(after === undefined ? [] : [{ op: "gte", field: "at", value: after } as Cond]), ...(before === undefined ? [] : [{ op: "lt", field: "at", value: before } as Cond])];
    const parts: Cond[] = [];

    const inId = query.in;
    const inChannel = inId ? this.groups.row(inId) : undefined;
    const inRoom = inId && (isRoomId(inId) || isAgentId(inId)) ? this.threads.agentRecords?.record(inId) : undefined;
    const agents = query.from === "agents";
    const tests = this.testSends();
    const testOf = new Map(tests.map(t => [`${t.thread}:${t.entry}`, t]));
    const scope = !inChannel && inId ? parseConversationId(this.threads.conversationOf(inId)) : undefined;
    const comms = scope ? [] : this.commThreads();
    const testRooms = this.testRooms();
    let boxQuery: SearchQuery | undefined;
    if (!inChannel) {
      const fromAgent = query.from && query.from !== "owner" && !agents ? parseConversationId(this.threads.conversationOf(query.from)) : undefined;
      parts.push(and(
        eq("source", "entry"), eq("channelCopy", false), ...range,
        ...(query.type === "tools" ? [isIn("kind", TOOL_KINDS)] : query.type === "messages" ? [not(isIn("kind", TOOL_KINDS))] : []),
        ...(scope ? [eq("convs", `${scope.thread}:${scope.conversation}`)] : comms.length ? [not(isIn("threads", comms))] : []),
        ...(query.from === "owner" ? [eq("author", "owner"), ...(tests.length ? [not(isIn("keys", tests.map(t => `${t.thread}:${t.entry}`)))] : [])] : agents ? [not(eq("author", "owner"))] : []),
        ...(fromAgent ? [or(and(eq("kind", "agent.message"), eq("author", query.from!)),
          and(not(eq("kind", "agent.message")), not(eq("author", "owner")), eq("convs", `${fromAgent.thread}:${fromAgent.conversation}`)))] : []),
      ));
      boxQuery = {
        q: query.q, sort, skipAgentMessages: CHANNEL_COPY_LIKE, withText: true, limit: offset + limit,
        ...(sort === "relevance" ? { demoteKinds: TOOL_KINDS } : {}),
        ...(query.type === "tools" ? { kinds: TOOL_KINDS } : query.type === "messages" ? { skipKinds: TOOL_KINDS } : {}),
        ...(scope ? { threads: [scope.thread], conversation: scope.conversation } : {}),
        ...(query.from === "owner" ? { from: "owner", ...(tests.length ? { skipEntries: tests.map(({ thread, entry }) => ({ thread, entry })) } : {}) } : agents ? { notFrom: "owner" } : {}),
        ...(fromAgent ? { by: { thread: fromAgent.thread, conversation: fromAgent.conversation, id: query.from! } } : {}),
        ...(after === undefined ? {} : { after }), ...(before === undefined ? {} : { before }),
      };
    }
    if ((!inId || inChannel) && query.type !== "tools") {
      const fromId = query.from && query.from !== "owner" && !agents ? this.threads.registered(query.from)?.id ?? query.from : query.from;
      parts.push(and(
        eq("source", "post"), eq("dm", false), ...range,
        inChannel ? eq("room", inChannel.id) : not(isIn("room", testRooms)),
        ...(agents ? [not(eq("author", "owner"))] : fromId ? [eq("author", fromId)] : []),
      ));
    }
    if ((!inId || inRoom) && query.type !== "tools") {
      const fromRecord = query.from && query.from !== "owner" && !agents ? this.threads.agentRecords?.record(query.from) : undefined;
      parts.push(and(
        eq("source", "post"), eq("dm", true), eq("listed", true), ...range,
        inRoom ? eq("room", inRoom.room) : not(isIn("room", testRooms)),
        ...(query.from === "owner" ? [eq("ownerPost", true)] : agents ? [eq("ownerPost", false)]
          : query.from ? [isIn("author", [query.from, ...(fromRecord ? [fromRecord.id] : [])])] : []),
      ));
    }

    const others = boxQuery && !query.local ? this.boxes() : [];
    const [mine, ...answers] = await Promise.all([
      parts.length ? this.engine.search(query.q, or(...parts), { sort, limit: offset + limit }) : Promise.resolve({ docs: [], total: 0 }),
      ...others.map(box => this.boxSearch(box, boxQuery!, comms)),
    ]);
    const summaries = new Map(this.threads.conversations().map(c => [c.id, c]));
    const lists: Row[][] = [mine.docs.map(doc => ({ at: doc.at, tier: sort === "relevance" ? doc.tier : 0, build: () => this.docHit(doc, scope?.thread, summaries, marks, testOf) }))];
    let total = mine.total;
    const missing: SearchMissing[] = [];
    answers.forEach((answer, i) => {
      if (!answer.ok) {
        missing.push({ box: others[i]!.box, note: missingNote(others[i]!.box, answer.error) });
        return;
      }
      total += answer.page.total;
      lists.push(answer.page.hits.map(hit => ({
        at: hit.at, tier: sort === "relevance" && TOOL_KINDS.includes(hit.kind) ? 1 : 0,
        build: () => this.threadHit(hit, summaries.get(conversationIdOf(hit.thread, hit.conversation)), marks, hit.kind === "pi.user" ? testOf.get(`${hit.thread}:${hit.entryId}`) : undefined),
      })));
    });
    const pending = boxQuery && query.local ? this.boxes().filter(box => box.link().state === "up").map(box => box.box) : [];
    for (const box of boxQuery && query.local ? this.boxes() : []) if (box.link().state !== "up") missing.push({ box: box.box, note: missingNote(box.box, new HostAway(box.box, box.link().since)) });

    let merged: Row[];
    if (sort === "recent") merged = lists.flat().sort((a, b) => b.at - a.at);
    else {
      merged = [];
      // By relevance the lists interleave by their rank, since the scores of two engines do not compare.
      for (let rank = 0; lists.some(list => rank < list.length); rank++) for (const list of lists) if (rank < list.length) merged.push(list[rank]!);
      merged.sort((a, b) => a.tier - b.tier);
    }
    let hits = merged.slice(offset, offset + limit).flatMap(row => row.build() ?? []);
    // An answer whose match sits only in a tool call's arguments is found by its text, so it sinks below the messages of its own page.
    if (sort === "relevance") hits = [...hits.filter(hit => hit.role !== "tool"), ...hits.filter(hit => hit.role === "tool")];
    return {
      hits, total, ...(offset + limit < total ? { nextCursor: String(offset + limit) } : {}), ...(missing.length ? { missing } : {}), ...(pending.length ? { pending } : {}),
    };
  }

  /** A document's hit: an entry opens in the scope's thread or the unarchived, newest thread that holds it, a post in its room. */
  private docHit(doc: SearchDoc, scopeThread: string | undefined, summaries: Map<string, ConversationSummary>, marks: string[], testOf: Map<string, TestSendEntry>): SearchHit | undefined {
    if (doc.source === "post") return this.postHit(doc, marks);
    const thread = scopeThread ?? this.copyThread(doc);
    const conversation = Number(doc.convs.find(c => c.startsWith(`${thread}:`))?.slice(thread.length + 1) ?? 1);
    const hit: HostHit = { thread, conversation, entryId: doc.entry, kind: doc.kind, author: doc.author, at: doc.at, snippet: "", text: doc.text };
    const test = doc.kind === "pi.user" ? doc.keys.map(key => testOf.get(key)).find(Boolean) : undefined;
    return this.threadHit(hit, summaries.get(conversationIdOf(thread, conversation)), marks, test);
  }

  /** Copies of one entry show from the unarchived, most recently updated thread (pi-host's rule in index-db.ts `searchIndex`). */
  private copyThread(doc: EntryDoc): string {
    const rank = (id: string) => {
      const t = this.threads.thread(id);
      return { archived: t?.archived ? 1 : 0, updated: t?.updatedAt ?? 0 };
    };
    return [...doc.threads].sort((a, b) => rank(a).archived - rank(b).archived || rank(b).updated - rank(a).updated)[0]!;
  }

  private postHit(doc: PostDoc, marks: string[]): SearchHit | undefined {
    const post = this.posts(doc.room).find(p => p.id === doc.post);
    if (!post) return undefined;
    if (doc.dm) {
      const agent = this.threads.agentRecords?.record(doc.room);
      return agent ? this.dmHit(doc.room, agent, post, marks) : undefined;
    }
    const row = this.groups.row(doc.room);
    if (!row) return undefined;
    const author = this.threads.principal(post.author);
    const long = fullText(post.text, marks);
    return {
      id: `${row.id}/${post.id}`, conversation: { id: row.id, kind: row.kind, name: row.name, ...(row.archived ? { archived: true } : {}) }, messageId: post.id,
      author: { id: author.id, name: author.name, kind: author.kind === "owner" ? "owner" : "agent" }, at: post.at, kind: "post",
      role: author.kind === "owner" ? "owner" : "agent", ...(post.threadRoot ? { threadRoot: post.threadRoot } : {}),
      snippet: snippet(post.text, marks) || long, ...(post.text.length > 240 ? { text: long } : {}), ...this.reactionsOf(post),
    };
  }

  /** A thread hit opens at its entry: the timeline's `around=e<id>` answers with the item that holds it as `focus`. */
  private threadHit(hit: HostHit, summary: ConversationSummary | undefined, marks: string[], test?: TestSendEntry): SearchHit {
    const conversationId = conversationIdOf(hit.thread, hit.conversation);
    const kind: ConversationKind = summary?.kind ?? (hit.conversation === 1 ? "solo" : "job");
    const said = hit.text === undefined ? undefined : describe(hit.kind, hit.author, hit.text, marks);
    const role = test ? "agent" : said?.role ?? (hit.kind === "pi.tool-result" ? "tool" : hit.author === "owner" ? "owner" : "agent");
    const shown = said ? snippet(said.text, marks) : "";
    const long = said ? fullText(said.text, marks) : "";
    const parentId = summary?.parent ?? (kind === "solo" ? undefined : this.threads.principal(conversationId).parent);
    return {
      id: `${conversationId}/e${hit.entryId}`,
      conversation: {
        id: conversationId, kind, name: summary?.name ?? this.threads.thread(hit.thread)?.name ?? hit.thread,
        ...(parentId && parentId !== conversationId ? { parent: { id: parentId, name: this.threads.principal(parentId).name } } : {}),
        ...(summary?.archived || this.threads.thread(hit.thread)?.archived ? { archived: true } : {}),
      },
      messageId: `e${hit.entryId}`, author: test ? this.testAuthor(test) : this.authorOf(hit, said), at: hit.at, ...(test ? { testSend: { reason: test.reason } } : {}),
      kind: hit.kind === "pi.assistant" ? "turn" : hit.kind === "pi.tool-result" ? "tool" : "message", role,
      ...(said?.tool ? { tool: said.tool } : hit.kind === "pi.tool-result" ? { tool: hit.author.replace(/^tool:/, "") } : {}),
      ...(said?.inCall ? { inCall: true } : {}),
      snippet: shown || safeSnippet(hit.snippet), ...(said && said.text.length > 240 ? { text: long } : {}),
    };
  }

  /** A DM post hit opens the DM at the post; a job's test send names the job as its author. */
  private dmHit(room: string, agent: AgentRecord, post: RoomPost, marks: string[]): SearchHit {
    const author = post.testSend ? this.threads.principal(post.testSend.by) : this.threads.principal(post.author);
    const owner = author.kind === "owner";
    const long = fullText(post.text, marks);
    const name = this.threads.agent(agent.id)?.name ?? agent.name;
    return {
      id: `${room}/${post.id}`, conversation: { id: room, kind: "dm", name, ...(agent.archived ? { archived: true } : {}) }, messageId: post.id,
      author: { id: author.id, name: author.name, kind: owner ? "owner" : "agent" }, at: post.at, kind: "post", role: owner ? "owner" : "agent",
      ...(post.testSend ? { testSend: { reason: post.testSend.reason } } : {}),
      snippet: snippet(post.text, marks) || long, ...(post.text.length > 240 ? { text: long } : {}), ...this.reactionsOf(post),
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
