import { join } from "node:path";
import { defaultDaemonSocketPath, getAgentDir, SettingsManager } from "prime-agent";
import { Catalog } from "./chat-catalog.ts";
import { ChatLabels } from "./chat-labels.ts";
import { ChatNotes } from "./chat-notes.ts";
import { ChatReadState } from "./chat-read-state.ts";
import { ThreadHub } from "./chat-threads.ts";
import { Chats } from "./chats.ts";
import { IdIndex } from "./id-index.ts";
import { ThreadOrigins } from "./thread-origin.ts";
import { isThinkingLevel, type ChatDefaults, type ChatDefaultsInput } from "./shared/types.ts";

/** The Prime Agent defaults for new sessions. The only reader and writer of settings.json in this service. */
export interface ChatDefaultsStore {
  read(): ChatDefaults;
  write(next: ChatDefaultsInput): Promise<void>;
}

export interface ChatBackend {
  catalog: Catalog;
  threads: ThreadHub;
  readState: ChatReadState;
  labels: ChatLabels;
  notes: ChatNotes;
  defaults: ChatDefaultsStore;
  chats: Chats;
  /** `<dataDir>/threads.json`: every thread `POST api/threads` created, both kinds. A listed id is `origin: "user"`. */
  created: IdIndex;
  close(): Promise<void>;
}

/**
 * Every call builds a fresh SettingsManager, as the daemon does per session, because native sessions write the same file when a thread's model changes.
 * `agentDir` doubles as `cwd` so no project-level `.prime/agent/settings.json` shadows the global value.
 */
export function chatDefaultsStore(agentDir: string): ChatDefaultsStore {
  const manager = () => SettingsManager.create(agentDir, agentDir);
  return {
    read() {
      const settings = manager();
      const level = settings.getDefaultThinkingLevel();
      return { provider: settings.getDefaultProvider() ?? null, modelId: settings.getDefaultModel() ?? null, thinkingLevel: isThinkingLevel(level) ? level : null };
    },
    async write(next) {
      const settings = manager();
      settings.setDefaultModelAndProvider(next.provider, next.modelId);
      if (next.thinkingLevel) settings.setDefaultThinkingLevel(next.thinkingLevel);
      await settings.flush();
      const failure = settings.drainErrors("global")[0];
      if (failure) throw failure.error;
    },
  };
}

export async function createChatBackend(options: { socketPath?: string; dataDir?: string; agentDir?: string } = {}): Promise<ChatBackend> {
  const socketPath = options.socketPath ?? defaultDaemonSocketPath();
  const agentDir = options.agentDir ?? getAgentDir();
  const dataDir = options.dataDir ?? join(agentDir, "browser-chat");
  const readState = new ChatReadState(join(dataDir, "read-state.json"));
  const labels = new ChatLabels(join(dataDir, "labels.json"));
  const notes = new ChatNotes(join(dataDir, "notes.json"));
  const defaults = chatDefaultsStore(agentDir);
  await readState.snapshot().catch(() => null);
  const index = new IdIndex(join(dataDir, "chats.json"), "Chat index");
  const created = new IdIndex(join(dataDir, "threads.json"), "Thread index");
  let chats: Chats;
  const catalog = new Catalog(socketPath, readState, labels, { ids: () => chats.ids() }, new ThreadOrigins(created));
  const threads = new ThreadHub(socketPath, catalog, () => defaults.read());
  chats = new Chats(index, threads, id => catalog.summary(id), line => process.stderr.write(line + "\n"));
  let closed = false;
  return {
    catalog, threads, readState, labels, notes, defaults, chats, created,
    async close() {
      if (closed) return;
      closed = true;
      chats.close();
      await threads.close();
      await catalog.close();
    },
  };
}
