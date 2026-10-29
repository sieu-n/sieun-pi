/**
 * Full-text search over every thread's entries (pi-host's FTS5 index through `durable_search`) and every room post, with the filters
 * from:, in:, after: and before: (~/work/slack-layer-design/search.md section 5). `total` is the exact count for the same filters (c191).
 *
 * A comm thread (phase 4) has no rows of its own: its entries are left out, and the DM posts whose words it holds are searched as the DM's
 * posts instead, so a hit opens the DM at the post. Channel and Solo room posts are searched as posts of their room (phase 5).
 */
import type { ConversationKind, ConversationSummary, SearchHit, SearchResult } from "../web/src/lib/api/types.ts";
import { CHANNEL_COPY_LIKE, type GroupRooms } from "./group-rooms.ts";
import { describe, fullText, searchTerms, snippet } from "./search-snippet.ts";
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { openIndexReadOnly, searchIndex } from "../../../packages/pi-host/src/durable/index-db.ts";
import { safeSnippet } from "./search-snippet.ts";
import type { Host, SearchHit as HostHit, SearchPage, SearchQuery } from "./host/types.ts";
import { conversationIdOf, parseConversationId, type Threads } from "./threads.ts";
import type { AgentRecord, RoomPost } from "./agent-store.ts";
import { isAgentId, isRoomId } from "./agents.ts";

/** The owner reads dates in KST. */
export const OWNER_ZONE_OFFSET_MS = 9 * 3600_000;

/** `from` is `owner`, `agents` or one agent id, and `type` keeps messages only or tool output only. */
export interface SearchParams {
  q: string; from?: string; in?: string; after?: string; before?: string; sort?: "relevance" | "recent"; type?: "messages" | "tools"; limit?: number; cursor?: string;
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

/** A post matches when it holds every term as a word prefix, the way the FTS side reads a bare word. */
function postMatch(text: string, words: string[]): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const word of words) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gu");
    const count = lower.match(re)?.length ?? 0;
    if (!count) return 0;
    score += count;
  }
  return score;
}

/**
 * Reciprocal rank fusion (Cormack, Clarke and Buettcher, SIGIR 2009, with their k = 60): the thread hits in pi-host's bm25 order and the posts
 * in match-count order merge by their rank in each list, so the best post sits beside the best thread hit.
 */
const fused = (rank: number): number => 1 / (60 + rank);

/** A thread hit or a channel post, ranked before its hit is built; only the page's rows become hits. Tier 1 (tool output) ranks after tier 0. */
type Ranked = { tier: number; score: number; at: number; build: () => SearchHit };

/** A work-thread input that was a job's test send typed into the owner's DM (rooms.ts `allTestSends`). */
export interface TestSendEntry { thread: string; entry: number; by: string; reason: string }

/** A DM post search reads as a post (rooms.ts `searchPosts`). */
export interface DmPost { room: string; agent: AgentRecord; post: RoomPost }

export class Search {
  private index?: DatabaseSync;
  /** The test sends: `from:owner` leaves them out, and their hits name the job as the author. Set by the app once it has the rooms. */
  testSends: () => TestSendEntry[] = () => [];
  /** Every agent's comm threads, whose entries search leaves out. */
  commThreads: () => string[] = () => [];
  /** The DM posts whose words live in a comm thread. */
  dmPosts: () => DmPost[] = () => [];

  /** With `indexPath`, thread hits come from pi-host's index.sqlite on a read-only connection, so search never waits on pi-host. */
  constructor(readonly host: Host, readonly threads: Threads, readonly groups: GroupRooms, private readonly indexPath?: string) {}

  close(): void {
    this.index?.close();
    this.index = undefined;
  }

