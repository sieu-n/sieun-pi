import { join } from "node:path";
import { defaultDaemonSocketPath, getAgentDir } from "prime-agent";
import { Catalog } from "./chat-catalog.ts";
import { ChatLabels } from "./chat-labels.ts";
import { ChatReadState } from "./chat-read-state.ts";
import { ThreadHub } from "./chat-threads.ts";

export interface ChatBackend {
  catalog: Catalog;
  threads: ThreadHub;
  readState: ChatReadState;
  labels: ChatLabels;
  close(): Promise<void>;
}

export async function createChatBackend(options: { socketPath?: string; dataDir?: string } = {}): Promise<ChatBackend> {
  const socketPath = options.socketPath ?? defaultDaemonSocketPath();
  const dataDir = options.dataDir ?? join(getAgentDir(), "browser-chat");
  const readState = new ChatReadState(join(dataDir, "read-state.json"));
  const labels = new ChatLabels(join(dataDir, "labels.json"));
  await readState.snapshot().catch(() => null);
  const catalog = new Catalog(socketPath, readState, labels);
  const threads = new ThreadHub(socketPath, catalog);
  catalog.runStartedAt = id => threads.state(id)?.runStartedAt ?? null;
  let closed = false;
  return {
    catalog, threads, readState, labels,
    async close() {
      if (closed) return;
      closed = true;
      await threads.close();
      await catalog.close();
    },
  };
}
