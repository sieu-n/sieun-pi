/**
 * Wires the host seam, the chat server's store and the services, and holds the one live hub every page connects to over /api/live.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type {
  AgentSummary, ConversationHeader, ConversationId, Delivery, ConversationPatch, ConversationSummary, ImageRef, Item, LiveCommand, LiveEvent, Me, ModelCatalog, ModelInfo, SendRequest, SendResult, Sidebar, ThinkingLevel,
  TimelinePage,
} from "../web/src/lib/api/types.ts";
import type { AllowedModel } from "../../../config/allowed-models.ts";
import { Boards } from "./boards.ts";
import { Channels, publicDelivery } from "./channels.ts";
import { DEFAULT_MODEL, type Config } from "./config.ts";
import type { Host } from "./host/types.ts";
import { Outbox, type OutboxRow } from "./outbox.ts";
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

type Client = { socket: WebSocket; watching: Set<ConversationId> };

export class App {
  readonly store: Store;
  readonly threads: Threads;
  readonly channels: Channels;
  readonly boards: Boards;
  readonly search: Search;
  readonly queues: QueueWatch;
  readonly outbox: Outbox;
  private readonly clients = new Set<Client>();
  private sidebarTimer?: NodeJS.Timeout;
  private lastSidebar = "";
  readonly wss = new WebSocketServer({ noServer: true });

  constructor(readonly config: Config, readonly host: Host, readonly log: (line: string) => void = line => console.log(line)) {
    this.store = new Store(config.dataDir);
    mkdirSync(this.store.imagePath(""), { recursive: true });
    this.threads = new Threads(host, this.store, {
      agents: (changed, removed) => {
        for (const agent of changed) this.broadcast({ type: "agent", agent });
        for (const id of removed) this.broadcast({ type: "agent_removed", id });
        this.sidebarSoon();
      },
      conversations: changed => this.conversationsChanged(changed),
      items: (conversation, items) => {
        this.toWatchers(conversation, { type: "items", conversation, items });
        this.outbox.reconcile(conversation, items);
      },
      partial: (conversation, partial) => this.toWatchers(conversation, { type: "partial", conversation, partial }),
      status: (conversation, status) => {
        this.broadcast({ type: "status", conversation, status });
        this.sidebarSoon();
      },
      jobs: (thread, jobs) => this.broadcast({ type: "jobs", thread, jobs }),
    }, config.box, log);
    this.channels = new Channels(this.store, host, this.threads, {
      queue: (target, place, listener) => this.queues.follow(target, place, listener),
      items: (conversation, items) => this.toWatchers(conversation, { type: "items", conversation, items }),
      channel: channel => this.broadcast({ type: "channel", channel }),
      conversations: changed => this.conversationsChanged(changed),
    }, log);
    this.threads.channelSummaries = () => this.channels.summaries();
    this.threads.channelsOf = agent => this.channels.memberChannels(agent);
    this.boards = new Boards(host, this.store, this.threads, {
      board: (chatId, board, awaitingGo) => this.broadcast({ type: "board", chatId, board, awaitingGo }),
      forYou: count => {
        this.broadcast({ type: "for_you", count });
        this.sidebarSoon();
      },
    }, log);
    this.boards.selfUrl = `http://127.0.0.1:${config.port}`;
    this.threads.onDoc = (thread, name, value) => {
      if (name === "chat.board") this.boards.docChanged(thread, value);
    };
    this.search = new Search(host, this.threads, this.channels, config.fixture ? undefined : config.durableIndex);
    this.queues = new QueueWatch(host, this.threads, (conversation, place) => this.toWatchers(conversation, { type: "queue", conversation, place }), log);
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
    this.channels.resume();
    this.boards.start();
    this.outbox.start();
  }

  async stop(): Promise<void> {
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
    const all = this.threads.conversations().filter(c => !c.archived);
    const byNew = (a: ConversationSummary, b: ConversationSummary) => b.lastActivityAt - a.lastActivityAt;
    return {
      solo: all.filter(c => c.kind === "solo").sort(byNew),
      channels: all.filter(c => c.kind === "channel").sort((a, b) => a.name.localeCompare(b.name)),
      dms: all.filter(c => c.kind === "dm").sort(byNew),
      forYou: await this.boards.forYouCount().catch(() => 0),
    };
  }

  private conversationsChanged(changed: ConversationSummary[]): void {
    for (const conversation of changed) this.broadcast({ type: "conversation", conversation });
    this.sidebarSoon();
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
    const summary = this.threads.conversations().find(c => c.id === id);
    const agent = this.threads.agent(id);
    if (!summary || !agent) throw new NotFound(`No conversation ${id}.`);
    const members = [{ principal: OWNER, role: "owner" as const, wakeOn: "all" as const }, { principal: this.threads.principal(agent.id), role: "member" as const, wakeOn: "all" as const, status: agent.status }];
    return { summary, members, model: agent.model, thinkingLevel: agent.thinkingLevel, agent, queue: this.queues.place(id) };
  }

  /**
   * A send lands in the chat server and answers at once, as in Slack: a channel post is written and its mentions go out behind it, and
   * a thread send goes to the outbox, which shows it on every watching page and hands it to pi-host with retries (server/outbox.ts).
   */
  async send(id: ConversationId, request: SendRequest): Promise<SendResult> {
    if (!request.text?.trim() && !request.images?.length) throw new Error("A message needs text or an image.");
    if (!request.requestId) throw new Error("A send needs a requestId, so a retry lands once.");
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
    const row = this.outbox.get(requestId);
    if (!row || row.conversation !== id) throw new NotFound(`No pending send ${requestId} in ${id}.`);
    const item = this.outbox.retry(requestId)!;
    return { item, deliveries: row.deliveries };
  }

  /** Drops a pending send the owner gave up on. */
  discardSend(id: ConversationId, requestId: string): void {
    const row = this.outbox.get(requestId);
    if (!row || row.conversation !== id) throw new NotFound(`No pending send ${requestId} in ${id}.`);
    this.outbox.discard(requestId);
  }

  /** Each @mention in a thread send goes to that agent as an agent message from the owner, once the send reached pi-host. */
  private async deliverMentions(row: OutboxRow): Promise<Delivery[]> {
    const deliveries: Delivery[] = [];
    for (const target of row.mentions.filter(m => m !== row.conversation && m !== "owner")) {
      const where = parseConversationId(target);
      const name = this.threads.principal(target).name;
      try {
        const sent = await this.host.submit(where.thread, {
          ...(where.conversation === 1 ? {} : { conversation: where.conversation }), text: row.text, requestId: `${row.requestId}:${target}`, whenBusy: "followUp",
          entry: { kind: "agent.message", data: { from: "owner", via: row.conversation } }, ownerTurn: true,
        });
        const place = waitingPlace(sent.ticket?.place);
        deliveries.push({ target, name, state: place?.state === "queued" ? "queued" : "delivered", at: Date.now(), ...(place ? { queue: place } : {}) });
        this.queues.follow(target, sent.ticket?.place ?? null);
      } catch (error) {
        deliveries.push({ target, name, state: "failed", at: Date.now(), error: error instanceof Error ? error.message : String(error) });
      }
    }
    return deliveries;
  }

  /** A timeline page; the newest page of a thread also carries the sends pi-host has not shown yet, after its entries. */
  async items(id: ConversationId, opts: { before?: string; after?: string; around?: string; limit?: number }): Promise<TimelinePage> {
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
    const { thread, conversation } = parseConversationId(id);
    await this.host.abort(thread, conversation === 1 ? undefined : conversation);
  }

  async patch(id: ConversationId, patch: ConversationPatch): Promise<ConversationHeader> {
    if (this.isChannel(id)) {
      this.channels.update(id, { ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.archived !== undefined ? { archived: patch.archived } : {}) });
      return this.header(id);
    }
    const { thread, conversation } = parseConversationId(id);
    if (conversation !== 1 && (patch.name !== undefined || patch.archived !== undefined)) throw new Error("Rename and archive the job's thread instead; a job inside a thread has no name of its own in pi-host.");
    await this.host.set(thread, {
      ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}), ...(patch.thinkingLevel !== undefined ? { thinkingLevel: patch.thinkingLevel } : {}),
    });
    await this.threads.refresh();
    return this.header(id);
  }

  async createAgent(input: { name?: string; model?: string; thinkingLevel?: string; cwd?: string; kind?: "chat" | "job"; parent?: string }): Promise<AgentSummary> {
    const created = await this.host.create({
      ...(input.name ? { name: input.name } : {}), model: input.model ?? MODELS.default.model, thinkingLevel: input.thinkingLevel ?? MODELS.default.thinkingLevel,
      ...(input.cwd ? { cwd: input.cwd } : {}),
    });
    if (input.kind === "job" || input.parent) {
      this.store.state.threads[created.id] = { kind: "job", ...(input.parent ? { parent: input.parent } : {}) };
      this.store.saveState();
    }
    await this.threads.refresh();
    return this.threads.agent(created.id)!;
  }

  openDm(agent: string): ConversationSummary {
    const found = this.threads.agent(agent);
    if (!found) throw new NotFound(`No agent ${agent}.`);
    // Only a root chat becomes a DM; a job opens by link and stays under its parent.
    if (found.kind === "chat" && found.conversation === 1 && !this.store.state.dms.includes(agent)) {
      this.store.state.dms.unshift(agent);
      this.store.saveState();
    }
    this.sidebarSoon();
    return this.threads.conversations().find(c => c.id === agent)!;
  }

  markRead(id: ConversationId, seq?: number): void {
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
    const client: Client = { socket, watching: new Set() };
    this.clients.add(client);
    void this.sidebar().then(sidebar => this.send1(client, { type: "hello", me: this.me(), sidebar, agents: this.threads.agents(), conversations: this.threads.conversations() }));
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
      for (const id of client.watching) if (!this.isChannel(id)) void this.threads.unwatch(id);
    });
  }

  private async command(client: Client, command: LiveCommand): Promise<void> {
    if (command.type === "watch") {
      if (client.watching.has(command.conversation)) return;
      client.watching.add(command.conversation);
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
      const live = await this.threads.watch(command.conversation);
      this.outbox.reconcile(command.conversation, live.items);
      const items: Item[] = [...live.items, ...this.outbox.items(command.conversation)];
      if (items.length) this.send1(client, { type: "items", conversation: command.conversation, items });
      this.send1(client, { type: "status", conversation: command.conversation, status: live.status });
      this.send1(client, { type: "queue", conversation: command.conversation, place: this.queues.place(command.conversation) });
    } else if (command.type === "unwatch") {
      if (!client.watching.delete(command.conversation)) return;
      if (!this.isChannel(command.conversation)) await this.threads.unwatch(command.conversation);
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
