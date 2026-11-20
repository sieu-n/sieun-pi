/**
 * `search_messages`: an agent's search of sw factory, the same search the owner's Cmd K runs, through apps/chat's `GET /api/search`
 * (apps/chat/server/search.ts). It finds room, Solo and DM posts, the replies in their threads, and what agents did inside their work
 * threads and jobs, with the owner's filters and their meaning: `from` (who wrote it), `in` (which room), `where` (a top-level post, a thread
 * reply, or inside a tool call or job), `after` and `before` (owner p115, msg mwomrz5y; contract: ~/work/search-filters/contract.md).
 *
 * Each hit prints as one line that says where it sits, who wrote it, its words and the id other room tools take, with the link that opens it.
 * The room-tools extension lists it beside `set_emoji` (`room-tools.ts`). Searching only reads, so a rerun after a crash is safe.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { SearchHit, SearchMissing } from "../../../../apps/chat/web/src/lib/api/types.ts";
import type { ChatApp } from "./chat-app.ts";

export const SEARCH_MESSAGES_TOOL = "search_messages";

export const SEARCH_MESSAGES_DESCRIPTION =
  "Search sw factory the way the owner's Cmd K search does: posts in channels, Solo rooms and DMs, the replies in their threads, and what " +
  "agents did inside their work threads and jobs, such as a command, its output or a job's message. The total is the exact count for the " +
  "filters. Narrow with the filters when you know something about what you want: from when you know who wrote it, in when you know the room, " +
  "where when you know if it was a top-level post, a reply in a thread or something done inside a tool call or job, and after or before for " +
  "dates. Each hit says where it sits, such as reply in thread p85 or tool call bash in job <name>, and ends with its id and link; a post's " +
  "id works in set_emoji, edit_message and save_message. For a Prime chat on :5182, thinking, or the messages around a hit, use search_history.";

const WHERE = ["root", "thread", "tool"] as const;
export type SearchWhere = typeof WHERE[number];

export interface SearchMessagesArgs {
  query: string; from?: string[] | string; in?: string; where?: SearchWhere[] | SearchWhere; after?: string; before?: string;
  sort?: "relevance" | "recent"; limit?: number; cursor?: string;
}

/** A hit with the fields the p115 filters added: where it sits, a reply's thread, and the web route that opens it. */
export type FilteredHit = SearchHit & { where?: SearchWhere; thread?: { root: string; title: string }; link?: string };
export interface FilteredResult { hits: FilteredHit[]; total: number; nextCursor?: string; missing?: SearchMissing[] }

/** The query string of `GET /api/search` for the tool's args; list params go as comma lists. */
export function searchQuery(args: SearchMessagesArgs): URLSearchParams {
  const params = new URLSearchParams({ q: args.query, brief: "1" });
  const list = (value: string[] | string | undefined) => (Array.isArray(value) ? value : value ? value.split(",") : []).map(v => v.trim()).filter(Boolean);
  const from = list(args.from);
  const where = list(args.where);
  if (from.length) params.set("from", from.join(","));
  if (where.length) params.set("where", where.join(","));
  for (const key of ["in", "after", "before", "sort", "cursor"] as const) if (args[key]) params.set(key, String(args[key]));
  if (args.limit) params.set("limit", String(args.limit));
  return params;
}

const plain = (html: string): string => html.replace(/<\/?mark>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
  .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code))).replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const stamp = (at: number): string => new Date(at).toISOString().slice(0, 16).replace("T", " ") + "Z";

