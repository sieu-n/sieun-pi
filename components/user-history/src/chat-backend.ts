import { dirname, join } from "node:path";
import { defaultDaemonSocketPath, getAgentDir, SettingsManager } from "prime-agent";
import { BoardStore } from "./chat-board-store.ts";
import { Catalog } from "./chat-catalog.ts";
import { ChatLabels } from "./chat-labels.ts";
import { ChatNotes } from "./chat-notes.ts";
import { ChatReadState } from "./chat-read-state.ts";
import { ThreadHub } from "./chat-threads.ts";
import { IdleSleepHold } from "./chat-awake.ts";
import { checkInRecord, checkInSettings } from "./chat-checkin.ts";
import { fallbackRecord } from "./chat-fallback.ts";
import { claudeReader } from "./chat-pool.ts";
import { Chats, extensionBuild, jobRegistry, loadRecord } from "./chats.ts";
import { Duties } from "./chat-duty-run.ts";
import { DutyStore } from "./chat-duty-store.ts";
import { IdIndex } from "./id-index.ts";
import { CONVERGENCE_DUTY, convergenceDuty } from "./shared/chat-duties.ts";
import { ThreadOrigins } from "./thread-origin.ts";
import { isThinkingLevel, type ChatDefaults, type ChatDefaultsInput } from "./shared/types.ts";
import { UsageService } from "./usage/service.ts";
import { startUsagePublisher } from "./usage/publish.ts";

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
  /** `<dataDir>/boards/<id>.json`: each chat's board. Changes from either writer reach the open thread as a board event. */
  boards: BoardStore;
  /** `<dataDir>/threads.json`: every thread `POST api/threads` created, both kinds. A listed id is `origin: "user"`. */
  created: IdIndex;
  /** Settings > Usage: token analytics of every agent on this Mac, from `<dataDir>/usage.duckdb`. Absent in tests that fake a backend. */
  usage?: UsageService;
  /** `<dataDir>/duties/`: each chat's standing duties and their runs; the runner ticks every 30 s. Absent in tests that fake a backend. */
  duties?: Duties;
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

/** The user-history component, where a duty's precheck script runs. */
const componentDir = dirname(import.meta.dirname);

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
  // While a chat or one of its jobs works, the service keeps the Mac from idle sleep (10-05: a battery sleep stopped every chat and job).
  const awake = new IdleSleepHold(line => process.stderr.write(`${new Date().toISOString()} ${line}\n`));
  const catalog = new Catalog(socketPath, readState, labels, { ids: () => chats.ids(), checkIns: () => chats.checkIns(), links: id => chats.links(id), briefs: () => chats.briefs() }, new ThreadOrigins(created));
  const boards = new BoardStore(dataDir);
  const threads = new ThreadHub(socketPath, catalog, () => defaults.read(), async id => (await chats.ids()).has(id) ? boards.read(id) : undefined);
  chats = new Chats(index, threads, id => catalog.summary(id), extensionBuild(), loadRecord(join(dataDir, "extension-loads.json")),
    { board: id => boards.read(id), rows: () => catalog.rows(), memory: checkInRecord(join(dataDir, "check-ins.json")), registry: jobRegistry(join(dataDir, "chat-jobs.json")),
      settings: checkInSettings(join(dataDir, "check-in-settings.json")), claude: claudeReader(), fallbacks: fallbackRecord(join(dataDir, "chat-fallbacks.json")),
      awake: working => awake.update(working), writeBoard: (id, ops) => boards.apply(id, ops, "agent"),
      checkInJobs: { dir: join(dataDir, "check-in-jobs"), board: id => join(boards.dir, id + ".json") } },
    line => process.stderr.write(line + "\n"));
  chats.briefChanged = () => { void catalog.notify().catch(() => {}); };
  const unwatchBoards = boards.watch((id, board) => threads.setBoard(id, board),
    error => process.stderr.write(`boards: ${error instanceof Error ? error.message : String(error)}\n`));
  // The usage worker thread reads the transcripts and owns usage.duckdb; its first build runs in the background.
  const usage = new UsageService({ dataDir, log: line => process.stderr.write(`${new Date().toISOString()} ${line}\n`) });
  usage.start();
  catalog.ratesSource = ids => usage.rates(ids);
  // Publishes usage aggregates to virev.ai/sieun when ~/Library/Application Support/sieun-usage-push/config.json exists.
  const stopPublish = await startUsagePublisher(usage, line => process.stderr.write(`${new Date().toISOString()} ${line}\n`));
  const duties = new Duties(new DutyStore(dataDir), { isChat: async id => (await chats.ids()).has(id),
    notify: (id, message) => threads.prompt(id, { message, images: [], mode: "steer" }), log: line => process.stderr.write(`${new Date().toISOString()} ${line}\n`) });
  // Every chat converges on its own: the Board convergence duty measures each board hourly and wakes the chat only on a miss.
  chats.chatAdded = id => { void duties.ensure(id, convergenceDuty(id, componentDir)).then(result => { if (!result.startsWith("unchanged")) process.stderr.write(`duty ${id.slice(0, 8)}: ${result} "${CONVERGENCE_DUTY}"\n`); },
    error => process.stderr.write(`duty ${id.slice(0, 8)}: ${CONVERGENCE_DUTY}: ${error instanceof Error ? error.message : String(error)}\n`)); };
  let closed = false;
  return {
    catalog, threads, readState, labels, notes, defaults, chats, boards, created, usage, duties,
    async close() {
      if (closed) return;
      closed = true;
      unwatchBoards();
      stopPublish();
      duties.close();
      await usage.close();
      chats.close();
      awake.close();
      await threads.close();
      await catalog.close();
    },
  };
}
