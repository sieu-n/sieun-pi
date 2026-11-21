/**
 * The `search_history` tool: full-text search over every session transcript on every box, through this box's pi-history socket. A stock Pi
 * or pi-host session loads this file as an extension, and the Prime extension in components/user-history registers the same tool.
 */
import { historyGet } from "../client.ts";
import type { ReadAnswer } from "../core/read.ts";
import type { Hit } from "../core/search.ts";
import type { SearchResult } from "../server.ts";

export const SEARCH_HISTORY_TOOL = "search_history";

/** `from`, `in`, `place`, `where`, `after` and `before` mean what they mean in sw factory's search_messages and the owner's Cmd K search. */
export interface SearchHistoryParams {
  query?: string; from?: string[] | string; in?: string[] | string; place?: string[] | string; where?: string[] | string; kind?: string; box?: string; after?: string; before?: string; sort?: string; limit?: number; read?: string;
}

/** The part of a session's context the tool reads: who is calling, so the socket applies that session's scope. */
export interface CallerContext { sessionManager: { getSessionId(): string; getSessionFile(): string | undefined } }

const unescape = (html: string): string => html.replace(/<\/?mark>/g, "").replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
const stamp = (at: number): string => new Date(at).toISOString().slice(0, 16).replace("T", " ") + "Z";

/** One hit as one line: when, where, which thread and session, what kind, the snippet and the ref that `read` takes. */
export function hitLine(hit: Hit): string {
  const what = hit.tool ? `${hit.kind} (${hit.tool})` : hit.kind;
  return `${stamp(hit.at)} ${hit.box} ${hit.rootName ? `${hit.rootName}/` : ""}${hit.thread} (${hit.session.slice(0, 8)}) ${what}: ${unescape(hit.snippet)} ref=${hit.ref}`;
}

export function resultText(result: SearchResult): string {
  const down = Object.entries(result.boxes).filter(([, state]) => !state.ok).map(([box, state]) => `${box} (${state.error ?? "no answer"})`);
  const head = `${result.hits.length} of ${result.total} hits, ${result.tookMs} ms, scope ${result.scope}.` + (down.length ? ` Not searched: ${down.join(", ")}.` : "");
  if (!result.hits.length) return `${head} Try fewer words or remove a filter.`;
  return [head, ...result.hits.map(hitLine)].join("\n");
}

export function readText(answer: ReadAnswer): string {
  return [`${answer.box} ${answer.thread} (${answer.session})`, ...answer.messages.map(message =>
    `${message.hit ? ">" : " "} ${stamp(message.at)} ${message.author} ${message.tool ? `${message.kind} (${message.tool})` : message.kind}: ${message.text}`)].join("\n");
}

const DESCRIPTION = "Search every agent session transcript on every box, Prime chats and jobs as well as sw factory threads: messages, tool calls " +
  "and their output, agent messages and summaries. Newest first by default. Use it for what happened inside a session, such as a command an " +
  "agent ran, an error it saw or a Prime chat's words. An sw factory agent uses search_messages first for what people and agents posted in " +
  "sw factory rooms, DMs and threads and for what its agents' jobs said or did, with place=jobs,tools when it can't name the job. Narrow with from (who wrote it), in (which chat, job or thread), place=tools (only tool calls and their " +
  "output), and after/before (dates). place takes only tools here: a transcript holds no room posts, and its index does not mark which session " +
  "is a job, so to find something said in some job use search_messages with place=jobs, or name the job with in. The query also takes in:, from:, kind:, box:, before:, after:, on:, -word, is:error and \"exact phrase\". " +
  "Pass read=<ref> from a hit to get the messages around it. An agent sees its own chat family unless the owner widened the scope.";

const KST_MS = 9 * 3_600_000;

/**
 * The socket's own params for the shared filters. `after` keeps its day, as since= does; `before` leaves its day out, as in search_messages,
 * so it becomes the ISO time that day starts in KST. `place` takes only `tools` and `where` only `tool`: a transcript has no room posts or
 * thread replies, and the index has no job marker for a pi-host thread (every durable hit is depth 0), so `jobs` could not mean what it
 * means in search_messages.
 */
