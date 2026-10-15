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
import { CorrectionLedger } from "./chat-corrections.ts";
import { claudeReader, markOwnerTurn, readHeldSpawns, setPoolPriority } from "./chat-pool.ts";
import { dutyAdmitter, queueLong, queueReader, sharedQueueRead } from "./chat-turn-queue.ts";
import { readStrays, startMacUsableWatch, TREE_MEMORY_FILE } from "./mac-usable-watch.ts";
import { chatPoolPriority, dutyJobIds, PoolPriorities } from "./chat-pool-priority.ts";
import { agentQueue, type AgentQueue, type IdleEviction } from "./chat-agent-queue.ts";
import { briefCheckRecord, deletedJobRecord, jobRegistry, replyCheckRecord } from "./chat-sources.ts";
import { jobResumes } from "./job-resume.ts";
import { interruptedRuns } from "./chat-resume.ts";
import { FLEET_STOP_FILE, FleetBudget, isProdAlert, readWorkersGb, startsOf } from "./fleet-budget.ts";
import { parkTick, queueView } from "./queue-park.ts";
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
import { promptView } from "./prompt-view.ts";
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
  /** `GET api/threads/<id>/prompt`: the prompt the thread's model gets (src/prompt-view.ts); null for a thread with no session file. Absent in tests that fake a backend. */
  prompt?: (id: string) => Promise<PromptView | null>;
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
  // Every non-owner start the service makes waits for the fleet budget: duty, check-in and fix jobs, send-backs, cut-turn continues and a job's
  // wake. Owner sends, a chat's own wake and alert wakes never ask it.
  const poolWaiting = async (): Promise<Set<string>> => {
    const pool = await queueReading().catch(() => null);
    return new Set([...pool?.working ?? [], ...pool?.queued ?? []].map(entry => entry.session));
  };
  const fleet = new FleetBudget({ gb: () => readWorkersGb(), queue: () => queueReading().catch(() => null), log: dutyLog, stopFile: join(dataDir, FLEET_STOP_FILE),
    live: async session => (await catalog.rows()).some(row => row.id === session && row.working) || (await poolWaiting()).has(session),
    fixLive: async chat => {
      const rows = await catalog.rows();
      const name = rows.find(row => row.id === chat)?.name.trim();
      if (!name) return false;
      const waiting = await poolWaiting();
      for (const row of rows) {
        if (!row.name.startsWith("fix ") || row.archived || !(row.working || waiting.has(row.id))) continue;
        if (await registry.chatOf(row.id) === name) return true;
      }
      return false;
    } });
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
    queueLong: async () => queueLong(await queueReading().catch(() => null)),
    stopped: () => fleet.switchedOff(),
    priority: async id => chatPoolPriority((await labels.snapshot()).threads[id]?.priority ?? 0),
    jobs: dutyJobHost({ threads, archives, rows: () => catalog.rows(), refresh: () => catalog.refresh(), registry, board: id => join(boards.dir, id + ".json"), log: dutyLog, fleet,
      started: id => poolPriorities.set(id, "low"), handoff: id => markOwnerTurn(id) }),
    checkIn: { view: id => chats.checkInView(id), run: (id, trigger) => chats.runCheckIn(id, trigger), measure: id => chats.measureCheckIn(id),
      set: async (id, change, actor) => { const view = await chats.setCheckIn(id, change, actor); if (view) await catalog.notify(); return view; } } });
  // While the fleet stop switch is on, the service's own prompts and restarts (job notices, status asks, continues of stalled runs) are held;
  // the owner's sends go through `threads` directly and never through this.
  const held = async (what: string): Promise<void> => { const stop = await fleet.switchedOff(); if (stop) throw new Error(`${what} held: ${stop}`); };
  const serviceThreads = new Proxy(threads, { get(target, prop, receiver) {
    const value: unknown = Reflect.get(target, prop, receiver);
    if (typeof value !== "function") return value;
    if (prop === "prompt" || prop === "restart") return async (...args: unknown[]) => { await held(String(prop)); return (value as (...a: unknown[]) => unknown).apply(target, args); };
    return (value as (...a: unknown[]) => unknown).bind(target);
  } });
  chats = new Chats(index, serviceThreads, id => catalog.summary(id), extensionBuild(), loadRecord(join(dataDir, "extension-loads.json")),
    { board: id => boards.read(id), rows: () => catalog.rows(), memory: checkInRecord(join(dataDir, "check-ins.json")), registry,
      replyChecks: replyCheckRecord(join(dataDir, "reply-checks.json")),
      briefChecks: briefCheckRecord(join(dataDir, "brief-checks.json")), deletedJobs: deletedJobRecord(join(dataDir, "deleted-jobs.json")),
      strays: readStrays,
      waking: session => waking(join(dataDir, "wakes"), session), wakes: now => pendingWakes(join(dataDir, "wakes"), now),
      starting: chat => startsOf(fleet.queued(), chat),
      resumes: { store: jobResumes(join(dataDir, "job-resumes")), applyBoard: (id, ops) => boards.apply(id, ops, "agent") },
      interrupted: isJob => interruptedRuns.resumeJobs(isJob, async id => { await threads.resume(id); }, fleet),
      settings, claude: claudeReader(), queue: queued, spawns: () => readHeldSpawns(),
      awake: working => awake.update(working), corrections: () => corrections.read(), duty: duties, duties: id => duties.store.list(id),
      dutyJobs: async id => (await duties.store.runs(id)).flatMap(run => run.job ? [run.job.id] : []),
      archived: new IdIndex(join(dataDir, "archived-chats.json"), "Archived chat index"),
      ...(options.ownChatsOnly ? { owned: new IdIndex(join(dataDir, "own-chats.json"), "Own chat index") } : {}) },
    line => process.stderr.write(line + "\n"));
  chats.briefChanged = () => { void catalog.notify().catch(() => {}); };
  const unwatchBoards = boards.watch((id, board) => {
    threads.setBoard(id, board);
    chats.boardChanged(id);
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
    queue: queueReading, log: dutyLog, treeMemoryFile: TREE_MEMORY_FILE, kill: (pid, signal) => { process.kill(pid, signal); },
    notify: async (chat, line) => { if (!threads.isLive(chat)) throw new Error("the chat is not attached"); await threads.notice(chat, line); },
    message: async (root, line) => {
      await held("mac usable ask");
      const active = (await catalog.summary(root))?.activeSessionId;
      if (!active) throw new Error("the thread is not loaded");
      await catalog.connect();
      const response = await catalog.client.request({ type: "send_message", targetActiveSessionId: active, message: line }, 30_000, { recoverable: false });
      if (!response.success) throw new Error(response.error);
    },
    interrupt: async (session, line) => { await held("mac usable interrupt"); await threads.restart(session, line, true); } });
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
  // A job's wake waits for the fleet budget and stays due until it opens; a chat's own wake goes at once.
  const wakeMessage = { ...agentMessage, deliver: async (session: string, text: string): Promise<"sent" | "gone"> => {
    await held("wake");
    if (!(await chats.ids()).has(session)) {
      const done = await fleet.tryAdmit({ kind: "wake", label: session.slice(0, 8) });
      if (!done) throw new Error(`held by the fleet budget: ${await fleet.held() ?? "starts wait"}`);
      done(session);
    }
    return agentMessage.deliver(session, text);
  } };
  const stopWakes = options.ownChatsOnly ? () => {} : startWakes({ dir: join(dataDir, "wakes"), runState: readRunState, stamp: runStamp, log: dutyLog,
    hold: async () => queueLong(await queueReading().catch(() => null)), ...wakeMessage });
  // A prod alert always goes; any other alert waits while the fleet stop switch is on, and the bridge sends it on a later tick.
  const alertMessage = { ...agentMessage, deliver: async (session: string, text: string): Promise<"sent" | "gone"> => {
    if (!isProdAlert(text)) await held("alert");
    return agentMessage.deliver(session, text);
  } };
  const grafanaConfig = join(dataDir, "grafana-alerts.json");
  const pollHealth = new PollHealth();
  const stopAlerts = options.ownChatsOnly ? () => {} : startAlertBridge({ file: join(dataDir, "alert-bridge.json"), alerts: () => pollHealth.poll(() => readGrafanaAlerts(grafanaConfig)),
    owners: () => readOwnersFor(grafanaConfig, homedir()), hasBoard: async session => (await boards.read(session)) !== null,
    boards, log: dutyLog, ...alertMessage });
  const stopBridgeWatch = options.ownChatsOnly ? () => {} : startBridgeWatch({ health: pollHealth, statusFile: join(homedir(), ".cache/virev/alert-bridge-status.json"),
    configFile: grafanaConfig, log: dutyLog, ...alertMessage });
  // A root job whose turn only waits in pi-pool's queue is parked so Prime can unload its worker, and goes back through the fleet budget once a
  // slot is free (src/queue-park.ts).
  let parking = false;
  const parker = options.ownChatsOnly ? undefined : setInterval(() => {
    if (parking) return;
    parking = true;
    void parkTick({ file: join(dataDir, "queue-parked.json"), queue: async () => queueView(await queueReading().catch(() => null)), chats: () => chats.ids(), fleet, log: dutyLog,
      abort: async session => {
        const active = (await catalog.summary(session))?.activeSessionId;
        if (!active) throw new Error("the session is not loaded");
        await catalog.connect();
        const response = await catalog.client.request({ type: "abort", activeSessionId: active }, 30_000, { recoverable: false });
        if (!response.success) throw new Error(response.error);
      },
      resume: (session, text) => threads.restart(session, text, false) })
      .catch(error => dutyLog(`queue park: ${error instanceof Error ? error.message : String(error)}`)).finally(() => { parking = false; });
  }, 60_000);
  parker?.unref();
  const prioritySync = setInterval(() => { void poolPriorities.sync(); }, 30_000);
  prioritySync.unref();
  void poolPriorities.sync();
  let closed = false;
  return {
    catalog, threads, readState, labels, bookmarks, defaults, newChat, chats, boards, created, usage, duties, poolPriorities,
    agentQueue: agentQueue(id => catalog.title(id), defaults),
    prompt: async id => {
      const sessionFile = (await catalog.summary(id))?.sessionFile;
      return sessionFile ? promptView(id, { sessionFile, dataDir, agentDir, chat: (await chats.ids()).has(id) }) : null;
    },
    ownerTurn: id => markOwnerTurn(id).catch(error => { dutyLog(`turn queue: owner turn for ${id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`); }),
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(prioritySync);
      if (parker) clearInterval(parker);
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
