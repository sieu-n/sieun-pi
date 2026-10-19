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
import { checkInRecord, JOB_CLEANUP_EVERY_MS } from "./chat-checkin.ts";
import { checkInSettings } from "./checkin-settings.ts";
import { checkInDuties } from "./checkin-findings.ts";
import { CLEAN_ROOM_CHATS_FILE, CLEAN_ROOM_CORRECTIONS_FILE, CorrectionLedger } from "./chat-corrections.ts";
import { claudeReader, markOwnerTurn, poolAdmits, readPoolClasses, readPoolStatus, setPoolPriority } from "./chat-pool.ts";
import { relayStats } from "./chat-hosts.ts";
import { boardQueueRead, hostsQueueRead, queueReader } from "./chat-turn-queue.ts";
import { readCallHandles, readFootprints, startMacUsableWatch } from "./mac-usable-watch.ts";
import { CallWatch } from "./hung-calls.ts";
import { CallStopper } from "./hung-stop.ts";
import { HostReach } from "./host-reach.ts";
import { relayWatch } from "./hosts.ts";
import { ARTIFACTS, dryLeftoverSource, hostLeftovers, leftoverSource, sshLeftovers } from "./job-leftovers.ts";
import { ALERT_TRIAGE_DUTY, chatPoolPriority, dutyJobIds, dutyJobPriority, PoolPriorities } from "./chat-pool-priority.ts";
import { agentQueue, type AgentQueue, type IdleEviction } from "./chat-agent-queue.ts";
import { briefCheckRecord, deletedJobRecord, jobRegistry, checkRecord, quietJobRecord } from "./chat-sources.ts";
import { jobResumes } from "./job-resume.ts";
import { cutJobs, interruptedRuns } from "./chat-resume.ts";
import { resumesNow, tailLines } from "./cut-end.ts";
import { IdleUnloader, providerWaits, unloadRequest } from "./idle-unload.ts";
import { readHeldTurns, readTurnSince, writeResumePending } from "./held-turns.ts";
import { recordUnloaded, writeReceipt } from "./unloaded.ts";
import { quietMinutes } from "./quiet-minutes.ts";
import { startTmpSweep } from "./tmp-sweep.ts";
import { Chats, UNKNOWN_ACTIVE } from "./chats.ts";
import { extensionBuild, loadRecord } from "./chat-brief.ts";
import { Duties } from "./chat-duty-run.ts";
import { fixLiveReader } from "./shared/duty-fixes.ts";
import { alertJobBrief, archiveDutyJob, dutyJobHost, dutyJobName, savedChat } from "./chat-duty-job.ts";
import { ArchiveQueue } from "./chat-archive-queue.ts";
import { DutyStore } from "./chat-duty-store.ts";
import { IdIndex } from "./id-index.ts";
import { newChatStore, type NewChatStore } from "./chat-new-chat.ts";
import { ThreadOrigins } from "./thread-origin.ts";
import { isThinkingLevel, type ChatDefaults, type ChatDefaultsInput } from "./shared/types.ts";
import { grafanaPrometheus, Usage } from "./usage/lgtm.ts";
import { pendingWakes, readRunState, runStamp, startWakes, waking } from "./wakes.ts";
import { BRIEFS_DIR, primeWorkers, startBriefKeeper, unstartedJobs } from "./brief-keeper.ts";
import { readOwnersFor, startAlertBridge } from "./alert-bridge.ts";
import { startBridgeWatch } from "./alert-bridge-health.ts";
import { startAlertPoll } from "./alert-poll.ts";
import { promptView, sessionFileFor } from "./prompt-view.ts";
import { sessionFileOf } from "./send-once.ts";
import { AgentOutbox, stopRecords } from "./agent-outbox.ts";
import { OwnerOutbox } from "./owner-outbox.ts";
import type { AgentKind } from "./outbox.ts";
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
  /** Settings > Usage, the Throughput line and the Agents card tok/s: token usage of every box, read from LGTM. Absent in tests that fake a backend. */
  usage?: Usage;
  /** `<dataDir>/duties/`: each chat's standing duties and their runs; the runner ticks every 30 s. Absent in tests that fake a backend. */
  duties?: Duties;
  /** Each live root's pool class (`pi-pool priority`), synced every 30 s and after a priority label change. Absent in tests that fake a backend. */
  poolPriorities?: PoolPriorities;
  /** Settings > This Mac > Agent queue: `pi-pool queue --json`, the queue switch and its two limits, and the daemon's idle unload time. Absent in tests that fake a backend. */
  agentQueue?: AgentQueue;
  /** This box's hung tool calls from the watch's newest minute (src/hung-calls.ts), which Settings > Hosts counts as hung. Absent in tests that fake a backend. */
  calls?: CallWatch;
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
 * `replay`: a scratch serve on a recorded fake daemon (`serve --replay-daemon`), whose threads attach as a live serve's do.
 * `hosts`: the other boxes in hosts.json, whose sessions join the catalog and whose commands go to their own daemons.
 * `copyFile`: where this box's session copy is kept across restarts (`SessionPeer`), so a restart serves the sidebar before any list.
 */
