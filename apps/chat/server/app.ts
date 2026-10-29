/**
 * Wires the host seam, the chat server's store and the services, and holds the one live hub every page connects to over /api/live.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type {
  AgentSummary, ConversationHeader, ConversationId, Delivery, ConversationPatch, ConversationSummary, ImageRef, Item, LiveCommand, LiveEvent, Me, ModelCatalog, ModelInfo, ProjectList, SendRequest, SendResult, Sidebar, ThinkingLevel,
  TimelinePage,
} from "../web/src/lib/api/types.ts";
import type { AllowedModel } from "../../../config/allowed-models.ts";
import { AgentStore, type AgentRecord } from "./agent-store.ts";
import { Agents, isRoomId, type SplitPlan } from "./agents.ts";
import { Boards } from "./boards.ts";
import { Channels, publicDelivery } from "./channels.ts";
import { DEFAULT_MODEL, type Config } from "./config.ts";
import type { Host } from "./host/types.ts";
import { Outbox, type OutboxRow } from "./outbox.ts";
import { projectCwd, projectList } from "./projects.ts";
import { Rooms } from "./rooms.ts";
import { Search } from "./search.ts";
import { Store } from "./store.ts";
import { modelRef, OWNER, parseConversationId, Threads } from "./threads.ts";
import { QueueWatch, waitingPlace } from "./queue.ts";

/** A model the pickers offer, which must be one of config/allowed-models.ts (owner rule c185: the newest model of each tier only). */
function offered(key: AllowedModel, label: string, family: string, levels: ThinkingLevel[]): ModelInfo {
  const [provider, id] = key.split("/") as [string, string];
  return { provider, id, label, family, levels };
}

export const MODELS: ModelCatalog = {
  models: [
    offered("anthropic/claude-opus-5-5", "Opus 5.5", "claude", ["off", "low", "medium", "high", "xhigh"]),
    offered("anthropic/claude-sonnet-5-5", "Sonnet 5.5", "claude", ["off", "low", "medium", "high"]),
    offered("anthropic/claude-fable-5-1", "Fable 5.1", "claude", ["off", "low", "medium", "high", "xhigh"]),
    offered("openai-codex/gpt-6.1-sol", "GPT-6.1 sol", "gpt", ["low", "medium", "high", "xhigh"]),
    offered("openai-codex/gpt-6-luna", "GPT-6 luna", "gpt", ["low", "medium", "high", "xhigh"]),
  ],
  default: { model: DEFAULT_MODEL, thinkingLevel: "high" },
};

/** `watching` maps each conversation a page watches to the thread conversations that watch holds open. */
type Client = { socket: WebSocket; watching: Map<ConversationId, ConversationId[]> };

export class App {
  readonly store: Store;
  readonly agentStore: AgentStore;
  readonly agents: Agents;
  readonly rooms: Rooms;
  readonly threads: Threads;
  readonly channels: Channels;
  readonly boards: Boards;
  readonly search: Search;
  readonly queues: QueueWatch;
  readonly outbox: Outbox;
  private readonly clients = new Set<Client>();
  private sidebarTimer?: NodeJS.Timeout;
  private lastSidebar = "";
  /** Each DM room's summary as last sent, so a room event goes out only when its row changed. */
  private roomCache = new Map<string, string>();
  readonly wss = new WebSocketServer({ noServer: true });

