/**
 * `Host` over every box agents run on (apps/chat/docs/agent-model.md, section 4 and phase 6): one `Host` per box, the chat's own box
 * first, which is a `RelayHost` once that box runs an agent relay and the local `PiHost` until then.
 *
 * 1. `threads()` asks every box and tags each row with its `box`. A box that does not answer gives its last good rows, kept in memory and in
 *    `<data dir>/host-routes.json`, so its agents stay listed while it is away.
 * 2. Each call about one thread goes to the box that listed it (the same file keeps the map), else to the box of the agent record that holds
 *    the thread (`agentHost`), else to the chat's own box.
 * 3. `create` makes the thread on the box it names, the chat's own box by default.
 * 4. `search` and `usage` ask the boxes whose link is up and merge the answers; `ping` answers for the chat's box with every box beside it.
 */
import type { BoxInfo } from "../../../../components/prime-relay/agents/protocol.ts";
import { readJson, writeJson } from "../store.ts";
import { join } from "node:path";
import { RelayHost, type LinkState } from "./relay-host.ts";
import type {
  CreateOptions, DurableEvent, DurableThread, EntryRecord, Host, Ping, SearchPage, SearchQuery, SubmissionRecord, Submitted, SubmitInput, Ticket, TreeNode, UsageTotal,
} from "./types.ts";

interface RoutesFile {
  v: 1;
  /** The box of each thread any box listed or this server made. */
  threads: Record<string, string>;
  /** Each box's last good thread list, by `live` (archived left out) and `all`. */
  rows: Record<string, { live?: DurableThread[]; all?: DurableThread[] }>;
}

export interface Box {
  box: string;
  label: string;
  host: Host;
}

export class MultiHost implements Host {
  readonly name: string;
  private readonly boxes = new Map<string, Box>();
  private readonly file: string;
  private routes: RoutesFile;
  private saved: string;
  private readonly started = Date.now();
  /** The box of the agent record that holds a thread, which the App sets once it has its records. */
  agentHost: (thread: string) => string | undefined = () => undefined;

  constructor(readonly self: string, boxes: Box[], dataDir: string, readonly selfInfo: BoxInfo, private readonly log: (line: string) => void = () => {}) {
    for (const box of boxes) this.boxes.set(box.box, box);
    if (!this.boxes.has(self)) throw new Error(`MultiHost needs a host for its own box ${self}.`);
    this.name = this.boxes.get(self)!.host.name;
    this.file = join(dataDir, "host-routes.json");
    this.routes = readJson<RoutesFile>(this.file, { v: 1, threads: {}, rows: {} });
    this.saved = JSON.stringify(this.routes);
  }

  /** Every box, the chat's own first. */
  list(): Box[] {
    return [this.boxes.get(this.self)!, ...[...this.boxes.values()].filter(b => b.box !== this.self)];
  }

  /** The box's relay client, when it has one. */
  relay(box: string): RelayHost | undefined {
    const host = this.boxes.get(box)?.host;
    return host instanceof RelayHost ? host : undefined;
  }

  relays(): RelayHost[] {
    return this.list().flatMap(b => (b.host instanceof RelayHost ? [b.host] : []));
  }

  has(box: string): boolean {
    return this.boxes.has(box);
  }

  /** Whether the server has a live link to the box; a box with a local host is always up, and a box it does not know is away. */
  link(box: string): LinkState {
    const entry = this.boxes.get(box);
    if (!entry) return { state: "away", since: this.started };
    return entry.host instanceof RelayHost ? entry.host.state() : { state: "up", since: this.started };
  }

  /** Calls `listener` when any box's link goes up or away. */
  onLink(listener: (box: string, link: LinkState) => void): void {
    for (const relay of this.relays()) relay.onLink(link => listener(relay.name, link));
  }

  /** The box's home, projects and agent folders: from its relay's hello, or this server's own for its box without a relay. */
  info(box: string): BoxInfo | undefined {
    const relay = this.relay(box);
    if (relay?.info) return relay.info;
    return box === this.self ? this.selfInfo : undefined;
  }

  /** The box that holds the thread. */
  boxOf(thread: string): string {
    const known = this.routes.threads[thread] ?? this.agentHost(thread);
    return known && this.boxes.has(known) ? known : this.self;
  }

  private hostOf(thread: string): Host {
    return this.boxes.get(this.boxOf(thread))!.host;
  }

  private remember(thread: string, box: string): void {
    this.routes.threads[thread] = box;
  }

  private save(): void {
    const json = JSON.stringify(this.routes);
    if (json === this.saved) return;
    this.saved = json;
    writeJson(this.file, this.routes);
  }