/** Where a hit sits, in the words of the Cmd K rows: the room, a reply's thread, or the tool call and job that hold it. */
function placeOf(hit: FilteredHit): string {
  const c = hit.conversation;
  const room = c.kind === "channel" ? `#${c.name.replace(/^#/, "")}` : c.kind === "dm" ? `DM with ${c.name}` : c.kind === "job" ? `job "${c.name}"${c.parent ? ` of ${c.parent.name}` : ""}` : `"${c.name}"`;
  const where = hit.where ?? (hit.kind === "tool" || hit.role === "tool" ? "tool" : hit.threadRoot ? "thread" : "root");
  const archived = c.archived ? " (archived)" : "";
  if (where === "thread") return `${room}${archived}, reply in thread ${hit.thread?.root ?? hit.threadRoot}${hit.thread?.title ? ` "${hit.thread.title}"` : ""}`;
  if (where === "tool") return `${room}${archived}, ${hit.tool ? `tool ${hit.inCall ? "call" : "output"} ${hit.tool}` : "inside the work"}`;
  return `${room}${archived}, top-level`;
}

/** One hit as one line: when, where it sits, who, the plain snippet, then the id and link. */
export function searchHitLine(hit: FilteredHit): string {
  return `- ${stamp(hit.at)} ${placeOf(hit)} · ${hit.author.name}: ${plain(hit.snippet)} · id ${hit.conversation.id}/${hit.messageId}${hit.link ? ` · ${hit.link}` : ""}`;
}

export function searchResultText(result: FilteredResult, args: SearchMessagesArgs): string {
  const notes = (result.missing ?? []).map(m => m.note);
  const head = `${result.hits.length} of ${result.total} hits${args.sort === "recent" ? ", newest first" : ""}.`;
  const more = result.nextCursor ? [`More: pass cursor=${result.nextCursor}.`] : [];
  if (!result.hits.length) return [head + " Try fewer words or drop a filter.", ...notes].join("\n");
  return [head, ...result.hits.map(searchHitLine), ...more, ...notes].join("\n");
}

const text = (value: string) => [{ type: "text" as const, text: value }];
const strings = (description: string) => Type.Union([Type.Array(Type.String()), Type.String()], { description });

/** The search_messages tool of one thread. */
export function searchTools(app: ChatApp) {
  return [defineTool({
    name: SEARCH_MESSAGES_TOOL,
    description: SEARCH_MESSAGES_DESCRIPTION,
    parameters: Type.Object({
      query: Type.String({ description: "Words to find; \"exact phrase\" keeps words together." }),
      from: Type.Optional(strings("Who wrote it: owner, agents for any agent, or an agent's name or id such as vent. Use it when you know who " +
        "said or did it. Several values match any of them.")),
      in: Type.Optional(Type.String({ description: "Which room: a channel name such as #sw-factory-build, a Solo room's name, an agent's name for " +
        "its DM, or a room or job id. Use it when you know where it was said." })),
      where: Type.Optional(Type.Union([Type.Array(Type.Union(WHERE.map(w => Type.Literal(w)))), Type.Union(WHERE.map(w => Type.Literal(w)))], {
        description: "root is a top-level post in a room or DM; thread is a reply inside a post's thread; tool is inside an agent's work, " +
          "a tool call, its output or a job's message, which never shows as a post. Use thread for an answer given as a reply, and tool " +
          "for a command, a file, an error or a number an agent found while working. Several values match any of them; none searches all three.",
      })),
      after: Type.Optional(Type.String({ description: "YYYY-MM-DD in KST, that day included: only what came then or later." })),
      before: Type.Optional(Type.String({ description: "YYYY-MM-DD in KST, that day left out: only what came earlier." })),
      sort: Type.Optional(Type.Union([Type.Literal("relevance"), Type.Literal("recent")], { description: "relevance by default; recent puts the newest first." })),
      limit: Type.Optional(Type.Number({ description: "Hits to return, 20 by default, 100 at most." })),
      cursor: Type.Optional(Type.String({ description: "The cursor a result's More line gives, for the next page." })),
    }),
    replay: "safe",
    execute: async (args, _api, context) => {
      try {
        return { output: text(searchResultText(await app.search(searchQuery(args), context.abortSignal), args)) };
      } catch (error) {
        if (context.abortSignal?.aborted) throw error;
        return { output: text(`search_messages failed: ${error instanceof Error ? error.message : String(error)}`), isError: true };
      }
    },
  })];
}
