import { join, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI } from "prime-agent";
import { BoardStore } from "../src/chat-board-store.ts";
import { ensureChatService } from "../src/chat-service.ts";
import { CHAT_BOARD_TOOL, CHAT_BRIEF, CHAT_FLAG, CHAT_MODE_ENTRY, chatGuard, chatModeAt, hasChatMarker, TELL_OWNER_LIMIT, TELL_OWNER_TOOL, tellOwner, withChatTool } from "../src/chats.ts";
import { parseBoardOps, PLAN_STATUSES, renderBoard } from "../src/shared/chat-board.ts";
import { ImageFitter } from "../src/context-images.ts";

export default function historyExtension(pi: ExtensionAPI): void {
  const images = new ImageFitter();
  pi.on("context", async event => {
    const messages = await images.messages(event.messages);
    return messages ? { messages } : undefined;
  });
  pi.registerFlag(CHAT_FLAG, { description: "Create this session as a browser chat (the chat server sets it; the session entry chat_mode is the durable mark)", type: "boolean" });
  // The chat brief lives in the board tool's promptGuidelines: when the tool is active the base system prompt carries the bullets, so agent-message
  // wakes and heartbeat turns (which skip before_agent_start) read it too. The board file is the one the chat server shows and the owner edits.
  // tell_owner below is active with it (CHAT_TOOLS).
  pi.registerTool({
    name: CHAT_BOARD_TOOL,
    label: "Chat board",
    description: "Read or change this chat's board, which the owner sees next to the chat: the plan (a nested checklist of goals and steps, each step " +
      "linked to its job), the owner's todo list (asks only the owner can answer, each with choices), and the scratchpad (short bullets, each with " +
      "links to what it is about). Ops apply in order, all or none. No ops returns the current board. Every result shows the whole board with item " +
      "ids (p1, t1, s1) and this chat's own link target.",
    promptGuidelines: [...CHAT_BRIEF],
    parameters: {
      type: "object",
      properties: {
        ops: {
          type: "array",
          description: "Board ops. plan_set {items:[{text,status?,job?,note?,children?}]} replaces the plan. plan_add {text,parent?,status?,job?} adds a goal, " +
            "or a step under parent. plan_update {id,text?,status?,job?,note?} (job or note null clears it). plan_remove {id} removes an item and its steps. " +
            "scratch_add {text,links?} adds one bullet; scratch_update {id,text?,links?} (links replaces the list, [] clears it); scratch_remove {id}. " +
            "A link is {label,target}, up to 5 per bullet; target is job:<name> (a job's report), thread:<sessionId> or thread:<sessionId>@<message " +
            "timestamp ms> (a thread or one message in it), wiki:<path under the llm-wiki content>, file:<absolute path to a text file>, or an http(s) URL. " +
            "todo_add {text,choices?} asks the owner one short question; choices are 2 to 4 short answers, your recommendation first. " +
            "todo_update {id,text?,done?,reply?}. todo_remove {id}.",
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["plan_set", "plan_add", "plan_update", "plan_remove", "scratch_add", "scratch_update", "scratch_remove", "todo_add", "todo_update", "todo_remove"] },
              id: { type: "string" }, parent: { type: "string" }, text: { type: "string" },
              status: { type: "string", enum: [...PLAN_STATUSES] }, job: { type: ["string", "null"] }, note: { type: ["string", "null"] },
              done: { type: "boolean" }, reply: { type: ["string", "null"] },
              links: { type: "array", items: { type: "object", properties: { label: { type: "string" }, target: { type: "string" } }, required: ["target"] } },
              choices: { type: "array", items: { type: "string" } },
              items: { type: "array", items: { type: "object" } },
            },
            required: ["op"],
          },
        },
      },
      required: ["ops"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const ops = parseBoardOps((params as { ops?: unknown }).ops ?? []);
      const sessionId = ctx.sessionManager.getSessionId();
      const { board, summaries } = await boards().apply(sessionId, ops, "agent");
      return { content: [{ type: "text", text: [...summaries, renderBoard(board, sessionId)].join("\n") }], details: undefined };
    },
  });
  // The feed shows this call's text as a bubble on any turn; on a turn the owner did not start it is the only text the owner sees.
  pi.registerTool({
    name: TELL_OWNER_TOOL,
    label: "Tell the owner",
    description: "Say one or two sentences to the owner on a turn the owner did not start (a job report, another thread, a check-in). " +
      `Up to ${TELL_OWNER_LIMIT} characters; longer is refused. Call it once per wake-up, at the end, only when a goal finished, something failed ` +
      "or is blocked, or you need a decision. On a turn the owner started, reply with text instead.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: `What the owner reads, one or two sentences, up to ${TELL_OWNER_LIMIT} characters.` } },
      required: ["text"],
    },
    async execute(_toolCallId, params) {
      const result = tellOwner((params as { text?: unknown }).text);
      if (!result.ok) throw new Error(result.text);
      return { content: [{ type: "text", text: result.text }], details: undefined };
    },
  });
  // Same directory as the chat server: the agent-chat-data-dir flag, else <agentDir>/browser-chat.
  const boards = () => {
    const dataDir = pi.getFlag("agent-chat-data-dir");
    return new BoardStore(typeof dataDir === "string" && dataDir ? resolve(dataDir) : join(getAgentDir(), "browser-chat"));
  };
  // The marker is written once, at the first session_start of a flagged root, and read back on every later start. Children (depth > 0) inherit
  // the flag and the active tool list through the runtime config, so they drop the tool. Any error fails open.
  let marked = false;
  pi.on("session_start", (_event, ctx) => {
    try {
      const depth = depthOf(ctx.sessionManager.getHeader());
      marked = depth === 0 && hasChatMarker(ctx.sessionManager.getEntries());
      const mode = chatModeAt({ depth, flagged: pi.getFlag(CHAT_FLAG) === true, marked });
      if (mode.mark) { pi.appendEntry(CHAT_MODE_ENTRY, { v: 1 }); marked = true; }
      const tools = withChatTool(pi.getActiveTools(), mode.active);
      if (tools) pi.setActiveTools(tools);
    } catch { marked = false; }
  });
  pi.on("tool_call", (event, ctx) => {
    try { return chatGuard({ toolName: event.toolName, input: event.input, depth: depthOf(ctx.sessionManager.getHeader()), marked }); }
    catch { return undefined; }
  });
  pi.registerFlag("agent-chat-socket", {
    description: "Native daemon socket for browser chat",
    type: "string",
  });
  pi.registerFlag("agent-chat-port", {
    description: "Fixed browser chat port (default 5182)",
    type: "string",
  });
  pi.registerFlag("agent-chat-data-dir", {
    description: "Private browser chat service directory",
    type: "string",
  });
  for (const command of ["what-did-i-say", "agent-chat"]) pi.registerCommand(command, {
    description: "Print the shared native chat URL",
    async handler(_args, ctx) {
      try {
        const socketPath = pi.getFlag("agent-chat-socket");
        const port = pi.getFlag("agent-chat-port");
        const dataDir = pi.getFlag("agent-chat-data-dir");
        const service = await ensureChatService({
          ...(typeof socketPath === "string" ? { socketPath } : {}),
          ...(typeof port === "string" ? { port: Number(port) } : {}),
          ...(typeof dataDir === "string" ? { dataDir } : {}),
        });
        const thread = "#" + encodeURIComponent(ctx.sessionManager.getSessionId());
        ctx.ui.notify(service.url + thread + (service.phoneUrl ? `\nPhone: ${service.phoneUrl}${thread}` : ""), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Could not start agent chat.", "error");
      }
    },
  });
}

function depthOf(header: { rlmDepth?: number; parentSession?: string } | null): number {
  return header?.rlmDepth ?? (header?.parentSession ? 1 : 0);
}