  constructor(readonly config: Config, readonly host: Host, readonly log: (line: string) => void = line => console.log(line)) {
    this.store = new Store(config.dataDir);
    mkdirSync(this.store.imagePath(""), { recursive: true });
    this.agentStore = new AgentStore(config.dataDir);
    this.agents = new Agents(this.agentStore, this.store, host, config, log);
    this.threads = new Threads(host, this.store, {
      agents: (changed, removed) => {
        for (const agent of changed) this.broadcast({ type: "agent", agent });
        for (const id of removed) this.broadcast({ type: "agent_removed", id });
        this.sidebarSoon();
      },
      jobList: (changed, removed) => {
        for (const job of changed) this.broadcast({ type: "job", job });
        for (const id of removed) this.broadcast({ type: "job_removed", id });
      },
      conversations: changed => this.conversationsChanged(changed),
      items: (conversation, items) => {
        this.toWatchers(conversation, { type: "items", conversation, items });
        this.outbox.reconcile(conversation, items);
        // A watched DM watches the thread its feed reads too, so a new speaking call posts without waiting for the next thread list read.
        const record = this.agents.ofWorkThread(conversation) ?? this.agents.ofComm(conversation)?.record;
        if (record) void this.rooms.feed(record);
      },
      partial: (conversation, partial) => this.toWatchers(conversation, { type: "partial", conversation, partial }),
      status: (conversation, status) => {
        this.broadcast({ type: "status", conversation, status });
        const record = this.agents.ofWorkThread(conversation);
        if (record) this.broadcast({ type: "status", conversation: record.room, status });
        // The DM works while its comm thread answers; the next thread list read sets the room's status once it stops.
        const comm = this.agents.ofComm(conversation);
        if (comm && status === "working") this.broadcast({ type: "status", conversation: comm.room, status });
        this.sidebarSoon();
      },
      jobs: (thread, jobs) => this.broadcast({ type: "jobs", thread, jobs }),
    }, config.box, log);
    this.threads.agentRecords = this.agents;
    this.rooms = new Rooms({
      store: this.agentStore, state: this.store, host, threads: this.threads, agents: this.agents,
      events: {
        items: (room, items) => this.toWatchers(room, { type: "items", conversation: room, items }),
        status: (room, status) => this.broadcast({ type: "status", conversation: room, status }),
        changed: () => this.roomsChanged(),
        thread: (record, thread) => this.watchRoomThread(record.room, thread),
        submitted: (thread, result) => this.queues.follow(thread, result.ticket?.place ?? null),
      },
      saveUpload: image => this.saveUpload(image), readUpload: ref => this.readUpload(ref), log,
    });
    this.threads.roomSummaries = () => this.rooms.summaries();
    this.threads.testSendsOf = thread => this.rooms.testSendsOf(thread);
    this.threads.onRefresh = () => {
      this.rooms.poll();
      this.sweepRefs();
    };
    this.channels = new Channels(this.store, host, this.threads, {
      queue: (target, place, listener) => this.queues.follow(target, place, listener),
      items: (conversation, items) => this.toWatchers(conversation, { type: "items", conversation, items }),
      channel: channel => this.broadcast({ type: "channel", channel }),
      conversations: changed => this.conversationsChanged(changed),
    }, log);
    this.threads.channelSummaries = () => this.channels.summaries();
    this.threads.channelsOf = agent => this.channels.memberChannels(agent);
    this.boards = new Boards(host, this.store, this.threads, this.agents, {
      board: (chatId, board, awaitingGo) => this.broadcast({ type: "board", chatId, board, awaitingGo }),
      forYou: count => {
        this.broadcast({ type: "for_you", count });
        this.sidebarSoon();
      },
      duties: (chatId, duties) => this.broadcast({ type: "duties", chatId, duties }),
    }, log);
    this.boards.selfUrl = `http://127.0.0.1:${config.port}`;
    this.threads.onDoc = (thread, name, value) => {
      if (name === "chat.board") this.boards.docChanged(thread, value);
    };
    this.search = new Search(host, this.threads, this.channels, config.fixture ? undefined : config.durableIndex);
    this.search.testSends = () => this.rooms.allTestSends();
    this.search.commThreads = () => this.agents.list().flatMap(record => Object.values(record.comm ?? {}));
    this.search.dmPosts = () => this.rooms.searchPosts();
    this.queues = new QueueWatch(host, this.threads, (conversation, place) => {
      this.toWatchers(conversation, { type: "queue", conversation, place });
      const record = this.agents.ofWorkThread(conversation) ?? this.agents.ofComm(conversation)?.record;
      if (record && this.agents.roomThread(record) === conversation) this.toWatchers(record.room, { type: "queue", conversation: record.room, place });
    }, log);
    this.outbox = new Outbox(config.dataDir, {
      host,
      submitted: (row, result) => this.queues.follow(row.conversation, result.ticket?.place ?? null),
      mentions: row => this.deliverMentions(row),
      changed: (conversation, items, removed) => this.toWatchers(conversation, { type: "items", conversation, items, ...(removed.length ? { removed } : {}) }),
      image: ref => this.readUpload(ref),
      log,
    });
    this.wss.on("connection", socket => this.connect(socket));
  }

