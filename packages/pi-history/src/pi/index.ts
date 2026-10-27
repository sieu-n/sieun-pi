/**
 * The `search_history` tool: full-text search over every session transcript on every box, through this box's pi-history socket. A stock Pi
 * or pi-host session loads this file as an extension, and the Prime extension in components/user-history registers the same tool.
 */
import { historyGet } from "../client.ts";
import type { ReadAnswer } from "../core/read.ts";
import type { Hit } from "../core/search.ts";
import type { SearchResult } from "../server.ts";

export const SEARCH_HISTORY_TOOL = "search_history";

export interface SearchHistoryParams {
  query?: string; kind?: string; chat?: string; agent?: string; box?: string; since?: string; until?: string; sort?: string; limit?: number; read?: string;
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

const DESCRIPTION = "Search every agent session transcript on every box: messages, tool calls and results, agent messages and summaries. " +
  "Newest first by default. The query takes Slack-style modifiers: in:<chat or thread>, from:<agent>|owner|tool, kind:message|tool|agent|thinking|summary, " +
  "box:mac|us-metal02, before:/after:/on:YYYY-MM-DD (KST), -word, is:error, \"exact phrase\". Pass read=<ref> from a hit to get the messages around it. " +
  "An agent sees its own chat family unless the owner widened the scope.";

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
        kind: { type: "string", description: "message, tool, agent, thinking, summary, or an exact kind such as tool_result." },
        chat: { type: "string", description: "A chat or thread name, or a session id prefix." },
        agent: { type: "string", description: "An agent name, owner or tool." },
        box: { type: "string", description: "mac or us-metal02." },
        since: { type: "string", description: "YYYY-MM-DD (KST) or an ISO time." },
        until: { type: "string", description: "YYYY-MM-DD (KST, the whole day) or an ISO time." },
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
          if (!params.query?.trim() && !params.chat && !params.agent && !params.kind && !params.since && !params.until) throw new Error("Pass a query, a filter, or read=<ref>.");
          text = resultText(await historyGet<SearchResult>("/v1/search", {
            q: params.query, kind: params.kind, chat: params.chat, agent: params.agent, box: params.box, since: params.since, until: params.until,
            sort: params.sort, limit: params.limit, ...caller,
          }));
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
