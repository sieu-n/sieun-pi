/**
 * Wires the host seam, the chat server's store and the services, and holds the one live hub every page connects to over /api/live.
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { rm } from "node:fs/promises";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type {
  AgentHostList, AgentId, AgentSummary, ConversationHeader, ConversationId, Delivery, ConversationPatch, ConversationSummary, ImageRef, Item, LiveCommand, LiveEvent, Me, ModelCatalog, ModelInfo, OpenedPage, ProjectList, Reaction, ReadPoint, Room, RunStatus, SendRequest, SendResult, Sidebar, ThinkingLevel,
  TimelinePage,
} from "../web/src/lib/api/types.ts";
import type { AllowedModel } from "../../../config/allowed-models.ts";
import type { FeedRow } from "../../../components/prime-relay/agents/protocol.ts";
import { AgentFolders, type BoxFiles } from "./agent-folder.ts";
import { AgentStore, type AgentRecord, type MemberChange, type RoomDelivery, type RoomId, type RoomPost, type WakeOn } from "./agent-store.ts";
import { Agents, isGroupRoomId, isRoomId } from "./agents.ts";
import { Boards } from "./boards.ts";
import { MIN_BYTES } from "./compress.ts";
import { CHANNEL_COPY_LIKE, GroupRooms, roomLabel } from "./group-rooms.ts";
import { assertEditable, deleteNotice, deliveriesOf, editNotice } from "./post-edits.ts";
import { editHold } from "../../../packages/pi-host/src/durable/long-edit.ts";
import { ForMe, parseItemId } from "./for-me.ts";
import { Later } from "./later.ts";
import { LATER, LaterFiles, LaterRows } from "./later-db.ts";
import { FolderWakes, WAKES, WakeRows } from "./wakes-db.ts";
import { DUTIES, DutyFiles, DutyJsonFiles } from "./duties-db.ts";
import { BOARD_WRITES, BoardWrites, BoardWritesFile } from "./board-writes-db.ts";
import { LaterDue } from "./later-due.ts";
import { answers, nextMorning } from "./keep-unread.ts";
import { AgentLater } from "./later-agents.ts";
import type { ForMeItem, ForMeList, ForMeStatus, LaterItem } from "../web/src/lib/api/types.ts";
import type { ConversationPrefs, PrefsPatch } from "../web/src/lib/api/types.ts";
import type { SavedLayout } from "../web/src/lib/api/types.ts";
import { DEFAULT_MODEL, DEFAULT_THINKING, type Config } from "./config.ts";
import { MultiHost } from "./host/multi-host.ts";
import { isHostAway, type Host } from "./host/types.ts";
import { Outbox, type OutboxRow } from "./outbox.ts";
import { DbOutboxLog, JsonOutboxLog, OUTBOX } from "./outbox-db.ts";
import { boxCwd, projectCwd, projectList } from "./projects.ts";
import { agentPost, react, ReactionError, reactionInput, reactionList, reactionsOf, reactionText } from "./reactions.ts";
import { doneInput, markDone, threadRootOf } from "./thread-done.ts";
import { markPin, pinInput, pinnedPosts } from "./pins.ts";
import { forwardInput, forwardOf } from "./forward.ts";
import type { ForwardedPost } from "../web/src/lib/api/types.ts";
import { Rooms, type SpeakAnswer } from "./rooms.ts";
import { movedNote, movedPosts, readMoved } from "./moved.ts";
import { applyPrefs, withPrefs } from "./sidebar-prefs.ts";
import { parseLayout } from "../web/src/lib/api/shared/sidebar-layout.ts";
import { bucketOf, changedBuckets, digests, PARTIAL_LISTS, threadTimes, timed, type PartialList, type ThreadTimes, type Timed } from "../web/src/lib/api/shared/hello-buckets.ts";
import { boardDelta, boardKey, boardStep, parseBoardsParam } from "../web/src/lib/api/shared/board-delta.ts";
import type { ChatBoard } from "../web/src/lib/api/shared/types.ts";
import { OwnerSettingsStore } from "./owner-settings.ts";
import { Unfurler } from "./unfurl.ts";
import { POST_KINDS, postHas, Search } from "./search.ts";
import { likeRegex, postDocId, SEARCH_DOC_VERSION, SearchEngine, SqliteEntries, type EntrySource, type PostDoc } from "./search-engine.ts";
import { STORE_FULL_PULL_MS, StoreUsage, storeReader, type UsageSums } from "./usage-store.ts";
import { UsageAnswers } from "./usage-answers.ts";
import { Meili, startOwnMeili, type OwnMeili } from "./meili.ts";
import type { FixtureHost } from "./host/fixture.ts";
import { drained } from "./disk.ts";
import { ChatDb } from "./chat-db.ts";
import { JsonMove, returnDropped, type JsonKind } from "./json-move.ts";
import { CACHE_KIND, HOST_ROUTES_KIND, KeptJson } from "./kept-json.ts";
import { ChatRecords, docKind, type DocSpec } from "./chat-records.ts";
import { AGENTS, CHANNELS, FOR_ME, ROOMS, STATE } from "./record-kinds.ts";
import { POSTS } from "./post-log.ts";
import { readJson, Store, writeJson } from "./store.ts";
import { modelRef, OWNER, parseConversationId, Threads, type ItemsSplit } from "./threads.ts";
import { QueueWatch, waitingPlace } from "./queue.ts";
import { webEntry } from "./web-entry.ts";
import { isImage, isModelImage, uploadExtension, withFileNotes } from "./files.ts";
import { fileImageSize, imageSize, withSize } from "./image-size.ts";
import { askNoticeOf, noticeOf, noticeReason } from "./notices.ts";

/** An image as a page from before 11-03 15:01Z sends it: its base64 bytes inline (see `App.uploaded`). */
type LegacyImage = { data: string; mimeType: string };

/** A model the pickers offer, which must be one of config/allowed-models.ts (owner rule c185: the newest model of each tier only). */
function offered(key: AllowedModel, label: string, family: string, levels: ThinkingLevel[]): ModelInfo {
  const [provider, id] = key.split("/") as [string, string];
  return { provider, id, label, family, levels };
}

export const MODELS: ModelCatalog = {
  models: [
    offered("anthropic/claude-opus-5-5", "Opus 5.5", "claude", ["off", "low", "medium", "high", "xhigh"]),
    offered("anthropic/claude-sonnet-5-5", "Sonnet 5.5", "claude", ["off", "low", "medium", "high"]),
    offered("anthropic/claude-fable-5-2", "Fable 5.2", "claude", ["off", "low", "medium", "high", "xhigh"]),
    offered("openai-codex/gpt-6.1-sol", "GPT-6.1 sol", "gpt", ["low", "medium", "high", "xhigh"]),
    offered("openai-codex/gpt-6-luna", "GPT-6 luna", "gpt", ["low", "medium", "high", "xhigh"]),
  ],
  default: { model: DEFAULT_MODEL, thinkingLevel: DEFAULT_THINKING },
};

/** The watch prefix of an agent's For list: `for:<agent id>`. */
const FOR_ME_WATCH = "for:";

/** How long the start waits for this box's own relay, PiHost's wait for a pi-host restart (RESTART_WAIT_MS in host/pi-host.ts). */
const OWN_RELAY_WAIT_MS = 30_000;

/** `watching` maps each conversation a page watches to the thread conversations that watch holds open. */
/** `boards` is the `boardKey` of each board the page holds, as its socket's `boards=` named it and each board event since left it. */
type Client = { socket: WebSocket; watching: Map<ConversationId, ConversationId[]>; req: IncomingMessage | undefined; boards: Map<string, string> };

/**
 * Runs a GET route for a page over its live socket (`LiveCommand` read), as http.ts answers it over HTTP; http.ts `serve` sets it. A
 * page reads its open panels this way when its socket opens again, since its HTTP connection may still wait in TCP's retries after a cut:
 * in the wake walk on 11-22 (~/work/p209-wake/after4) the panels' HTTP reads at the open took 4.7 s behind a read the cut had caught.
 */
export type SocketRead = (path: string, req: IncomingMessage | undefined) => Promise<{ status: number; value?: unknown; error?: string }>;

/** The usage store `APPS_CHAT_USAGE_STORE` names, keeping its snapshot in the data dir; undefined when it names none. */
export function storeUsageOf(config: Config, log: (line: string) => void): StoreUsage | undefined {
  return config.usageStore
    ? new StoreUsage(storeReader(config.usageStore), config.usageStore.table, log, Date.now, STORE_FULL_PULL_MS, join(config.dataDir, "usage-sums.json"))
    : undefined;
}

