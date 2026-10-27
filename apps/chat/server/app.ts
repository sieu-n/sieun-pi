/**
 * Wires the host seam, the chat server's store and the services, and holds the one live hub every page connects to over /api/live.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type {
  AgentSummary, ConversationHeader, ConversationId, ConversationPatch, ConversationSummary, ImageRef, LiveCommand, LiveEvent, Me, ModelCatalog, SendRequest, SendResult, Sidebar,
} from "../web/src/lib/api/types.ts";
import { Boards } from "./boards.ts";
import { Channels, publicDelivery } from "./channels.ts";
import type { Config } from "./config.ts";
import type { Host } from "./host/types.ts";
import { Search } from "./search.ts";
import { Store } from "./store.ts";
import { modelRef, OWNER, parseConversationId, Threads } from "./threads.ts";

export const MODELS: ModelCatalog = {
  models: [
    { provider: "anthropic", id: "claude-opus-5-5", label: "Opus 5.5", family: "claude", levels: ["off", "low", "medium", "high", "xhigh"] },
    { provider: "anthropic", id: "claude-sonnet-5", label: "Sonnet 5", family: "claude", levels: ["off", "low", "medium", "high"] },
    { provider: "openai-codex", id: "gpt-5.5", label: "GPT-5.5", family: "gpt", levels: ["low", "medium", "high", "xhigh"] },
  ],
  default: { model: "anthropic/claude-opus-5-5", thinkingLevel: "high" },
};

type Client = { socket: WebSocket; watching: Set<ConversationId> };

export class App {
  readonly store: Store;
  readonly threads: Threads;
  readonly channels: Channels;
  readonly boards: Boards;
  readonly search: Search;
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
    this.threads.onDoc = (thread, name, value) => {
      if (name === "chat.board") this.boards.docChanged(thread, value);
    };
    this.search = new Search(host, this.threads, this.channels);
    this.wss.on("connection", socket => this.connect(socket));
  }

  async start(): Promise<void> {
    await this.threads.start(this.config.fixture ? 1000 : 2000);
    this.channels.resume();
    this.boards.start();
  }

  async stop(): Promise<void> {
    this.boards.stop();
    clearTimeout(this.sidebarTimer);
    await this.threads.stop();
    for (const client of this.clients) client.socket.close();
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
    return { summary, members, model: agent.model, thinkingLevel: agent.thinkingLevel, agent };
  }

  async send(id: ConversationId, request: SendRequest): Promise<SendResult> {
    if (!request.text?.trim() && !request.images?.length) throw new Error("A message needs text or an image.");
    if (!request.requestId) throw new Error("A send needs a requestId, so a retry lands once.");
    const images = (request.images ?? []).map(image => this.saveUpload(image));
    if (this.isChannel(id)) {
      const posted = await this.channels.post(id, "owner", { ...request, images: undefined as never }, images);
      return posted;
    }
    const { thread, conversation } = parseConversationId(id);
    if (!this.threads.thread(thread)) throw new NotFound(`No thread ${thread}.`);
    await this.host.submit(thread, {
      ...(conversation === 1 ? {} : { conversation }), text: request.text, ...(request.images?.length ? { images: request.images } : {}),
      requestId: request.requestId, whenBusy: request.whenBusy ?? "steer",
    });
    this.store.state.reads[id] = { at: Date.now() };
    this.store.saveState();
    const deliveries = [];
    for (const target of (request.mentions ?? []).filter(m => m !== id && m !== "owner")) {
      const where = parseConversationId(target);
      try {
        await this.host.submit(where.thread, {
          ...(where.conversation === 1 ? {} : { conversation: where.conversation }), text: request.text, requestId: `${request.requestId}:${target}`, whenBusy: "followUp",
          entry: { kind: "agent.message", data: { from: "owner", via: id } },
        });
        deliveries.push({ target, name: this.threads.principal(target).name, state: "delivered" as const, at: Date.now() });
      } catch (error) {
        deliveries.push({ target, name: this.threads.principal(target).name, state: "failed" as const, at: Date.now(), error: error instanceof Error ? error.message : String(error) });
      }
    }
    return {
      item: { kind: "message", id: `r:${request.requestId}`, at: Date.now(), author: OWNER, text: request.text, images, mentions: request.mentions ?? [], deliveries, pending: true },
      deliveries,
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
