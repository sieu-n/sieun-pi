/**
 * Wires the host seam, the chat server's store and the services, and holds the one live hub every page connects to over /api/live.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type {
  AgentSummary, ConversationHeader, ConversationId, Delivery, ConversationPatch, ConversationSummary, ImageRef, LiveCommand, LiveEvent, Me, ModelCatalog, ModelInfo, SendRequest, SendResult, Sidebar, ThinkingLevel,
} from "../web/src/lib/api/types.ts";
import type { AllowedModel } from "../../../config/allowed-models.ts";
import { Boards } from "./boards.ts";
import { Channels, publicDelivery } from "./channels.ts";
import { DEFAULT_MODEL, type Config } from "./config.ts";
import type { Host } from "./host/types.ts";
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
      items: (conversation, items) => this.toWatchers(conversation, { type: "items", conversation, items }),
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
    this.wss.on("connection", socket => this.connect(socket));
  }

  async start(): Promise<void> {
    await this.threads.start(this.config.fixture ? 1000 : 2000);
    this.channels.resume();
    this.boards.start();
  }

  async stop(): Promise<void> {
    this.boards.stop();
    this.queues.stop();
    clearTimeout(this.sidebarTimer);
    await this.threads.stop();
    for (const client of this.clients) client.socket.close();
    this.search.close();
    await this.host.close();
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

  async send(id: ConversationId, request: SendRequest): Promise<SendResult> {
    if (!request.text?.trim() && !request.images?.length) throw new Error("A message needs text or an image.");
    if (!request.requestId) throw new Error("A send needs a requestId, so a retry lands once.");
    const images = (request.images ?? []).map(image => this.saveUpload(image));
    if (this.isChannel(id)) return this.channels.post(id, "owner", { ...request, images: undefined as never }, images);
    const { thread, conversation } = parseConversationId(id);
    if (!this.threads.thread(thread)) throw new NotFound(`No thread ${thread}.`);
    const submitted = await this.host.submit(thread, {
      ...(conversation === 1 ? {} : { conversation }), text: request.text, ...(request.images?.length ? { images: request.images } : {}),
      requestId: request.requestId, whenBusy: request.whenBusy ?? "steer", ownerTurn: true,
    });
    this.store.state.reads[id] = { at: Date.now() };
    this.store.saveState();
    const queue = waitingPlace(submitted.ticket?.place);
    this.queues.follow(id, submitted.ticket?.place ?? null);
    const deliveries: Delivery[] = [];
    for (const target of (request.mentions ?? []).filter(m => m !== id && m !== "owner")) {
      const where = parseConversationId(target);
      const name = this.threads.principal(target).name;
      try {
        const sent = await this.host.submit(where.thread, {
          ...(where.conversation === 1 ? {} : { conversation: where.conversation }), text: request.text, requestId: `${request.requestId}:${target}`, whenBusy: "followUp",
          entry: { kind: "agent.message", data: { from: "owner", via: id } }, ownerTurn: true,
        });
        const place = waitingPlace(sent.ticket?.place);
        deliveries.push({ target, name, state: place?.state === "queued" ? "queued" : "delivered", at: Date.now(), ...(place ? { queue: place } : {}) });
        this.queues.follow(target, sent.ticket?.place ?? null);
      } catch (error) {
        deliveries.push({ target, name, state: "failed", at: Date.now(), error: error instanceof Error ? error.message : String(error) });
      }
    }
    return {
      item: {
        kind: "message", id: `r:${request.requestId}`, at: Date.now(), author: OWNER, text: request.text, images, mentions: request.mentions ?? [], deliveries, pending: true,
        ...(queue ? { queue } : {}),
      },
      deliveries,
      queue,
    };
  }

  private saveUpload(image: { data: string; mimeType: string }): ImageRef {
    const ext = image.mimeType.split("/")[1]?.replace(/[^a-z0-9]/g, "") || "bin";
    const name = `${randomUUID()}.${ext}`;
    writeFileSync(this.store.imagePath(name), Buffer.from(image.data, "base64"));
    return { url: `/api/uploads/${name}`, mimeType: image.mimeType };
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
    if (!this.threads.agent(agent)) throw new NotFound(`No agent ${agent}.`);
    if (!this.store.state.dms.includes(agent)) {
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
        if (page.items.length) this.send1(client, { type: "items", conversation: command.conversation, items: page.items });
      }
      const live = await this.threads.watch(command.conversation);
      if (live.items.length) this.send1(client, { type: "items", conversation: command.conversation, items: live.items });
      this.send1(client, { type: "partial", conversation: command.conversation, partial: live.partial });
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
