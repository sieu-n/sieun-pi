/**
 * `Host` over every box agents run on (apps/chat/docs/agent-model.md, section 4 and phase 6): one `Host` per box, the chat's own box
 * first, which is a `RelayHost` once that box runs an agent relay and the local `PiHost` until then.
 *
 * 1. `threads()` asks every box and tags each row with its `box`. A box that does not answer gives its last good rows, kept in memory and in
 *    `<data dir>/host-routes.json`, or in chat.sqlite once the App calls `keep`, so its agents stay listed while it is away. With no
 *    `archived` option it sends each box's cursor and merges the rows changed since it into the rows it keeps (`BoxRows`).
 * 2. Each call about one thread goes to the box that listed it (the same file keeps the map), else to the box of the agent record that holds
 *    the thread (`agentHost`), else to the chat's own box.
 * 3. `create` makes the thread on the box it names, the chat's own box by default.
 * 4. `ping` answers for the chat's box with every box beside it.
 */
import type { BoxInfo } from "../../../../components/prime-relay/agents/protocol.ts";
import { replaceLater } from "../disk.ts";
import type { Kept } from "../kept-json.ts";
import { readJson } from "../store.ts";
import { join } from "node:path";
import { RelayHost, type LinkState } from "./relay-host.ts";
import type {
  CreateOptions, DurableEvent, DurableThread, EntriesQuery, EntryRecord, Host, Ping, SubmissionRecord, Submitted, SubmitInput, Ticket, TreeNode,
} from "./types.ts";

/** The routes' file, which also names their rows in chat.sqlite (kept-json.ts HOST_ROUTES_KIND). */
export const ROUTES_FILE = "host-routes.json";

interface RoutesFile {
  v: 1;
  /** The box of each thread any box listed or this server made. */
  threads: Record<string, string>;
  /** Each box's last good thread list, by `live` (archived left out) and `all`. */
  rows: Record<string, { live?: DurableThread[]; all?: DurableThread[] }>;
}

/** One box's rows as its last `durable_threads` answers left them, by id and newest first, with the cursor to send next. */
interface BoxRows {
  cursor: string | null;
  byId: Map<string, DurableThread>;
  rows: DurableThread[];
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
  /** chat.sqlite's rows of the routes, which `keep` sets when APPS_CHAT_DB_KINDS names the host-routes kind; else the file keeps them. */
  private kept?: Kept;
  private saving = false;
  private readonly started = Date.now();
  /** Each box's rows of `threads()` with no option, kept between reads with the cursor of the box's last answer. */
  private readonly pages = new Map<string, BoxRows>();
  /** The box of the agent record that holds a thread, which the App sets once it has its records. */
  agentHost: (thread: string) => string | undefined = () => undefined;

  constructor(readonly self: string, boxes: Box[], dataDir: string, readonly selfInfo: BoxInfo, private readonly log: (line: string) => void = () => {}) {
    for (const box of boxes) this.boxes.set(box.box, box);
    if (!this.boxes.has(self)) throw new Error(`MultiHost needs a host for its own box ${self}.`);
    this.name = this.boxes.get(self)!.host.name;
    this.file = join(dataDir, ROUTES_FILE);
    this.routes = readJson<RoutesFile>(this.file, { v: 1, threads: {}, rows: {} });
    this.saved = JSON.stringify(this.routes);
  }