  async threads(opts: { archived?: boolean } = {}): Promise<DurableThread[]> {
    const key = opts.archived ? "all" : "live";
    const boxes = this.list();
    const answers = await Promise.allSettled(boxes.map(b => b.host.threads(opts)));
    const out: DurableThread[] = [];
    let firstError: unknown;
    let answered = 0;
    answers.forEach((answer, i) => {
      const { box } = boxes[i]!;
      if (answer.status === "fulfilled") {
        answered += 1;
        const rows = answer.value.map(row => ({ ...row, box }));
        for (const row of rows) this.remember(row.id, box);
        (this.routes.rows[box] ??= {})[key] = rows;
        out.push(...rows);
      } else {
        firstError ??= answer.reason;
        out.push(...(this.routes.rows[box]?.[key] ?? []));
      }
    });
    if (!answered) throw firstError;
    this.save();
    return out;
  }

  async create(opts: CreateOptions): Promise<DurableThread> {
    const box = opts.box ?? this.self;
    const entry = this.boxes.get(box);
    if (!entry) throw new Error(`No box ${box}; the boxes are ${[...this.boxes.keys()].join(", ")}.`);
    const { box: _box, ...fields } = opts;
    const created = { ...(await entry.host.create(fields)), box };
    this.remember(created.id, box);
    this.save();
    return created;
  }

  submit(thread: string, input: SubmitInput): Promise<Submitted> {
    return this.hostOf(thread).submit(thread, input);
  }
  ticket(thread: string, conversation?: number): Promise<Ticket | null> {
    return this.hostOf(thread).ticket(thread, conversation);
  }
  abort(thread: string, conversation?: number): Promise<void> {
    return this.hostOf(thread).abort(thread, conversation);
  }
  wait(thread: string, submission: number): Promise<SubmissionRecord> {
    return this.hostOf(thread).wait(thread, submission);
  }
  tree(thread: string): Promise<TreeNode[]> {
    return this.hostOf(thread).tree(thread);
  }
  entries(thread: string, opts: { conversation?: number; before?: number; after?: number; limit?: number }): Promise<{ entries: EntryRecord[]; more: boolean }> {
    return this.hostOf(thread).entries(thread, opts);
  }
  watch(thread: string, opts: { conversation?: number; fromEntry?: number }, sink: (event: DurableEvent) => void): Promise<() => Promise<void>> {
    return this.hostOf(thread).watch(thread, opts, sink);
  }
  docGet(thread: string, name: string): Promise<unknown> {
    return this.hostOf(thread).docGet(thread, name);
  }
  docPut(thread: string, name: string, value: unknown): Promise<void> {
    return this.hostOf(thread).docPut(thread, name, value);
  }
  async set(thread: string, patch: { name?: string; model?: string; thinkingLevel?: string; archived?: boolean; cwd?: string }): Promise<DurableThread> {
    const box = this.boxOf(thread);
    return { ...(await this.boxes.get(box)!.host.set(thread, patch)), box };
  }

  /** The boxes whose link is up, for the calls that fan out. */
  private upBoxes(): Box[] {
    return this.list().filter(b => this.link(b.box).state === "up");
  }

  /** Every up box's hits: the newest first for `sort: "recent"`, else each box's in its own rank order, the chat's box first. */
  async search(query: SearchQuery): Promise<SearchPage> {
    const boxes = this.upBoxes();
    const answers = await Promise.allSettled(boxes.map(b => b.host.search(query)));
    const hits: SearchPage["hits"] = [];
    let total = 0;
    answers.forEach((answer, i) => {
      if (answer.status === "fulfilled") {
        hits.push(...answer.value.hits);
        total += answer.value.total;
      } else this.log(`search on ${boxes[i]!.box} failed: ${String(answer.reason)}`);
    });
    if (query.sort === "recent") hits.sort((a, b) => b.at - a.at);
    return { hits: query.limit ? hits.slice(0, query.limit) : hits, total };
  }

  async usage(range: { since?: number; until?: number; threads?: string[] }): Promise<UsageTotal[]> {
    const boxes = this.upBoxes();
    const answers = await Promise.allSettled(boxes.map(b => b.host.usage(range)));
    return answers.flatMap((answer, i) => {
      if (answer.status === "fulfilled") return answer.value;
      this.log(`usage on ${boxes[i]!.box} failed: ${String(answer.reason)}`);
      return [];
    });
  }

  async ping(): Promise<Ping> {
    const boxes = this.list();
    const answers = await Promise.all(boxes.map(b => b.host.ping().catch((error): Ping => ({ ok: false, error: String(error) }))));
    const per: NonNullable<Ping["boxes"]> = Object.fromEntries(boxes.map((b, i) => {
      const { boxes: _nested, ...one } = answers[i]!;
      return [b.box, one];
    }));
    return { ...per[this.self]!, boxes: per };
  }

  async close(): Promise<void> {
    await Promise.all(this.list().map(b => b.host.close().catch(() => undefined)));
  }
}
