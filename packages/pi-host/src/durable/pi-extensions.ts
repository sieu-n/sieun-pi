/**
 * Runs a pi coding-agent extension (the pi `ExtensionAPI` that Prime and pi-host's Pi sessions load) inside pi-host and hands its parts to
 * durable threads, so a thread runs the extension's own tools and text instead of a retyped copy.
 *
 * `loadPiExtension` calls the extension's factory with a recording `ExtensionAPI`: every `registerTool` is kept as the extension wrote it
 * (name, description, parameters, promptGuidelines, execute), every `on(event)` handler is kept, flags read back the values the caller set,
 * and `appendEntry` and `sendMessage` are recorded. `emit` runs the kept handlers of one event with a session context, as pi's runner does, so
 * a `session_start` handler registers the tools it registers in a chat. Every other API method is a no-op that the load records by name
 * (`skipped`), since a durable thread has no TUI, no pi session file and no pi agent loop.
 *
 * `durableTool` turns one kept tool into a pi-durable `defineTool` registration with the same name, description and parameters. Its execute
 * maps pi-durable's call to pi's `execute(toolCallId, params, signal, onUpdate, ctx)`: the call id, the abort signal from the call's context,
 * running output through `api.output`, and a context whose `sessionManager` answers with the thread's ids, name and file and whose `cwd` is
 * the conversation's. A binding may give its own execute instead, for a tool whose side effects belong to another store in a durable thread.
 *
 * Replay safety is the binding's choice per tool (`replay: "safe"` only for idempotent ones); unset, a call a restart interrupts gets
 * pi-durable's `interrupted` result.
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";

/** A tool as a pi extension registers it. */
export interface PiTool {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  promptSnippet?: string;
  promptGuidelines?: readonly string[];
  /** pi's `sequential` keeps the calls of one assistant message from running at once, as pi-rlm's ipython asks. */
  executionMode?: "sequential" | "parallel";
  execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: ((partial: unknown) => void) | undefined, ctx: unknown): Promise<PiToolResult>;
}
export interface PiToolResult { content?: (TextContent | ImageContent)[]; details?: unknown; isError?: boolean }

type Handler = (event: unknown, ctx: unknown) => unknown;

/** The part of pi's session manager the extensions read, answered from a durable thread. */
export interface PiSession {
  id: string;
  name?: string;
  /** The thread's SQLite file, which stands where pi has its session file. */
  file?: string;
  cwd: string;
  /** 0 for a thread's root conversation, 1 for a subagent's child conversation. */
  depth?: number;
  /** Prime-shaped session entries (`{ type: "message", message, ... }`); empty unless the caller has them. */
  entries?: () => readonly unknown[];
}

export interface LoadedPiExtension {
  /** Each tool by name, in first registration order; a later registration of the same name replaces the definition, as pi's does. */
  readonly tools: Map<string, PiTool>;
  readonly handlers: Map<string, Handler[]>;
  readonly flags: Map<string, boolean | string | undefined>;
  /** `appendEntry` calls: a durable thread keeps no pi session entries, so they are recorded and dropped. */
  readonly appended: { customType: string; data: unknown }[];
  /** API methods the extension called that do nothing here, by name. */
  readonly skipped: Set<string>;
  /** Runs every handler of `event` in registration order with `ctx`, and returns their results. A handler that throws is logged and skipped. */
  emit(event: string, payload: unknown, ctx: unknown): Promise<unknown[]>;
}

export interface LoadOptions {
  /** Values `getFlag` returns, such as a chat's `chat` and `agent-chat-data-dir`. A flag the extension registers with a default gets it otherwise. */
  flags?: Record<string, boolean | string>;
  log?: (line: string) => void;
}

