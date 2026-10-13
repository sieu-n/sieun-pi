import { join } from "node:path";
import { defaultDaemonSocketPath, getAgentDir, SettingsManager } from "prime-agent";
import { BoardStore } from "./chat-board-store.ts";
import { Catalog } from "./chat-catalog.ts";
import { ChatLabels } from "./chat-labels.ts";
import { ChatNotes } from "./chat-notes.ts";
import { ChatBookmarks } from "./chat-bookmarks.ts";
import { ChatReadState } from "./chat-read-state.ts";
import { ThreadHub } from "./chat-threads.ts";
import { IdleSleepHold } from "./chat-awake.ts";
import { checkInRecord } from "./chat-checkin.ts";
import { checkInSettings } from "./checkin-settings.ts";
import { CorrectionLedger } from "./chat-corrections.ts";
import { claudeReader, setPoolPriority } from "./chat-pool.ts";
import { dutyJobIds, PoolPriorities } from "./chat-pool-priority.ts";
import { agentQueue, type AgentQueue } from "./chat-agent-queue.ts";
import { briefCheckRecord, jobRegistry, replyCheckRecord } from "./chat-sources.ts";
import { Chats } from "./chats.ts";
import { extensionBuild, loadRecord } from "./chat-brief.ts";
import { Duties } from "./chat-duty-run.ts";
import { archiveDutyJob, dutyJobHost } from "./chat-duty-job.ts";
import { ArchiveQueue } from "./chat-archive-queue.ts";
import { DaemonGate, rosterList } from "./chat-daemon-gate.ts";
import { DutyStore } from "./chat-duty-store.ts";
import { IdIndex } from "./id-index.ts";
import { newChatStore, type NewChatStore } from "./chat-new-chat.ts";
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
  /** `<dataDir>/bookmarks.json`: chat messages the owner saved, listed in the Bookmarks view. */
  bookmarks: ChatBookmarks;
  defaults: ChatDefaultsStore;
  /** `<dataDir>/new-chat.json`: the New chat box's start skill. */
  newChat: NewChatStore;
  chats: Chats;
  /** `<dataDir>/boards/<id>.json`: each chat's board. Changes from either writer reach the open thread as a board event. */
  boards: BoardStore;
  /** `<dataDir>/threads.json`: every thread `POST api/threads` created, both kinds. A listed id is `origin: "user"`. */
  created: IdIndex;
  /** Settings > Usage: token analytics of every agent on this Mac, from `<dataDir>/usage.duckdb`. Absent in tests that fake a backend. */
  usage?: UsageService;
  /** `<dataDir>/duties/`: each chat's standing duties and their runs; the runner ticks every 30 s. Absent in tests that fake a backend. */
  duties?: Duties;
  /** Each live root's pool class (`pi-pool priority`), synced every 30 s and after a priority label change. Absent in tests that fake a backend. */
  poolPriorities?: PoolPriorities;
  /** Settings > This Mac > Agent queue: `pi-pool queue --json` and the two limits, with the limit to restore in `<dataDir>/agent-queue.json`. Absent in tests that fake a backend. */
  agentQueue?: AgentQueue;
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

