/**
 * Full-text search over every thread's entries (pi-host's FTS5 index through `durable_search`) and every channel post, with the filters
 * from:, in:, after: and before: (~/work/slack-layer-design/search.md section 5). `total` is the exact count for the same filters (c191).
 */
import type { ConversationKind, ConversationSummary, SearchHit, SearchResult } from "../web/src/lib/api/types.ts";
import type { Channels } from "./channels.ts";
import type { Host, SearchHit as HostHit } from "./host/types.ts";
import { conversationIdOf, parseConversationId, type Threads } from "./threads.ts";

/** The owner reads dates in KST. */
export const OWNER_ZONE_OFFSET_MS = 9 * 3600_000;

export interface SearchParams { q: string; from?: string; in?: string; after?: string; before?: string; sort?: "relevance" | "recent"; limit?: number; cursor?: string }

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

const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** pi-host's snippet is raw text with <mark> tags; escape everything else. */
export function safeSnippet(raw: string): string {
  return raw.split(/(<mark>|<\/mark>)/).map(part => (part === "<mark>" || part === "</mark>" ? part : escapeHtml(part))).join("");
}

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

function postSnippet(text: string, words: string[]): string {
  const lower = text.toLowerCase();
  const first = Math.min(...words.map(w => lower.indexOf(w)).filter(i => i >= 0));
  const start = Math.max(0, first - 60);
  const slice = text.slice(start, start + 220);
  const re = new RegExp(`(${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "giu");
  return (start > 0 ? "…" : "") + slice.split(re).map((part, i) => (i % 2 === 1 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part))).join("") + (start + 220 < text.length ? "…" : "");
}

/** A thread hit or a channel post, ranked before its hit is built; only the page's rows become hits. */
type Ranked = { score: number; at: number; build: () => SearchHit };

export class Search {
  constructor(readonly host: Host, readonly threads: Threads, readonly channels: Channels) {}

  async run(params: SearchParams): Promise<SearchResult> {
    const query = parseQuery(params);
    const words = terms(query.q);
    if (!words.length) return { hits: [], total: 0 };
    const after = query.after ? dayStart(query.after) : undefined;
    const before = query.before ? dayStart(query.before) : undefined;
    const sort = query.sort ?? "relevance";
    const offset = Number(query.cursor ?? 0) || 0;
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const ranked: Ranked[] = [];
    let total = 0;

    const inId = query.in;
    const inChannel = inId ? this.channels.row(inId) : undefined;
    if (!inChannel) {
      const scope = inId ? parseConversationId(inId) : undefined;
      const fromAgent = query.from && query.from !== "owner" ? parseConversationId(query.from) : undefined;
      // The merged page holds at most offset + limit thread hits, so the host builds snippets for those rows only.
      const page = await this.host.search({
        q: query.q, sort, limit: offset + limit,
        ...(scope ? { threads: [scope.thread], conversation: scope.conversation } : {}),
        ...(query.from === "owner" ? { from: "owner" } : {}),
        ...(fromAgent ? { by: { thread: fromAgent.thread, conversation: fromAgent.conversation, id: query.from! } } : {}),
        ...(after === undefined ? {} : { after }), ...(before === undefined ? {} : { before }),
      });
      total += page.total;
      const summaries = new Map(this.threads.conversations().map(c => [c.id, c]));
      page.hits.forEach((hit, rank) => ranked.push({ score: page.total - rank, at: hit.at, build: () => this.threadHit(hit, summaries.get(conversationIdOf(hit.thread, hit.conversation))) }));
    }
    if (!inId || inChannel) {
      for (const { row, post } of this.channels.allPosts()) {
        if (inChannel && row.id !== inChannel.id) continue;
        if (query.from && post.author !== query.from) continue;
        if (after !== undefined && post.at < after) continue;
        if (before !== undefined && post.at >= before) continue;
        const score = postMatch(post.text, words);
        if (!score) continue;
        total += 1;
        ranked.push({
          score, at: post.at,
          build: () => {
            const author = this.threads.principal(post.author);
            return {
              id: `${row.id}/${post.id}`, conversation: { id: row.id, kind: "channel", name: row.name }, messageId: post.id,
              author: { id: author.id, name: author.name, kind: author.kind === "owner" ? "owner" : "agent" }, at: post.at, kind: "post", snippet: postSnippet(post.text, words),
            };
          },
        });
      }
    }
    if (sort === "recent") ranked.sort((a, b) => b.at - a.at);
    else ranked.sort((a, b) => b.score - a.score || b.at - a.at);
    const hits = ranked.slice(offset, offset + limit).map(row => row.build());
    return { hits, total, ...(offset + limit < total ? { nextCursor: String(offset + limit) } : {}) };
  }

  /** A thread hit opens at its entry: the timeline's `around=e<id>` answers with the item that holds it as `focus`. */
  private threadHit(hit: HostHit, summary: ConversationSummary | undefined): SearchHit {
    const conversationId = conversationIdOf(hit.thread, hit.conversation);
    const kind: ConversationKind = summary?.kind ?? (hit.conversation === 1 ? "solo" : "job");
    return {
      id: `${conversationId}/e${hit.entryId}`, conversation: { id: conversationId, kind, name: summary?.name ?? this.threads.thread(hit.thread)?.name ?? hit.thread },
      messageId: `e${hit.entryId}`, author: this.authorOf(hit), at: hit.at,
      kind: hit.kind === "pi.assistant" ? "turn" : hit.kind === "pi.tool-result" ? "tool" : "message", snippet: safeSnippet(hit.snippet),
    };
  }

  private authorOf(hit: HostHit): SearchHit["author"] {
    if (hit.author === "owner") return { id: "owner", name: "You", kind: "owner" };
    if (hit.kind === "agent.message") {
      const p = this.threads.principal(hit.author);
      return { id: p.id, name: p.name, kind: p.kind === "owner" ? "owner" : "agent" };
    }
    const p = this.threads.principal(conversationIdOf(hit.thread, hit.conversation));
    return { id: p.id, name: p.name, kind: "agent" };
  }
}