  /**
   * pi-host's search rules on the chat's own read-only connection: after a restart on 10-28, pi-host took 7 to 12 s to listen, and every
   * search waited for it. pi-host's socket answers only while the file is missing or unreadable.
   */
  private threadSearch(query: SearchQuery): Promise<SearchPage> {
    if (!this.index && this.indexPath && existsSync(this.indexPath)) {
      try {
        this.index = openIndexReadOnly(this.indexPath);
      } catch {
        this.index = undefined;
      }
    }
    if (this.index) {
      try {
        return Promise.resolve(searchIndex(this.index, query));
      } catch {
        this.close();
      }
    }
    return this.host.search(query);
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
    const ranked: Ranked[] = [];
    let total = 0;

    const inId = query.in;
    const inChannel = inId ? this.groups.row(inId) : undefined;
    const inRoom = inId && (isRoomId(inId) || isAgentId(inId)) ? this.threads.agentRecords?.record(inId) : undefined;
    const agents = query.from === "agents";
    if (!inChannel) {
      const tests = this.testSends();
      const testOf = new Map(tests.map(t => [`${t.thread}:${t.entry}`, t]));
      const scope = inId ? parseConversationId(this.threads.conversationOf(inId)) : undefined;
      const fromAgent = query.from && query.from !== "owner" && !agents ? parseConversationId(this.threads.conversationOf(query.from)) : undefined;
      const filters: Omit<SearchQuery, "limit" | "withText"> = {
        q: query.q, sort, skipAgentMessages: CHANNEL_COPY_LIKE,
        ...(sort === "relevance" ? { demoteKinds: TOOL_KINDS } : {}),
        ...(query.type === "tools" ? { kinds: TOOL_KINDS } : query.type === "messages" ? { skipKinds: TOOL_KINDS } : {}),
        ...(scope ? { threads: [scope.thread], conversation: scope.conversation } : {}),
        ...(query.from === "owner" ? { from: "owner", ...(tests.length ? { skipEntries: tests.map(({ thread, entry }) => ({ thread, entry })) } : {}) } : agents ? { notFrom: "owner" } : {}),
        ...(fromAgent ? { by: { thread: fromAgent.thread, conversation: fromAgent.conversation, id: query.from! } } : {}),
        ...(after === undefined ? {} : { after }), ...(before === undefined ? {} : { before }),
      };
      // Comm threads drop out of an unscoped search: their own count comes off the total, and the page reads that many more rows.
      const comms = scope ? [] : this.commThreads();
      const skipped = comms.length ? (await this.threadSearch({ ...filters, threads: comms, limit: 0 })).total : 0;
      const commSet = new Set(comms);
      // The merged page holds at most offset + limit thread hits, so the host builds snippets for those rows only.
      const page = await this.threadSearch({ ...filters, limit: offset + limit + skipped, withText: true });
      total += page.total - skipped;
      const summaries = new Map(this.threads.conversations().map(c => [c.id, c]));
      page.hits.filter(hit => !commSet.has(hit.thread)).slice(0, offset + limit).forEach((hit, rank) => ranked.push({
        tier: sort === "relevance" && TOOL_KINDS.includes(hit.kind) ? 1 : 0, score: fused(rank), at: hit.at,
        build: () => this.threadHit(hit, summaries.get(conversationIdOf(hit.thread, hit.conversation)), marks, hit.kind === "pi.user" ? testOf.get(`${hit.thread}:${hit.entryId}`) : undefined),
      }));
    }
    if ((!inId || inChannel) && query.type !== "tools") {
      const posts: Ranked[] = [];
      const fromId = query.from && query.from !== "owner" && !agents ? this.threads.registered(query.from)?.id ?? query.from : query.from;
      for (const { row, post } of this.groups.allPosts()) {
        if (inChannel && row.id !== inChannel.id) continue;
        if (agents ? post.author === "owner" : fromId && post.author !== fromId) continue;
        if (after !== undefined && post.at < after) continue;
        if (before !== undefined && post.at >= before) continue;
        const score = postMatch(post.text, words);
        if (!score) continue;
        total += 1;
        posts.push({
          tier: 0, score, at: post.at,
          build: () => {
            const author = this.threads.principal(post.author);
            const long = fullText(post.text, marks);
            return {
              id: `${row.id}/${post.id}`, conversation: { id: row.id, kind: row.kind, name: row.name, ...(row.archived ? { archived: true } : {}) }, messageId: post.id,
              author: { id: author.id, name: author.name, kind: author.kind === "owner" ? "owner" : "agent" }, at: post.at, kind: "post",
              role: author.kind === "owner" ? "owner" : "agent", ...(post.threadRoot ? { threadRoot: post.threadRoot } : {}),
              snippet: snippet(post.text, marks) || long, ...(post.text.length > 240 ? { text: long } : {}),
            };
          },
        });
      }
      posts.sort((a, b) => b.score - a.score || b.at - a.at).forEach((post, rank) => ranked.push({ ...post, score: fused(rank) }));
    }
    if ((!inId || inRoom) && query.type !== "tools") {
      const posts: Ranked[] = [];
      const fromRecord = query.from && query.from !== "owner" && !agents ? this.threads.agentRecords?.record(query.from) : undefined;
      for (const { room, agent, post } of this.dmPosts()) {
        if (inRoom && agent.id !== inRoom.id) continue;
        const byOwner = post.author === "owner" && !post.testSend;
        if (query.from === "owner" ? !byOwner : agents ? byOwner : query.from && post.author !== query.from && post.author !== fromRecord?.id) continue;
        if (after !== undefined && post.at < after) continue;
        if (before !== undefined && post.at >= before) continue;
        const score = postMatch(post.text, words);
        if (!score) continue;
        total += 1;
        posts.push({ tier: 0, score, at: post.at, build: () => this.dmHit(room, agent, post, marks) });
      }
      posts.sort((a, b) => b.score - a.score || b.at - a.at).forEach((post, rank) => ranked.push({ ...post, score: fused(rank) }));
    }
    if (sort === "recent") ranked.sort((a, b) => b.at - a.at);
    else ranked.sort((a, b) => a.tier - b.tier || b.score - a.score || b.at - a.at);
    let hits = ranked.slice(offset, offset + limit).map(row => row.build());
    // An answer whose match sits only in a tool call's arguments is found by its text, so it sinks below the messages of its own page.
    if (sort === "relevance") hits = [...hits.filter(hit => hit.role !== "tool"), ...hits.filter(hit => hit.role === "tool")];
    return { hits, total, ...(offset + limit < total ? { nextCursor: String(offset + limit) } : {}) };
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
      snippet: snippet(post.text, marks) || long, ...(post.text.length > 240 ? { text: long } : {}),
    };
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