/** `ownChatsOnly`: this serve does not own the live chats, so it acts only on the chats it created (`CheckInSource.owned`). */
export async function createChatBackend(options: { socketPath?: string; dataDir?: string; agentDir?: string; daemonGateChat?: string | null; ownChatsOnly?: boolean } = {}): Promise<ChatBackend> {
  const socketPath = options.socketPath ?? defaultDaemonSocketPath();
  const agentDir = options.agentDir ?? getAgentDir();
  const dataDir = options.dataDir ?? join(agentDir, "browser-chat");
  const readState = new ChatReadState(join(dataDir, "read-state.json"));
  const labels = new ChatLabels(join(dataDir, "labels.json"));
  const notes = new ChatNotes(join(dataDir, "notes.json"));
  const bookmarks = new ChatBookmarks(join(dataDir, "bookmarks.json"));
  const defaults = chatDefaultsStore(agentDir);
  const newChat = newChatStore(join(dataDir, "new-chat.json"));
  await readState.snapshot().catch(() => null);
  const index = new IdIndex(join(dataDir, "chats.json"), "Chat index");
  const created = new IdIndex(join(dataDir, "threads.json"), "Thread index");
  let chats: Chats;
  // While a chat or one of its jobs works, the service keeps the Mac from idle sleep (10-05: a battery sleep stopped every chat and job).
  const awake = new IdleSleepHold(line => process.stderr.write(`${new Date().toISOString()} ${line}\n`));
  const catalog = new Catalog(socketPath, readState, labels, { ids: () => chats.ids(), checkIns: () => chats.checkIns(), links: id => chats.links(id), briefs: () => chats.briefs(), archivedIds: () => chats.archivedIds(), roster: children => chats.roster(children) }, new ThreadOrigins(created));
  const boards = new BoardStore(dataDir);
  const corrections = new CorrectionLedger(dataDir);
  const threads = new ThreadHub(socketPath, catalog, () => defaults.read(), async id => (await chats.ids()).has(id) ? boards.read(id) : undefined);
  const registry = jobRegistry(join(dataDir, "chat-jobs.json"));
  const poolPriorities = new PoolPriorities({ rows: () => catalog.rows(), duties: rows => dutyJobIds(rows, registry), set: setPoolPriority,
    log: line => process.stderr.write(`${new Date().toISOString()} ${line}\n`) });
  // Each chat's duties: every run starts one duty job linked to the chat. The standing ones are scheduled here; the built-in check-in duty is
  // scheduled and measured in Chats and handed here, and its card edits the check-in setting.
  const dutyLog = (line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);
  const settings = checkInSettings(join(dataDir, "check-in-settings.json"));
  // While the daemon does not answer the gate pauses every chat's check-in but the configured daemonGateChat's, and resumes them when it
  // answers again. It writes only the service log; it posts nothing into a chat.
  const keep = options.daemonGateChat ?? undefined;
  const gate = new DaemonGate({ settings, chats: () => chats.ids(), keep: new Set(keep ? [keep] : []), log: dutyLog, changed: () => catalog.notify(),
    lastCheckIn: async id => (await chats.checkInView(id))?.lastAt ?? null,
    list: async () => {
      await catalog.connect();
      await rosterList((command, timeoutMs, options) => catalog.client.request(command, timeoutMs, options));
    } });
  // A finished duty job's archive runs in the background with retries, so a slow daemon never holds up the next job's start.
  const archives = new ArchiveQueue({ path: join(dataDir, "duty-archive-queue.json"), archive: archiveDutyJob(threads, () => catalog.rows()), log: dutyLog });
  const duties = new Duties(new DutyStore(dataDir), { isChat: async id => (await chats.ids()).has(id), log: dutyLog, daemon: gate,
    jobs: dutyJobHost({ threads, archives, rows: () => catalog.rows(), refresh: () => catalog.refresh(), registry, board: id => join(boards.dir, id + ".json"), log: dutyLog,
      started: id => poolPriorities.set(id, "low") }),
    checkIn: { view: id => chats.checkInView(id), run: id => chats.runCheckIn(id),
      set: async (id, change, actor) => { const view = await chats.setCheckIn(id, change, actor); if (view) await catalog.notify(); return view; } } });
  chats = new Chats(index, threads, id => catalog.summary(id), extensionBuild(), loadRecord(join(dataDir, "extension-loads.json")),
    { board: id => boards.read(id), rows: () => catalog.rows(), memory: checkInRecord(join(dataDir, "check-ins.json")), registry,
      replyChecks: replyCheckRecord(join(dataDir, "reply-checks.json")),
      briefChecks: briefCheckRecord(join(dataDir, "brief-checks.json")),
      settings, claude: claudeReader(),
      awake: working => awake.update(working), corrections: () => corrections.read(), duty: duties, duties: id => duties.store.list(id),
      dutyJobs: async id => (await duties.store.runs(id)).flatMap(run => run.job ? [run.job.id] : []),
      archived: new IdIndex(join(dataDir, "archived-chats.json"), "Archived chat index"),
      ...(options.ownChatsOnly ? { owned: new IdIndex(join(dataDir, "own-chats.json"), "Own chat index") } : {}) },
    line => process.stderr.write(line + "\n"));
  chats.briefChanged = () => { void catalog.notify().catch(() => {}); };
  const unwatchBoards = boards.watch((id, board) => threads.setBoard(id, board),
    error => process.stderr.write(`boards: ${error instanceof Error ? error.message : String(error)}\n`));
  // The usage worker thread reads the transcripts and owns usage.duckdb; its first build runs in the background.
  const usage = new UsageService({ dataDir, log: line => process.stderr.write(`${new Date().toISOString()} ${line}\n`) });
  usage.start();
  catalog.ratesSource = ids => usage.rates(ids);
  catalog.linkSessions = (id, links) => boards.linkSessions(id, links)
    .catch(error => { process.stderr.write(`boards: ${id}: ${error instanceof Error ? error.message : String(error)}\n`); });
  // Publishes usage aggregates to virev.ai/sieun when ~/Library/Application Support/sieun-usage-push/config.json exists.
  const stopPublish = await startUsagePublisher(usage, line => process.stderr.write(`${new Date().toISOString()} ${line}\n`));
  const prioritySync = setInterval(() => { void poolPriorities.sync(); }, 30_000);
  prioritySync.unref();
  void poolPriorities.sync();
  let closed = false;
  return {
    catalog, threads, readState, labels, notes, bookmarks, defaults, newChat, chats, boards, created, usage, duties, poolPriorities,
    agentQueue: agentQueue(join(dataDir, "agent-queue.json"), id => catalog.title(id)),
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(prioritySync);
      unwatchBoards();
      stopPublish();
      duties.close();
      archives.close();
      await usage.close();
      chats.close();
      awake.close();
      await threads.close();
      await catalog.close();
    },
  };
}