/** Calls the factory with the recording API and returns what it registered. */
export async function loadPiExtension(factory: (pi: never) => unknown, options: LoadOptions = {}): Promise<LoadedPiExtension> {
  const tools = new Map<string, PiTool>();
  const handlers = new Map<string, Handler[]>();
  const flags = new Map<string, boolean | string | undefined>(Object.entries(options.flags ?? {}));
  const appended: { customType: string; data: unknown }[] = [];
  const skipped = new Set<string>();
  let active: string[] | undefined;
  const api: Record<string, unknown> = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => { const at = list.indexOf(handler); if (at >= 0) list.splice(at, 1); };
    },
    registerTool(tool: PiTool) { tools.set(tool.name, tool); },
    registerFlag(name: string, flag: { default?: boolean | string }) { if (!flags.has(name)) flags.set(name, flag.default); },
    getFlag(name: string) { return flags.get(name); },
    appendEntry(customType: string, data: unknown) { appended.push({ customType, data }); },
    getActiveTools() { return active ?? [...tools.keys()]; },
    getAllTools() { return [...tools.values()].map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })); },
    setActiveTools(names: string[]) { active = [...names]; },
  };
  const pi = new Proxy(api, {
    get(target, key) {
      if (typeof key !== "string" || key in target) return target[key as string];
      // registerCommand, registerShortcut, sendMessage, registerMessageRenderer and the rest: nothing in a durable thread takes them.
      return () => { skipped.add(key); return undefined; };
    },
  });
  await factory(pi as never);
  return {
    tools, handlers, flags, appended, skipped,
    async emit(event, payload, ctx) {
      const out: unknown[] = [];
      for (const handler of handlers.get(event) ?? []) {
        try {
          out.push(await handler(payload, ctx));
        } catch (error) {
          options.log?.(`pi extension ${event} handler failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return out;
    },
  };
}

/** The pi `ExtensionContext` a handler or tool of a durable thread sees. */
export function piContext(session: PiSession, signal?: AbortSignal): Record<string, unknown> {
  const entries = () => [...(session.entries?.() ?? [])];
  const header = { type: "session", id: session.id, cwd: session.cwd, timestamp: new Date(0).toISOString(), ...(session.depth ? { rlmDepth: session.depth } : {}) };
  return {
    cwd: session.cwd,
    hasUI: false,
    signal,
    ui: new Proxy({}, { get: () => () => undefined }),
    sessionManager: {
      getSessionId: () => session.id,
      getSessionName: () => session.name,
      getSessionFile: () => session.file,
      getSessionDir: () => undefined,
      getCwd: () => session.cwd,
      getHeader: () => header,
      getEntries: entries,
      getBranch: entries,
      getLeafId: () => null,
    },
  };
}

export interface DurableToolBinding {
  /** Only for tools whose rerun after a crash changes nothing outside the thread. */
  replay?: "safe" | "unsafe";
  /** The pi session the call runs in: the thread's ids, name, file and cwd. */
  session: (api: ToolExecutionApi, context: Context) => PiSession | Promise<PiSession>;
  /** Runs the call instead of the extension's own execute, for a tool whose store differs in a durable thread. Same result shape. */
  execute?: (params: unknown, api: ToolExecutionApi, context: Context) => Promise<PiToolResult>;
  /** The result's details to keep in the transcript for UIs (pi-durable stores them with the result); default none. */
  details?: (result: PiToolResult) => JsonValue | undefined;
}

/** Text a pi result's content holds, for a running update's output. */
const textOf = (content: PiToolResult["content"]): string => (content ?? []).flatMap(part => (part.type === "text" ? [part.text] : [])).join("");

/**
 * The pi tool as a pi-durable tool: its own name, description and parameters (JSON Schema, which pi-ai validates as it does in Prime), and an
 * execute that calls the extension's or the binding's. A result marked `isError`, or a throw, is an error result whose text is the
 * result's or the error's message, as pi's agent loop sends it, without pi-durable's `<harness>` wrapper.
 */
export function durableTool(tool: PiTool, binding: DurableToolBinding): ToolRegistration {
  return defineTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as never,
    ...(binding.replay ? { replay: binding.replay } : {}),
    ...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
    execute: async (args, api, context): Promise<ToolExecutionResult> => {
      let result: PiToolResult;
      try {
        if (binding.execute) result = await binding.execute(args, api, context);
        else {
          const session = await binding.session(api, context);
          let streamed = "";
          const onUpdate = (partial: unknown) => {
            const text = textOf((partial as PiToolResult | undefined)?.content);
            if (text.startsWith(streamed) && text.length > streamed.length) api.output(text.slice(streamed.length));
            streamed = text;
          };
          result = await tool.execute(api.callId, args, context.abortSignal, onUpdate, piContext(session, context.abortSignal));
        }
      } catch (error) {
        // An abort stays pi-durable's to record. Any other throw is the error result pi's agent loop makes of it: the message as the text.
        if (context.abortSignal?.aborted) throw error;
        return { output: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
      const details = binding.details?.(result);
      return { output: result.content ?? [], ...(result.isError ? { isError: true } : {}), ...(details !== undefined ? { details } : {}) };
    },
  });
}
