/**
 * Full-text search over every thread's entries (pi-host's FTS5 index through `durable_search`) and every channel post, with the filters
 * from:, in:, after: and before: (~/work/slack-layer-design/search.md section 5). `total` is the exact count for the same filters (c191).
 */
import type { ConversationKind, SearchHit, SearchResult } from "../web/src/lib/api/types.ts";
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

type Scored = { hit: Omit<SearchHit, "messageId"> & { messageId?: string; entry?: { thread: string; conversation: number; entryId: number } }; score: number };

export class Search {
  constructor(readonly host: Host, readonly threads: Threads, readonly channels: Channels) {}

  async run(params: SearchParams): Promise<SearchResult> {
    const query = parseQuery(params);
    const words = terms(query.q);
    if (!words.length) return { hits: [], total: 0 };
    const after = query.after ? dayStart(query.after) : undefined;
    const before = query.before ? dayStart(query.before) : undefined;
    const sort = query.sort ?? "relevance";
    const scored: Scored[] = [];

    const inId = query.in;
    const inChannel = inId ? this.channels.row(inId) : undefined;
    if (!inChannel) {
      const scope = inId ? parseConversationId(inId) : undefined;
      const fromAgent = query.from && query.from !== "owner" ? parseConversationId(query.from) : undefined;
      const threads = scope ? [scope.thread] : fromAgent ? [fromAgent.thread] : undefined;
      const raw = await this.host.search({
        q: query.q, ...(threads ? { threads } : {}), ...(after === undefined ? {} : { after }), ...(before === undefined ? {} : { before }), sort, limit: 1_000_000,
      });
      raw.forEach((hit, rank) => {
        if (scope && hit.conversation !== scope.conversation) return;
        const author = this.authorOf(hit);
        if (query.from) {
          if (query.from === "owner" ? author.id !== "owner" : author.id !== query.from) return;
        }
        const conversationId = conversationIdOf(hit.thread, hit.conversation);
        const summary = this.threads.conversations().find(c => c.id === conversationId);
        const kind: ConversationKind = summary?.kind ?? (hit.conversation === 1 ? "solo" : "job");
        scored.push({
          score: raw.length - rank,
          hit: {
            id: `${conversationId}/e${hit.entryId}`, conversation: { id: conversationId, kind, name: summary?.name ?? this.threads.thread(hit.thread)?.name ?? hit.thread },
            author, at: hit.at, kind: hit.kind === "pi.assistant" ? "turn" : hit.kind === "pi.tool-result" ? "tool" : "message", snippet: safeSnippet(hit.snippet),
            entry: { thread: hit.thread, conversation: hit.conversation, entryId: hit.entryId },
          },
        });
      });
    }
    if (!inId || inChannel) {
      for (const { row, post } of this.channels.allPosts()) {
        if (inChannel && row.id !== inChannel.id) continue;
        if (query.from && post.author !== query.from) continue;
        if (after !== undefined && post.at < after) continue;
        if (before !== undefined && post.at >= before) continue;
        const score = postMatch(post.text, words);
        if (!score) continue;
        const author = this.threads.principal(post.author);
        scored.push({
          score,
          hit: {
            id: `${row.id}/${post.id}`, conversation: { id: row.id, kind: "channel", name: row.name }, messageId: post.id,
            author: { id: author.id, name: author.name, kind: author.kind === "owner" ? "owner" : "agent" }, at: post.at, kind: "post", snippet: postSnippet(post.text, words),
          },
        });
      }
    }
    if (sort === "recent") scored.sort((a, b) => b.hit.at - a.hit.at);
    else scored.sort((a, b) => b.score - a.score || b.hit.at - a.hit.at);
    const offset = Number(query.cursor ?? 0) || 0;
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const page = scored.slice(offset, offset + limit);
    const hits = await Promise.all(page.map(async ({ hit }) => {
      const { entry, ...rest } = hit;
      const messageId = entry ? await this.threads.itemIdOf(entry.thread, entry.conversation, entry.entryId).catch(() => `e${entry.entryId}`) : hit.messageId!;
      return { ...rest, messageId };
    }));
    return { hits, total: scored.length, ...(offset + limit < scored.length ? { nextCursor: String(offset + limit) } : {}) };
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