export function socketFilters(params: SearchHistoryParams): Record<string, string | undefined> {
  const places = values(params.place).map(value => value.toLowerCase());
  const otherPlaces = places.filter(value => value !== "tools" && value !== "tool");
  if (otherPlaces.length) throw new Error(`place=${otherPlaces.join(",")} is not in session transcripts; search_messages takes it. search_history takes place=tools or no place.`);
  const where = values(params.where);
  const posts = where.filter(value => value !== "tool");
  if (posts.length) throw new Error(`where=${posts.join(",")} is for room posts and thread replies, which search_messages searches; search_history takes where=tool or no where.`);
  const tools = places.length > 0 || where.length > 0;
  if (tools && params.kind) throw new Error("Pass place=tools or kind, not both.");
  const day = params.before && /^(\d{4})-(\d{2})-(\d{2})$/.exec(params.before);
  const before = day ? new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])) - KST_MS).toISOString() : params.before;
  const joined = (list: string[]) => list.length ? list.join(",") : undefined;
  return { agent: joined(values(params.from)), chat: joined(values(params.in)), kind: tools ? "tool" : params.kind, since: params.after, until: before };
}

/** A list param as the model sent it: an array, or one string that may hold a comma list. */
const values = (value: string[] | string | undefined): string[] =>
  (Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : []).map(part => part.trim()).filter(Boolean);

/** The tool definition, in the shape Pi's and Prime's registerTool take. */
export function searchHistoryTool(): {
  name: string; label: string; description: string; parameters: Record<string, unknown>;
  execute(toolCallId: string, params: SearchHistoryParams, signal: AbortSignal | undefined, onUpdate: unknown, ctx: CallerContext): Promise<{ content: { type: "text"; text: string }[]; details: undefined }>;
} {
  return {
    name: SEARCH_HISTORY_TOOL,
    label: "Search history",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to find, with optional modifiers." },
        from: { type: "array", items: { type: "string" }, description: "Who wrote it: an agent's name, owner, or tool. Use it when you know who said or ran it. Several values match any of them." },
        in: { type: "array", items: { type: "string" }, description: "Which chat, job or thread: its name, or a session id prefix. Use it when you know where it happened. Several values match any of them." },
        place: { type: "array", items: { type: "string", enum: ["tools"] }, description: "tools keeps only tool calls and their output, for a command, a file read or an error that never showed in a message. The other search_messages places (channels, dms, solo, threads, jobs) are not in transcripts; use search_messages for them." },
        where: { type: "array", items: { type: "string", enum: ["tool"] }, description: "The older form of place=tools, kept for old calls." },
        kind: { type: "string", description: "An exact kind when place is not enough: message, agent, thinking, summary, or one such as tool_result." },
        box: { type: "string", description: "mac or us-metal02." },
        after: { type: "string", description: "YYYY-MM-DD (KST), that day included, or an ISO time: only what came then or later." },
        before: { type: "string", description: "YYYY-MM-DD (KST), that day left out, or an ISO time: only what came earlier." },
        sort: { type: "string", enum: ["newest", "relevant"] },
        limit: { type: "number", description: "Hits to return, 20 by default, 100 at most." },
        read: { type: "string", description: "A hit's ref: return the messages around that hit instead of searching." },
      },
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const caller = { caller: ctx.sessionManager.getSessionId(), callerPath: ctx.sessionManager.getSessionFile() };
      let text: string;
      try {
        if (params.read) text = readText(await historyGet<ReadAnswer>("/v1/read", { ref: params.read, ...caller }));
        else {
          const filters = socketFilters(params);
          if (!params.query?.trim() && !Object.values(filters).some(Boolean)) throw new Error("Pass a query, a filter, or read=<ref>.");
          text = resultText(await historyGet<SearchResult>("/v1/search", { q: params.query, ...filters, box: params.box, sort: params.sort, limit: params.limit, ...caller }));
        }
      } catch (error) {
        text = `search_history failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      return { content: [{ type: "text", text }], details: undefined };
    },
  };
}

/** The Pi extension: registers search_history in every session. */
export default function piHistoryExtension(pi: { registerTool(tool: ReturnType<typeof searchHistoryTool>): void }): void {
  pi.registerTool(searchHistoryTool());
}
