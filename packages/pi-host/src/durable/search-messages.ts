/**
 * `search_messages`: an agent's search of sw factory, the same search the owner's Cmd K runs, through apps/chat's `GET /api/search`
 * (apps/chat/server/search.ts). It finds room, Solo and DM posts, the replies in their threads, and what agents did inside their work
 * threads and jobs, with the owner's filters and their meaning: `from` (who wrote it), `place` (the Cmd K pills: channels, DMs, Solo, threads,
 * jobs, tool calls; owner p125 and p126, contract ~/work/search-in-category/contract.md), `in` (which room), `after` and `before` (owner p115,
 * msg mwomrz5y).
 *
 * Each hit prints as one line that says where it sits, who wrote it, its words and the id other room tools take, with the link that opens it.
 * The room-tools extension lists it beside `set_emoji` (`room-tools.ts`). Searching only reads, so a rerun after a crash is safe.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { SearchHit, SearchResult } from "../../../../apps/chat/web/src/lib/api/types.ts";
import type { ChatApp } from "./chat-app.ts";

export const SEARCH_MESSAGES_TOOL = "search_messages";

export const SEARCH_MESSAGES_DESCRIPTION =
  "Search sw factory the way the owner's Cmd K search does: posts in channels, Solo rooms and DMs, the replies in their threads, and what " +
  "agents and their jobs said or did inside their work, such as a job's report, a command or its output. When the ask is about " +
  "something a job or an agent did, found or said while working and you don't know which job, search with place: [\"jobs\", \"tools\"]: " +
  "jobs holds what agents and jobs wrote, and tools holds commands and their output. Use place threads for an answer given as a reply, and " +
  "channels, dms or solo for a top-level post. Use in when you know the one room or job, from when you know who wrote it, and after or " +
  "before for dates. The total is the exact count for the filters. Each hit says where it sits, such as reply in thread p85 or tool output " +
  "bash in job <name>, and ends with its id and link; a post's id works in set_emoji, edit_message and save_message. To read more of a " +
  "hit, such as a tool's whole output, search again narrowly with full: true. For a Prime chat on :5182 or thinking, use search_history.";

/** The Cmd K place pills, in their row order; `GET /api/search` takes them as `place` (contract ~/work/search-in-category/contract.md). */
export const SEARCH_PLACES = ["channels", "dms", "solo", "threads", "jobs", "tools"] as const;
export type SearchPlace = typeof SEARCH_PLACES[number];

export interface SearchMessagesArgs {
  query: string; from?: string[] | string; place?: SearchPlace[] | string; in?: string; after?: string; before?: string;
  sort?: "relevance" | "recent"; limit?: number; cursor?: string; full?: boolean;
}

/** The query string of `GET /api/search` for the tool's args; list params go as comma lists. */
export function searchQuery(args: SearchMessagesArgs): URLSearchParams {
  const params = new URLSearchParams({ q: args.query, ...(args.full ? {} : { brief: "1" }) });
  const list = (value: string[] | string | undefined) => (Array.isArray(value) ? value : value ? value.split(",") : []).map(v => v.trim()).filter(Boolean);
  const from = list(args.from);
  const place = list(args.place);
  if (from.length) params.set("from", from.join(","));
  if (place.length) params.set("place", place.join(","));
  for (const key of ["in", "after", "before", "sort", "cursor"] as const) if (args[key]) params.set(key, String(args[key]));
  if (args.limit) params.set("limit", String(args.limit));
  return params;
}

const unescape = (html: string): string => html.replace(/<\/?mark>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
  .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code))).replace(/&amp;/g, "&");
const plain = (html: string): string => unescape(html).replace(/\s+/g, " ").trim();
const stamp = (at: number): string => new Date(at).toISOString().slice(0, 16).replace("T", " ") + "Z";

/** Where a hit sits, in the words of the Cmd K rows: the room, a reply's thread, or the tool call and job that hold it. */
function placeOf(hit: SearchHit): string {
  const c = hit.conversation;
  const room = c.kind === "channel" ? `#${c.name.replace(/^#/, "")}` : c.kind === "dm" ? `DM with ${c.name}` : c.kind === "job" ? `job "${c.name}"${c.parent ? ` of ${c.parent.name}` : ""}` : `"${c.name}"`;
  const at = `${room}${c.archived ? " (archived)" : ""}`;
  if (hit.where === "thread") return `${at}, reply in thread ${hit.thread?.root ?? hit.threadRoot}${hit.thread?.title ? ` "${hit.thread.title}"` : ""}`;
  if (hit.where === "tool") return `${at}, ${hit.tool ? `tool ${hit.inCall ? "call" : "output"} ${hit.tool}` : "inside the work"}`;
  return `${at}, top-level`;
}

/** One hit as one line: when, where it sits, who, the plain snippet, then the id and link; with `full`, its longer text follows, indented. */
export function searchHitLine(hit: SearchHit, full = false): string {
  const line = `- ${stamp(hit.at)} ${placeOf(hit)} · ${hit.author.name}: ${plain(hit.snippet)} · id ${hit.conversation.id}/${hit.messageId} · ${hit.link}`;
  return full && hit.text ? `${line}\n  ${unescape(hit.text).replace(/\n/g, "\n  ")}` : line;
}

export function searchResultText(result: SearchResult, args: SearchMessagesArgs): string {
  const notes = (result.missing ?? []).map(m => m.note);
  const head = `${result.hits.length} of ${result.total} hits${args.sort === "recent" ? ", newest first" : ""}.`;
  const more = result.nextCursor ? [`More: pass cursor=${result.nextCursor}.`] : [];
  if (!result.hits.length) return [head + " Try fewer words or drop a filter.", ...notes].join("\n");
  return [head, ...result.hits.map(hit => searchHitLine(hit, args.full)), ...more, ...notes].join("\n");
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
      place: Type.Optional(Type.Union([Type.Array(Type.Union(SEARCH_PLACES.map(p => Type.Literal(p)))), Type.String()], {
        description: "What kind of place, as the owner's Cmd K pills: channels (top-level posts in channels), dms (top-level posts in DMs), " +
          "solo (top-level posts in Solo rooms and the owner's own chats), threads (replies inside a post's thread), jobs (what agents said " +
          "or did inside their work threads and jobs, other than tool output) and tools (tool calls and their output anywhere). Pass " +
          "[\"jobs\", \"tools\"] when a job or an agent did, found or said it while working and you can't name the job. An array or a " +
          "comma list; several values match any of them, and none searches every place.",
      })),
      in: Type.Optional(Type.String({ description: "Which one room or job: a channel name such as #sw-factory-build, a Solo room's name, an " +
        "agent's name for its DM, a job's name as a hit shows it, or a room or job id. Use it when you know where it was said or which job did it." })),
      after: Type.Optional(Type.String({ description: "YYYY-MM-DD in KST, that day included: only what came then or later." })),
      before: Type.Optional(Type.String({ description: "YYYY-MM-DD in KST, that day left out: only what came earlier." })),
      sort: Type.Optional(Type.Union([Type.Literal("relevance"), Type.Literal("recent")], { description: "relevance by default; recent puts the newest first." })),
      limit: Type.Optional(Type.Number({ description: "Hits to return, 20 by default, 100 at most." })),
      cursor: Type.Optional(Type.String({ description: "The cursor a result's More line gives, for the next page." })),
      full: Type.Optional(Type.Boolean({ description: "true prints each hit's longer text, up to 2,000 characters, under its line. Use it with a " +
        "narrow query or a small limit when the snippet cuts off what you need, such as a tool's output or a long post." })),
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