export async function createChatBackend(options: { socketPath?: string; dataDir?: string; agentDir?: string; ownChatsOnly?: boolean; scratch?: boolean; replay?: boolean; hosts?: HostCatalogs | null; copyFile?: string | null } = {}): Promise<ChatBackend> {
  const scratch = options.scratch === true;
  // A replay serve runs the loops a live start runs whose only effects are daemon commands, which all reach the recorded fake daemon, and
  // writes in its data dir copy. Whatever reaches past those (job leftovers, GitHub, the spawn ledger, Grafana, duty measures,
  // compaction) stays off or dry. `quiet` is a scratch serve without it.
  const replay = scratch && options.replay === true;
  const quiet = scratch && !replay;
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
      file: join(dataDir, "idle-clocks.json") }, new FirstPages(join(dataDir, "first-pages")), quiet, join(dataDir, "saved-archive-queue.json"));
  const registry = jobRegistry(join(dataDir, "chat-jobs.json"));
  const poolPriorities = new PoolPriorities({ rows: () => catalog.rows(), duties: rows => dutyJobIds(rows, registry), read: readPoolClasses, set: setPoolPriority,
    log: line => process.stderr.write(`${new Date().toISOString()} ${line}\n`) });
  // Each chat's duties: every run starts one duty job linked to the chat. The standing ones are scheduled here; the built-in check-in duty is
  // scheduled and measured in Chats and handed here, and its card edits the check-in setting.
  const dutyLog = (line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);
  const settings = checkInSettings(join(dataDir, "check-in-settings.json"));
  // A finished duty job's archive runs in the background with retries, so a slow daemon never holds up the next job's start.
  const archives = new ArchiveQueue({ path: join(dataDir, "duty-archive-queue.json"), archive: archiveDutyJob(threads, () => catalog.rows()), log: dutyLog, ...quiet ? { tickMs: 0 } : {} });
  const queueReading = boardQueueRead;
  // A Mac chat's jobs wait in the Mac's pool, so its check-in, its agents and its duties read every box's queue (`hostsQueueRead`).
  const hostsReading = hostsQueueRead(queueReading, () => catalog.remoteHosts().map(({ host }) => () => relayStats(host)));
  const queued = queueReader(hostsReading);
  const poolWaiting = async (): Promise<Set<string>> => {
    const pool = await hostsReading().catch(() => null);
    return new Set([...pool?.working ?? [], ...pool?.queued ?? []].map(entry => entry.session));
  };
  const dutyJobs = dutyJobHost({ threads, archives, rows: () => catalog.rows(), refresh: () => catalog.refresh(), registry,
    saved: async id => { const file = await sessionFileOf(id, agentDir); return file ? savedChat(file) : null; }, sessionFile: id => sessionFileOf(id, agentDir),
    board: id => join(boards.dir, id + ".json"), log: dutyLog,
    started: async (id, chat, name) => poolPriorities.set(id, dutyJobPriority(name, chatPoolPriority((await labels.snapshot()).threads[chat.id]?.priority ?? 0))) });
  const duties = new Duties(new DutyStore(dataDir), { isChat: async id => (await chats.ids()).has(id), log: dutyLog, ...quiet ? { tickMs: 0 } : {},
    ...replay ? { precheckCommand: () => ["/bin/sh", "-c", 'printf \'{"metrics":{}}\' > "$OUTPUT_FILE"'] } : {},
    board: id => boards.read(id), applyBoard: async (id, ops) => { await boards.apply(id, ops, "agent"); },
    fixLive: fixLiveReader({ rows: () => catalog.rows(), asleep: async now => (await pendingWakes(join(dataDir, "wakes"), now)).map(wake => wake.session),
      pool: poolWaiting, held: () => chats.poolHeldSessions() }),
    priority: async id => chatPoolPriority((await labels.snapshot()).threads[id]?.priority ?? 0),
    jobs: dutyJobs, poolAdmits,
    checkIn: { view: id => chats.checkInView(id), run: (id, trigger, rerunOf) => chats.runCheckIn(id, trigger, rerunOf), measure: id => chats.measureCheckIn(id),
      set: async (id, change, actor) => { const view = await chats.setCheckIn(id, change, actor); if (view) await catalog.notify(); return view; } } });
  // A gone job's leftovers end on the box whose daemon runs its folder's session; a replay serve stops nothing anywhere.
  const jobEnds = hostLeftovers({ local: replay ? dryLeftoverSource : leftoverSource, remote: replay ? undefined : sshLeftovers,
    hostOf: id => { const name = catalog.hostOf(id); return name ? catalog.remoteHosts().find(({ host }) => host.name === name)?.host ?? null : null; } });
  chats = new Chats(index, threads, id => catalog.summary(id), extensionBuild(), loadRecord(join(dataDir, "extension-loads.json")),
    { board: id => boards.read(id), boardView: id => boards.view(id), rows: () => catalog.rows(), memory: checkInRecord(join(dataDir, "check-ins.json")), registry,
      correctionChecks: checkRecord(join(dataDir, "correction-checks.json")),
      briefChecks: briefCheckRecord(join(dataDir, "brief-checks.json")), deletedJobs: deletedJobRecord(join(dataDir, "deleted-jobs.json")), quietJobs: quietJobRecord(join(dataDir, "quiet-jobs.json")),
      leftovers: (dir, session) => jobEnds.leftovers(dir, session),
      deletedLeftovers: chat => jobEnds.deleted(chat),
      waking: session => waking(join(dataDir, "wakes"), session), wakes: now => pendingWakes(join(dataDir, "wakes"), now),
      resumes: { store: jobResumes(join(dataDir, "job-resumes")), applyBoard: (id, ops) => boards.apply(id, ops, "agent") },
      // resume_paused.py sends its continues to the live daemon itself, so a replay serve only reads the cut jobs.
      interrupted: replay ? async () => { await cutJobs(dataDir, [...await chats.ids()], ARTIFACTS); return null; } : async (isJob, owners) => interruptedRuns.resumeJobs(isJob, id => threads.reopenFailed(id), owners, cut => writeResumePending(dataDir, cut, Date.now()),
        await cutJobs(dataDir, [...await chats.ids()]), async id => {
          await threads.abort(id);
          await threads.settled(id);
          // A native abort holds the session's input until the next human prompt; reopen it so the continue gets through (as Resume does).
          await threads.resumeQueue(id).catch(() => {});
        }),
      held: now => readHeldTurns(dataDir, now),
      unstarted: async now => unstartedJobs(join(dataDir, BRIEFS_DIR), now, treeWorker),
      settings, claude: claudeReader(), poolAdmits, poolHeldFile: join(dataDir, "pool-held.json"), queue: queued,
      awake: working => awake.update(working), corrections: () => corrections.read(), duty: duties,
      cleanRoom: async id => (await cleanRoomChats.ids()).includes(id) ? new CorrectionLedger(dataDir, CLEAN_ROOM_CORRECTIONS_FILE).read() : null, duties: id => checkInDuties(duties.store, id, async other => (await chats.ids()).has(other)),
      dutyJobs: async id => (await duties.store.runs(id)).flatMap(run => run.job ? [run.job.id] : []),
      dutyRuns: id => duties.store.runs(id), prs: replay ? async () => new Map() : prStates(),
      archived: new IdIndex(join(dataDir, "archived-chats.json"), "Archived chat index"), cleanRoomChats,
      ...(ownChatsOnly ? { owned: new IdIndex(join(dataDir, "own-chats.json"), "Own chat index") } : {}), ...quiet ? { tickMs: 0 } : {} },
    line => process.stderr.write(line + "\n"));
  chats.briefChanged = () => { void catalog.notify().catch(() => {}); };
  catalog.onCut(cut => { if (resumesNow(cut, Date.now())) chats.interruptedSoon(0); });
  catalog.onSupervisorChange(() => {
    dutyLog("chats: the Prime daemon has a new supervisor; the pass over interrupted jobs runs soon");
    chats.interruptedSoon();
  });
  const unwatchBoards = boards.watch((id, board) => {
    threads.setBoard(id, board);
    if (!quiet) void duties.boardChanged(id, board).catch(error => dutyLog(`duties: board change of ${id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`));
  },
    error => process.stderr.write(`boards: ${error instanceof Error ? error.message : String(error)}\n`));
  // A chat over 100 MB is compacted after its Prime compaction, in a child process (src/session-autocompact.ts). Another box's chat is left to that box.
  const autoCompact = new SessionAutoCompact({ socketPath, log: dutyLog });
  const unobserveCompaction = scratch ? () => {} : threads.observe({ live: () => {}, children: () => {}, idle: () => {},
    compacted: (id, file) => {
      if (catalog.hostOf(id) !== null) return;
      void chats.ids().then(ids => ids.has(id) ? autoCompact.compacted(id, file) : null).catch(error => dutyLog(`session compact ${id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`));
    } });
  // Token usage of every box comes from LGTM only (src/usage/lgtm.ts); nothing is queried until a page subscribes or the Agents card asks for rates.
  const usage = new Usage(grafanaPrometheus(join(dataDir, "grafana-alerts.json")));
  catalog.ratesSource = ids => usage.rates(ids);
  catalog.queueSource = async () => (await queued()).queued;
  catalog.wakesSource = now => pendingWakes(join(dataDir, "wakes"), now);
  catalog.linkSessions = (id, links) => boards.linkSessions(id, links)
    .catch(error => { process.stderr.write(`boards: ${id}: ${error instanceof Error ? error.message : String(error)}\n`); });
  // Which other boxes Tailscale reads offline (src/host-reach.ts), for the watch and the outbox, which leave such a box alone until it is back.
  const reach = options.hosts?.reach ?? new HostReach({ addressOf: name => catalog.remoteHosts().find(({ host }) => host.name === name)?.host.address, log: dutyLog });
  // One watch line a minute with this box's numbers and, through each relay, every other box's (src/mac-usable-watch.ts HostWatchLine).
  const calls = new CallWatch();
  // A hung call's bash() commands get stopped so its await returns, on a live serve only; the session hears why through the outbox, which is
  // made below and first used once a call has been silent an hour.
  const stop = new CallStopper({ handles: readCallHandles, kill: (pid, signal) => { process.kill(pid, signal); }, log: dutyLog,
    tell: (session, root, text) => agentOutbox.deliver(session, text, root) });
  const stopWatch = ownChatsOnly && !replay ? async () => {} : startMacUsableWatch({ dataDir, rows: () => catalog.daemonRows(), chats: () => chats.ids(), title: id => catalog.title(id),
    queue: queueReading, log: dutyLog, calls, ...scratch ? {} : { stop }, ...catalog.selfHostName() ? { host: catalog.selfHostName()! } : {},
    remotes: () => catalog.remoteHosts().map(({ host, rows }) => ({ name: host.name, rows, read: pids => relayWatch(host, pids), reach: () => reach.reach(host.name) })) });
  // Every agent message the service sends waits on disk until the daemon takes it, and one that may have gone is looked for before it goes
  // again (src/agent-outbox.ts). A scratch serve keeps its own folder, so it never delivers the live service's messages.
  const agentOutbox = new AgentOutbox(join(dataDir, quiet ? "agent-outbox-scratch" : "agent-outbox"), { log: dutyLog, hostOf: session => catalog.hostOf(session), reach: host => reach.reach(host),
    stopped: stopRecords(dataDir),
    send: async (session, text) => {
      const response = await sendReopening(session, async () => (await catalog.daemonFor(session)).request({ type: "send_message", targetActiveSessionId: session, message: text }, 30_000, { recoverable: false }),
        id => reopenSession(catalog, { agentDir, ...replay ? {} : { adopt: (root: string) => adoptMoved(root, agentDir) } }, id), dutyLog);
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
    // Another box's session reads this box's relay copy of its file, since the path on that box does not open here: until 10-19 every landed
    // and obsolete check of a Mac target read nothing, and a lost head to 01a15427 held 15 messages for over an hour.
    fileOf: async session => {
      if (!catalog.hostOf(session)) return await sessionFileFor(session, { listed: async id => (await catalog.summary(id))?.sessionFile, dataDir, agentDir }) ?? sessionFileOf(session, agentDir);
      const summary = await catalog.summary(session);
      return (summary && await catalog.localFile(summary)) ?? null;
    },
    open: async session => {
      const summary = await catalog.summary(session);
      return !!summary && !summary.workerState && await reopenSession(catalog, { agentDir }, session);
    },
    startRoot: async root => {
      if (!await reopenSession(catalog, { agentDir }, root)) throw new Error(`no session file for root ${root.slice(0, 8)}`);
    } });
  const agentMessage = { deliver: (session: string, text: string, root?: string, kind?: AgentKind, setAt?: number) => agentOutbox.deliver(session, text, root, kind, setAt) };
  const stopWakes = quiet ? () => {} : startWakes({ dir: join(dataDir, "wakes"), runState: replay ? async () => ({ done: false }) : readRunState, stamp: runStamp, log: dutyLog, ...agentMessage });
  const stopBriefs = quiet ? () => {} : startBriefKeeper({ dir: join(dataDir, BRIEFS_DIR), worker: treeWorker, log: dutyLog, ...agentMessage,
    restart: async (record, text) => {
      const chat = await dutyJobs.chat(record.root);
      if (!chat) throw new Error(`no chat ${record.root.slice(0, 8)}`);
      return (await dutyJobs.start(chat, record.name || record.id, text(chat.name))).id;
    } });
  const grafanaConfig = join(dataDir, "grafana-alerts.json");
  const statusFile = join(homedir(), ".cache/virev/alert-bridge-status.json");
  const alertPoll = ownChatsOnly ? null : startAlertPoll({ grafanaConfig, sessionsDir: join(agentDir, "sessions"), statusFile }, dutyLog);
  const stopAlerts = !alertPoll ? () => {} : startAlertBridge({ file: join(dataDir, "alert-bridge.json"),
    alerts: () => alertPoll.alerts(),
    owners: () => readOwnersFor(grafanaConfig, homedir()), hasBoard: async session => (await boards.read(session)) !== null,
    startJob: async (chatId, lines, previous) => {
      const chat = await dutyJobs.chat(chatId);
      if (!chat) throw new Error(`no chat ${chatId.slice(0, 8)}`);
      const at = Date.now();
      const name = dutyJobName(ALERT_TRIAGE_DUTY, chat.name, at);
      return await dutyJobs.start(chat, name, alertJobBrief(chat, name, at, lines, previous), at);
    },
    jobWorking: job => dutyJobs.working(job),
    jobTurn: async (job, since) => {
      const file = await sessionFileFor(job.id, { listed: async id => (await catalog.summary(id))?.sessionFile, dataDir, agentDir }) ?? await sessionFileOf(job.id, agentDir);
      return file ? readTurnSince(file, since) : { ran: false };
    },
    retryJob: () => chats.interruptedSoon(0),
    log: dutyLog, ...agentMessage });
  const stopBridgeWatch = !alertPoll ? () => {} : startBridgeWatch({ health: alertPoll.health, statusFile, configFile: grafanaConfig,
    alerting: alerting => alertPoll.alerting(alerting), log: dutyLog, ...agentMessage });
  // An idle root job, dormant chat or subagent stops after the quiet window, a session that ended its task after ENDED_MS, and a job or chat
  // asleep in Prime's provider retry once pi-pool holds its tree past the quiet window, since Prime's own sweeps fail under load and count a
  // retry as work. A quiet worker that grew past RECYCLE_OWN_BYTES is recycled. Each sweep starts its stops at once and does not wait for a slow kill
  // (src/idle-unload.ts IdleUnloader). Every box's idle sessions stop from here, since the chat service is the one place that knows which chats
  // a tab or the pool holds.
  const unloader_ = new IdleUnloader({
    rows: () => [...catalog.daemonRows(), ...catalog.remoteRows()],
    localRows: () => catalog.daemonRows(),
    // The one quiet window (src/quiet-minutes.ts, 15 min by default) that d7's quiet_agent_gb judges; idle eviction off stops none.
    idleMs: () => defaults.idleEviction() === "off" ? null : quietMinutes(dataDir) * 60_000,
    chats: () => chats.ids(),
    dormant: id => threads.isDormant(id),
    pool: () => poolWaiting(),
    waking: async now => new Set((await pendingWakes(join(dataDir, "wakes"), now).catch(() => [])).map(wake => wake.session)),
    // A session asleep in Prime's provider retry stops when its transcript ends on the failed reply and pi-pool serves its tree (keyed by the
    // root session) only past the unload's minutes. Only this box's sessions: another box's pool decides for its own. The job sweep's resume
    // pass continues a job once the pool or the token hook lets its tree in (resume_paused.py unload_stop_holds), and a chat's revive reopens
    // the chat once pi-pool admits it (Chats.revive).
    held: (rows, now, idleMs, chatIds) => providerWaits(rows, now, idleMs, { all: catalog.daemonRows(), local: row => !catalog.hostOf(row.sessionId),
      tail: async file => (await tailLines(file, 64 * 1024)).join("\n"), read: threads => readPoolStatus(threads, { maxAgeMs: 60_000 }) }, chatIds),
    release: id => threads.restAsleep(id),
    own: async pids => {
      const footprints = await readFootprints([...pids]);
      return new Map(Object.entries(footprints.workers).map(([pid, worker]) => [Number(pid), worker.own ?? 0] as const));
    },
    restNow: (id, quietMs) => threads.restNow(id, quietMs),
    title: id => catalog.title(id),
    // Only a file on this box can be rewritten as active after a bare kill, so another box's session is never killed by a daemon without
    // kill_origin (src/idle-unload.ts NO_BARE_KILL).
    request: (row, type) => unloadRequest(catalog.clientFor(row.activeSessionId!), row.activeSessionId!, type, !catalog.hostOf(row.sessionId)),
    stopped: async (row, isChat, since) => {
      await recordUnloaded(dataDir, [row.sessionId], Date.now()).catch(error => dutyLog(`idle unload: record ${row.sessionId}: ${error instanceof Error ? error.message : String(error)}`));
      // The daemon's kill writes the archived state, which would hide the session from agent_message and the list. Every session it stopped
      // is rewritten as active, not only chats and threads.json threads: on 10-18 the jobs 'parity prod promote 12' and 'meta ads advertisers
      // push' stayed archived after the 12:53:07Z sweep. A chat he archived stays archived, and so does a thread an archive reached since `since`.
      const listed = isChat || !(await chats.archivedIds()).has(row.sessionId);
      if (listed) await threads.keepListed(row.sessionId, since).catch(error => dutyLog(`idle unload: keep listed ${row.sessionId}: ${error instanceof Error ? error.message : String(error)}`));
    },
    receipt: entry => writeReceipt(dataDir, entry),
    log: dutyLog,
    now: () => Date.now(),
  });
  let unloading = false;
  const unloader = ownChatsOnly && !replay ? undefined : setInterval(() => {
    if (unloading) return;
    unloading = true;
    void unloader_.sweep().catch(error => dutyLog(`idle unload: ${error instanceof Error ? error.message : String(error)}`)).finally(() => { unloading = false; });
  }, 60_000);
  unloader?.unref();
  // /tmp is a tmpfs on Linux, so what nobody holds or names there is RAM or swap that no work uses (src/tmp-sweep.ts).
  const stopTmpSweep = ownChatsOnly || process.platform !== "linux" ? () => {} : startTmpSweep({ rows: () => catalog.daemonRows(),
    waking: async () => new Set((await pendingWakes(join(dataDir, "wakes"), Date.now()).catch(() => [])).map(wake => wake.session)),
    idleMs: () => { const minutes = defaults.idleEviction(); return minutes === "off" ? null : minutes * 60_000; }, log: dutyLog, everyMs: JOB_CLEANUP_EVERY_MS });
  const prioritySync = quiet ? undefined : setInterval(() => { void poolPriorities.sync(); }, 30_000);
  prioritySync?.unref();
  if (!quiet) void poolPriorities.sync();
  // An owner send to a session on this box marks its turn in this box's pi-pool; another box's relay marks its own (ThreadHub.prompt `owner`).
  threads.markOwnerTurn = id => markOwnerTurn(id).catch(error => { dutyLog(`turn queue: owner turn for ${id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`); });
  // A scratch serve's data dir is a copy of the live one, so it keeps its own outbox: the live service delivers the sends in "outbox".
  const outbox = new OwnerOutbox(join(dataDir, scratch ? "outbox-scratch" : "outbox"), { threads, chats, catalog }, dutyLog);
  let closed = false;
  return {
    catalog, threads, readState, labels, defaults, newChat, chats, boards, created, usage, duties, poolPriorities, calls,
    agentQueue: agentQueue(id => catalog.title(id), defaults),
    drainSends: async () => { stopWakes(); await agentOutbox.close(); },
    prompt: async (id, via) => {
      const sessionFile = await sessionFileFor(id, { listed: async session => (await catalog.summary(session))?.sessionFile, ...(via ? { via } : {}), dataDir, agentDir });
      const title = catalog.title(id);
      return sessionFile ? promptView(id, { sessionFile, dataDir, agentDir, chat: (await chats.ids()).has(id), ...(title ? { title } : {}) }) : null;
    },
    outbox, messages: agentOutbox,
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
      stopTmpSweep();
      stopWakes();
      stopBriefs();
      stopAlerts();
      stopBridgeWatch();
      alertPoll?.stop();
      unwatchBoards();
      unobserveCompaction();
      duties.close();
      archives.close();
      chats.close();
      awake.close();
      await threads.close();
      await catalog.close();
      usage.close();
    },
  };
}
