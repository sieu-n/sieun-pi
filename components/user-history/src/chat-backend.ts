import { homedir } from "node:os";
import { join } from "node:path";
import { defaultDaemonSocketPath, getAgentDir, SettingsManager } from "prime-agent";
import { BoardStore } from "./chat-board-store.ts";
import { Catalog } from "./chat-catalog.ts";
import { ChatLabels } from "./chat-labels.ts";
import { ChatBookmarks } from "./chat-bookmarks.ts";
import { ChatReadState } from "./chat-read-state.ts";
import { ThreadHub } from "./chat-threads.ts";
import { IdleSleepHold } from "./chat-awake.ts";
import { checkInRecord } from "./chat-checkin.ts";
import { checkInSettings } from "./checkin-settings.ts";
import { CLEAN_ROOM_CHATS_FILE, CLEAN_ROOM_CORRECTIONS_FILE, CorrectionLedger } from "./chat-corrections.ts";
import { claudeReader, markOwnerTurn, setPoolPriority } from "./chat-pool.ts";
import { dutyAdmitter, queueReader, sharedQueueRead } from "./chat-turn-queue.ts";
import { startMacUsableWatch } from "./mac-usable-watch.ts";
import { endLeftovers, leftoverSource } from "./job-leftovers.ts";
import { chatPoolPriority, dutyJobIds, PoolPriorities } from "./chat-pool-priority.ts";
import { agentQueue, type AgentQueue, type IdleEviction } from "./chat-agent-queue.ts";
import { briefCheckRecord, deletedJobRecord, jobRegistry, replyCheckRecord } from "./chat-sources.ts";
import { jobResumes } from "./job-resume.ts";
import { cutJobs, interruptedRuns } from "./chat-resume.ts";
import { unloadPlan } from "./idle-unload.ts";
import { readHeldTurns, writeResumePending } from "./held-turns.ts";
import { Chats, UNKNOWN_ACTIVE } from "./chats.ts";
import { extensionBuild, loadRecord } from "./chat-brief.ts";
import { Duties } from "./chat-duty-run.ts";
import { fixJobLive } from "./shared/duty-fixes.ts";
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
import { pendingWakes, readRunState, runStamp, startWakes, waking } from "./wakes.ts";
import { readGrafanaAlerts, readOwnersFor, startAlertBridge } from "./alert-bridge.ts";
import { PollHealth, startBridgeWatch } from "./alert-bridge-health.ts";
import { DAEMON_WORKER_START_MS } from "./daemon-worker-start.ts";
import { promptView, sessionFileFor } from "./prompt-view.ts";
import { prStates } from "./pr-states.ts";
import type { PromptView } from "./shared/prompt-view.ts";

/** The Prime Agent defaults for new sessions. The only reader and writer of settings.json in this service. */
export interface ChatDefaultsStore extends IdleEviction {
  read(): ChatDefaults;
  write(next: ChatDefaultsInput): Promise<void>;
}