  /** Keeps the routes in `kept` from now on, starting from the ones it holds; the App calls it before any call goes out. */
  keep(kept: Kept): void {
    this.kept = kept;
    this.routes = (kept.read(ROUTES_FILE) as RoutesFile | undefined) ?? this.routes;
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

  /**
   * Saves the routes once the current task ends, as one write however many calls asked. The file held 1.3 MB on 11-23, and its JSON and sync
   * write took about 37 ms of each POST /api/agents before the answer; now they run after it, and the write goes through the disk queue.
   * Kept in chat.sqlite, a save writes only the rows that changed.
   */
  private save(): void {
    if (this.saving) return;
    this.saving = true;
    setImmediate(() => {
      this.saving = false;
      if (this.kept) return void this.kept.write(ROUTES_FILE, this.routes);
      const json = JSON.stringify(this.routes);
      if (json === this.saved) return;
      this.saved = json;
      replaceLater(this.file, `${json}\n`);
    });
  }

  async threads(opts: { archived?: boolean } = {}): Promise<DurableThread[]> {
    const key = opts.archived ? "all" : "live";
    const boxes = this.list();
    const answers = await Promise.allSettled(boxes.map(b => this.boxThreads(b, opts)));
    const out: DurableThread[] = [];
    let firstError: unknown;
    let answered = 0;
    let changed = false;
    answers.forEach((answer, i) => {
      const { box } = boxes[i]!;
      if (answer.status === "fulfilled") {
        answered += 1;
        const { rows, touched } = answer.value;
        for (const row of touched) this.remember(row.id, box);
        if (touched.length || (this.routes.rows[box] ??= {})[key] !== rows) {
          (this.routes.rows[box] ??= {})[key] = rows;
          changed = true;
        }
        out.push(...rows);
      } else {
        firstError ??= answer.reason;
        out.push(...(this.routes.rows[box]?.[key] ?? []));
      }
    });
    if (!answered) throw firstError;
    if (changed) this.save();
    return out;
  }

  /**
   * One box's rows tagged with the box, and the rows new to this read, whose routes are noted. With no option and a host that takes a cursor,
   * the box answers only the rows changed since its last answer: parsing all 2,300 rows every 2 s took about 28 ms of the chat's loop on 11-24
   * (p276). A row no answer changed stays the same object, so the thread list read keeps its summaries without comparing it. A cursor the
   * box does not know, such as one from before its pi-host restarted, gets every row with `full`, and so does a pi-host from before 11-24.
   */
  private async boxThreads(b: Box, opts: { archived?: boolean }): Promise<{ rows: DurableThread[]; touched: DurableThread[] }> {
    const tag = (rows: DurableThread[]) => rows.map(row => ({ ...row, box: b.box }));
    if (opts.archived !== undefined || !b.host.threadPage) {
      const rows = tag(await b.host.threads(opts));
      return { rows, touched: rows };
    }
    const kept = this.pages.get(b.box);
    const page = await b.host.threadPage(kept?.cursor ?? null);
    if (page.full || !kept) {
      const rows = tag(page.threads);
      this.pages.set(b.box, { cursor: page.cursor, byId: new Map(rows.map(row => [row.id, row])), rows });
      return { rows, touched: rows };
    }
    kept.cursor = page.cursor;
    if (!page.threads.length && !page.removed.length) return { rows: kept.rows, touched: [] };
    const touched = tag(page.threads);
    for (const row of touched) kept.byId.set(row.id, row);
    for (const id of page.removed) kept.byId.delete(id);
    // pi-host lists threads newest first, and the merged rows keep that order.
    kept.rows = [...kept.byId.values()].sort((x, y) => y.updatedAt - x.updatedAt);
    return { rows: kept.rows, touched };
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
  entries(thread: string, opts: EntriesQuery): Promise<{ entries: EntryRecord[]; more: boolean }> {
    return this.hostOf(thread).entries(thread, opts);
  }
  watch(thread: string, opts: { conversation?: number; fromEntry?: number }, sink: (event: DurableEvent) => void): Promise<() => Promise<void>> {
    return this.hostOf(thread).watch(thread, opts, sink);
  }
  docGet(thread: string, name: string): Promise<unknown> {
    return this.hostOf(thread).docGet(thread, name);
  }
  docPut(thread: string, name: string, value: unknown, opts?: { newerOnly?: boolean }): Promise<void> {
    return this.hostOf(thread).docPut(thread, name, value, opts);
  }
  async set(thread: string, patch: { name?: string; model?: string; thinkingLevel?: string; archived?: boolean; cwd?: string }): Promise<DurableThread> {
    const box = this.boxOf(thread);
    return { ...(await this.boxes.get(box)!.host.set(thread, patch)), box };
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