export class App {
  /** chat.sqlite, which holds each kind of record moved out of the JSON files (chat-db.ts), and those moves by kind (json-move.ts). */
  readonly chatDb: ChatDb;
  readonly moves = new Map<string, JsonMove>();
  /** The JSON documents of Store, AgentStore and ForMe, kept as rows of chat.sqlite for each kind `config.dbKinds` names (chat-records.ts). */
  readonly records: ChatRecords;
  readonly store: Store;
  readonly agentStore: AgentStore;
  readonly agents: Agents;
  readonly rooms: Rooms;
  readonly threads: Threads;
  /** Channels and Solo rooms. */
  readonly groups: GroupRooms;
  readonly boards: Boards;
  readonly search: Search;
  readonly queues: QueueWatch;
  readonly searchEngine: SearchEngine;
  private searchStop: () => void = () => {};
  /** api/usage's sums: the usage store's, kept in memory, or the fixture's own. */
  readonly usage: UsageSums;
  private readonly storeUsage?: StoreUsage;
  /** api/usage's answers, kept between changes of the sums (server/usage-answers.ts). */
  readonly usageAnswers: UsageAnswers;
  readonly outbox: Outbox;
  /** The boxes agents run on, when the host is a `MultiHost` (server/host/multi-host.ts); a fixture or test host has one box. */
  readonly routing?: MultiHost;
  /** Each agent's folder, on this box's disk or through its box's relay. */
  readonly folders: AgentFolders;
  /** Each agent's For list and its completed marks (for-me.ts). */
  readonly forMe: ForMe;
  /** Save for later: each principal's saved room posts (later.ts). */
  readonly later: Later;
  /** Remind me: the one timer that fires the owner's due reminders (later-due.ts). */
  readonly laterDue: LaterDue<LaterItem>;
  /** The agents' side of Save for later and Remind me: their tools' answers and their reminders' wakes (later-agents.ts). */
  readonly agentLater: AgentLater;
  /** The owner's status, notification setting and recent searches, shared by every browser (owner-settings.ts). */
  readonly ownerSettings: OwnerSettingsStore;
  private readonly clients = new Set<Client>();
  private sidebarTimer?: NodeJS.Timeout;
  private lastSidebar = "";
  /** Each DM room's summary as last sent, so a room event goes out only when its row changed. */
  private roomCache = new Map<string, string>();
  /** The `ensureComms` pass going now, and the one queued behind it, so passes run one at a time. */
  private commsRun?: Promise<void>;
  private commsNext?: Promise<void>;
  /** The `<agent>/<room>` pairs whose last comm thread try failed, so a failure logs once until it heals. */
  private readonly commFailed = new Set<string>();
  /** The edit texts each thread's edit was held for (`editHold`), so the same text sent again edits the post (c98). */
  private readonly heldEdits = new Map<string, Set<string>>();
  /**
   * The socket compresses each frame over one packet (permessage-deflate). On 11-20 the hello frame was 742 KB of JSON, sent on every connect
   * to the owner 197 ms away; zlib level 3 made it 88 KB in 4.7 ms on us-metal02 (min of 30), against 80 KB in 14.1 ms at the default level 6.
   */
  readonly wss = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: MIN_BYTES, zlibDeflateOptions: { level: 3 } } });
  /** Slack-style link previews of the web links posts hold (unfurl.ts). */
  readonly unfurl = new Unfurler();

  /** `early.storeUsage` is the usage store a successor made and `prepare`d before the server it follows stopped (main.ts). */
  constructor(readonly config: Config, readonly host: Host, readonly log: (line: string) => void = line => console.log(line), early: { storeUsage?: StoreUsage } = {}) {
    this.chatDb = new ChatDb(join(config.dataDir, "chat.sqlite"), { log });
    // A kind a server moved that APPS_CHAT_DB_KINDS no longer names, a rollback by kind, goes back to its files before any store reads them.
    const kinds: JsonKind[] = [AGENTS, ROOMS, STATE, FOR_ME].map(spec => docKind(spec as unknown as DocSpec<object>));
    kinds.push(CHANNELS, POSTS, CACHE_KIND, HOST_ROUTES_KIND, WAKES, LATER, DUTIES, BOARD_WRITES, OUTBOX);
    returnDropped(this.chatDb, config.dataDir, kinds, config.dbKinds ?? [], log);
    this.records = new ChatRecords(this.chatDb, config.dataDir, kind => this.move(kind), config.dbKinds ?? []);
    if (this.records.inDb(CHANNELS.kind)) this.records.move(CHANNELS);
    this.store = new Store(config.dataDir, this.records);
    if (config.dbKinds?.includes(CACHE_KIND.kind)) this.store.caches = new KeptJson(this.chatDb, CACHE_KIND, kind => this.move(kind));
    this.ownerSettings = new OwnerSettingsStore(this.store, settings => this.broadcast({ type: "owner_settings", settings }));
    mkdirSync(this.store.imagePath(""), { recursive: true });
    this.agentStore = new AgentStore(config.dataDir, this.records);
    this.agents = new Agents(this.agentStore, this.store, host, config, log);
    const routing = host instanceof MultiHost ? host : undefined;
    this.routing = routing;
    if (routing) {
      if (config.dbKinds?.includes(HOST_ROUTES_KIND.kind)) routing.keep(new KeptJson(this.chatDb, HOST_ROUTES_KIND, kind => this.move(kind)));
      for (const relay of routing.relays()) if (this.store.caches) relay.kept = this.store.caches;
      routing.agentHost = thread => this.agents.record(thread)?.host;
      this.agents.hostState = box => routing.link(box).state;
    }
    this.folders = new AgentFolders(record => ({ agentsDir: this.agents.agentsDirOf(record), ...(routing && record.host !== config.box ? { files: this.boxFiles(record.host) } : {}) }));
    this.forMe = new ForMe({ store: this.agentStore, item: (row, post) => (row.kind === "dm" ? this.rooms.item(post) : this.groups.item(row, post)) });
    const wakeDir = join(config.dataDir, "wakes");
    const wakes = config.dbKinds?.includes(WAKES.kind) ? new WakeRows(this.chatDb, this.move(WAKES), wakeDir, log) : new FolderWakes(wakeDir);
    this.later = new Later({
      store: this.agentStore, principal: id => this.threads.principal(id),
      lists: config.dbKinds?.includes(LATER.kind) ? new LaterRows(this.chatDb, this.move(LATER)) : new LaterFiles(config.dataDir),
      item: (row, post) => (row.kind === "dm" ? this.rooms.item(post) : this.groups.item(row, post)),
    });
    this.later.onChange(({ by, item }) => {
      this.broadcast({ type: "later", by, open: this.later.openCount(by) });
      const post = by === "owner" && item.room !== undefined ? this.agentStore.postsOf(item.room).find(p => p.id === item.post) : undefined;
      if (post && item.room !== undefined) this.emitPosts(item.room, [post]);
    });
    this.laterDue = new LaterDue({
      items: () => this.later.items("owner"),
      notified: (item, at) => (this.later.get("owner", item.id) ? this.later.update("owner", item.id, { notifiedAt: at }) : undefined),
      fire: item => {
        if (item.unread && item.room !== undefined) {
          try {
            this.roomUnreadFrom(item.room, item.post);
          } catch (error) {
            log(`later: ${item.id} kept unread, but its room or post is gone: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        const row = this.later.list("owner", "open", { test: true }).items.find(r => r.id === item.id);
        // A walk's reminder in a test room toasts and notifies only on the pages that have that room open, never in the owner's own windows.
        if (row?.test) this.toWatchers(row.room, { type: "later_due", row });
        else if (row) this.broadcast({ type: "later_due", row });
      },
      log,
    });
    this.later.onChange(({ by, item, removed }) => {
      if (by !== "owner") return;
      this.laterDue.arm();
      // Checking a Keep unread item off, archiving it or unsaving it handles the post, so its room stops reading unread from it.
      if (item.unread && item.room !== undefined && (removed || item.state !== "open") && this.store.state.reads[item.room]?.from === item.post) this.markRead(item.room);
    });
    const linkOf = routing ? (box: string) => routing.link(box).state : undefined;
    const fileNotes = (text: string, refs: readonly ImageRef[]) => withFileNotes(text, refs, config.box, ref => this.uploadPath(ref));
    this.threads = new Threads(host, this.store, {
      agents: (changed, removed) => {
        for (const agent of changed) this.broadcast({ type: "agent", agent });
        for (const id of removed) this.broadcast({ type: "agent_removed", id });
        this.sidebarSoon();
      },
      jobList: (changed, removed) => {
        for (const job of changed) this.broadcast({ type: "job", job });
        for (const id of removed) this.broadcast({ type: "job_removed", id });
        this.boards.jobsChanged(changed, removed);
      },
      conversations: changed => this.conversationsChanged(changed),
      items: (conversation, items) => {
        this.toWatchers(conversation, { type: "items", conversation, items });
        this.outbox.reconcile(conversation, items);
        // A watched DM watches the thread its feed reads too, so a new speaking call posts without waiting for the next thread list read.
        const comm = this.agents.ofComm(conversation);
        if (comm && isGroupRoomId(comm.room)) {
          void this.groups.feed(conversation);
          return;
        }
        const record = this.agents.ofWorkThread(conversation) ?? comm?.record;
        if (record) void this.rooms.feed(record);
      },
      status: (conversation, status) => {
        this.broadcast({ type: "status", conversation, status });
        // The room a comm or work thread belongs to works out its status from both, on the path each thread list read takes.
        const comm = this.agents.ofComm(conversation);
        if (comm && isGroupRoomId(comm.room)) this.groups.settle(comm.room);
        else {
          const record = this.agents.ofWorkThread(conversation) ?? comm?.record;
          if (record) this.rooms.settle(record);
        }
        this.sidebarSoon();
      },
      jobs: (thread, jobs) => this.broadcast({ type: "jobs", thread, jobs }),
    }, config.box, log);
    this.threads.agentRecords = this.agents;
    this.agents.createThread = (opts, claim) => this.threads.create(opts, claim);
    this.rooms = new Rooms({
      store: this.agentStore, state: this.store, host, threads: this.threads, agents: this.agents,
      events: {
        items: (room, items) => {
          this.toWatchers(room, { type: "items", conversation: room, items });
          this.forMeChanged();
        },
        status: (room, status) => this.roomStatus(room, status),
        changed: () => this.roomsChanged(),
        thread: (record, thread) => this.watchRoomThread(record.room, thread),
        submitted: (thread, result) => this.queues.follow(thread, result.ticket?.place ?? null),
      },
      uploaded: ref => this.uploaded(ref), readUpload: ref => this.readUpload(ref), fileNotes, log, ...(linkOf ? { linkOf } : {}),
      laterMark: post => this.later.mark("owner", post.room, post.id),
    });
    this.threads.roomSummaries = () => this.rooms.summaries().filter(c => !this.agentStore.isTest(c.id));
    this.threads.testSendsOf = thread => this.rooms.testSendsOf(thread);
    this.threads.onRefresh = () => {
      this.rooms.poll();
      this.groups.poll();
      this.sweepRefs();
      void this.ensureComms();
    };
    this.groups = new GroupRooms({
      store: this.agentStore, state: this.store, host, threads: this.threads, agents: this.agents,
      events: {
        items: (room, items) => {
          this.toWatchers(room, { type: "items", conversation: room, items });
          this.forMeChanged();
        },
        room: room => this.broadcast({ type: "room", room }),
        conversations: changed => this.conversationsChanged(changed),
        status: (room, status) => this.roomStatus(room, status),
        thread: (room, thread) => this.watchRoomThread(room, thread),
        submitted: (thread, result) => this.queues.follow(thread, result.ticket?.place ?? null),
      },
      uploaded: ref => this.uploaded(ref), readUpload: ref => this.readUpload(ref), fileNotes, log, ...(linkOf ? { linkOf } : {}),
      laterMark: post => this.later.mark("owner", post.room, post.id),
      agentLaterMark: (agent, post) => this.later.mark(agent, post.room, post.id),
    });
    this.threads.groupSummaries = () => this.groups.summaries().filter(c => !this.agentStore.isTest(c.id));
    this.threads.roomsOf = agent => this.groups.memberRooms(agent).map(row => row.id);
    this.threads.pendingWakes = () => wakes.list().map(({ wake }) => wake.session);
    const inDb = (kind: JsonKind) => config.dbKinds?.includes(kind.kind) === true;
    this.boards = new Boards(host, this.store, this.threads, this.agents, {
      duties: inDb(DUTIES) ? new DutyFiles(this.chatDb, this.move(DUTIES)) : new DutyJsonFiles(config.dataDir),
      writes: inDb(BOARD_WRITES) ? new BoardWrites(this.chatDb, this.move(BOARD_WRITES)) : new BoardWritesFile(config.dataDir),
      wakes,
    }, {
      board: (chatId, board, awaitingGo, lists, before) => this.boardChanged(chatId, board, before, { awaitingGo, ...lists }),
      row: (chatId, row) => this.broadcast({ type: "board_row", chatId, row }),
      forYou: count => {
        this.broadcast({ type: "for_you", count });
        this.sidebarSoon();
      },
      asksDue: (items, at) => {
        for (const item of items) this.broadcast({ type: "notice", notice: askNoticeOf(item, at) });
      },
      duties: (chatId, duties) => this.broadcast({ type: "duties", chatId, duties }),
    }, log);
    this.boards.selfUrl = `http://127.0.0.1:${config.port}`;
    this.agentLater = new AgentLater({
      later: this.later, wakes, postsOf: room => this.agentStore.postsOf(room), principal: id => this.threads.principal(id),
      label: (record, room) => {
        const row = this.groups.row(room);
        return row ? roomLabel(row) : room === record.room ? "DM" : room;
      },
      thread: (record, room) => (room === record.room ? this.agents.roomThread(record) : this.groups.row(room) ? record.comm?.[room] : undefined),
      record: id => this.agents.record(id), log,
    });
    this.later.onChange(({ item, removed }) => this.agentLater.syncWake(item, removed));
    this.boards.wakeHooks = { expand: text => this.agentLater.expand(text), delivered: text => this.agentLater.delivered(text) };
    if (routing) {
      // A check wake of a thread on another box runs its check there.
      this.boards.checkOn = thread => {
        const box = routing.boxOf(thread);
        const relay = box === config.box ? undefined : routing.relay(box);
        return relay ? (command, timeoutMs, owner) => relay.check(command, timeoutMs, owner) : undefined;
      };
      for (const relay of routing.relays()) relay.onFeed = row => this.feedRow(row);
      routing.onLink((box, link) => {
        // The agents' hostState follows on the thread list read; deliveries that waited for the box go once it is back.
        // The box's thread list is read first, so an agent archived there meanwhile reads as archived before its waiting posts go.
        const refreshed = this.threads.refresh().catch(error => this.log(`thread refresh after ${box} went ${link.state} failed: ${String(error)}`));
        if (link.state === "up") {
          void refreshed.then(() => this.rooms.release(box)).catch(error => this.log(`rooms: release of ${box} failed: ${String(error)}`));
          void refreshed.then(() => this.groups.release(box)).catch(error => this.log(`group rooms: release of ${box} failed: ${String(error)}`));
        }
      });
    }
    this.threads.onDoc = (thread, name, value) => {
      if (name === "chat.board") this.boards.docChanged(thread, value);
    };
    this.searchEngine = this.newSearchEngine(routing?.list()[0]!.host ?? host, routing);
    if (config.usageStore) {
      this.usage = this.storeUsage = early.storeUsage ?? storeUsageOf(config, log)!;
      // The first read starts with the server rather than with the loops 2 s after the listen: a restart's first api/usage call waited
      // 1.2 s for the snapshot and the tail read on 11-24, and they now run while the server starts.
      void this.storeUsage.pull();
    }
    else if (config.fixture && (host as Partial<UsageSums>).usage) this.usage = host as Host & UsageSums;
    else this.usage = { usage: () => Promise.reject(new Error("no usage store: APPS_CHAT_USAGE_STORE names none")) };
    this.usageAnswers = new UsageAnswers(this.usage, this.threads);
    this.search = new Search(this.threads, this.groups, this.searchEngine, room => this.agentStore.postsOf(room));
    if (routing) {
      this.search.boxes = () => routing.list().filter(b => b.box !== config.box).map(b => ({ box: b.box, link: () => routing.link(b.box) }));
    }
    this.search.testSends = () => this.rooms.allTestSends();
    this.search.saved = () => this.later.items("owner").flatMap(item => (item.state === "open" && !item.unread && item.room !== undefined ? [postDocId(item.room, item.post)] : []));
    // Search leaves out every comm thread and every thread of a walk's test agent.
    this.searchEngine.hiddenThreads = () => this.agentStore.hiddenThreads();
    this.agentStore.onPost = post => this.searchEngine.postChanged(postDocId(post.room, post.id), this.postDoc(post.room, post));
    // The drafts set a post's deliveries and fields in the same append, so the notice reads them after it settles.
    this.agentStore.onAppend = post => queueMicrotask(() => this.notice(post));
    this.queues = new QueueWatch(host, this.threads, (conversation, place) => {
      this.toWatchers(conversation, { type: "queue", conversation, place });
      const record = this.agents.ofWorkThread(conversation) ?? this.agents.ofComm(conversation)?.record;
      if (record && this.agents.roomThread(record) === conversation) this.toWatchers(record.room, { type: "queue", conversation: record.room, place });
    }, log);
    const outboxLog = config.dbKinds?.includes(OUTBOX.kind) ? new DbOutboxLog(this.chatDb, this.move(OUTBOX)) : new JsonOutboxLog(config.dataDir);
    this.outbox = new Outbox(outboxLog, {
      host,
      submitted: (row, result) => this.queues.follow(row.conversation, result.ticket?.place ?? null),
      refWritten: thread => this.agents.refWritten(thread),
      mentions: row => this.deliverMentions(row),
      changed: (conversation, items, removed) => this.toWatchers(conversation, { type: "items", conversation, items, ...(removed.length ? { removed } : {}) }),
      image: ref => this.readUpload(ref),
      fileNotes,
      log,
    });
    this.boards.sends = this.outbox;
    this.wss.on("connection", (socket: WebSocket, req?: IncomingMessage) => this.connect(socket, req));
  }

  /**
   * Starts the relays and the thread list, then the loops unless `loops` is false, when `startLoops` runs them later. Resolves with how long
   * each part took, which a hand-over's log names.
   */
  async start(options: { loops?: boolean } = {}): Promise<string> {
    const began = performance.now();
    for (const relay of this.routing?.relays() ?? []) relay.start();
    // This box's own agents go through its relay too; its first thread list waits for the hello, as PiHost waits for a pi-host restart.
    const own = this.routing?.relays().find(relay => relay.name === this.config.box);
    if (own && !(await own.whenUp(OWN_RELAY_WAIT_MS))) this.log(`relay ${own.name}: no hello in ${OWN_RELAY_WAIT_MS / 1000} s, starting with its agents away`);
    const relayed = performance.now();
    await this.threads.start(this.config.fixture ? 1000 : 2000);
    const listed = performance.now();
    const loops = options.loops === false ? "loops after the listen" : `loops ${this.startLoops()} ms`;
    return `own relay ${Math.round(relayed - began)} ms, thread list ${Math.round(listed - relayed)} ms, ${loops}`;
  }

  /**
   * Starts the rooms' deliveries, the boards, the outbox, Later and usage, and returns how many ms that took. A send that comes before
   * this waits as "sending" in its room's log, and the rooms' start schedules every such post. At load 110 to 125 on 11-22 this took
   * 1,256 ms of a successor's 1,518 ms between the old server's stop and its listen, mostly the rooms' scan of every agent room's posts.
   */
  startLoops(): number {
    const began = performance.now();
    this.rooms.start();
    this.groups.start();
    this.boards.start();
    this.outbox.start();
    this.laterDue.arm();
    this.storeUsage?.start();
    this.usageAnswers.start();
    if (this.config.meili) void this.searchEngine.refresh().catch(error => this.log(`search: ${String(error)}`));
    return Math.round(performance.now() - began);
  }

  /**
   * Opens the move of one kind of record into chat.sqlite: its new tables, then the import of each of its JSON files whose content the DB
   * has not seen (json-move.ts). A store calls it from the constructor, before the server serves.
   */
  move(kind: JsonKind): JsonMove {
    const move = new JsonMove(this.chatDb, this.config.dataDir, kind, { log: this.log });
    move.open();
    this.moves.set(kind.kind, move);
    return move;
  }

  /**
   * Stops the app's loops and writes its queue. A hand-over's old server passes `keepHost`: its pi-host client stays open for the reads it
   * still finishes after the stop (http.ts `passThrough`), and closes when the process exits.
   */
  async stop(options: { keepHost?: boolean } = {}): Promise<void> {
    // A hand-over's stop writes no usage snapshot: its successor read the last full read's before this stop (usage-store.ts `prepare`).
    this.rooms.stop();
    this.groups.stop();
    this.boards.stop();
    this.outbox.stop();
    this.laterDue.stop();
    this.queues.stop();
    clearTimeout(this.sidebarTimer);
    // The stop leaves a board put at work running. Its board stays in board-writes.json or chat.sqlite, which `drained` and `chatDb.written`
    // below write, and the next process puts it again, and its newerOnly keeps a later board when it lands after that put (boards.ts `putBoards`). On 11-23 a stop that waited
    // for it held a hand-over's calls up to 28.6 s behind puts held 35 s (~/work/pi-host-stalls/d-put-wait).
    // The host client closes first: a watch's unwatch sent to a pi-host that restarts beside the chat retried for 30 s, past systemd's
    // 20 s stop timeout, so restarting both services on 10-28 ended in a SIGKILL. pi-host drops a closed connection's watches itself.
    if (!options.keepHost) await this.host.close();
    await this.threads.stop();
    for (const client of this.clients) client.socket.close();
    this.searchStop();
    this.storeUsage?.stop(!options.keepHost);
    this.usageAnswers.stop();
    this.records.flush();
    await Promise.all([...this.moves.values()].map(move => move.flushExports()));
    await this.chatDb.written();
    await drained();
  }

  /**
   * Search's one Meilisearch index: the Komodo container box-sieun-pi-meilisearch-1 when the config names it, else a Meilisearch of this server's own, started on the
   * first search. Entries come from pi-host's index.sqlite, or from the fixture host's threads.
   */
  private newSearchEngine(local: Host, routing: MultiHost | undefined): SearchEngine {
    const { config } = this;
    const fixture = (local as Partial<Pick<FixtureHost, "readIndex">>).readIndex ? (local as FixtureHost) : undefined;
    const sqlite = !fixture && config.durableIndex ? new SqliteEntries(config.box, config.durableIndex) : undefined;
    const ownSource: EntrySource = sqlite ?? {
      box: config.box, atSearch: true, up: () => true,
      read: cursor => (fixture ? fixture.readIndex(cursor) : { rows: [], cursor: "0", more: false }),
    };
    // Every other box's rows come through its relay into the same index.
    const others: EntrySource[] = (routing?.list() ?? []).flatMap(({ box }) => {
      const relay = box === config.box ? undefined : routing!.relay(box);
      return relay ? [{ box, atSearch: false, up: () => routing!.link(box).state === "up", read: (cursor: string | undefined) => relay.indexRead(cursor) }] : [];
    });
    let own: OwnMeili | undefined;
    let memory: Record<string, string> = {};
    const file = join(config.dataDir, "search", "meili.json");
    // With the cache kind in chat.sqlite, the cursor is a cache row under the file's name.
    const { caches } = this.store;
    if (config.meili) {
      // `cursor` is this box's cursor as the file kept it before other boxes were indexed too.
      type Saved = { v?: number; cursor?: string; cursors?: Record<string, string> };
      const saved = caches ? ((caches.read("search/meili.json") ?? {}) as Saved) : readJson<Saved>(file, {});
      if (saved.v === SEARCH_DOC_VERSION) memory = saved.cursors ?? (saved.cursor === undefined ? {} : { [config.box]: saved.cursor });
    }
    const cursors = {
      get: (box: string) => memory[box],
      set: (box: string, next: string) => {
        memory = { ...memory, [box]: next };
        if (!config.meili) return;
        if (caches) void caches.write("search/meili.json", { v: SEARCH_DOC_VERSION, cursors: memory });
        else writeJson(file, { v: SEARCH_DOC_VERSION, cursors: memory });
      },
    };
    // The hidden threads Meilisearch holds flagged, kept for the next start; with the cursors, only for the Meilisearch that outlives the server.
    const flaggedFile = join(config.dataDir, "search", "flagged.json");
    type Flagged = { v?: number; threads?: string[] };
    const flaggedSaved = !config.meili ? {} : caches ? ((caches.read("search/flagged.json") ?? {}) as Flagged) : readJson<Flagged>(flaggedFile, {});
    const flagged = {
      get: () => (flaggedSaved.v === SEARCH_DOC_VERSION ? flaggedSaved.threads ?? [] : []),
      set: (threads: readonly string[]) => {
        if (!config.meili) return;
        const next = { v: SEARCH_DOC_VERSION, threads: [...threads] };
        if (caches) void caches.write("search/flagged.json", next);
        else writeJson(flaggedFile, next);
      },
    };
    const engine = new SearchEngine({
      connect: async () => {
        if (config.meili) return new Meili(config.meili.url, readFileSync(config.meili.keyFile, "utf8").trim());
        own = await startOwnMeili();
        return own.meili;
      },
      sources: [ownSource, ...others], cursors, flagged, channelCopy: likeRegex(CHANNEL_COPY_LIKE), log: this.log,
      allPosts: () => [...this.groups.rows().map(row => row.id), ...this.agents.list().map(record => record.room)]
        .flatMap(room => this.agentStore.postsOf(room).flatMap(post => this.postDoc(room, post) ?? [])),
    });
    // The live index follows pi-host's writes as they land, so the next search has little left to read.
    let watcher: FSWatcher | undefined;
    if (config.meili && config.durableIndex) {
      try {
        watcher = watch(dirname(config.durableIndex), (_event, name) => {
          if (String(name).startsWith("index.sqlite")) engine.scheduleRefresh();
        });
      } catch (error) {
        this.log(`search: cannot watch ${config.durableIndex} (${String(error)}); entries are read at each search`);
      }
    }
    this.searchStop = () => {
      engine.stop();
      watcher?.close();
      sqlite?.close();
      own?.stop();
    };
    return engine;
  }

  /** A post's search document, or null for a post in no DM, channel or Solo room. */
  private postDoc(room: string, post: RoomPost): PostDoc | null {
    const principal = (id: string) => this.threads.principal(id);
    const base = {
      id: postDocId(room, post.id), source: "post", kind: post.threadRoot ? POST_KINDS.reply : POST_KINDS.root, text: post.text, reactions: reactionList(principal, post),
      at: post.at, tier: 0, author: post.author, room, post: post.id, has: postHas(post, principal),
    } as const;
    const record = this.agents.record(room);
    if (record?.room === room) return { ...base, dm: true, listed: this.rooms.searchListed(record, post), ownerPost: post.author === "owner" && !post.testSend };
    if (this.groups.row(room)?.id === room) return { ...base, dm: false, listed: true, ownerPost: post.author === "owner" };
    return null;
  }

  /** The web build this server serves, read once: a release puts a new build in a new folder and restarts the server. */
  private webBuild: { entry: string | null } | undefined;

  me(): Me {
    this.webBuild ??= { entry: webEntry(this.config.webDir) };
    return {
      owner: OWNER, host: this.config.box, fixture: this.config.fixture, wikiBase: this.config.wikiBase, version: this.config.version,
      web: this.webBuild.entry,
    };
  }

  async sidebar(): Promise<Sidebar> {
    const byNew = (a: ConversationSummary, b: ConversationSummary) => b.lastActivityAt - a.lastActivityAt;
    const mark = (c: ConversationSummary) => this.marked(c);
    const groups = this.groups.summaries().filter(c => !c.archived && !this.agentStore.isTest(c.id)).map(mark);
    const solo = groups.filter(c => c.kind === "solo");
    return {
      // Solo rooms only, open ones first. A root thread is a job on its agent's page (agents.ts `fileSpawned`), never a sidebar row.
      solo: [...solo.filter(c => c.closedAt === undefined).sort(byNew), ...solo.filter(c => c.closedAt !== undefined).sort(byNew)],
      channels: groups.filter(c => c.kind === "channel").sort((a, b) => a.name.localeCompare(b.name)),
      dms: this.rooms.summaries().filter(c => !c.archived && !this.agentStore.isTest(c.id)).map(mark).sort(byNew),
      forYou: await this.boards.forYouCount().catch(() => 0),
      ...(this.store.state.sidebarLayout ? { layout: this.store.state.sidebarLayout } : {}),
    };
  }

  /** Saves the owner's whole sidebar layout from one browser and sends the sidebar to every other one. */
  setSidebarLayout(body: unknown): SavedLayout {
    const saved: SavedLayout = { ...parseLayout(body), rev: (this.store.state.sidebarLayout?.rev ?? 0) + 1 };
    this.store.state.sidebarLayout = saved;
    this.store.saveState();
    this.sidebarSoon();
    return saved;
  }

  private conversationsChanged(changed: ConversationSummary[]): void {
    for (const conversation of changed) this.broadcast({ type: "conversation", conversation });
    this.sidebarSoon();
  }

  /**
   * DM rooms changed, every one or only `only`'s: a row goes out when it differs from the last one sent. A new agent passes its own, since
   * the summaries of every DM took about 40 ms of a create on 11-23 over the live data dir's agents.
   */
  private roomsChanged(only?: AgentRecord): void {
    const changed = (only ? [this.rooms.summary(only)] : this.rooms.summaries()).filter(c => this.roomCache.get(c.id) !== JSON.stringify(c));
    for (const summary of changed) this.roomCache.set(summary.id, JSON.stringify(summary));
    this.conversationsChanged(changed);
  }

  /** Points each listed thread of each agent at its folder with an `agent.ref` doc (agents.ts), in the background. */
  private sweepRefs(): void {
    void this.agents.sweepRefs(thread => this.threads.thread(thread) !== undefined);
  }

  /**
   * Gives each open agent its comm thread in its DM and in each open channel or Solo room it is a member of, in the background after each
   * thread list read, so its work thread holds the work role and only comm threads post in its rooms (docs/agent-model.md). Until 11-21 a
   * room's first delivery made it, so search-product-misc, seo, mcp, api-portal, feature-probe and the knowledge manager had a DM the
   * owner never wrote in, whose feed read the work thread. Their work threads posted there with the chat brief, and the five with no comm
   * thread at all held no work role. An agent whose box is away or whose work thread pi-host does not list waits for the next read.
   * Resolves once a pass that began after this call ends, so the caller's new record or member is in it.
   */
  ensureComms(): Promise<void> {
    if (!this.commsRun) return (this.commsRun = this.commsPass().finally(() => { this.commsRun = undefined; }));
    // A record added while a pass runs gets the next pass, at most one queued behind it.
    return (this.commsNext ??= this.commsRun.then(() => {
      this.commsNext = undefined;
      return this.ensureComms();
    }));
  }

  private async commsPass(): Promise<void> {
    const missing = this.agents.list().filter(record => !record.archived && this.threads.thread(record.workThread) !== undefined
      && this.routing?.link(record.host).state !== "away").flatMap(record => [
      ...(record.comm?.[record.room] ? [] : [{ record, room: record.room, make: () => this.rooms.commThread(record) }]),
      ...this.groups.memberRooms(record.id).filter(row => !record.comm?.[row.id]).map(row => ({ record, room: row.id, make: () => this.groups.commThread(row, record) })),
    ]);
    if (!missing.length) return;
    let made = 0;
    for (const { record, room, make } of missing) {
      const key = `${record.id}/${room}`;
      try {
        const thread = await make();
        made++;
        this.commFailed.delete(key);
        this.log(`agents: ${record.id} has comm thread ${thread} in ${room}`);
      } catch (error) {
        if (!this.commFailed.has(key)) this.log(`agents: no comm thread for ${record.id} in ${room} yet, the next thread list read tries again: ${String(error)}`);
        this.commFailed.add(key);
      }
    }
    if (!made) return;
    await this.threads.refresh();
    this.roomsChanged();
  }

  /** Each page that watches the room watches `thread` too, as a room watch opened after the comm thread came would. */
  private async watchRoomThread(room: ConversationId, thread: ConversationId): Promise<void> {
    const adds: Promise<unknown>[] = [];
    for (const client of this.clients) {
      const targets = client.watching.get(room);
      if (!targets || targets.includes(thread)) continue;
      targets.push(thread);
      adds.push(this.threads.watch(thread).catch(() => undefined));
    }
    await Promise.all(adds);
  }

  /** The agent a DM room id names, or NotFound. */
  private roomAgent(id: ConversationId): AgentRecord {
    const record = this.agents.record(id);
    if (!record || record.room !== id) throw new NotFound(`No DM ${id}.`);
    return record;
  }

  /** A room's row with the owner's star, mute and hidden state, for the sidebar and for the room's header, which a test room's row reads. */
  private marked(summary: ConversationSummary): ConversationSummary {
    return withPrefs(summary, this.store.state.sidebar?.[summary.id], this.agentStore.postsOf(summary.id));
  }

  /** Stars, mutes, closes or leaves a DM, channel or Solo room for the owner's sidebar. */
  setPrefs(id: ConversationId, patch: PrefsPatch): ConversationPrefs {
    if (!this.isGroup(id)) this.roomAgent(id);
    const all = (this.store.state.sidebar ??= {});
    const next = applyPrefs(all[id], patch, Date.now());
    if (next) all[id] = next;
    else delete all[id];
    this.store.saveState();
    this.sidebarSoon();
    return next ?? {};
  }

  private sidebarSoon(): void {
    this.sidebarTimer ??= setTimeout(() => {
      this.sidebarTimer = undefined;
      void this.sidebar().then(sidebar => {
        const json = JSON.stringify(sidebar);
        if (json === this.lastSidebar) return;
        this.lastSidebar = json;
        this.broadcast({ type: "sidebar", sidebar });
      });
    }, 150);
  }

  // Conversations

  /** Whether the id names a channel or Solo room. */
  isGroup(id: ConversationId): boolean {
    return this.groups.row(id) !== undefined;
  }

  /** A new conversation's first page and header, as its first open reads them (`OpenedPage`). */
  async opened(id: ConversationId): Promise<OpenedPage> {
    const [page, header] = await Promise.all([this.items(id, {}), this.header(id)]);
    return { page, header };
  }

  async header(id: ConversationId): Promise<ConversationHeader> {
    const group = this.groups.row(id);
    if (group) {
      const readSeq = this.groups.readSeq(group);
      const posts = this.agentStore.postsOf(group.id);
      return {
        summary: this.marked(this.groups.summary(group)), members: this.groups.members(group), model: null, thinkingLevel: null, createdAt: group.createdAt,
        pins: pinnedPosts(posts).map(p => this.groups.item(group, p, posts)),
        boards: group.members.filter(m => this.agents.record(m.agent)).map(m => m.agent),
        ...(group.kind === "channel"
          ? { purpose: group.purpose, ...(group.homeChat ? { homeChat: group.homeChat } : {}) }
          : { agenda: group.agenda, ...(group.closedAt !== undefined ? { closedAt: group.closedAt } : {}) }),
        ...(readSeq !== undefined ? { readSeq } : {}), ...(group.test ? { test: true as const } : {}),
      };
    }
    if (isRoomId(id)) {
      const record = this.roomAgent(id);
      const agent = this.threads.agent(record.id);
      if (!agent) throw new NotFound(`No agent ${record.id}.`);
      const readSeq = this.rooms.readSeq(record);
      return {
        summary: this.marked(this.rooms.summary(record)), members: this.members(agent), model: agent.model, thinkingLevel: agent.thinkingLevel, agent,
        queue: this.queues.place(this.agents.roomThread(record)), workThread: record.workThread, ...(readSeq !== undefined ? { readSeq } : {}),
        pins: pinnedPosts(this.agentStore.postsOf(record.room)).map(p => this.rooms.item(p)),
      };
    }
    const summary = this.threads.conversation(id);
    const agent = this.threads.agent(id);
    if (!summary || !agent) throw new NotFound(`No conversation ${id}.`);
    return { summary, members: this.members(agent), model: agent.model, thinkingLevel: agent.thinkingLevel, agent, queue: this.queues.place(id) };
  }

  private members(agent: AgentSummary): ConversationHeader["members"] {
    return [{ principal: OWNER, role: "owner", wakeOn: "all" }, { principal: this.threads.principal(agent.id), role: "member", wakeOn: "all", status: agent.status }];
  }

  /**
   * A send lands in the chat server and answers at once, as in Slack: a post in a DM, a channel or a Solo room is written and delivered behind the answer,
   * and a send into a work thread's transcript goes to the outbox, which shows it on every watching page and hands it to pi-host with
   * retries (server/outbox.ts). Its images are refs that POST /api/uploads gave when the owner attached them, so no image bytes ride on the
   * send: on 11-03 a send that carried a 318 KB screenshot took 7.9 s to read off the owner's link.
   */
  async send(id: ConversationId, request: SendRequest): Promise<SendResult> {
    if (!request.text?.trim() && !request.images?.length && !request.forward) throw new Error("A message needs text, an image or a forwarded post.");
    if (!request.requestId) throw new Error("A send needs a requestId, so a retry lands once.");
    const forward = request.forward ? this.forwarded(request.forward) : undefined;
    if (forward && !isRoomId(id) && !this.isGroup(id)) throw new Error("A post forwards into a DM, a channel or a Solo room.");
    if (isRoomId(id)) {
      const record = this.roomAgent(id);
      const result = this.rooms.post(record, request, forward);
      this.answeredKeptUnread(record.room, request.requestId);
      if (request.mentions?.length) void this.deliverMentions({ requestId: request.requestId, conversation: id, text: request.text ?? "", mentions: request.mentions })
        .then(sent => sent.filter(d => d.state === "failed").forEach(d => this.log(`posts: mention of ${d.target} in ${id} ${request.requestId} failed: ${d.error}`)));
      await this.agentStore.written(record.room);
      return result;
    }
    if (this.isGroup(id)) {
      const result = this.groups.post(id, request, forward);
      this.answeredKeptUnread(id, request.requestId);
      await this.agentStore.written(id);
      return result;
    }
    const { thread } = parseConversationId(id);
    if (!this.threads.thread(thread)) throw new NotFound(`No thread ${thread}.`);
    const open = this.outbox.get(request.requestId);
    if (open && open.conversation !== id) throw new Error(`A requestId names one send; ${request.requestId} went to ${open.conversation}.`);
    const images = open ? open.images : (request.images ?? []).map(image => this.uploaded(image));
    const item = this.outbox.add({
      requestId: request.requestId, conversation: id, text: request.text ?? "", images, mentions: (request.mentions ?? []).filter(m => m !== id && m !== "owner"),
      whenBusy: request.whenBusy ?? "steer",
    });
    this.store.state.reads[id] = { at: Date.now() };
    this.store.saveState();
    await this.outbox.written();
    return { item, deliveries: item.kind === "message" ? item.deliveries : [] };
  }

  /** The post a send forwards, copied as it reads now (forward.ts). */
  private forwarded(input: unknown): ForwardedPost {
    const ref = forwardInput(input);
    const group = this.groups.row(ref.room);
    const record = group ? undefined : isRoomId(ref.room) ? this.roomAgent(ref.room) : undefined;
    const room = group?.id ?? record?.room;
    if (!room) throw new NotFound(`No room ${ref.room}; a forward quotes a post of a DM, a channel or a Solo room.`);
    const post = this.agentStore.postsOf(room).find(p => p.id === ref.post);
    if (!post) throw new NotFound(`No post ${ref.post} in ${ref.room}.`);
    return forwardOf(post, group?.name ?? record!.name, id => this.threads.principal(id));
  }

  /** A thread in a DM, a channel or a Solo room: its root post and every reply, oldest first. */
  replies(id: ConversationId, root: string): { root: Item; items: Item[] } {
    return isRoomId(id) ? this.rooms.replies(this.roomAgent(id), root) : this.groups.replies(id, root);
  }

  /** Tries a failed or waiting send again now. */
  retrySend(id: ConversationId, requestId: string): SendResult {
    if (isRoomId(id)) return this.rooms.retry(this.roomAgent(id), requestId);
    if (this.isGroup(id)) return this.groups.retry(id, requestId);
    const row = this.outbox.get(requestId);
    if (!row || row.conversation !== id) throw new NotFound(`No pending send ${requestId} in ${id}.`);
    const item = this.outbox.retry(requestId)!;
    return { item, deliveries: row.deliveries };
  }

  /** Marks a DM post that a job typed into the owner's composer as that job's test send (rooms.ts `markTestSend`). */
  markTestSend(id: ConversationId, postId: string, input: { by?: unknown; reason?: unknown }): SendResult {
    if (!isRoomId(id)) throw new Error("A test send mark is for a DM post; name its room, such as dm_vent.");
    return this.rooms.markTestSend(this.roomAgent(id), postId, input);
  }

  /** The owner puts an emoji on a room post or takes his own off (reactions.ts `react`); the post's watchers get it at once. */
  react(id: ConversationId, postId: string, input: { emoji?: unknown; on?: unknown }): { item: Item } {
    const room = isRoomId(id) ? this.roomAgent(id).room : this.groups.row(id)?.id;
    if (!room) throw new NotFound(`No room ${id}; reactions go on posts in a DM, a channel or a Solo room.`);
    const post = this.agentStore.postsOf(room).find(p => p.id === postId);
    if (!post) throw new NotFound(`No post ${postId} in ${id}.`);
    const { emoji, on } = reactionInput(input);
    this.setReaction(room, post, "owner", emoji, on);
    if (on) this.handledKeptUnread(room, post.id);
    return { item: this.postItem(room, post) };
  }

  /**
   * Mark unread (keep-unread.ts): the room reads unread from the post, and the post stays in Later's Keep unread stack until the owner
   * handles it, with a reminder at the next 9:00 in Seoul that marks the room unread from it again.
   */
  markUnread(id: ConversationId, post: string): void {
    const room = isRoomId(id) ? this.roomAgent(id).room : this.groups.row(id)?.id;
    if (!room) throw new NotFound(`No room ${id}; Mark unread is for posts in a DM, a channel or a Solo room.`);
    this.roomUnreadFrom(room, post);
    this.later.keepUnread("owner", room, post, nextMorning(Date.now()));
  }

  /** Undo of an unsave from Later (later.ts `restore`): the item comes back as it was, and a post kept unread makes its room unread from it again. */
  restoreLater(id: string, input: Record<string, unknown>): LaterItem {
    const item = this.later.restore("owner", id, input);
    if (item.unread && item.state === "open" && item.room !== undefined) this.roomUnreadFrom(item.room, item.post);
    return item;
  }

  private roomUnreadFrom(room: RoomId, post: string): void {
    if (this.isGroup(room)) this.groups.markRead(room, undefined, post);
    else this.rooms.markRead(this.roomAgent(room), undefined, post);
  }

  /** The owner's send answers each post he kept unread in the room that it replies to, which checks them off. */
  private answeredKeptUnread(room: RoomId, requestId: string): void {
    const reply = this.agentStore.byRequestId(room, requestId);
    if (!reply) return;
    const posts = this.agentStore.postsOf(room);
    for (const item of this.later.items("owner")) {
      if (item.room !== room || !item.unread || item.state !== "open") continue;
      const marked = posts.find(p => p.id === item.post);
      if (marked && answers(marked, reply)) this.later.update("owner", item.id, { state: "done" });
    }
  }

  /** The owner reacted to a post he kept unread, which handles it. */
  private handledKeptUnread(room: RoomId, post: string): void {
    const item = this.later.find("owner", room, post);
    if (item?.unread && item.state === "open") this.later.update("owner", item.id, { state: "done" });
  }

  /**
   * An agent's set_emoji: the thread names the agent and its room (a comm thread its room's, the work thread the DM), and `message` names a
   * post there, or `<room>/<post>` in another room the agent is in (reactions.ts `agentPost`). The answer's `text` is the tool's result.
   */
  reactAsAgent(thread: string, input: { message?: unknown; emoji?: unknown; on?: unknown }): { room: string; post: string; reactions: Reaction[]; text: string } {
    const { emoji, on } = reactionInput(input);
    const { record, room, post } = this.agentMessage(thread, input.message, "set_emoji");
    this.setReaction(room, post, record.id, emoji, on);
    const principal = (id: string) => this.threads.principal(id);
    return { room, post: post.id, reactions: reactionsOf(principal, post).reactions ?? [], text: reactionText(principal, post, emoji, on, String(input.message).includes("/")) };
  }

  /**
   * The agent and post an agent's room tool names: the thread names the agent and its room (a comm thread its room's, the work thread the
   * DM), and `message` names a post there, or `<room>/<post>` in another room the agent is in (reactions.ts `agentPost`).
   */
  private agentMessage(thread: string, message: unknown, tool: string): { record: AgentRecord; room: RoomId; post: RoomPost } {
    const { record, room, via, id } = this.agentTarget(thread, message, tool);
    return { record, room, post: agentPost(this.agentStore.postsOf(room), record, via, room, id) };
  }

  /** The agent, room and post id `message` names, with the thread the agent reads that room's posts through. */
  private agentTarget(thread: string, message: unknown, tool: string): { record: AgentRecord; room: RoomId; via: string; id: string } {
    const comm = this.agents.ofComm(thread);
    const record = comm?.record ?? this.agents.ofWorkThread(thread);
    if (!record) throw new ReactionError(404, `Thread ${thread} is no agent's comm thread or work thread; call ${tool} from the agent's own thread.`);
    if (typeof message !== "string" || !message.trim()) {
      throw new ReactionError(400, `${tool} names its post as message, such as p12, dm_vent/p12 or the [message id: ...] value after an owner message.`);
    }
    const slash = message.indexOf("/");
    const room = (slash < 0 ? comm?.room ?? record.room : message.slice(0, slash).trim()) as RoomId;
    const roomThread = room === record.room ? this.agents.roomThread(record) : this.groups.row(room) ? record.comm?.[room] : undefined;
    if (!roomThread) throw new ReactionError(404, `${record.name} is not in room ${room}; name a post in its DM ${record.room} or in a channel it is in, such as ${record.room}/p12.`);
    return { record, room, via: slash < 0 ? thread : roomThread, id: message.slice(slash + 1) };
  }

  /**
   * An agent's edit_message on its own post, through the owner's edit (`rewrite`). `message` names the post as set_emoji does, or as
   * `reply:<id>`, the agent's first post that answers that owner post (`RoomPost.answers`), or `last`, its newest post in the room. The room's
   * feed is read first, so a post the agent's turn made a moment ago is there. An edit that runs long or holds a table is held once here,
   * whether it came from edit_message or from a kernel's own call of this route (`editHold`), and answers 400 with the note.
   */
  async editAsAgent(thread: string, input: { message?: unknown; text?: unknown }): Promise<{ room: string; post: string; text: string }> {
    const named = typeof input.message === "string" ? input.message.trim() : input.message;
    const reply = typeof named === "string" && /^reply:/i.test(named);
    const { record, room, via, id } = this.agentTarget(thread, reply ? (named as string).slice("reply:".length) : named, "edit_message");
    const group = this.groups.row(room);
    await (group ? this.groups.feed(record.comm?.[room] ?? "") : this.rooms.feed(record));
    const posts = this.agentStore.postsOf(room);
    const mine = (p: RoomPost) => p.author === record.id && p.deletedAt === undefined;
    let post: RoomPost | undefined;
    if (reply) {
      const asked = agentPost(posts, record, via, room, id);
      post = posts.find(p => mine(p) && p.answers === asked.id);
      if (!post) throw new ReactionError(404, `${record.name} has no post in ${room} that answers ${asked.id}; name your post by its id, such as ${room}/p12, or as last.`);
    } else if (/^last$/i.test(id.trim())) {
      post = posts.findLast(mine);
      if (!post) throw new ReactionError(404, `${record.name} has no post in ${room} yet; post with tell_owner first.`);
    } else post = agentPost(posts, record, via, room, id);
    if (typeof input.text === "string" && input.text.trim() !== post.text) {
      const held = this.heldEdits.get(thread) ?? new Set<string>();
      this.heldEdits.set(thread, held);
      const note = editHold(input.text.trim(), held);
      if (note) throw new ReactionError(400, note);
      const moved = this.movedSinceRead(record, room, post);
      if (moved) throw new ReactionError(400, moved);
    }
    const changed = this.rewrite(room, post, record.id, input.text, thread) !== undefined;
    return { room, post: post.id, text: changed ? `Edited ${post.id} in ${room}; the room shows the new text with (edited).` : `${post.id} in ${room} already reads that way; nothing changed.` };
  }

  /**
   * The read-before-send check on an agent's edit (moved.ts): the note that holds it once when the thread of `post` moved since the agent's
   * comm thread for the room last read it, else undefined. The posts it shows count as read, so the same edit again goes through.
   */
  private movedSinceRead(record: AgentRecord, room: RoomId, post: RoomPost): string | undefined {
    const group = this.groups.row(room);
    const thread = group ? record.comm?.[room] : this.agents.roomThread(record);
    const cursor = group ? this.agentStore.rooms.commFeed?.[thread ?? ""] : this.agentStore.rooms.feed[record.id];
    if (!thread || !cursor?.read) return undefined;
    const moved = movedPosts(this.agentStore.postsOf(room), record.id, thread, cursor.read, post.threadRoot ?? (group?.kind === "channel" ? post.id : undefined));
    if (!moved.length) return undefined;
    const now = Date.now();
    cursor.read = readMoved(cursor.read, moved, now);
    this.agentStore.saveRooms();
    return movedNote(moved, id => this.threads.principal(id).name, "edit");
  }

  /**
   * A speaking call's post, made while the call's execute runs so the tool answers with its id, after the read-before-send check (rooms.ts
   * `speakNow`): `held` carries the new posts that held it, and `unknown` means the thread is no agent's comm thread or the feed has no such
   * call, so the feed posts it as before once the result lands.
   */
  async speakAsAgent(thread: string, input: { call?: unknown }): Promise<SpeakAnswer> {
    if (typeof input.call !== "string" || !input.call) throw new ReactionError(400, "A speak names its tool call as call.");
    const comm = this.agents.ofComm(thread);
    if (!comm) return { kind: "unknown" };
    return this.groups.row(comm.room) ? this.groups.speak(thread, input.call) : this.rooms.speak(comm.record, thread, input.call);
  }

  /**
   * A pi-host root's agent_message.send to a thread its own pi-host does not run (pi-host rlm.ts `sendAcross`): `to` is the thread's id or
   * its exact name, and the submit goes to the box that runs it, through that box's relay as a room post does. NotFound when no thread has
   * that id or name, so pi-host answers "No sibling matches"; HostAway (503) when the box is away, and nothing is queued then.
   */
  async agentMessageAsAgent(from: string, input: { to?: unknown; text?: unknown; requestId?: unknown; whenBusy?: unknown }): Promise<{ thread: string; name: string; box: string; submission: number }> {
    const to = typeof input.to === "string" ? input.to.trim() : "";
    if (!to || typeof input.text !== "string" || !input.text.trim()) throw new ReactionError(400, "An agent message is { to: <thread id or name>, text }.");
    const rows = this.threads.threadsList().filter(row => !row.archived && row.id !== from);
    const byId = rows.find(row => row.id === to);
    const found = byId ? [byId] : rows.filter(row => row.name === to);
    if (!found.length) throw new NotFound(`No thread on any box has the id or name ${JSON.stringify(to)}.`);
    const where = (row: (typeof rows)[number]) => `${row.name} (${row.id}) on ${row.box ?? this.config.box}`;
    if (found.length > 1) throw new ReactionError(400, `${JSON.stringify(to)} names ${found.length} threads: ${found.map(where).join(", ")}; send to one full id.`);
    const target = found[0]!;
    const box = target.box ?? this.config.box;
    try {
      const { submission } = await this.host.submit(target.id, {
        text: input.text, whenBusy: input.whenBusy === "followUp" ? "followUp" : "steer", ...(typeof input.requestId === "string" && input.requestId ? { requestId: input.requestId } : {}),
        entry: { kind: "agent.message", data: { from, via: "agent_message" } },
      });
      return { thread: target.id, name: target.name, box, submission };
    } catch (error) {
      if (isHostAway(error)) error.message = `${where(target)} is away now, so the message was not sent; send it again once ${box} is back.`;
      throw error;
    }
  }

  /** An agent's save_message or remind_me (later-agents.ts `set`); the answer's `text` is the tool's result. */
  laterAsAgent(thread: string, input: { message?: unknown; state?: unknown; remindAt?: unknown; memo?: unknown }): { text: string } {
    const { record, room, post } = this.agentMessage(thread, input.message, input.remindAt !== undefined ? "remind_me" : "save_message");
    return { text: this.agentLater.set(record, room, post, input) };
  }

  /** An agent's read_post (later-agents.ts `read`): the post `message` names, as set_emoji names it, and its thread. The feed is read first, so a post its turn made a moment ago is there. */
  async readAsAgent(thread: string, message: unknown): Promise<{ room: string; post: string; text: string }> {
    const { record, room } = this.agentTarget(thread, message, "read_post");
    await (this.groups.row(room) ? this.groups.feed(record.comm?.[room] ?? "") : this.rooms.feed(record));
    const { post } = this.agentMessage(thread, message, "read_post");
    const { text, shown } = this.agentLater.read(record, room, post);
    // The posts a comm thread read count as read, as a hold's do (`movedSinceRead`), so its send right after is not held for them.
    const group = this.groups.row(room);
    const comm = group ? record.comm?.[room] : this.agents.roomThread(record);
    const cursor = group ? this.agentStore.rooms.commFeed?.[comm ?? ""] : this.agentStore.rooms.feed[record.id];
    if (comm === thread && cursor?.read && !cursor.read.ended) {
      cursor.read = readMoved(cursor.read, shown.map(p => ({ post: p, edited: false })), Date.now());
      this.agentStore.saveRooms();
    }
    return { room, post: post.id, text };
  }

  /** An agent's list_saved_messages (later-agents.ts `listText`). */
  laterListAsAgent(thread: string, state: string | null): { text: string } {
    const record = this.agents.ofComm(thread)?.record ?? this.agents.ofWorkThread(thread);
    if (!record) throw new ReactionError(404, `Thread ${thread} is no agent's comm thread or work thread; call list_saved_messages from the agent's own thread.`);
    if (state !== null && state !== "open" && state !== "done") throw new ReactionError(400, "A saved list's state is open or done.");
    return { text: this.agentLater.listText(record, state ?? "open") };
  }

  /** The owner's own post in a DM, a channel or a Solo room, with the room it is in. */
  private ownPost(id: ConversationId, postId: string): { room: string; post: RoomPost } {
    const room = isRoomId(id) ? this.roomAgent(id).room : this.groups.row(id)?.id;
    if (!room) throw new NotFound(`No room ${id}; you edit and delete posts in a DM, a channel or a Solo room.`);
    const post = this.agentStore.postsOf(room).find(p => p.id === postId);
    if (!post) throw new NotFound(`No post ${postId} in ${id}.`);
    assertEditable(post, "owner");
    return { room, post };
  }

  /** Slack's Edit message on the owner's own post (post-edits.ts): a delivery on its way carries the new text, and an agent that read it gets the edit. */
  editPost(id: ConversationId, postId: string, input: { text?: unknown }): { item: Item } {
    const { room, post } = this.ownPost(id, postId);
    const before = this.rewrite(room, post, "owner", input.text);
    if (before !== undefined) void this.tellReaders(room, post, `e${post.editedAt}`, place => editNotice(post, place, before));
    return { item: this.postItem(room, post) };
  }

  /**
   * The one edit of a room post, the owner's and an agent's alike (post-edits.ts): `by`'s own post gets the new text and `editedAt`, keeps its
   * place, thread, `answers` and reactions, and the room's watchers get it. An agent's edit also stores `from`, the thread that sent it.
   * Returns the text before, or undefined when the text is the same.
   */
  private rewrite(room: string, post: RoomPost, by: RoomPost["author"], input: unknown, from?: string): string | undefined {
    assertEditable(post, by);
    if (typeof input !== "string") throw new ReactionError(400, "A post edit carries text, a string.");
    const text = input.trim();
    if (!text && !post.images.length) throw new ReactionError(400, "A post needs text or an image; delete it instead of clearing it.");
    if (text === post.text) return undefined;
    const before = post.text;
    this.agentStore.set(post, { text, editedAt: Date.now(), ...(from ? { editedFrom: from } : {}) });
    this.emitPosts(room, [post]);
    return before;
  }

  /** Slack's Delete message on the owner's own post (post-edits.ts): its words go, a delivery on its way stops, and an agent that read it is told. */
  deletePost(id: ConversationId, postId: string): { item: Item } {
    const { room, post } = this.ownPost(id, postId);
    const before = post.text;
    const now = Date.now();
    const stop = (d: RoomDelivery): RoomDelivery => (d.state === "sending" ? { ...d, state: "stopped", at: now, error: "You deleted this post before it was delivered." } : d);
    this.agentStore.set(post, {
      text: "", images: [], deletedAt: now,
      ...(post.delivery ? { delivery: stop(post.delivery) } : {}), ...(post.deliveries ? { deliveries: post.deliveries.map(stop) } : {}),
    });
    this.emitPosts(room, [post]);
    void this.tellReaders(room, post, `x${now}`, place => deleteNotice(post, place, before));
    return { item: this.postItem(room, post) };
  }

  /** Each agent that already got the post gets `notice` as an owner input in the thread it got the post in. */
  private async tellReaders(room: string, post: RoomPost, key: string, notice: (place: string) => string): Promise<void> {
    const group = this.groups.row(room);
    const text = notice(group ? roomLabel(group) : "your DM");
    for (const d of deliveriesOf(post)) {
      if (d.state !== "delivered" || !d.thread) continue;
      try {
        await this.outbox.submit(d.thread, { text, requestId: `${key}:${room}:${post.id}:${d.target}`, whenBusy: "steer", ownerTurn: true });
      } catch (error) {
        this.log(`posts: telling ${d.target} about ${room} ${post.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Adds agents to a channel or Solo room and makes each new member's comm thread there in the background (`ensureComms`). */
  addMembers(id: ConversationId, agents: string[], wakeOn?: WakeOn, by: MemberChange["by"] = "owner"): { room: Room; added: AgentId[] } {
    const result = this.groups.addMembers(id, agents, wakeOn, by);
    if (result.added.length) void this.ensureComms();
    return result;
  }

  /**
   * Takes an agent out of a channel or Solo room (group-rooms.ts `removeMember`) and stops its comm thread there, as the room's Stop does,
   * so a turn it was in, or one waiting for a slot in pi-pool's queue, posts nothing after the remove. A later @mention starts a new turn.
   */
  async removeMember(id: ConversationId, agent: string, by: MemberChange["by"] = "owner"): Promise<{ room: Room; removed: boolean; wakeOn?: WakeOn }> {
    const result = this.groups.removeMember(id, agent, by);
    const thread = result.removed ? this.threads.registered(agent)?.comm?.[result.room.id] : undefined;
    if (thread) await this.host.abort(thread).catch(error => this.log(`rooms: stopping ${agent}'s comm thread ${thread} after its remove from ${result.room.id} failed: ${String(error)}`));
    return result;
  }

  /**
   * An agent's set_room_member: adds `agent`, an agent id or name, to `room`, a channel or Solo room by id or `#name`, or takes it out.
   * The answer's `text` is the tool's result line.
   */
  async memberAsAgent(thread: string, input: { room?: unknown; agent?: unknown; member?: unknown }): Promise<{ room: RoomId; agent: AgentId; member: boolean; text: string }> {
    const record = this.agents.ofComm(thread)?.record ?? this.agents.ofWorkThread(thread);
    if (!record) throw new ReactionError(404, `Thread ${thread} is no agent's comm thread or work thread; call set_room_member from the agent's own thread.`);
    if (typeof input.room !== "string" || !input.room.trim()) throw new ReactionError(400, "set_room_member names the room, such as ch_1a2b3c4d or #general.");
    if (typeof input.agent !== "string" || !input.agent.trim()) throw new ReactionError(400, "set_room_member names the agent by its id, such as ag_vent, or its name.");
    if (typeof input.member !== "boolean") throw new ReactionError(400, "set_room_member's member is true to add the agent or false to remove it.");
    const row = this.groups.row(input.room.trim());
    if (!row) throw new ReactionError(404, `No channel or Solo room ${input.room}; name it by its id, such as ch_1a2b3c4d, or as #name.`);
    const target = this.threads.registered(input.agent.trim());
    if (!target) throw new ReactionError(404, `No agent ${input.agent}; name a registered agent by its id, such as ag_vent, or its name.`);
    const where = roomLabel(row);
    if (input.member) {
      const { added } = this.addMembers(row.id, [target.id], undefined, record.id);
      const text = added.length ? `Added ${target.name} to ${where}; it hears every post there from now on.` : `${target.name} is already in ${where}; nothing changed.`;
      return { room: row.id, agent: target.id, member: true, text };
    }
    const { removed } = await this.removeMember(row.id, target.id, record.id);
    const text = removed ? `Removed ${target.name} from ${where}; later posts no longer reach it, unless one @mentions it.` : `${target.name} is not in ${where}; nothing changed.`;
    return { room: row.id, agent: target.id, member: false, text };
  }

  /** The owner marks the thread of a room post done or reopens it (thread-done.ts); the room's watchers get its root at once. */
  threadDone(id: ConversationId, postId: string, input: { done?: unknown }): { item: Item } {
    const room = isRoomId(id) ? this.roomAgent(id).room : this.groups.row(id)?.id;
    if (!room) throw new NotFound(`No room ${id}; a thread is marked done in a DM, a channel or a Solo room.`);
    const posts = this.agentStore.postsOf(room);
    const post = posts.find(p => p.id === postId);
    if (!post) throw new NotFound(`No post ${postId} in ${id}.`);
    const root = threadRootOf(posts, post);
    const flag = markDone(root, doneInput(input));
    if (flag) {
      this.agentStore.set(root, { done: flag });
      this.emitPosts(room, [root]);
    }
    return { item: this.postItem(room, root) };
  }

  /** The owner pins a room post or un-pins it (pins.ts); the room's watchers get the post at once and re-read the header's Pinned list. */
  pin(id: ConversationId, postId: string, input: { pinned?: unknown }): { item: Item } {
    const room = isRoomId(id) ? this.roomAgent(id).room : this.groups.row(id)?.id;
    if (!room) throw new NotFound(`No room ${id}; a post is pinned in a DM, a channel or a Solo room.`);
    const post = this.agentStore.postsOf(room).find(p => p.id === postId);
    if (!post) throw new NotFound(`No post ${postId} in ${id}.`);
    const flag = markPin(post, pinInput(input));
    if (flag) {
      this.agentStore.set(post, { pinned: flag });
      this.emitPosts(room, [post]);
    }
    return { item: this.postItem(room, post) };
  }

  private setReaction(room: string, post: RoomPost, by: "owner" | AgentRecord["id"], emoji: string, on: boolean): void {
    const reactions = react(post, by, emoji, on);
    if (!reactions) return;
    this.agentStore.set(post, { reactions });
    this.emitPosts(room, [post]);
  }

  /** Room posts whose state changed, re-read and sent to the room's watchers. */
  private emitPosts(room: string, posts: RoomPost[]): void {
    const record = this.agents.record(room);
    if (record?.room === room) return this.rooms.changed(record, posts);
    const group = this.groups.row(room);
    if (group) this.groups.emit(group, posts);
  }

  private postItem(room: string, post: RoomPost): Item {
    const group = this.groups.row(room);
    return group ? this.groups.item(group, post) : this.rooms.item(post);
  }

  /** Drops a pending send the owner gave up on. A DM post is stored, so it stays. */
  discardSend(id: ConversationId, requestId: string): void {
    if (isRoomId(id) || this.isGroup(id)) throw new Error("A room post is stored; retry its delivery instead of discarding it.");
    const row = this.outbox.get(requestId);
    if (!row || row.conversation !== id) throw new NotFound(`No pending send ${requestId} in ${id}.`);
    this.outbox.discard(requestId);
  }

  /**
   * Each @mention in a thread send or a DM post goes to the mentioned agent's work thread as an agent message from the owner, once the send
   * reached pi-host. Only a registered agent is a target (`Threads.registered`): a mention of a job, a bare thread, a name only a job has
   * or an archived agent is not delivered. A mention pi-host did not take, as while it restarts for an install, stays in the outbox and
   * goes when pi-host is back (`Outbox.submit`), and reads queued meanwhile.
   */
  private async deliverMentions(row: Pick<OutboxRow, "requestId" | "conversation" | "text" | "mentions">): Promise<Delivery[]> {
    const deliveries: Delivery[] = [];
    const targets = new Map(row.mentions.flatMap(m => {
      const record = this.threads.registered(m);
      return record && !record.archived && record.workThread !== row.conversation && record.room !== row.conversation ? [[record.id, record] as const] : [];
    }));
    for (const [target, record] of targets) {
      const name = this.threads.principal(target).name;
      try {
        const sent = await this.outbox.submit(record.workThread, {
          text: row.text, requestId: `${row.requestId}:${target}`, whenBusy: "followUp",
          entry: { kind: "agent.message", data: { from: "owner", via: row.conversation } }, ownerTurn: true,
        });
        if (!sent) {
          deliveries.push({ target, name, state: "queued", at: Date.now() });
          continue;
        }
        const place = waitingPlace(sent.ticket?.place);
        deliveries.push({ target, name, state: place?.state === "queued" ? "queued" : "delivered", at: Date.now(), ...(place ? { queue: place } : {}) });
        this.queues.follow(record.workThread, sent.ticket?.place ?? null);
      } catch (error) {
        deliveries.push({ target, name, state: "failed", at: Date.now(), error: error instanceof Error ? error.message : String(error) });
      }
    }
    return deliveries;
  }

  /** A timeline page; the newest page of a thread also carries the sends pi-host has not shown yet, after its entries. */
  async items(id: ConversationId, opts: { before?: string; after?: string; around?: string; limit?: number }, split?: ItemsSplit): Promise<TimelinePage> {
    if (isRoomId(id)) return this.rooms.timeline(this.roomAgent(id), opts);
    if (this.isGroup(id)) return this.groups.timeline(id, opts);
    const page = await this.threads.timeline(id, opts, split);
    this.outbox.reconcile(id, page.items);
    if (opts.before || page.newer) return page;
    const pending = this.outbox.items(id);
    return pending.length ? { ...page, items: [...page.items, ...pending] } : page;
  }

  /**
   * POST /api/uploads: an attached file's bytes, kept under a fresh name; a send names the ref it returns. An image answers its size in
   * pixels; any other file (server/files.ts) answers the `name` the page passed and its size in bytes.
   */
  async upload(contentType: string, body: Readable, fileName?: string): Promise<ImageRef> {
    const mimeType = contentType.split(";")[0]!.trim().toLowerCase() || "application/octet-stream";
    const name = `${randomUUID()}.${uploadExtension(mimeType, isImage({ mimeType }) ? undefined : fileName)}`;
    const path = this.store.imagePath(name);
    try {
      await pipeline(body, createWriteStream(path));
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
    const size = statSync(path).size;
    if (!size) {
      await rm(path, { force: true });
      throw new Error("An upload needs the file's bytes.");
    }
    if (isImage({ mimeType })) return { url: `/api/uploads/${name}`, mimeType, ...fileImageSize(path) };
    return { url: `/api/uploads/${name}`, mimeType, name: fileName?.trim().slice(0, 255) || "file", size };
  }

  /**
   * A send's image: a ref POST /api/uploads gave, whose file is here. A page loaded before b2058046 (11-03 15:01Z) still sends the image's
   * base64 bytes as `{data, mimeType}`; those are kept as an upload on arrival, because on 11-04 at 03:09Z the owner's open tab sent two
   * posts that way and both came back Not delivered with "No upload undefined". The server takes the send form of the build before the
   * current one in this way each time a release changes it, and pages reload themselves to the new build at a safe moment
   * (web/src/lib/api/reload.ts); each arrival logs a line, so the log shows when no older page sends it any more.
   */
  private uploaded(ref: ImageRef | LegacyImage): ImageRef {
    const legacy = ref as Partial<LegacyImage>;
    if (typeof legacy?.data === "string" && typeof legacy.mimeType === "string" && legacy.mimeType.startsWith("image/") && legacy.data) {
      const name = `${randomUUID()}.${legacy.mimeType.split("/")[1]!.replace(/[^a-z0-9]/g, "") || "bin"}`;
      const bytes = Buffer.from(legacy.data, "base64");
      writeFileSync(this.store.imagePath(name), bytes);
      this.log(`send: an inline image from a page on a web build before b2058046, kept as /api/uploads/${name}`);
      return { url: `/api/uploads/${name}`, mimeType: legacy.mimeType, ...imageSize(bytes) };
    }
    ref = ref as ImageRef;
    const name = typeof ref?.url === "string" && ref.url.startsWith("/api/uploads/") ? ref.url.slice("/api/uploads/".length).replace(/[^\w.-]/g, "") : "";
    if (!name || !existsSync(this.store.imagePath(name))) {
      throw new Error(`No upload ${String(ref?.url)}; post the image to POST /api/uploads first and send the {url, mimeType} it answers.`);
    }
    if (!isImage(ref)) {
      const label = typeof ref.name === "string" && ref.name.trim() ? ref.name.trim().slice(0, 255) : "file";
      return { url: `/api/uploads/${name}`, mimeType: ref.mimeType, name: label, size: statSync(this.store.imagePath(name)).size };
    }
    const image = withSize({ url: `/api/uploads/${name}`, mimeType: ref.mimeType }, () => fileImageSize(this.store.imagePath(name)));
    if (isModelImage(ref)) return image;
    const label = typeof ref.name === "string" && ref.name.trim() ? ref.name.trim().slice(0, 255) : "image";
    return { ...image, name: label, size: statSync(this.store.imagePath(name)).size };
  }

  /** Where an upload's bytes sit on this box, which an agent reads a file that is not an image from (server/files.ts). */
  uploadPath(ref: ImageRef): string {
    return this.store.imagePath(ref.url.slice("/api/uploads/".length).replace(/[^\w.-]/g, ""));
  }

  /** An attached image's bytes for a model; any other file, a TIFF or SVG image too, reaches the agent as a line with its path instead. */
  private readUpload(ref: ImageRef): { data: string; mimeType: string } | undefined {
    const name = ref.url.startsWith("/api/uploads/") ? ref.url.slice("/api/uploads/".length).replace(/[^\w.-]/g, "") : "";
    if (!name || !isModelImage(ref)) return undefined;
    try {
      return { data: readFileSync(this.store.imagePath(name)).toString("base64"), mimeType: ref.mimeType };
    } catch {
      return undefined;
    }
  }

  /** Stops the conversation's turn, a running one or one that waits for a working slot, and its wait line goes at the next queue read. */
  async abort(id: ConversationId): Promise<void> {
    if (this.isGroup(id)) {
      await this.groups.abort(id);
      for (const comm of this.groups.commThreads(this.groups.require(id))) this.queues.stopped(comm.thread);
      return;
    }
    if (isRoomId(id)) {
      const record = this.roomAgent(id);
      const threads = [...new Set([record.workThread, this.agents.roomThread(record)])];
      await Promise.all(threads.map(thread => this.host.abort(thread)));
      for (const thread of threads) this.queues.stopped(thread);
      return;
    }
    const { thread, conversation } = parseConversationId(id);
    await this.host.abort(thread, conversation === 1 ? undefined : conversation);
    this.queues.stopped(id);
  }

  /**
   * On a DM, a rename or archive changes the agent and its work thread, cwd changes the work thread, and model and thinking level change the
   * work thread and every comm thread, since a comm thread took the work thread's model only when it was made (`threadModel`).
   */
  async patch(id: ConversationId, patch: ConversationPatch): Promise<ConversationHeader> {
    if (this.isGroup(id)) {
      this.groups.update(id, { ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.archived !== undefined ? { archived: patch.archived } : {}) });
      return this.header(id);
    }
    const { thread, conversation } = parseConversationId(isRoomId(id) ? this.roomAgent(id).workThread : id);
    if (conversation !== 1 && patch.name !== undefined) throw new Error("Rename the job's thread instead; a job inside a thread has no name of its own in pi-host.");
    if (conversation !== 1 && patch.cwd !== undefined) throw new Error("A job inside a thread runs in its thread's folder; move the thread's root instead.");
    // pi-host archives only a root thread, so the archive of a job inside a thread is the chat server's own flag.
    const jobArchive = conversation !== 1 && patch.archived !== undefined;
    if (jobArchive) this.threads.setJobArchived(thread, conversation, patch.archived!);
    const set = {
      ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.archived !== undefined && !jobArchive ? { archived: patch.archived } : {}),
      ...(patch.cwd !== undefined ? { cwd: projectCwd(this.config, patch.cwd) } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}), ...(patch.thinkingLevel !== undefined ? { thinkingLevel: patch.thinkingLevel } : {}),
    };
    const known = patch.model === undefined || MODELS.models.some(m => `${m.provider}/${m.id}` === patch.model);
    if (!Object.keys(set).length) void this.threads.poll();
    else if (!(patch.cwd === undefined && known && this.threads.change(thread, set))) this.threads.put(await this.host.set(thread, set));
    const model = { ...(set.model !== undefined ? { model: set.model } : {}), ...(set.thinkingLevel !== undefined ? { thinkingLevel: set.thinkingLevel } : {}) };
    if (isRoomId(id) && Object.keys(model).length) {
      const comms = Object.values(this.roomAgent(id).comm ?? {});
      await Promise.all(comms.map(async comm => { if (!(known && this.threads.change(comm, model))) this.threads.put(await this.host.set(comm, model)); }));
    }
    return this.header(id);
  }

  /** A feed row from a box's relay: the room whose thread spoke reads its feed, and the relay client acks the row after it. */
  private async feedRow(row: FeedRow): Promise<void> {
    const comm = this.agents.ofComm(row.thread);
    if (comm && isGroupRoomId(comm.room)) return this.groups.feed(row.thread);
    const record = this.agents.ofWorkThread(row.thread) ?? comm?.record;
    if (record) await this.rooms.feed(record);
  }

  /** Files on another box, through its relay. */
  private boxFiles(box: string): BoxFiles {
    const relay = () => {
      const found = this.routing?.relay(box);
      if (!found) throw new Error(`No relay for box ${box}, so its agent folders cannot be read here.`);
      return found;
    };
    return { get: async path => relay().fileGet(path), put: async (path, text) => relay().filePut(path, text) };
  }

  /** The boxes a new agent can run on, with their link state and project folders. */
  agentHosts(): AgentHostList {
    const routing = this.routing;
    if (!routing) {
      const list = projectList(this.config);
      return { hosts: [{ box: this.config.box, label: this.config.box, self: true, state: "up", home: list.home, projects: list.projects.map(p => p.path) }] };
    }
    return {
      hosts: routing.list().map(b => {
        const link = routing.link(b.box);
        const info = routing.info(b.box);
        return { box: b.box, label: b.label, self: b.box === this.config.box, state: link.state, since: link.since, ...(info ? { home: info.home, projects: info.projects } : {}) };
      }),
    };
  }

  /** The project folders a new agent can run in on this box (`server/projects.ts`). */
  projects(): ProjectList {
    return projectList(this.config);
  }

  /**
   * A new agent: its work thread in a project folder (the one given, else the default project, never the home folder), its record and its DM
   * room, made at once. With `kind: "job"` or a `parent`, the thread is a root job filed under that agent instead. With `test` it is a walk's
   * throwaway agent, which no owner list, live event or badge shows (`AgentStore.isTest`). `brief`, the owner's words for what the agent is
   * for, becomes its brief.md: until 11-21 creation wrote none, so the knowledge manager agent (11-20) sat with an empty board and a
   * responsibility only its name held, and its check-ins said "nothing changed" for a day.
   */
  async createAgent(input: { name?: string; brief?: string; model?: string; thinkingLevel?: string; cwd?: string; kind?: "chat" | "job"; parent?: string; test?: boolean; host?: string }): Promise<AgentSummary> {
    const box = input.host ?? this.config.box;
    let cwd: string;
    let agentsDir: string | undefined;
    if (box === this.config.box) cwd = projectCwd(this.config, input.cwd);
    else {
      if (!this.routing?.has(box)) throw new Error(`No box ${box} runs agents; GET /api/agent-hosts lists the boxes.`);
      const info = this.routing.info(box);
      if (!info) throw new Error(`A new agent on ${box} needs its relay's hello first, for its project folders, and ${box} has not said hello since this server started.`);
      cwd = boxCwd(info, input.cwd);
      agentsDir = info.agentsDir;
    }
    let record: AgentRecord | undefined;
    const created = await this.threads.create({
      ...(input.name ? { name: input.name } : {}), model: input.model ?? MODELS.default.model, thinkingLevel: input.thinkingLevel ?? MODELS.default.thinkingLevel, cwd,
      ...(box === this.config.box ? {} : { box }),
    }, thread => {
      if (input.kind === "job" || input.parent) {
        this.store.state.threads[thread.id] = { kind: "job", ...(input.parent ? { parent: this.agents.record(input.parent)?.id ?? input.parent } : {}) };
        this.store.saveState();
        if (input.parent) this.agents.alias(thread.id, input.parent);
        return;
      }
      record = this.agents.add(thread, agentsDir, input.test === true);
    });
    this.threads.put(created);
    // The answer does not wait for the new thread's first agent.ref: the outbox holds a send into the thread until it lands (outbox.ts
    // `refWritten`). On 11-23 that wait was two pi-host round trips of the create, and a thread list read that answered meanwhile held the
    // event loop before the answer went out.
    if (!record) return this.threads.agent(created.id)!;
    if (input.brief?.trim()) await this.folders.writeBrief(record, input.brief.trim());
    this.roomsChanged(record);
    return this.threads.agent(record.id)!;
  }

  /** The agent's For list (for-me.ts); `id` is its agent id or one of its thread ids, so a pi-host tool passes its own thread. */
  forMeList(id: string, status: ForMeStatus | "all"): ForMeList {
    const record = this.forMeAgent(id);
    const list = this.forMe.list(record, status);
    return {
      ...list, items: list.items.map(item => {
        const later = this.later.mark(record.id, item.room, item.post);
        return later ? { ...item, later } : item;
      }),
    };
  }

  /**
   * Marks an item on the agent's For list completed or pending; a page that watches the list hears of a change at once. `messageId` is the
   * item's `<room>/<post>` id, or, when `id` is one of the agent's threads, any id its other room tools take (`agentPost`), such as p12 or
   * the [message id: ...] value: on 11-21 mark_message refused the raw message id that set_emoji had just taken for the same post.
   */
  markForMe(id: string, message: unknown, completed: boolean): { item: ForMeItem; pending: number } {
    const record = this.forMeAgent(id);
    const messageId = this.forMeItemId(id, message);
    const marked = this.forMe.mark(record, messageId, completed);
    if (!marked) throw new NotFound(`${messageId} is not on ${record.name}'s For list; pass an id that GET /api/agents/${record.id}/for-me?status=all lists.`);
    if (marked.changed) this.forMeChanged(record.id);
    return { item: marked.item, pending: marked.pending };
  }

  /**
   * Marks several items of the agent's For list at once, for Mark all completed and its Undo and for mark_message's message_ids, each named
   * as `markForMe` takes it: in 7 days to 11-25 real agents made 590 mark_message calls that one call with a list would have made.
   */
  markManyForMe(id: string, messages: readonly unknown[], completed: boolean): { changed: string[]; missing: string[]; pending: number } {
    const record = this.forMeAgent(id);
    const messageIds = [...new Set(messages.map(message => this.forMeItemId(id, message)))];
    const { changed, missing, pending } = this.forMe.markMany(record, messageIds, completed);
    if (missing.length === messageIds.length && missing.length) throw new NotFound(`None of ${missing.slice(0, 3).join(", ")} is on ${record.name}'s For list; pass ids that GET /api/agents/${record.id}/for-me?status=all lists.`);
    if (changed.length) this.forMeChanged(record.id);
    return { changed, missing, pending };
  }

  /**
   * The For item id `<room>/<post>` that `message` names: that form itself, or, when `id` is one of the agent's threads, any id its other room
   * tools take (`agentPost`), such as p12 or the [message id: ...] value.
   */
  private forMeItemId(id: string, message: unknown): string {
    const named = parseItemId(message);
    if (named) return `${named.room}/${named.post}`;
    if (!this.agents.ofComm(id) && !this.agents.ofWorkThread(id)) {
      throw new ReactionError(400, `${JSON.stringify(message ?? "")} is no For item id; pass messageId as <room id>/<post id>, such as dm_vent/p41 or ch_1a2b3c4d/p12.`);
    }
    const { room, post } = this.agentMessage(id, message, "mark_message");
    return `${room}/${post.id}`;
  }

  private forMeAgent(id: string): AgentRecord {
    const record = this.agents.record(id);
    if (!record) throw new NotFound(`No agent ${id}; pass an agent id such as ag_vent, or the id of one of its threads.`);
    return record;
  }

  /** Each page that watches `for:<agent>` gets the agent's pending count, computed only for agents some page watches. */
  private forMeChanged(only?: AgentRecord["id"]): void {
    const keys = new Set<string>();
    for (const client of this.clients) for (const key of client.watching.keys()) if (key.startsWith(FOR_ME_WATCH)) keys.add(key);
    for (const key of keys) {
      const record = this.agents.record(key.slice(FOR_ME_WATCH.length));
      if (record && (!only || record.id === only)) this.toWatchers(key, { type: "for_me", agent: record.id, pending: this.forMe.pending(record) });
    }
  }

  /** An agent's DM row; every agent has one. */
  openDm(agent: string): ConversationSummary {
    const record = this.agents.record(agent);
    if (!record) throw new NotFound(`No agent ${agent}.`);
    return this.rooms.summary(record);
  }

  /** The owner read the conversation to `seq`, or to its newest post. */
  markRead(id: ConversationId, seq?: number): void {
    if (isRoomId(id)) {
      this.rooms.markRead(this.roomAgent(id), seq);
      return;
    }
    if (this.isGroup(id)) {
      this.groups.markRead(id, seq);
      return;
    }
    this.store.state.reads[id] = { at: Date.now() };
    this.store.saveState();
    void this.threads.refresh();
  }

  /**
   * The owner's page read to `seq`. A DM, channel or Solo room shows a thread reply only as its root's count, so a read past every post the
   * room shows reads the thread replies after them too, and a reply in a thread whose root is off the page clears with the room.
   */
  readShown(id: ConversationId, seq?: number): void {
    const shown = (p: RoomPost): boolean => !p.threadRoot || !!p.alsoInChannel;
    const rooms = seq !== undefined && (isRoomId(id) || this.isGroup(id));
    this.markRead(id, rooms && !this.agentStore.postsOf(id as RoomId).some(p => p.seq > seq && shown(p)) ? undefined : seq);
  }

  /** Mark all as read: reads each room to its newest post and answers where each read point was, which `restoreReads` puts back for Undo. */
  markAllRead(ids: readonly ConversationId[]): ReadPoint[] {
    return ids.map(id => {
      const was = this.store.state.reads[id];
      this.markRead(id);
      return { room: id, seq: was?.seq ?? 0, ...(was?.from ? { from: was.from } : {}) };
    });
  }

  /** Undo of Mark all as read: each room reads from where it did, unread from its marked post again when it had one. */
  restoreReads(points: readonly ReadPoint[]): void {
    for (const { room, seq, from } of points) {
      if (from && (isRoomId(room) || this.isGroup(room))) this.roomUnreadFrom(room, from);
      else this.markRead(room, seq);
    }
  }

  // Live hub

  /** http.ts `serve` sets it; without it a page's socket read answers 503 and the page reads over HTTP. */
  socketRead: SocketRead | undefined;
  /** The last hello's lists, which the next hello reuses while they hold the same items (`helloLists`). */
  private readonly hello: { base?: HelloBase } = {};
  /** The most characters of list items one hello message carries (`helloMessages`); a spec sets it lower to split a fixture's hello. */
  helloPartChars = HELLO_PART_CHARS;

  private connect(socket: WebSocket, req?: IncomingMessage): void {
    const held = new URL(req?.url ?? "/", "http://x").searchParams;
    const client: Client = { socket, watching: new Map(), req, boards: parseBoardsParam(held.get("boards")) };
    this.clients.add(client);
    void this.sidebar().then(sidebar => {
      const lists = helloLists(held, { jobs: this.threads.jobList(), conversations: this.threads.conversations() }, this.hello);
      for (const message of helloMessages({ type: "hello", me: this.me(), sidebar, agents: this.threads.agents() }, lists, this.helloPartChars)) {
        if (client.socket.readyState === WebSocket.OPEN) client.socket.send(message);
      }
    });
    socket.on("message", data => {
      let command: LiveCommand;
      try {
        command = JSON.parse(String(data)) as LiveCommand;
      } catch {
        return;
      }
      void this.command(client, command).catch(error => this.send1(client, { type: "error", message: error instanceof Error ? error.message : String(error) }));
    });
    socket.on("close", () => {
      this.clients.delete(client);
      for (const targets of client.watching.values()) for (const target of targets) void this.threads.unwatch(target);
    });
  }

  private async command(client: Client, command: LiveCommand): Promise<void> {
    if (command.type === "ping") return this.send1(client, { type: "pong" });
    if (command.type === "boards") {
      for (const [chat, key] of parseBoardsParam(command.held)) client.boards.set(chat, key);
      return;
    }
    if (command.type === "read") {
      const answer = await (this.socketRead?.(command.path, client.req) ?? Promise.resolve({ status: 503, error: "This server reads no route over the socket." }));
      return this.send1(client, { type: "answer", id: command.id, ...answer });
    }
    if (command.type === "watch") {
      if (client.watching.has(command.conversation)) return;
      // An agent's For list holds no thread open; the page gets its pending count now and on every change.
      if (command.conversation.startsWith(FOR_ME_WATCH)) {
        const record = this.forMeAgent(command.conversation.slice(FOR_ME_WATCH.length));
        client.watching.set(command.conversation, []);
        this.send1(client, { type: "for_me", agent: record.id, pending: this.forMe.pending(record) });
        return;
      }
      client.watching.set(command.conversation, []);
      if (isRoomId(command.conversation)) {
        const record = this.roomAgent(command.conversation);
        if (command.after) {
          const items = this.rooms.since(record, command.after);
          if (items.length) this.send1(client, { type: "items", conversation: command.conversation, items });
        }
        this.send1(client, { type: "status", conversation: command.conversation, status: this.rooms.status(record) });
        this.send1(client, { type: "queue", conversation: command.conversation, place: this.queues.place(this.agents.roomThread(record)) });
        // The work thread for its status, and the comm thread, whose speaking calls are the room's posts.
        const targets = [...new Set([record.workThread, this.agents.roomThread(record)])];
        client.watching.set(command.conversation, targets);
        await Promise.all(targets.map(target => this.threads.watch(target)));
        return;
      }
      const group = this.groups.row(command.conversation);
      if (group) {
        if (command.after) {
          const items = this.groups.since(group.id, command.after);
          if (items.length) this.send1(client, { type: "items", conversation: command.conversation, items });
        }
        this.send1(client, { type: "status", conversation: command.conversation, status: this.groups.status(group) });
        // The members' comm threads for the room, whose speaking calls are its posts; a comm thread made later joins through `thread`.
        const targets = this.groups.commThreads(group).map(c => c.thread);
        client.watching.set(command.conversation, targets);
        await Promise.all(targets.map(target => this.threads.watch(target)));
        return;
      }
      if (command.after) {
        const page = await this.threads.timeline(command.conversation, { after: command.after, limit: 200 });
        this.outbox.reconcile(command.conversation, page.items);
        if (page.items.length) this.send1(client, { type: "items", conversation: command.conversation, items: page.items });
      }
      client.watching.set(command.conversation, [command.conversation]);
      const live = await this.threads.watch(command.conversation);
      this.outbox.reconcile(command.conversation, live.items);
      const items: Item[] = [...live.items, ...this.outbox.items(command.conversation)];
      if (items.length) this.send1(client, { type: "items", conversation: command.conversation, items });
      this.send1(client, { type: "status", conversation: command.conversation, status: live.status });
      this.send1(client, { type: "queue", conversation: command.conversation, place: this.queues.place(command.conversation) });
    } else if (command.type === "unwatch") {
      const targets = client.watching.get(command.conversation);
      if (!targets) return;
      client.watching.delete(command.conversation);
      for (const target of targets) await this.threads.unwatch(target);
    }
  }

  private send1(client: Client, event: LiveEvent): void {
    if (client.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify(event));
  }

  /** Sends a room's status to every page; a test room's goes only to the pages that watch it, so a walk sees its own Stop come and go. */
  private roomStatus(room: ConversationId, status: RunStatus): void {
    const event: LiveEvent = { type: "status", conversation: room, status };
    if (this.agentStore.isTest(room)) this.toWatchers(room, event);
    else this.broadcast(event);
  }

  /** Sends an event to every page, except one about a walk's test agent, room or job, which no owner list shows. */
  broadcast(event: LiveEvent): void {
    if (this.aboutTest(event)) return;
    const json = JSON.stringify(event);
    for (const client of this.clients) if (client.socket.readyState === WebSocket.OPEN) client.socket.send(json);
  }

  /**
   * A board change to every page: what changed to a page that holds the board kept before it, and the whole board to any other, which then
   * holds this one. On 11-23 agent factory's whole board was 219 KB of JSON and 80 KB on the wire in each event, to every open tab, while a
   * change touched one step; what changed came to 0.1 to 0.3 KB on the wire (~/work/p231-slow-calls/p231-board-event).
   */
  private boardChanged(chatId: string, board: ChatBoard, before: ChatBoard | null, rest: Omit<Extract<LiveEvent, { type: "board" }>, "type" | "chatId" | "board" | "delta">): void {
    const whole: LiveEvent = { type: "board", chatId, board, ...rest };
    if (this.aboutTest(whole)) return;
    const base = before && boardKey(before);
    const step = before && boardStep(before, board);
    let wholeJson: string | undefined;
    const deltaJson = base && step ? JSON.stringify({ type: "board", chatId, delta: boardDelta(base, board, [step]), ...rest } satisfies LiveEvent) : undefined;
    const key = boardKey(board);
    for (const client of this.clients) {
      if (client.socket.readyState !== WebSocket.OPEN) continue;
      client.socket.send(deltaJson && client.boards.get(chatId) === base ? deltaJson : (wholeJson ??= JSON.stringify(whole)));
      client.boards.set(chatId, key);
    }
  }

  private aboutTest(event: LiveEvent): boolean {
    const id = event.type === "agent" ? event.agent.id : event.type === "job" ? event.job.agent?.id ?? event.job.id
      : event.type === "conversation" ? event.conversation.agent ?? event.conversation.id : event.type === "room" ? event.room.id
      : event.type === "status" ? event.conversation : event.type === "jobs" ? event.thread : event.type === "board" || event.type === "board_row" || event.type === "duties" ? event.chatId : undefined;
    return id !== undefined && this.agentStore.isTest(id);
  }

  /** Sends a new post's notice to every page; a test room's goes only to the pages that watch it, so a walk can see its own. */
  private notice(post: RoomPost): void {
    const row = this.agentStore.groupRoom(post.room) ?? this.agentStore.rooms.rooms.find(r => r.id === post.room);
    if (!row) return;
    const reason = noticeReason(row, post, this.agentStore.postsOf(row.id), Date.now());
    if (!reason) return;
    const event: LiveEvent = { type: "notice", notice: noticeOf(row, post, reason, this.threads.principal(post.author), id => this.threads.principal(id).name) };
    if (this.agentStore.isTest(row.id)) this.toWatchers(row.id, event);
    else this.broadcast(event);
  }

  private toWatchers(conversation: ConversationId, event: LiveEvent): void {
    const json = JSON.stringify(event);
    for (const client of this.clients) if (client.watching.has(conversation) && client.socket.readyState === WebSocket.OPEN) client.socket.send(json);
  }
}

export class NotFound extends Error {}

export { modelRef };

/**
 * A hello's lists as `helloLists` last built them: the lists it read, each thread's time, their `Timed` form, each timed item's JSON and
 * each digest a page asked for.
 */
type HelloBase = {
  jobs: AgentSummary[]; conversations: ConversationSummary[]; times: ThreadTimes;
  timed: { jobs: Timed<AgentSummary>[]; conversations: Timed<ConversationSummary>[] }; json: Record<PartialList, string[]>;
  digests: Partial<Record<PartialList, string>>;
};

/** A hello's lists as `helloMessages` sends them: each item's JSON, each thread's time and the buckets a partial hello carries. */
type HelloLists = Record<PartialList, string[]> & Pick<Extract<LiveEvent, { type: "hello" }>, "partial" | "times">;

/**
 * The most characters of list items one hello message carries. A browser builds each socket message's string in one task before any
 * script runs: on 11-25 a cold load of live :5184 got a 2.5 MB hello (2,731 jobs, 3,025 conversations), and Chrome built its string for
 * 130 to 145 ms and the whole task took 528 to 697 ms at CPU rate 1 and 2,101 ms at rate 4 (~/work/p300-channel-open/trace-summary.md).
 * At 128 KB a part is about 7 ms of that string work at rate 1, and a reload's partial hello of 81 to 146 KB stays one or two messages.
 */
export const HELLO_PART_CHARS = 128 * 1024;

/**
 * The hello as socket messages. While its lists' items fit in `budget` characters it is one whole hello. Else the hello carries the first
 * part of the items and `parts`, the number of `list_part` messages that follow it with the rest, in list order, which the page joins
 * before it takes the lists (stores.svelte.ts). The item JSON comes from `helloLists`, so no item is stringified again here.
 */
export function helloMessages(head: Pick<Extract<LiveEvent, { type: "hello" }>, "type" | "me" | "sidebar" | "agents">, lists: HelloLists, budget: number): string[] {
  const empty = (): Record<PartialList, string[]> => ({ jobs: [], conversations: [] });
  const parts = [empty()];
  let size = 0;
  for (const name of PARTIAL_LISTS) {
    for (const item of lists[name]) {
      if (size && size + item.length > budget) {
        parts.push(empty());
        size = 0;
      }
      parts.at(-1)![name].push(item);
      size += item.length + 1;
    }
  }
  const body = (part: Record<PartialList, string[]>): string => `"jobs":[${part.jobs.join(",")}],"conversations":[${part.conversations.join(",")}]`;
  const [first, ...rest] = parts;
  const hello = JSON.stringify({ ...head, times: lists.times, ...(lists.partial ? { partial: lists.partial } : {}), ...(rest.length ? { parts: rest.length } : {}) });
  return [`${hello.slice(0, -1)},${body(first!)}}`, ...rest.map(part => `{"type":"list_part",${body(part)}}`)];
}

/** The two lists hold the same items in the same order: the same objects, or equal JSON for the few a list builds anew at each read. */
function sameItems(a: readonly object[], b: readonly object[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && JSON.stringify(a[i]) !== JSON.stringify(b[i])) return false;
  return true;
}

/**
 * The hello's jobs and conversations in their `Timed` form with each thread's time in `times`: whole for a page that named nothing it
 * holds, else only the buckets whose digest differs from the page's (shared/hello-buckets.ts), with their numbers in `partial`.
 *
 * `kept` holds the last hello's lists, timed forms and digests, which the next hello reuses while the lists hold the same items. Every page
 * opens its socket again at each release, and in the first seconds after the 10:02Z start on 11-24 each hello held the loop 130 to 150 ms,
 * `digests` the top function (~/work/p279-search/p279-meili.md).
 */
function helloLists(held: URLSearchParams, lists: { jobs: AgentSummary[]; conversations: ConversationSummary[] }, kept: { base?: HelloBase } = {}): HelloLists {
  let base = kept.base;
  if (!base || !sameItems(base.jobs, lists.jobs) || !sameItems(base.conversations, lists.conversations)) {
    const times = threadTimes(lists.jobs);
    const timedLists = { jobs: timed("jobs", lists.jobs, times), conversations: timed("conversations", lists.conversations, times) };
    const json = { jobs: timedLists.jobs.map(item => JSON.stringify(item)), conversations: timedLists.conversations.map(item => JSON.stringify(item)) };
    base = kept.base = { ...lists, times, timed: timedLists, json, digests: {} };
  }
  const out = { ...base.json };
  const partial: Partial<Record<PartialList, number[]>> = {};
  for (const name of PARTIAL_LISTS) {
    const page = held.get(name);
    const items: readonly { id: string }[] = base.timed[name];
    const changed = page ? changedBuckets(page, base.digests[name] ??= digests(items)) : null;
    if (!changed) continue;
    partial[name] = [...changed];
    out[name] = out[name].filter((_, index) => changed.has(bucketOf(items[index]!.id)));
  }
  return { ...out, times: base.times, ...(Object.keys(partial).length ? { partial } : {}) };
}
