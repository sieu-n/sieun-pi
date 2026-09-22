import { join } from "node:path";
import { defaultDaemonSocketPath, getAgentDir } from "prime-agent";
import { Catalog } from "./chat-catalog.ts";
import { ChatReadState } from "./chat-read-state.ts";
import { ThreadHub } from "./chat-threads.ts";

export interface ChatBackend {
  catalog: Catalog;
  threads: ThreadHub;
  readState: ChatReadState;
  close(): Promise<void>;
}

export async function createChatBackend(options: { socketPath?: string; readStatePath?: string } = {}): Promise<ChatBackend> {
  const socketPath = options.socketPath ?? defaultDaemonSocketPath();
  const readState = new ChatReadState(options.readStatePath ?? join(getAgentDir(), "browser-chat", "read-state.json"));
  await readState.snapshot().catch(() => null);
  const catalog = new Catalog(socketPath, readState);
  const threads = new ThreadHub(socketPath, catalog);
  let closed = false;
  return {
    catalog, threads, readState,
    async close() {
      if (closed) return;
      closed = true;
      await threads.close();
      await catalog.close();
    },
  };
}