  async start(): Promise<void> {
    await this.threads.start(this.config.fixture ? 1000 : 2000);
    this.rooms.start();
    this.channels.resume();
    this.boards.start();
    this.outbox.start();
  }

  async stop(): Promise<void> {
    this.rooms.stop();
    this.boards.stop();
    this.outbox.stop();
    this.queues.stop();
    clearTimeout(this.sidebarTimer);
    // The host client closes first: a watch's unwatch sent to a pi-host that restarts beside the chat retried for 30 s, past systemd's
    // 20 s stop timeout, so restarting both services on 10-28 ended in a SIGKILL. pi-host drops a closed connection's watches itself.
    await this.host.close();
    await this.threads.stop();
    for (const client of this.clients) client.socket.close();
    this.search.close();
  }

  me(): Me {
    return { owner: OWNER, host: this.config.box, fixture: this.config.fixture, wikiBase: this.config.wikiBase, version: this.config.version };
  }

  async sidebar(): Promise<Sidebar> {
    const byNew = (a: ConversationSummary, b: ConversationSummary) => b.lastActivityAt - a.lastActivityAt;
    return {
      solo: this.threads.threadConversations().filter(c => c.kind === "solo" && !c.archived).sort(byNew),
      channels: this.channels.summaries().filter(c => !c.archived).sort((a, b) => a.name.localeCompare(b.name)),
      dms: this.rooms.summaries().filter(c => !c.archived).sort(byNew),
      forYou: await this.boards.forYouCount().catch(() => 0),
    };
  }

  private conversationsChanged(changed: ConversationSummary[]): void {
    for (const conversation of changed) this.broadcast({ type: "conversation", conversation });
    this.sidebarSoon();
  }

  /** A DM room changed: its row goes out when it differs from the last one sent. */
  private roomsChanged(): void {
    const changed = this.rooms.summaries().filter(c => this.roomCache.get(c.id) !== JSON.stringify(c));
    for (const summary of changed) this.roomCache.set(summary.id, JSON.stringify(summary));
    this.conversationsChanged(changed);
  }

