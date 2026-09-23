import type { ExtensionAPI } from "prime-agent";
import { ensureChatService } from "../src/chat-service.ts";
import { ImageFitter } from "../src/context-images.ts";

export default function historyExtension(pi: ExtensionAPI): void {
  const images = new ImageFitter();
  pi.on("context", async event => {
    const messages = await images.messages(event.messages);
    return messages ? { messages } : undefined;
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
        ctx.ui.notify(service.url + "#" + encodeURIComponent(ctx.sessionManager.getSessionId()), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Could not start agent chat.", "error");
      }
    },
  });
}