export interface ChatBackend {
  catalog: Catalog;
  threads: ThreadHub;
  readState: ChatReadState;
  labels: ChatLabels;
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
  /** Settings > This Mac > Agent queue: `pi-pool queue --json`, the queue switch and its two limits, and the daemon's idle unload time. Absent in tests that fake a backend. */
  agentQueue?: AgentQueue;
  /**
   * Marks the owner's prompt to a thread as an owner turn in the Mac-wide turn queue (`pi-pool owner-turn`), right before it is sent, so it never
   * waits behind background work. It never rejects: a pool that fails is logged and the prompt goes as before. Absent in tests that fake a backend.
   */
  ownerTurn?: (sessionId: string) => Promise<void>;
  /**
   * `GET api/threads/<id>/prompt?via=<parent ids>`: the prompt any session's model gets (src/prompt-view.ts), a thread, a job or a subagent the
   * daemon no longer lists (`sessionFileFor`); null for a session with no session file. Absent in tests that fake a backend.
   */
  prompt?: (id: string, via?: readonly string[]) => Promise<PromptView | null>;
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
    idleEviction: () => manager().getIdleEvictionMinutes(),
    async setIdleEviction(value) {
      const settings = manager();
      settings.setIdleEvictionMinutes(value);
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
  const cleanRoomChats = new IdIndex(join(dataDir, CLEAN_ROOM_CHATS_FILE), "Clean-room chat index");
  const threads = new ThreadHub(socketPath, catalog, () => defaults.read(), async id => (await chats.ids()).has(id) ? boards.read(id) : undefined,
    { minutes: () => defaults.idleEviction(), held: async (id: string): Promise<boolean> => (await duties.view(id)).some(duty => duty.running),
      file: join(dataDir, "idle-clocks.json") });
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
  // Duty and check-in jobs wait for the Mac-wide turn queue before their session is created; a restart releases the keys its killed waits left.
  const turns = dutyAdmitter({ log: dutyLog });
  const queueReading = sharedQueueRead();
  const queued = queueReader(queueReading);
  const poolWaiting = async (): Promise<Set<string>> => {
    const pool = await queueReading().catch(() => null);
    return new Set([...pool?.working ?? [], ...pool?.queued ?? []].map(entry => entry.session));
  };
  const duties = new Duties(new DutyStore(dataDir), { isChat: async id => (await chats.ids()).has(id), log: dutyLog, daemon: gate, admit: turns.admit,
    board: id => boards.read(id),
    applyBoard: (id, ops) => boards.apply(id, ops, "agent"),
    fixLive: async (id, item) => {
      const now = Date.now();
      const asleep = new Set((await pendingWakes(join(dataDir, "wakes"), now).catch(() => [])).map(wake => wake.session));
      const pool = await queueReading().catch(() => null);
      const waiting = new Set([...pool?.working ?? [], ...pool?.queued ?? []].map(entry => entry.session));
      return fixJobLive(item, id, await catalog.rows(), asleep, waiting, now);
    },
    priority: async id => chatPoolPriority((await labels.snapshot()).threads[id]?.priority ?? 0),
    jobs: dutyJobHost({ threads, archives, rows: () => catalog.rows(), refresh: () => catalog.refresh(), registry, board: id => join(boards.dir, id + ".json"), log: dutyLog,
      started: id => poolPriorities.set(id, "low"), handoff: id => markOwnerTurn(id) }),
    checkIn: { view: id => chats.checkInView(id), run: (id, trigger) => chats.runCheckIn(id, trigger), measure: id => chats.measureCheckIn(id),
      set: async (id, change, actor) => { const view = await chats.setCheckIn(id, change, actor); if (view) await catalog.notify(); return view; } } });
  chats = new Chats(index, threads, id => catalog.summary(id), extensionBuild(), loadRecord(join(dataDir, "extension-loads.json")),
    { board: id => boards.read(id), rows: () => catalog.rows(), memory: checkInRecord(join(dataDir, "check-ins.json")), registry,
      replyChecks: replyCheckRecord(join(dataDir, "reply-checks.json")), correctionChecks: replyCheckRecord(join(dataDir, "correction-checks.json")),
      briefChecks: briefCheckRecord(join(dataDir, "brief-checks.json")), deletedJobs: deletedJobRecord(join(dataDir, "deleted-jobs.json")),
      leftovers: (dir, session) => endLeftovers(leftoverSource, dir, session),
      waking: session => waking(join(dataDir, "wakes"), session), wakes: now => pendingWakes(join(dataDir, "wakes"), now),
      resumes: { store: jobResumes(join(dataDir, "job-resumes")), applyBoard: (id, ops) => boards.apply(id, ops, "agent") },
      interrupted: async (isJob, owners) => interruptedRuns.resumeJobs(isJob, async id => { await threads.resume(id); }, owners, cut => writeResumePending(dataDir, cut, Date.now()),
        await cutJobs(dataDir, [...await chats.ids()])),
      held: now => readHeldTurns(dataDir, now),
      settings, claude: claudeReader(), queue: queued,
      awake: working => awake.update(working), corrections: () => corrections.read(), duty: duties,
      cleanRoom: async id => (await cleanRoomChats.ids()).includes(id) ? new CorrectionLedger(dataDir, CLEAN_ROOM_CORRECTIONS_FILE).read() : null, duties: id => duties.store.list(id),
      dutyJobs: async id => (await duties.store.runs(id)).flatMap(run => run.job ? [run.job.id] : []),
      dutyRuns: id => duties.store.runs(id), prs: prStates(),
      archived: new IdIndex(join(dataDir, "archived-chats.json"), "Archived chat index"),
      ...(options.ownChatsOnly ? { owned: new IdIndex(join(dataDir, "own-chats.json"), "Own chat index") } : {}) },
    line => process.stderr.write(line + "\n"));
  chats.briefChanged = () => { void catalog.notify().catch(() => {}); };
  const unwatchBoards = boards.watch((id, board) => {
    threads.setBoard(id, board);
    void duties.boardChanged(id, board).catch(error => dutyLog(`duties: board change of ${id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`));
  },
    error => process.stderr.write(`boards: ${error instanceof Error ? error.message : String(error)}\n`));
  // The usage worker thread reads the transcripts and owns usage.duckdb; its first build runs in the background.
  const usage = new UsageService({ dataDir, log: line => process.stderr.write(`${new Date().toISOString()} ${line}\n`) });
  usage.start();
  catalog.ratesSource = ids => usage.rates(ids);
  catalog.queueSource = queued;
  void turns.sweep(async id => (await chats.ids()).has(id)).catch(error => dutyLog(`turn queue: sweep: ${error instanceof Error ? error.message : String(error)}`));
  catalog.linkSessions = (id, links) => boards.linkSessions(id, links)
    .catch(error => { process.stderr.write(`boards: ${id}: ${error instanceof Error ? error.message : String(error)}\n`); });
  // Publishes usage aggregates to virev.ai/sieun when ~/Library/Application Support/sieun-usage-push/config.json exists.
  const stopPublish = await startUsagePublisher(usage, line => process.stderr.write(`${new Date().toISOString()} ${line}\n`));
  const stopWatch = options.ownChatsOnly ? () => {} : startMacUsableWatch({ dataDir, rows: () => catalog.daemonRows(), chats: () => chats.ids(), title: id => catalog.title(id),
    queue: queueReading, log: dutyLog });
  const agentMessage = {
    deliver: async (session: string, text: string): Promise<"sent" | "gone"> => {
      await catalog.connect();
      const response = await catalog.client.request({ type: "send_message", targetActiveSessionId: session, message: text }, 30_000, { recoverable: false });
      if (response.success) return "sent";
      if (response.error.startsWith(UNKNOWN_ACTIVE)) return "gone";
      throw new Error(response.error);
    },
    startRoot: async (root: string): Promise<void> => {
      const sessionPath = (await catalog.summary(root))?.sessionFile;
      if (!sessionPath) throw new Error(`no session file for root ${root.slice(0, 8)}`);
      const response = await catalog.client.request({ type: "create", lifecycle: "resident", sessionPath }, DAEMON_WORKER_START_MS, { recoverable: false });
      if (!response.success) throw new Error(response.error);
    },
  };
  const stopWakes = options.ownChatsOnly ? () => {} : startWakes({ dir: join(dataDir, "wakes"), runState: readRunState, stamp: runStamp, log: dutyLog, ...agentMessage });
  const grafanaConfig = join(dataDir, "grafana-alerts.json");
  const pollHealth = new PollHealth();
  const stopAlerts = options.ownChatsOnly ? () => {} : startAlertBridge({ file: join(dataDir, "alert-bridge.json"), alerts: () => pollHealth.poll(() => readGrafanaAlerts(grafanaConfig)),
    owners: () => readOwnersFor(grafanaConfig, homedir()), hasBoard: async session => (await boards.read(session)) !== null,
    boards, log: dutyLog, ...agentMessage });
  const stopBridgeWatch = options.ownChatsOnly ? () => {} : startBridgeWatch({ health: pollHealth, statusFile: join(homedir(), ".cache/virev/alert-bridge-status.json"),
    configFile: grafanaConfig, log: dutyLog, ...agentMessage });
  // An idle root job's worker stops a minute after its last activity rather than at Prime's idle sweep (src/idle-unload.ts).
  const unloadIdle = async (): Promise<void> => {
    const stopped: string[] = [];
    for (const row of unloadPlan(catalog.daemonRows(), { chats: await chats.ids(), pool: await poolWaiting(), now: Date.now() })) {
      const response = await catalog.client.request({ type: "kill", activeSessionId: row.activeSessionId! }, 30_000, { recoverable: false }).catch(error => ({ success: false as const, error: String(error) }));
      if (response.success) stopped.push(row.sessionName?.trim() || row.sessionId.slice(0, 8));
      else dutyLog(`idle unload: ${row.sessionId.slice(0, 8)}: ${response.error}`);
    }
    if (stopped.length) dutyLog(`idle unload: stopped the workers of ${stopped.length} idle root jobs: ${stopped.join(", ")}`);
  };
  let unloading = false;
  const unloader = options.ownChatsOnly ? undefined : setInterval(() => {
    if (unloading) return;
    unloading = true;
    void unloadIdle().catch(error => dutyLog(`idle unload: ${error instanceof Error ? error.message : String(error)}`)).finally(() => { unloading = false; });
  }, 60_000);
  unloader?.unref();
  const prioritySync = setInterval(() => { void poolPriorities.sync(); }, 30_000);
  prioritySync.unref();
  void poolPriorities.sync();
  let closed = false;
  return {
    catalog, threads, readState, labels, bookmarks, defaults, newChat, chats, boards, created, usage, duties, poolPriorities,
    agentQueue: agentQueue(id => catalog.title(id), defaults),
    prompt: async (id, via) => {
      const sessionFile = await sessionFileFor(id, { listed: async session => (await catalog.summary(session))?.sessionFile, ...(via ? { via } : {}), dataDir, agentDir });
      const title = catalog.title(id);
      return sessionFile ? promptView(id, { sessionFile, dataDir, agentDir, chat: (await chats.ids()).has(id), ...(title ? { title } : {}) }) : null;
    },
    ownerTurn: id => markOwnerTurn(id).catch(error => { dutyLog(`turn queue: owner turn for ${id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`); }),
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(prioritySync);
      if (unloader) clearInterval(unloader);
      stopWatch();
      stopWakes();
      stopAlerts();
      stopBridgeWatch();
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
