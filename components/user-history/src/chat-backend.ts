import { homedir } from "node:os";
import { join } from "node:path";
import { defaultDaemonSocketPath, getAgentDir, SettingsManager } from "prime-agent";
import { BoardStore } from "./chat-board-store.ts";
import { Catalog } from "./chat-catalog.ts";
import type { HostCatalogs } from "./host-catalogs.ts";
import { ChatLabels } from "./chat-labels.ts";
import { ChatReadState } from "./chat-read-state.ts";
import { ThreadHub } from "./chat-threads.ts";
import { FirstPages } from "./first-page.ts";
import { SessionAutoCompact } from "./session-autocompact.ts";
import { IdleSleepHold } from "./chat-awake.ts";
import { checkInRecord } from "./chat-checkin.ts";
import { checkInSettings } from "./checkin-settings.ts";
import { checkInDuties } from "./checkin-findings.ts";
import { CLEAN_ROOM_CHATS_FILE, CLEAN_ROOM_CORRECTIONS_FILE, CorrectionLedger } from "./chat-corrections.ts";
import { claudeReader, markOwnerTurn, setPoolPriority } from "./chat-pool.ts";
import { boardQueueRead, dutyAdmitter, queueReader } from "./chat-turn-queue.ts";
import { readFootprints, startMacUsableWatch } from "./mac-usable-watch.ts";
import { relayWatch } from "./hosts.ts";
import { ARTIFACTS, deletedFolders, endLeftovers, leftoverSource } from "./job-leftovers.ts";
import { chatPoolPriority, dutyJobIds, dutyJobPriority, PoolPriorities } from "./chat-pool-priority.ts";
import { agentQueue, type AgentQueue, type IdleEviction } from "./chat-agent-queue.ts";
import { briefCheckRecord, deletedJobRecord, jobRegistry, checkRecord } from "./chat-sources.ts";
import { jobResumes } from "./job-resume.ts";
import { cutJobs, interruptedRuns } from "./chat-resume.ts";
import { resumesNow } from "./cut-end.ts";
import { IdleUnloader, unloadRequest } from "./idle-unload.ts";
import { readHeldTurns, writeResumePending } from "./held-turns.ts";
import { recordUnloaded } from "./unloaded.ts";
import { Chats, UNKNOWN_ACTIVE } from "./chats.ts";
import { extensionBuild, loadRecord } from "./chat-brief.ts";
import { Duties } from "./chat-duty-run.ts";
import { fixJobLive } from "./shared/duty-fixes.ts";
import { alertJobBrief, archiveDutyJob, dutyJobHost, dutyJobName, savedChat } from "./chat-duty-job.ts";
import { ArchiveQueue } from "./chat-archive-queue.ts";
import { DutyStore } from "./chat-duty-store.ts";
import { IdIndex } from "./id-index.ts";
import { newChatStore, type NewChatStore } from "./chat-new-chat.ts";
import { ThreadOrigins } from "./thread-origin.ts";
import { isThinkingLevel, type ChatDefaults, type ChatDefaultsInput } from "./shared/types.ts";
import { UsageService } from "./usage/service.ts";
import { startUsagePublisher } from "./usage/publish.ts";
import { addWakeNote, pendingWakes, readRunState, runStamp, startWakes, waking } from "./wakes.ts";
import { BRIEFS_DIR, primeWorkers, startBriefKeeper, unstartedJobs } from "./brief-keeper.ts";
import { readGrafanaAlerts, readOwnersFor, startAlertBridge } from "./alert-bridge.ts";
import { trainFile } from "./checkin-load.ts";
import { startProdTurns } from "./prod-turns.ts";
import { TokenHookWatch, withHookAlert } from "./token-hook-watch.ts";
import { PollHealth, startBridgeWatch } from "./alert-bridge-health.ts";
import { promptView, sessionFileFor } from "./prompt-view.ts";
import { sessionFileOf } from "./send-once.ts";
import { AgentOutbox } from "./agent-outbox.ts";
import { OwnerOutbox } from "./owner-outbox.ts";
import { adoptMoved, REOPENABLE, reopenSession, sendReopening } from "./reopen-send.ts";
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
  /** `<dataDir>/outbox/`: the owner's sends from the composer, on disk until the daemon takes them (src/owner-outbox.ts). */
  outbox: OwnerOutbox;
  /** `<dataDir>/agent-outbox/`: every agent message the service sends, on disk until the daemon takes it (src/agent-outbox.ts). */
  messages: AgentOutbox;
  /** Stops the wake ticker and the agent outbox and waits for its disk writes; the service runs it before it closes its daemon links. */
  drainSends?: () => Promise<void>;
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

