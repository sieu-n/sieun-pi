import type { ExtensionAPI } from "prime-agent";
import { ensureChatService } from "../src/chat-service.ts";
import { CHAT_BRIEF, CHAT_FLAG, CHAT_MODE_ENTRY, CHAT_MODE_TOOL, chatGuard, chatModeAt, hasChatMarker, withChatTool } from "../src/chats.ts";
import { ImageFitter } from "../src/context-images.ts";

export default function historyExtension(pi: ExtensionAPI): void {
  const images = new ImageFitter();
  pi.on("context", async event => {
    const messages = await images.messages(event.messages);
    return messages ? { messages } : undefined;
  });
  pi.registerFlag(CHAT_FLAG, { description: "Create this session as a browser chat (the chat server sets it; the session entry chat_mode is the durable mark)", type: "boolean" });
  // The chat brief lives in this tool's promptGuidelines: when the tool is active the base system prompt carries the bullets, so agent-message
  // wakes and heartbeat turns (which skip before_agent_start) read it too. The tool itself does nothing.
  pi.registerTool({
    name: CHAT_MODE_TOOL,
    label: "Chat mode",
    description: "Confirms that this session is a browser chat. It changes nothing.",
    promptGuidelines: [...CHAT_BRIEF],
    parameters: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: "chat mode is on" }], details: undefined }; },
  });
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