  /** Points each listed thread of each agent at its folder with an `agent.ref` doc (agents.ts), in the background. */
  private sweepRefs(): void {
    void this.agents.sweepRefs(thread => this.threads.thread(thread) !== undefined);
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

  isChannel(id: ConversationId): boolean {
    return this.channels.row(id) !== undefined;
  }

  async header(id: ConversationId): Promise<ConversationHeader> {
    const channel = this.channels.row(id);
    if (channel) {
      const summary = this.channels.summaries().find(s => s.id === channel.id)!;
      return {
        summary, members: this.channels.members(channel), model: null, thinkingLevel: null, purpose: channel.purpose,
        ...(channel.homeChat ? { homeChat: channel.homeChat } : {}), ...(this.store.state.reads[channel.id]?.seq !== undefined ? { readSeq: this.store.state.reads[channel.id]!.seq! } : {}),
      };
    }
    if (isRoomId(id)) {
      const record = this.roomAgent(id);
      const agent = this.threads.agent(record.id);
      if (!agent) throw new NotFound(`No agent ${record.id}.`);
      const readSeq = this.rooms.readSeq(record);
      return {
        summary: this.rooms.summary(record), members: this.members(agent), model: agent.model, thinkingLevel: agent.thinkingLevel, agent,
        queue: this.queues.place(this.agents.roomThread(record)), workThread: record.workThread, ...(readSeq !== undefined ? { readSeq } : {}),
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
   * A send lands in the chat server and answers at once, as in Slack: a DM post or a channel post is written and delivered behind the answer,
   * and a send into a work thread's transcript goes to the outbox, which shows it on every watching page and hands it to pi-host with
   * retries (server/outbox.ts).
   */
  async send(id: ConversationId, request: SendRequest): Promise<SendResult> {
    if (!request.text?.trim() && !request.images?.length) throw new Error("A message needs text or an image.");
    if (!request.requestId) throw new Error("A send needs a requestId, so a retry lands once.");
    if (isRoomId(id)) {
      const record = this.roomAgent(id);
      const result = this.rooms.post(record, request);
      if (request.mentions?.length) void this.deliverMentions({ requestId: request.requestId, conversation: id, text: request.text ?? "", mentions: request.mentions });
      return result;
    }
    if (this.isChannel(id)) {
      const images = (request.images ?? []).map(image => this.saveUpload(image));
      return this.channels.post(id, "owner", { ...request, images: undefined as never }, images);
    }
    const { thread } = parseConversationId(id);
    if (!this.threads.thread(thread)) throw new NotFound(`No thread ${thread}.`);
    const open = this.outbox.get(request.requestId);
    if (open && open.conversation !== id) throw new Error(`A requestId names one send; ${request.requestId} went to ${open.conversation}.`);
    const images = open ? open.images : (request.images ?? []).map(image => this.saveUpload(image));
    const item = this.outbox.add({
      requestId: request.requestId, conversation: id, text: request.text ?? "", images, mentions: (request.mentions ?? []).filter(m => m !== id && m !== "owner"),
      whenBusy: request.whenBusy ?? "steer",
    });
    this.store.state.reads[id] = { at: Date.now() };
    this.store.saveState();
    return { item, deliveries: item.kind === "message" ? item.deliveries : [] };
  }

  /** Tries a failed or waiting send again now. */
  retrySend(id: ConversationId, requestId: string): SendResult {
    if (isRoomId(id)) return this.rooms.retry(this.roomAgent(id), requestId);
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

  /** Drops a pending send the owner gave up on. A DM post is stored, so it stays. */
  discardSend(id: ConversationId, requestId: string): void {
    if (isRoomId(id)) throw new Error("A DM post is stored; retry its delivery instead of discarding it.");
    const row = this.outbox.get(requestId);
    if (!row || row.conversation !== id) throw new NotFound(`No pending send ${requestId} in ${id}.`);
    this.outbox.discard(requestId);
  }

  /**
   * Each @mention in a thread send or a DM post goes to the mentioned agent's work thread as an agent message from the owner, once the send
   * reached pi-host. Only a registered agent is a target (`Threads.registered`): a mention of a job, a bare thread or a name only a job has
   * is not delivered.
   */
  private async deliverMentions(row: Pick<OutboxRow, "requestId" | "conversation" | "text" | "mentions">): Promise<Delivery[]> {
    const deliveries: Delivery[] = [];
    const targets = new Map(row.mentions.flatMap(m => {
      const record = this.threads.registered(m);
      return record && record.workThread !== row.conversation && record.room !== row.conversation ? [[record.id, record] as const] : [];
    }));
    for (const [target, record] of targets) {
      const name = this.threads.principal(target).name;
      try {
        const sent = await this.host.submit(record.workThread, {
          text: row.text, requestId: `${row.requestId}:${target}`, whenBusy: "followUp",
          entry: { kind: "agent.message", data: { from: "owner", via: row.conversation } }, ownerTurn: true,
        });
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
  async items(id: ConversationId, opts: { before?: string; after?: string; around?: string; limit?: number }): Promise<TimelinePage> {
    if (isRoomId(id)) return this.rooms.timeline(this.roomAgent(id), opts);
    if (this.isChannel(id)) return this.channels.timeline(id, opts);
    const page = await this.threads.timeline(id, opts);
    this.outbox.reconcile(id, page.items);
    if (opts.before || page.newer) return page;
    const pending = this.outbox.items(id);
    return pending.length ? { ...page, items: [...page.items, ...pending] } : page;
  }

  private saveUpload(image: { data: string; mimeType: string }): ImageRef {
    const ext = image.mimeType.split("/")[1]?.replace(/[^a-z0-9]/g, "") || "bin";
    const name = `${randomUUID()}.${ext}`;
    writeFileSync(this.store.imagePath(name), Buffer.from(image.data, "base64"));
    return { url: `/api/uploads/${name}`, mimeType: image.mimeType };
  }

  private readUpload(ref: ImageRef): { data: string; mimeType: string } | undefined {
    const name = ref.url.startsWith("/api/uploads/") ? ref.url.slice("/api/uploads/".length).replace(/[^\w.-]/g, "") : "";
    if (!name) return undefined;
    try {
      return { data: readFileSync(this.store.imagePath(name)).toString("base64"), mimeType: ref.mimeType };
    } catch {
      return undefined;
    }
  }

  async abort(id: ConversationId): Promise<void> {
    if (this.isChannel(id)) {
      const row = this.channels.row(id)!;
      await Promise.all(row.members.filter(m => m.principal !== "owner").map(m => {
        const where = parseConversationId(m.principal);
        return this.host.abort(where.thread, where.conversation === 1 ? undefined : where.conversation).catch(() => undefined);
      }));
      return;
    }
    if (isRoomId(id)) {
      const record = this.roomAgent(id);
      await Promise.all([...new Set([record.workThread, this.agents.roomThread(record)])].map(thread => this.host.abort(thread)));
      return;
    }
    const { thread, conversation } = parseConversationId(id);
    await this.host.abort(thread, conversation === 1 ? undefined : conversation);
  }

  /** On a DM, a rename or archive changes the agent and its work thread, and model, thinking level and cwd change the work thread. */
  async patch(id: ConversationId, patch: ConversationPatch): Promise<ConversationHeader> {
    if (this.isChannel(id)) {
      this.channels.update(id, { ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.archived !== undefined ? { archived: patch.archived } : {}) });
      return this.header(id);
    }
    const { thread, conversation } = parseConversationId(isRoomId(id) ? this.roomAgent(id).workThread : id);
    if (conversation !== 1 && (patch.name !== undefined || patch.archived !== undefined)) throw new Error("Rename and archive the job's thread instead; a job inside a thread has no name of its own in pi-host.");
    if (conversation !== 1 && patch.cwd !== undefined) throw new Error("A job inside a thread runs in its thread's folder; move the thread's root instead.");
    await this.host.set(thread, {
      ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
      ...(patch.cwd !== undefined ? { cwd: projectCwd(this.config, patch.cwd) } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}), ...(patch.thinkingLevel !== undefined ? { thinkingLevel: patch.thinkingLevel } : {}),
    });
    await this.threads.refresh();
    return this.header(id);
  }

  /** The project folders a new agent can run in on this box (`server/projects.ts`). */
  projects(): ProjectList {
    return projectList(this.config);
  }

  /**
   * A new agent: its work thread in a project folder (the one given, else the default project, never the home folder), its record and its DM
   * room, made at once. With `kind: "job"` or a `parent`, the thread is a root job filed under that agent instead. With `kind: "solo"` it is
   * a root chat no agent holds, as the composer's "new chat" makes, which shows in the sidebar's solo group and in no agent list.
   */
  async createAgent(input: { name?: string; model?: string; thinkingLevel?: string; cwd?: string; kind?: "chat" | "job" | "solo"; parent?: string }): Promise<AgentSummary> {
    const cwd = projectCwd(this.config, input.cwd);
    const created = await this.host.create({
      ...(input.name ? { name: input.name } : {}), model: input.model ?? MODELS.default.model, thinkingLevel: input.thinkingLevel ?? MODELS.default.thinkingLevel, cwd,
    });
    if (input.kind === "solo") {
      await this.threads.refresh();
      return this.threads.agent(created.id)!;
    }
    if (input.kind === "job" || input.parent) {
      this.store.state.threads[created.id] = { kind: "job", ...(input.parent ? { parent: this.agents.record(input.parent)?.id ?? input.parent } : {}) };
      this.store.saveState();
      if (input.parent) this.agents.alias(created.id, input.parent);
      await this.threads.refresh();
      return this.threads.agent(created.id)!;
    }
    const record = this.agents.add(created);
    await this.threads.refresh();
    this.roomsChanged();
    return this.threads.agent(record.id)!;
  }

  /**
   * The split of an agent into its work thread and DM comm thread: the plan, or with `apply` the comm thread `ensureComm` holds after it,
   * with the room's feed moved onto it. The migration (`scripts/split-agents.ts`) goes through this route, so the running server stays the
   * only writer of agents.json.
   */
  async split(agent: string, apply: boolean): Promise<SplitPlan | { plan: SplitPlan; comm: string }> {
    const record = this.agents.record(agent);
    if (!record) throw new NotFound(`No agent ${agent}.`);
    const plan = await this.agents.splitPlan(record);
    if (!apply) return plan;
    const comm = await this.agents.ensureComm(record);
    await this.rooms.feed(record);
    await this.threads.refresh();
    this.roomsChanged();
    return { plan, comm };
  }

  /** An agent's DM row; every agent has one. */
  openDm(agent: string): ConversationSummary {
    const record = this.agents.record(agent);
    if (!record) throw new NotFound(`No agent ${agent}.`);
    return this.rooms.summary(record);
  }

  markRead(id: ConversationId, seq?: number): void {
    if (isRoomId(id)) {
      this.rooms.markRead(this.roomAgent(id), seq);
      return;
    }
    if (this.isChannel(id)) {
      this.channels.markRead(id, seq);
      return;
    }
    this.store.state.reads[id] = { at: Date.now() };
    this.store.saveState();
    void this.threads.refresh();
  }

  // Live hub

  private connect(socket: WebSocket): void {
    const client: Client = { socket, watching: new Map() };
    this.clients.add(client);
    void this.sidebar().then(sidebar => this.send1(client, { type: "hello", me: this.me(), sidebar, agents: this.threads.agents(), jobs: this.threads.jobList(), conversations: this.threads.conversations() }));
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
    if (command.type === "watch") {
      if (client.watching.has(command.conversation)) return;
      client.watching.set(command.conversation, []);
      if (isRoomId(command.conversation)) {
        const record = this.roomAgent(command.conversation);
        if (command.after) {
          const page = this.rooms.timeline(record, { after: command.after, limit: 200 });
          if (page.items.length) this.send1(client, { type: "items", conversation: command.conversation, items: page.items });
        }
        this.send1(client, { type: "status", conversation: command.conversation, status: this.rooms.status(record) });
        this.send1(client, { type: "queue", conversation: command.conversation, place: this.queues.place(this.agents.roomThread(record)) });
        // The work thread for its status, and the comm thread, whose speaking calls are the room's posts.
        const targets = [...new Set([record.workThread, this.agents.roomThread(record)])];
        client.watching.set(command.conversation, targets);
        await Promise.all(targets.map(target => this.threads.watch(target)));
        return;
      }
      if (this.isChannel(command.conversation)) {
        if (command.after) {
          const page = this.channels.timeline(command.conversation, { after: command.after, limit: 200 });
          if (page.items.length) this.send1(client, { type: "items", conversation: command.conversation, items: page.items });
        }
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

  broadcast(event: LiveEvent): void {
    const json = JSON.stringify(event);
    for (const client of this.clients) if (client.socket.readyState === WebSocket.OPEN) client.socket.send(json);
  }

  private toWatchers(conversation: ConversationId, event: LiveEvent): void {
    const json = JSON.stringify(event);
    for (const client of this.clients) if (client.watching.has(conversation) && client.socket.readyState === WebSocket.OPEN) client.socket.send(json);
  }
}

export class NotFound extends Error {}

export { modelRef, publicDelivery };
