import type { ExtensionAPI } from "prime-agent";
import { createChatBackend } from "../src/chat-backend.ts";
import { startChatServer } from "../src/chat-server.ts";

export function registerChatCommand(pi: ExtensionAPI, asideExecutable: string): void {
  let chat: Awaited<ReturnType<typeof startChatServer>> | undefined;
  pi.registerFlag("agent-chat-socket", {
    description: "Daemon socket for /agent-chat when using a non-default --daemon-socket",
    type: "string",
  });
  pi.on("session_shutdown", async () => { await chat?.close(); chat = undefined; });
  pi.registerCommand("agent-chat", {
    description: "Message sessions and browse agents in Aside",
    async handler(_args, ctx) {
      await chat?.close();
      chat = undefined;
      const socketPath = pi.getFlag("agent-chat-socket");
      let backend: Awaited<ReturnType<typeof createChatBackend>> | undefined;
      try {
        backend = await createChatBackend(typeof socketPath === "string" ? { socketPath } : {});
        const initialSessionId = ctx.sessionManager.getSessionId();
        if (!(await backend.list()).some(session => session.sessionId === initialSessionId)) {
          throw new Error("This session is not in the selected daemon. For a custom daemon, set --agent-chat-socket to the same path.");
        }
        chat = await startChatServer({ backend, initialSessionId });
        const opened = await pi.exec(asideExecutable, ["-b", "at.studio.AsideBrowser", chat.url], { timeout: 30000 });
        if (opened.code !== 0 || opened.killed) throw new Error("Aside could not open chat. This command requires macOS and the Aside app.");
        ctx.ui.notify("Opened agent chat in Aside. Closing chat does not stop your agents.", "info");
      } catch (error) {
        await chat?.close();
        await backend?.close();
        chat = undefined;
        ctx.ui.notify(error instanceof Error ? error.message : "Could not open agent chat.", "error");
      }
    },
  });
}