/**
 * `ownChatsOnly`: this serve does not own the live chats, so it acts only on the chats it created (`CheckInSource.owned`).
 * `scratch`: a serve on a copy of the live data dir, such as a CPU profile. Its wakes, spawn briefs, archive queue and duties are the live
 * service's, so it starts none of the loops that send, prompt, reopen, archive or write the pool, and it acts only on its own chats. On 10-18 a
 * profile serve on a copy woke 3 jobs and relayed 2 wakes through their parents at 08:25Z, which the live service also sent.
 * `hosts`: the other boxes in hosts.json, whose sessions join the catalog and whose commands go to their own daemons.
 * `copyFile`: where this box's session copy is kept across restarts (`SessionPeer`), so a restart serves the sidebar before any list.
 */
export async function createChatBackend(options: { socketPath?: string; dataDir?: string; agentDir?: string; ownChatsOnly?: boolean; scratch?: boolean; hosts?: HostCatalogs | null; copyFile?: string | null } = {}): Promise<ChatBackend> {
  const scratch = options.scratch === true;
  const ownChatsOnly = options.ownChatsOnly === true || scratch;
  const socketPath = options.socketPath ?? defaultDaemonSocketPath();
  const agentDir = options.agentDir ?? getAgentDir();
  const dataDir = options.dataDir ?? join(agentDir, "browser-chat");
  const treeWorker = primeWorkers(join(agentDir, "daemon-workers"));
  const readState = new ChatReadState(join(dataDir, "read-state.json"));
  const labels = new ChatLabels(join(dataDir, "labels.json"));
  const defaults = chatDefaultsStore(agentDir);
  const newChat = newChatStore(join(dataDir, "new-chat.json"));
  await readState.snapshot().catch(() => null);
  const index = new IdIndex(join(dataDir, "chats.json"), "Chat index");
  const created = new IdIndex(join(dataDir, "threads.json"), "Thread index");
  let chats: Chats;
  // While a chat or one of its jobs works, the service keeps the Mac from idle sleep (10-05: a battery sleep stopped every chat and job).
  const awake = new IdleSleepHold(line => process.stderr.write(`${new Date().toISOString()} ${line}\n`));
  const cleanRoomChats = new IdIndex(join(dataDir, CLEAN_ROOM_CHATS_FILE), "Clean-room chat index");
  const catalog = new Catalog(socketPath, readState, labels, { ids: () => chats.ids(), checkIns: () => chats.checkIns(), links: id => chats.links(id), briefs: () => chats.briefs(), archivedIds: () => chats.archivedIds(), roster: children => chats.roster(children) }, new ThreadOrigins(created, cleanRoomChats), options.hosts ?? null, options.copyFile ?? null);
  const boards = new BoardStore(dataDir);
  const corrections = new CorrectionLedger(dataDir);
  const threads = new ThreadHub(socketPath, catalog, () => defaults.read(), async id => (await chats.ids()).has(id) ? boards.read(id) : undefined,
    { minutes: () => defaults.idleEviction(), held: async (id: string): Promise<boolean> => (await duties.view(id)).some(duty => duty.running),
      file: join(dataDir, "idle-clocks.json") }, new FirstPages(join(dataDir, "first-pages")));
  const registry = jobRegistry(join(dataDir, "chat-jobs.json"));
  const poolPriorities = new PoolPriorities({ rows: () => catalog.rows(), duties: rows => dutyJobIds(rows, registry), set: setPoolPriority,
    log: line => process.stderr.write(`${new Date().toISOString()} ${line}\n`) });
  // Each chat's duties: every run starts one duty job linked to the chat. The standing ones are scheduled here; the built-in check-in duty is
  // scheduled and measured in Chats and handed here, and its card edits the check-in setting.
  const dutyLog = (line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);
  const settings = checkInSettings(join(dataDir, "check-in-settings.json"));
  // A finished duty job's archive runs in the background with retries, so a slow daemon never holds up the next job's start.
  const archives = new ArchiveQueue({ path: join(dataDir, "duty-archive-queue.json"), archive: archiveDutyJob(threads, () => catalog.rows()), log: dutyLog, ...scratch ? { tickMs: 0 } : {} });
  // Duty and check-in jobs wait for the Mac-wide turn queue before their session is created; a restart releases the keys its killed waits left.
  const turns = dutyAdmitter({ log: dutyLog });
  const queueReading = boardQueueRead;
  const queued = queueReader(queueReading);
  const poolWaiting = async (): Promise<Set<string>> => {
    const pool = await queueReading().catch(() => null);
    return new Set([...pool?.working ?? [], ...pool?.queued ?? []].map(entry => entry.session));
  };
  const dutyJobs = dutyJobHost({ threads, archives, rows: () => catalog.rows(), refresh: () => catalog.refresh(), registry,
    saved: async id => { const file = await sessionFileOf(id, agentDir); return file ? savedChat(file) : null; }, board: id => join(boards.dir, id + ".json"), log: dutyLog,
    started: async (id, chat, name) => poolPriorities.set(id, dutyJobPriority(name, chatPoolPriority((await labels.snapshot()).threads[chat.id]?.priority ?? 0))),
    handoff: id => markOwnerTurn(id) });
  const duties = new Duties(new DutyStore(dataDir), { isChat: async id => (await chats.ids()).has(id), log: dutyLog, admit: turns.admit, ...scratch ? { tickMs: 0 } : {},
    board: id => boards.read(id), applyBoard: async (id, ops) => { await boards.apply(id, ops, "agent"); },
    fixLive: async (id, item) => {
      const now = Date.now();
      const asleep = new Set((await pendingWakes(join(dataDir, "wakes"), now).catch(() => [])).map(wake => wake.session));
      const pool = await queueReading().catch(() => null);
      const waiting = new Set([...pool?.working ?? [], ...pool?.queued ?? []].map(entry => entry.session));
      return fixJobLive(item, id, await catalog.rows(), asleep, waiting, now);
    },
    priority: async id => chatPoolPriority((await labels.snapshot()).threads[id]?.priority ?? 0),
    jobs: dutyJobs,
    checkIn: { view: id => chats.checkInView(id), run: (id, trigger) => chats.runCheckIn(id, trigger), measure: id => chats.measureCheckIn(id),
      set: async (id, change, actor) => { const view = await chats.setCheckIn(id, change, actor); if (view) await catalog.notify(); return view; } } });
  chats = new Chats(index, threads, id => catalog.summary(id), extensionBuild(), loadRecord(join(dataDir, "extension-loads.json")),
    { board: id => boards.read(id), boardView: id => boards.view(id), rows: () => catalog.rows(), memory: checkInRecord(join(dataDir, "check-ins.json")), registry,
      correctionChecks: checkRecord(join(dataDir, "correction-checks.json")),
      briefChecks: briefCheckRecord(join(dataDir, "brief-checks.json")), deletedJobs: deletedJobRecord(join(dataDir, "deleted-jobs.json")),
      leftovers: (dir, session) => endLeftovers(leftoverSource, dir, session),
      deletedLeftovers: async chat => endLeftovers(leftoverSource, await deletedFolders(join(ARTIFACTS, chat))),
      waking: session => waking(join(dataDir, "wakes"), session), wakes: now => pendingWakes(join(dataDir, "wakes"), now),
      wakeNote: (session, text) => addWakeNote(join(dataDir, "wakes"), session, text),
      resumes: { store: jobResumes(join(dataDir, "job-resumes")), applyBoard: (id, ops) => boards.apply(id, ops, "agent") },
      interrupted: async (isJob, owners) => interruptedRuns.resumeJobs(isJob, async id => { await threads.resume(id); }, owners, cut => writeResumePending(dataDir, cut, Date.now()),
        await cutJobs(dataDir, [...await chats.ids()]), async id => {
          await threads.abort(id);
          await threads.settled(id);
          // A native abort holds the session's input until the next human prompt; reopen it so the continue gets through (as Resume does).
          await threads.resumeQueue(id).catch(() => {});
        }),
      held: now => readHeldTurns(dataDir, now),
      unstarted: async now => unstartedJobs(join(dataDir, BRIEFS_DIR), now, treeWorker),
      settings, claude: claudeReader(), queue: queued,
      awake: working => awake.update(working), corrections: () => corrections.read(), duty: duties,
      cleanRoom: async id => (await cleanRoomChats.ids()).includes(id) ? new CorrectionLedger(dataDir, CLEAN_ROOM_CORRECTIONS_FILE).read() : null, duties: id => checkInDuties(duties.store, id, async other => (await chats.ids()).has(other)),
      dutyJobs: async id => (await duties.store.runs(id)).flatMap(run => run.job ? [run.job.id] : []),
      dutyRuns: id => duties.store.runs(id), prs: prStates(),
      archived: new IdIndex(join(dataDir, "archived-chats.json"), "Archived chat index"),
      ...(ownChatsOnly ? { owned: new IdIndex(join(dataDir, "own-chats.json"), "Own chat index") } : {}), ...scratch ? { tickMs: 0 } : {} },
    line => process.stderr.write(line + "\n"));
  chats.briefChanged = () => { void catalog.notify().catch(() => {}); };
  catalog.onCut(cut => { if (resumesNow(cut, Date.now())) chats.interruptedSoon(0); });
  catalog.onSupervisorChange(() => {
    dutyLog("chats: the Prime daemon has a new supervisor; the pass over interrupted jobs runs soon");
    chats.interruptedSoon();
  });
  const unwatchBoards = boards.watch((id, board) => {
    threads.setBoard(id, board);
    if (!scratch) void duties.boardChanged(id, board).catch(error => dutyLog(`duties: board change of ${id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`));
  },
    error => process.stderr.write(`boards: ${error instanceof Error ? error.message : String(error)}\n`));
  // A chat over 100 MB is compacted after its Prime compaction, in a child process (src/session-autocompact.ts). Another box's chat is left to that box.
  const autoCompact = new SessionAutoCompact({ socketPath, log: dutyLog });
  const unobserveCompaction = scratch ? () => {} : threads.observe({ live: () => {}, children: () => {}, idle: () => {},
    compacted: (id, file) => {
      if (catalog.hostOf(id) !== null) return;
      void chats.ids().then(ids => ids.has(id) ? autoCompact.compacted(id, file) : null).catch(error => dutyLog(`session compact ${id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`));
    } });
  // The usage worker thread reads the transcripts and owns usage.duckdb; its first build runs in the background.
  const usage = new UsageService({ dataDir, log: line => process.stderr.write(`${new Date().toISOString()} ${line}\n`) });
  usage.start();
  catalog.ratesSource = ids => usage.rates(ids);
  catalog.queueSource = queued;
  catalog.wakesSource = now => pendingWakes(join(dataDir, "wakes"), now);
  if (!scratch) void turns.sweep(async id => (await chats.ids()).has(id)).catch(error => dutyLog(`turn queue: sweep: ${error instanceof Error ? error.message : String(error)}`));
  catalog.linkSessions = (id, links) => boards.linkSessions(id, links)
    .catch(error => { process.stderr.write(`boards: ${id}: ${error instanceof Error ? error.message : String(error)}\n`); });
  // Publishes usage aggregates to virev.ai/sieun when ~/Library/Application Support/sieun-usage-push/config.json exists.
  const stopPublish = scratch ? () => {} : await startUsagePublisher(usage, line => process.stderr.write(`${new Date().toISOString()} ${line}\n`));
  // One watch line a minute with this box's numbers and, through each relay, every other box's (src/mac-usable-watch.ts HostWatchLine).
  const stopWatch = ownChatsOnly ? async () => {} : startMacUsableWatch({ dataDir, rows: () => catalog.daemonRows(), chats: () => chats.ids(), title: id => catalog.title(id),
    queue: queueReading, log: dutyLog, idleMinutes: () => defaults.idleEviction(), ...catalog.selfHostName() ? { host: catalog.selfHostName()! } : {},
    remotes: () => catalog.remoteHosts().map(({ host, rows }) => ({ name: host.name, rows, read: pids => relayWatch(host, pids) })) });
  // Every agent message the service sends waits on disk until the daemon takes it, and one that may have gone is looked for before it goes
  // again (src/agent-outbox.ts). A scratch serve keeps its own folder, so it never delivers the live service's messages.
  const agentOutbox = new AgentOutbox(join(dataDir, scratch ? "agent-outbox-scratch" : "agent-outbox"), { log: dutyLog,
    send: async (session, text) => {
      const response = await sendReopening(session, async () => (await catalog.daemonFor(session)).request({ type: "send_message", targetActiveSessionId: session, message: text }, 30_000, { recoverable: false }),
        id => reopenSession(catalog, { agentDir, adopt: root => adoptMoved(root, agentDir) }, id), dutyLog);
      if (response.success) return "sent";
      // A subagent still unreachable after the reopen is relayed through its parent (AgentOutbox).
      if (REOPENABLE.test(response.error)) return "gone";
      throw new Error(response.error);
    },
    target: async session => {
      const client = await catalog.daemonFor(session).catch(() => null);
      const response = client && await client.request({ type: "get_state", activeSessionId: session }, 30_000, { recoverable: false }).catch(() => null);
      if (!response) return null;
      if (!response.success) return REOPENABLE.test(response.error) ? { queued: [], busy: false } : null;
      const data = response.data as { sessionActions?: { steering?: unknown; followUps?: unknown }; isStreaming?: unknown; isCompacting?: unknown;
        isRunningTools?: unknown; unfinishedActionCount?: unknown };
      const actions = data.sessionActions;
      const unfinished = typeof data.unfinishedActionCount === "number" ? data.unfinishedActionCount : undefined;
      return { queued: [actions?.steering, actions?.followUps].flatMap(list => Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []),
        busy: data.isStreaming === true || data.isCompacting === true || data.isRunningTools === true || (unfinished ?? 0) > 0, ...unfinished === undefined ? {} : { unfinished } };
    },
    fileOf: async session => await sessionFileFor(session, { listed: async id => (await catalog.summary(id))?.sessionFile, dataDir, agentDir }) ?? sessionFileOf(session, agentDir),
    startRoot: async root => {
      if (!await reopenSession(catalog, { agentDir }, root)) throw new Error(`no session file for root ${root.slice(0, 8)}`);
    } });
  const agentMessage = { deliver: (session: string, text: string, root?: string) => agentOutbox.deliver(session, text, root) };
  const stopWakes = scratch ? () => {} : startWakes({ dir: join(dataDir, "wakes"), runState: readRunState, stamp: runStamp, log: dutyLog, ...agentMessage });
  const stopBriefs = scratch ? () => {} : startBriefKeeper({ dir: join(dataDir, BRIEFS_DIR), worker: treeWorker, log: dutyLog, ...agentMessage,
    restart: async (record, text) => {
      const chat = await dutyJobs.chat(record.root);
      if (!chat) throw new Error(`no chat ${record.root.slice(0, 8)}`);
      return (await dutyJobs.start(chat, record.name || record.id, text(chat.name))).id;
    } });
  const grafanaConfig = join(dataDir, "grafana-alerts.json");
  const pollHealth = new PollHealth();
  const hookWatch = new TokenHookWatch({ sessionsDir: join(agentDir, "sessions") });
  const stopAlerts = ownChatsOnly ? () => {} : startAlertBridge({ file: join(dataDir, "alert-bridge.json"),
    alerts: () => pollHealth.poll(() => withHookAlert(readGrafanaAlerts(grafanaConfig), hookWatch)),
    owners: () => readOwnersFor(grafanaConfig, homedir()), hasBoard: async session => (await boards.read(session)) !== null,
    startJob: async (chatId, steps) => {
      const chat = await dutyJobs.chat(chatId);
      if (!chat) throw new Error(`no chat ${chatId.slice(0, 8)}`);
      const at = Date.now();
      const name = dutyJobName("alert", chat.name, at);
      return await dutyJobs.start(chat, name, alertJobBrief(chat, name, at, steps), false, at);
    },
    jobWorking: job => dutyJobs.working(job),
    boards, log: dutyLog, ...agentMessage });
  const stopProdTurns = ownChatsOnly ? () => {} : startProdTurns({ runsFile: trainFile(), bridgeFile: join(dataDir, "alert-bridge.json"), log: dutyLog });
  const stopBridgeWatch = ownChatsOnly ? () => {} : startBridgeWatch({ health: pollHealth, statusFile: join(homedir(), ".cache/virev/alert-bridge-status.json"),
    configFile: grafanaConfig, log: dutyLog, ...agentMessage });
  // An idle root job, dormant chat or subagent stops after idleEvictionMinutes, and a session that ended its task after ENDED_MS, since Prime's own
  // sweeps fail under load. A quiet worker that grew past RECYCLE_OWN_BYTES is recycled. Each sweep starts its stops at once and does not wait
  // for a slow kill (src/idle-unload.ts IdleUnloader). Every box's idle sessions stop from here, since the chat service is the one place that
  // knows which chats a tab or the pool holds.
  const unloader_ = new IdleUnloader({
    rows: () => [...catalog.daemonRows(), ...catalog.remoteRows()],
    localRows: () => catalog.daemonRows(),
    idleMs: () => { const minutes = defaults.idleEviction(); return minutes === "off" ? null : minutes * 60_000; },
    chats: () => chats.ids(),
    dormant: id => threads.isDormant(id),
    pool: () => poolWaiting(),
    waking: async now => new Set((await pendingWakes(join(dataDir, "wakes"), now).catch(() => [])).map(wake => wake.session)),
    own: async pids => {
      const footprints = await readFootprints([...pids]);
      return new Map(Object.entries(footprints.workers).map(([pid, worker]) => [Number(pid), worker.own ?? 0] as const));
    },
    restNow: (id, quietMs) => threads.restNow(id, quietMs),
    title: id => catalog.title(id),
    request: (row, type) => unloadRequest(catalog.clientFor(row.activeSessionId!), row.activeSessionId!, type),
    stopped: async (row, isChat, since) => {
      await recordUnloaded(dataDir, [row.sessionId], Date.now()).catch(error => dutyLog(`idle unload: record ${row.sessionId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`));
      // The daemon's kill writes the archived state, which would hide a chat until the next service start unarchived it (Chats.adopt) and the
      // owner's plain thread (threads.json) for good. A chat he archived stays archived, and so does a thread an archive reached since `since`.
      const listed = isChat || ((await created.ids()).includes(row.sessionId) && !(await chats.archivedIds()).has(row.sessionId));
      if (listed) await threads.keepListed(row.sessionId, since).catch(error => dutyLog(`idle unload: keep listed ${row.sessionId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`));
    },
    log: dutyLog,
    now: () => Date.now(),
  });
  let unloading = false;
  const unloader = ownChatsOnly ? undefined : setInterval(() => {
    if (unloading) return;
    unloading = true;
    void unloader_.sweep().catch(error => dutyLog(`idle unload: ${error instanceof Error ? error.message : String(error)}`)).finally(() => { unloading = false; });
  }, 60_000);
  unloader?.unref();
  const prioritySync = scratch ? undefined : setInterval(() => { void poolPriorities.sync(); }, 30_000);
  prioritySync?.unref();
  if (!scratch) void poolPriorities.sync();
  const ownerTurn = (id: string) => markOwnerTurn(id).catch(error => { dutyLog(`turn queue: owner turn for ${id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`); });
  // A scratch serve's data dir is a copy of the live one, so it keeps its own outbox: the live service delivers the sends in "outbox".
  const outbox = new OwnerOutbox(join(dataDir, scratch ? "outbox-scratch" : "outbox"), { threads, chats, catalog, ownerTurn }, dutyLog);
  let closed = false;
  return {
    catalog, threads, readState, labels, defaults, newChat, chats, boards, created, usage, duties, poolPriorities,
    agentQueue: agentQueue(id => catalog.title(id), defaults),
    drainSends: async () => { stopWakes(); await agentOutbox.close(); },
    prompt: async (id, via) => {
      const sessionFile = await sessionFileFor(id, { listed: async session => (await catalog.summary(session))?.sessionFile, ...(via ? { via } : {}), dataDir, agentDir });
      const title = catalog.title(id);
      return sessionFile ? promptView(id, { sessionFile, dataDir, agentDir, chat: (await chats.ids()).has(id), ...(title ? { title } : {}) }) : null;
    },
    ownerTurn, outbox, messages: agentOutbox,
    async close() {
      if (closed) return;
      closed = true;
      // First, so the line of the minute it stops in goes out while the rest closes (startMacUsableWatch).
      const watchStopped = stopWatch();
      await outbox.close();
      await agentOutbox.close();
      await watchStopped;
      clearInterval(prioritySync);
      if (unloader) clearInterval(unloader);
      stopWakes();
      stopBriefs();
      stopAlerts();
      stopProdTurns();
      stopBridgeWatch();
      unwatchBoards();
      unobserveCompaction();
      stopPublish();
      duties.close();
      archives.close();
      chats.close();
      awake.close();
      await threads.close();
      await catalog.close();
      await usage.close();
    },
  };
}
