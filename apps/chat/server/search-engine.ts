/**
 * The one Meilisearch index behind search: the thread entries of every box, one document per entry however many threads hold a copy of it,
 * and every room post with its reactions. Another box's rows come through its agent relay's `durable_index_read`, so a search never waits on
 * that box and still finds its threads while it is offline. On us-metal02 on 11-03 it answered every keystroke of "delete" and "vent" with the exact count in
 * 6 to 9 ms against 50 to 1,540 ms for pi-host's FTS5 table (~/work/fast-search/).
 *
 * A change reaches Meilisearch as a task that took 1.5 to 3.1 s to finish on that box. Until its task is done a document sits in
 * `pending`, which search reads in memory and leaves out of the Meilisearch query by id, so a post or entry is found at once and counted once.
 * An empty index's first fill is waited for instead, so a fresh server's counts are Meilisearch's from its first search.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { openIndexReadOnly, readIndexRows, type IndexRead, type IndexRow } from "../../../packages/pi-host/src/durable/index-db.ts";
import { Meili, MeiliError } from "./meili.ts";

export const SEARCH_INDEX = "search";
/** The documents' shape; a saved cursor of another version fills the index again. */
export const SEARCH_DOC_VERSION = 1;

/** `sort` comes first so a `recent` search is newest first; tool output (tier 1) ranks after every message by relevance. */
export const SEARCH_SETTINGS = {
  searchableAttributes: ["text", "reactions"],
  filterableAttributes: ["id", "source", "kind", "author", "at", "tier", "threads", "convs", "keys", "channelCopy", "room", "dm", "listed", "ownerPost"],
  sortableAttributes: ["at"],
  rankingRules: ["sort", "tier:asc", "words", "typo", "proximity", "attribute", "exactness"],
  // Meilisearch counts hits only up to maxTotalHits (1,000 by default); "d" alone matched 48,594 entries on 11-03, and the count stays exact (c191).
  pagination: { maxTotalHits: 100_000_000 },
  // Search filters on these attributes and never asks for facet values, while building facet search took 15.8 s of the last 20 batches' 42 s
  // of indexing on 11-03 (progressTrace, 1 to 9 documents a batch).
  facetSearch: false,
};

/**
 * Sends to Meilisearch are this far apart. A batch costs about the same for 1 or 9 documents (word fst 0.6 s, facet search 0.8 s a batch on
 * 11-03), and a send on each pi-host write kept it indexing 48 batches a minute, all of the time; documents in between are read from memory.
 */
const SEND_SPACING_MS = 5_000;

/** Meilisearch's default http-payload-size-limit is 100 MB, so one request of documents stays under it. */
const PAYLOAD_BYTES = 100_000_000;

/** One row of a box's pi-host search index. */
export type EntryRow = IndexRow;

/**
 * One box's entries: this box's pi-host index.sqlite (or a fixture host's threads), or another box's index through its agent relay's
 * `durable_index_read`. Every box's rows go into the one index, so a search never asks another box and finds an offline box's threads.
 */
export interface EntrySource {
  box: string;
  /** Read at each search as well, since it answers in about 0.1 ms: this box's own index. Another box is read every `SEND_SPACING_MS`. */
  atSearch: boolean;
  /** False while the box is away; its rows read so far stay searchable. */
  up(): boolean;
  /** The rows after `cursor`, a page at a time (`more`), and the cursor to read on from. */
  read(cursor: string | undefined): IndexRead | Promise<IndexRead>;
}

/** How far one box's rows have reached the index: `unread` before its first read, `indexing` until Meilisearch has its first read. */
export type BoxIndexState = "unread" | "indexing" | "read";

export interface EntryDoc {
  id: string; source: "entry"; text: string; at: number; tier: 0 | 1; kind: string; author: string; entry: number;
  /** Every thread that holds a copy, `thread:conversation` of each copy, and `thread:entry` of each copy. */
  threads: string[]; convs: string[]; keys: string[];
  /** An agent message that is a channel post's copy in a member's comm thread (group-rooms.ts CHANNEL_COPY_LIKE). */
  channelCopy: boolean;
}
export interface PostDoc {
  id: string; source: "post"; text: string; reactions: string; at: number; tier: 0; author: string; room: string; post: string;
  /** A DM post; `listed` is false for a DM post search leaves out (rooms.ts `searchListed`); `ownerPost` is the owner's and no test send. */
  dm: boolean; listed: boolean; ownerPost: boolean;
}
export type SearchDoc = EntryDoc | PostDoc;

/** A filter as data: Meilisearch reads its string form, and `pending` documents are tested against it in memory. */
export type Cond =
  | { op: "eq"; field: keyof EntryDoc | keyof PostDoc; value: string | number | boolean }
  | { op: "in"; field: keyof EntryDoc | keyof PostDoc; values: readonly (string | number)[] }
  | { op: "gte" | "lt"; field: "at"; value: number }
  | { op: "not"; cond: Cond }
  | { op: "and" | "or"; conds: Cond[] };

export const eq = (field: Extract<Cond, { op: "eq" }>["field"], value: string | number | boolean): Cond => ({ op: "eq", field, value });
export const isIn = (field: Extract<Cond, { op: "in" }>["field"], values: readonly (string | number)[]): Cond => ({ op: "in", field, values });
export const not = (cond: Cond): Cond => ({ op: "not", cond });
export const and = (...conds: Cond[]): Cond => ({ op: "and", conds });
export const or = (...conds: Cond[]): Cond => ({ op: "or", conds });

export function filterText(cond: Cond): string {
  switch (cond.op) {
    case "eq": return `${cond.field} = ${JSON.stringify(cond.value)}`;
    case "in": return cond.values.length ? `${cond.field} IN [${cond.values.map(v => JSON.stringify(v)).join(", ")}]` : "id IN []";
    case "gte": return `${cond.field} >= ${cond.value}`;
    case "lt": return `${cond.field} < ${cond.value}`;
    case "not": return `NOT (${filterText(cond.cond)})`;
    case "and": return cond.conds.length ? cond.conds.map(c => `(${filterText(c)})`).join(" AND ") : "id NOT IN []";
    case "or": return cond.conds.length ? cond.conds.map(c => `(${filterText(c)})`).join(" OR ") : "id IN []";
  }
}

function fieldHas(doc: SearchDoc, field: string, want: string | number | boolean): boolean {
  const v = (doc as unknown as Record<string, unknown>)[field];
  return Array.isArray(v) ? v.includes(want) : v === want;
}

export function holds(cond: Cond, doc: SearchDoc): boolean {
  switch (cond.op) {
    case "eq": return fieldHas(doc, cond.field, cond.value);
    case "in": for (const v of cond.values) if (fieldHas(doc, cond.field, v)) return true; return false;
    case "gte": return Number((doc as unknown as Record<string, unknown>)[cond.field]) >= cond.value;
    case "lt": return Number((doc as unknown as Record<string, unknown>)[cond.field]) < cond.value;
    case "not": return !holds(cond.cond, doc);
    case "and": for (const c of cond.conds) if (!holds(c, doc)) return false; return true;
    case "or": for (const c of cond.conds) if (holds(c, doc)) return true; return false;
  }
}

/** A LIKE pattern as a regex: `%` is any run, `_` one character, ASCII letters fold, as SQLite's LIKE reads it. */
export function likeRegex(pattern: string): RegExp {
  const body = [...pattern].map(ch => (ch === "%" ? "[\\s\\S]*" : ch === "_" ? "[\\s\\S]" : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("");
  return new RegExp(`^${body}$`, "i");
}

/** The id every copy of one entry shares: copies keep the entry's id, kind, author and time (index-db.ts `searchIndex`). */
export const entryDocId = (row: Pick<EntryRow, "entryId" | "kind" | "author" | "at">): string =>
  `e${row.entryId}_${createHash("sha1").update(`${row.kind}\u0000${row.author}\u0000${row.at}`).digest("hex").slice(0, 20)}`;
export const postDocId = (room: string, post: string): string => `p_${room.replace(/[^\w-]/g, "_")}_${post.replace(/[^\w-]/g, "_")}`;

/** This box's pi-host index.sqlite on a read-only connection, read as pi-host's `durable_index_read` reads it. */
export class SqliteEntries implements EntrySource {
  private db?: DatabaseSync;
  readonly atSearch = true;
  constructor(readonly box: string, private readonly path: string) {}
  up(): boolean {
    return true;
  }
  read(cursor: string | undefined): IndexRead {
    if (!this.db && !existsSync(this.path)) return { rows: [], cursor: cursor ?? "0", more: false };
    this.db ??= openIndexReadOnly(this.path);
    return readIndexRows(this.db, cursor);
  }
  close(): void {
    this.db?.close();
    this.db = undefined;
  }
}

/** The words a document must hold as word prefixes in memory, the way search reads a bare word. */
export function queryWords(q: string): string[] {
  return [...new Set((q.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []))];
}

/** Each pending document's folded words, read once, since search tests every pending document at each keystroke. */
const wordsOf = new WeakMap<SearchDoc, string[]>();

function docMatches(doc: SearchDoc, words: readonly string[]): number {
  let own = wordsOf.get(doc);
  if (!own) {
    own = queryWords(`${doc.text}\n${doc.source === "post" ? doc.reactions : ""}`);
    wordsOf.set(doc, own);
  }
  let score = 0;
  for (const w of words) {
    let count = 0;
    for (const word of own) if (word.startsWith(w)) count++;
    if (!count) return 0;
    score += count;
  }
  return score;
}

type Pending = { doc: SearchDoc | null; task?: number };

/** One entry's document with the threads of both: a copy in another thread adds its thread. */
function mergeCopies(was: Pick<EntryDoc, "threads" | "convs" | "keys">, doc: EntryDoc): EntryDoc {
  const union = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])];
  return { ...doc, threads: union(was.threads, doc.threads), convs: union(was.convs, doc.convs), keys: union(was.keys, doc.keys) };
}

export interface EngineDeps {
  /** The Meilisearch to use, asked for once when search starts. */
  connect: () => Promise<Meili>;
  /** Every box's entries; this box's own source has `atSearch`. */
  sources: EntrySource[];
  /** Every post's document, read when search starts. */
  allPosts: () => SearchDoc[];
  /** Each box's entry cursor whose rows Meilisearch has been sent, and its store; none for this box's own source means an empty index. */
  cursors: { get(box: string): string | undefined; set(box: string, cursor: string): void };
  channelCopy: RegExp;
  log: (line: string) => void;
}

export interface EngineAnswer { docs: SearchDoc[]; total: number }

export class SearchEngine {
  private readonly pending = new Map<string, Pending>();
  private ready?: Promise<void>;
  private sync?: Promise<void>;
  private resync = false;
  private sendTimer?: ReturnType<typeof setTimeout>;
  private pullTimer?: ReturnType<typeof setInterval>;
  private lastSend = 0;
  private meili!: Meili;
  /** While an empty index fills, every document is in `pending` and search reads only memory until the fill's tasks are done. */
  private filling = false;
  private fillTasks?: number[];
  /** Each box's entry cursor read into memory, ahead of the saved one until `refresh` sends its documents; none before its first read. */
  private readonly readCursors = new Map<string, string>();
  /** A box's read in flight, so two reads of one box never take the same rows. */
  private readonly reads = new Map<string, Promise<void>>();
  /** The Meilisearch tasks of each box's first read, until they are done. */
  private readonly firstTasks = new Map<string, number[]>();
  private readonly unsent = new Map<string, SearchDoc>();
  private draining?: Promise<void>;

  constructor(private readonly deps: EngineDeps) {}

  private get own(): EntrySource[] {
    return this.deps.sources.filter(source => source.atSearch);
  }

  /** Where a box's rows stand, for the note search gives about a box whose threads may be missing. */
  boxState(box: string): BoxIndexState {
    if (this.firstTasks.has(box) || (this.reads.has(box) && !this.readCursors.has(box))) return "indexing";
    return this.readCursors.has(box) ? "read" : "unread";
  }

  /**
   * Opens the index. An empty index gets this box's entries and every post, which search reads in memory until Meilisearch has them all;
   * an index that has documents gets the entries after the saved cursors and every post again, so a change made while this server was down
   * is found. Every other box is read after it, and again every `SEND_SPACING_MS`.
   */
  start(): Promise<void> {
    if (this.ready) return this.ready;
    const fresh = this.own.some(source => this.deps.cursors.get(source.box) === undefined);
    if (!fresh) for (const source of this.deps.sources) {
      const cursor = this.deps.cursors.get(source.box);
      if (cursor !== undefined) this.readCursors.set(source.box, cursor);
    }
    if (fresh) this.filling = true;
    this.ready = (async () => {
      const posts = this.deps.allPosts();
      const first = fresh ? await this.readAll(this.own) : undefined;
      if (first) for (const doc of [...first, ...posts]) this.pending.set(doc.id, { doc });
      this.meili = await this.deps.connect();
      const stats = await this.openIndex();
      if (!first) {
        if (stats.numberOfDocuments > 0) await this.putDocs(posts);
        else {
          // Meilisearch lost its documents: fill it again, and read every other box again from its first row.
          this.deps.log("search: the Meilisearch index is empty while a cursor is saved; indexing every entry again");
          this.readCursors.clear();
          const all = await this.readAll(this.own);
          this.filling = true;
          for (const doc of [...all, ...posts]) this.pending.set(doc.id, { doc });
          this.fillTasks = await this.putDocs([...all, ...posts]);
          this.saveCursors(this.own);
        }
      } else {
        // Documents of an older shape go before the index fills again.
        if (stats.numberOfDocuments > 0) await this.meili.waitTask(await this.meili.call("DELETE", `/indexes/${SEARCH_INDEX}/documents`));
        this.fillTasks = await this.putDocs([...first, ...posts]);
        this.saveCursors(this.own);
      }
      if (this.deps.sources.some(source => !source.atSearch)) {
        this.pullTimer = setInterval(() => void this.pullOthers(), SEND_SPACING_MS);
        this.pullTimer.unref?.();
        void this.pullOthers();
      }
    })();
    this.ready.catch(error => {
      this.ready = undefined;
      this.deps.log(`search: Meilisearch did not open (${String(error)})`);
    });
    return this.ready;
  }

  stop(): void {
    clearInterval(this.pullTimer);
    clearTimeout(this.sendTimer);
  }

  /** Every row of these sources from their first, as documents with the copies of all of them merged, and each box's cursor after them. */
  private async readAll(sources: EntrySource[]): Promise<EntryDoc[]> {
    const rows: EntryRow[] = [];
    for (const source of sources) {
      let cursor: string | undefined;
      for (;;) {
        const page = await source.read(cursor);
        rows.push(...page.rows);
        cursor = page.cursor;
        if (!page.more) break;
      }
      this.readCursors.set(source.box, cursor);
    }
    return this.entryDocs(rows);
  }

  private saveCursors(sources: EntrySource[]): void {
    for (const source of sources) {
      const cursor = this.readCursors.get(source.box);
      if (cursor !== undefined && cursor !== this.deps.cursors.get(source.box)) this.deps.cursors.set(source.box, cursor);
    }
  }

  /** Creates the index or changes its settings only when they differ, since each change is a task that waits behind any indexing. */
  private async openIndex(): Promise<{ numberOfDocuments: number }> {
    const settings = await this.meili.call<Record<string, unknown>>("GET", `/indexes/${SEARCH_INDEX}/settings`).catch(() => undefined);
    if (!settings) await this.meili.waitTask(await this.meili.call("POST", "/indexes", { uid: SEARCH_INDEX, primaryKey: "id" }));
    const differs = !settings || Object.entries(SEARCH_SETTINGS).some(([key, value]) => JSON.stringify(settings[key]) !== JSON.stringify(value));
    if (differs) {
      const task = await this.meili.waitTask(await this.meili.call("PATCH", `/indexes/${SEARCH_INDEX}/settings`, SEARCH_SETTINGS));
      if (task.status !== "succeeded") throw new MeiliError(`Meilisearch refused the ${SEARCH_INDEX} settings: ${task.error?.message ?? task.status}`);
    }
    return this.meili.call<{ numberOfDocuments: number }>("GET", `/indexes/${SEARCH_INDEX}/stats`);
  }

  /**
   * Reads the rows a box added since its last read into `pending`, where search finds them at once; `refresh` sends them. A box's first
   * read, or a read of more than one page, goes to Meilisearch at once instead: it may be every row the box has (79,845 on us-metal02 on
   * 11-03), which search would otherwise test in memory and leave out of each query by id. Its threads show as Meilisearch takes them, and
   * `boxState` says the box is indexing meanwhile.
   */
  private readBox(source: EntrySource): Promise<void> {
    const running = this.reads.get(source.box);
    if (running) return running;
    const read = (async () => {
      let bulk = !this.readCursors.has(source.box);
      if (bulk) this.firstTasks.set(source.box, this.firstTasks.get(source.box) ?? []);
      for (;;) {
        const page = await source.read(this.readCursors.get(source.box));
        bulk ||= page.more;
        const docs = this.entryDocs(page.rows);
        if (bulk) {
          const tasks = await this.putDocs(docs, { hold: false });
          this.firstTasks.set(source.box, [...(this.firstTasks.get(source.box) ?? []), ...tasks]);
          this.deps.cursors.set(source.box, page.cursor);
        } else {
          for (const doc of docs) {
            const held = this.pending.get(doc.id)?.doc;
            const merged = held?.source === "entry" ? mergeCopies(held, doc) : doc;
            this.pending.set(doc.id, { doc: merged });
            this.unsent.set(doc.id, merged);
          }
        }
        this.readCursors.set(source.box, page.cursor);
        if (!page.more) break;
      }
    })().finally(() => this.reads.delete(source.box));
    this.reads.set(source.box, read);
    return read;
  }

  private readonly pullErrors = new Map<string, string>();

  /** Reads every other box that is up; their new rows go out with the next send. A box's failed read is logged once per distinct error. */
  private async pullOthers(): Promise<void> {
    await Promise.all(this.deps.sources.filter(source => !source.atSearch && source.up()).map(source => this.readBox(source).then(
      () => void this.pullErrors.delete(source.box),
      (error: unknown) => {
        const text = String(error);
        if (this.pullErrors.get(source.box) !== text) this.deps.log(`search: reading ${source.box}'s index failed (${text}); its threads stay as last read`);
        this.pullErrors.set(source.box, text);
      },
    )));
    if (this.unsent.size) this.scheduleRefresh();
  }

  /** A `refresh` at most once per `SEND_SPACING_MS`, for a write that landed or a search; `settled` and the first start send at once. */
  scheduleRefresh(): void {
    if (this.sendTimer) return;
    this.sendTimer = setTimeout(() => {
      this.sendTimer = undefined;
      this.lastSend = Date.now();
      void this.refresh().catch(error => this.deps.log(`search: ${String(error)}`));
    }, Math.max(0, this.lastSend + SEND_SPACING_MS - Date.now()));
    this.sendTimer.unref?.();
  }

  /** Reads this box's new rows, sends what every read left in `unsent` and saves the cursors; a call while one runs runs once more after it. */
  refresh(): Promise<void> {
    if (this.sync) {
      this.resync = true;
      return this.sync;
    }
    this.sync = (async () => {
      try {
        await this.start();
        do {
          this.resync = false;
          await Promise.all(this.own.map(source => this.readBox(source)));
          // The cursors and the documents they cover are taken together, with no wait between.
          const cursors = new Map(this.readCursors);
          const docs = [...this.unsent.values()];
          this.unsent.clear();
          if (docs.length) await this.putDocs(docs);
          for (const [box, cursor] of cursors) if (cursor !== this.deps.cursors.get(box)) this.deps.cursors.set(box, cursor);
        } while (this.resync);
      } finally {
        this.sync = undefined;
      }
    })();
    return this.sync;
  }

  /** A post that was added or changed, or `null` with its id when it left search. Before search starts, `start` reads every post. */
  postChanged(id: string, doc: PostDoc | null): void {
    if (!this.ready) return;
    this.pending.set(id, { doc });
    void this.ready.then(async () => void (doc ? await this.putDocs([doc]) : await this.deleteDocs([id]))).catch(error => this.deps.log(`search: post ${id} not indexed: ${String(error)}`));
  }

  /** Waits until Meilisearch holds every document search has read or sent it, from every box that is up; a test reads the index after it. */
  async settled(): Promise<void> {
    await this.start();
    await this.pullOthers();
    await this.refresh();
    for (const uid of this.fillTasks ?? []) await this.meili.waitTask({ taskUid: uid });
    await this.checkFill();
    for (const uids of this.firstTasks.values()) for (const uid of uids) await this.meili.waitTask({ taskUid: uid });
    while (this.pending.size || this.firstTasks.size) {
      const uids = [...new Set([...this.pending.values()].flatMap(p => (p.task === undefined ? [] : [p.task])))];
      for (const uid of uids) await this.meili.waitTask({ taskUid: uid });
      await this.settle();
      if (!uids.length) await new Promise(resolve => setImmediate(resolve));
    }
  }

  /** Entry rows as documents: the copies of one entry among them, in any thread of any box, make one document that names every thread. */
  private entryDocs(rows: EntryRow[]): EntryDoc[] {
    const groups = new Map<string, EntryRow[]>();
    for (const row of rows) {
      const id = entryDocId(row);
      const copies = groups.get(id);
      if (copies) copies.push(row);
      else groups.set(id, [row]);
    }
    return [...groups].map(([id, copies]) => {
      const first = copies[0]!;
      return {
        id, source: "entry", text: first.text, at: first.at, tier: first.kind === "pi.tool-result" ? 1 : 0, kind: first.kind, author: first.author, entry: first.entryId,
        threads: [...new Set(copies.map(c => c.thread))], convs: [...new Set(copies.map(c => `${c.thread}:${c.conversation}`))],
        keys: [...new Set(copies.map(c => `${c.thread}:${c.entryId}`))],
        channelCopy: first.kind === "agent.message" && this.deps.channelCopy.test(first.text),
      } satisfies EntryDoc;
    });
  }

  /**
   * Puts documents in `pending` and sends them; an entry merges the threads of the copy Meilisearch or `pending` already holds. With
   * `hold: false` they skip `pending` and show once Meilisearch has them.
   */
  private async putDocs(docs: SearchDoc[], opts: { hold: boolean } = { hold: true }): Promise<number[]> {
    const entries = docs.filter((doc): doc is EntryDoc => doc.source === "entry");
    const known = new Map<string, EntryDoc>();
    for (const doc of entries) {
      const held = this.pending.get(doc.id)?.doc;
      if (held?.source === "entry" && held !== doc) known.set(doc.id, held);
    }
    const lookup = entries.filter(doc => !known.has(doc.id)).map(doc => doc.id);
    if (lookup.length && !this.filling) for (const doc of await this.meili.fetch<EntryDoc>(SEARCH_INDEX, lookup, ["id", "threads", "convs", "keys"])) known.set(doc.id, doc);
    const merged = docs.map(doc => {
      const was = doc.source === "entry" ? known.get(doc.id) : undefined;
      return was && doc.source === "entry" ? mergeCopies(was, doc) : doc;
    });
    // A document `pending` holds already stays there in its merged form, so memory never shows an older copy than Meilisearch.
    for (const doc of merged) if (opts.hold || this.pending.has(doc.id)) this.pending.set(doc.id, { doc });
    const tasks: number[] = [];
    for (let at = 0; at < merged.length;) {
      // The array's brackets and one comma per document count toward the limit too.
      let bytes = 2;
      const batch: SearchDoc[] = [];
      const parts: string[] = [];
      while (at < merged.length) {
        const part = JSON.stringify(merged[at]);
        const size = Buffer.byteLength(part) + 1;
        if (batch.length && bytes + size > PAYLOAD_BYTES) break;
        bytes += size;
        parts.push(part);
        batch.push(merged[at++]!);
      }
      const { taskUid } = await this.meili.put(SEARCH_INDEX, `[${parts.join(",")}]`);
      for (const doc of batch) if (this.pending.get(doc.id)?.doc === doc) this.pending.set(doc.id, { doc, task: taskUid });
      tasks.push(taskUid);
    }
    this.drain();
    return tasks;
  }

  private async deleteDocs(ids: string[]): Promise<void> {
    const { taskUid } = await this.meili.deleteIds(SEARCH_INDEX, ids);
    for (const id of ids) if (this.pending.get(id)?.doc === null) this.pending.set(id, { doc: null, task: taskUid });
    this.drain();
  }

  /**
   * Drops sent documents from `pending` once Meilisearch has them, with no search needed. Until 11-09 only a search did, so an idle spell's
   * pi-host rows piled up there: 8,270 rows came in the 27 h before the d2 duty's first search on 11-08, which took 445 ms on :5184 to test
   * them in memory and leave them out of Meilisearch's query by id, and 9.95 s when the same rows were replayed into a copy of the index.
   * Meilisearch runs one index's tasks in the order they came, so the newest task's end covers every task before it.
   */
  private drain(): void {
    if (this.draining || this.filling) return;
    let newest: number | undefined;
    for (const p of this.pending.values()) if (p.task !== undefined && (newest === undefined || p.task > newest)) newest = p.task;
    if (newest === undefined) return;
    const last = newest;
    this.draining = this.meili.waitTask({ taskUid: last })
      .then(() => this.settle())
      .catch(error => this.deps.log(`search: ${String(error)}`))
      .finally(() => {
        this.draining = undefined;
        for (const p of this.pending.values()) if (p.task !== undefined && p.task > last) return this.drain();
      });
  }

  /** Drops the pending documents whose task Meilisearch finished; the fill ends when none of its documents waits. */
  private async settle(): Promise<void> {
    const uids = [...new Set([...this.pending.values()].flatMap(p => (p.task === undefined ? [] : [p.task])))];
    if (uids.length) {
      const done = new Map((await this.meili.done(uids)).map(t => [t.uid, t]));
      for (const [id, p] of this.pending) {
        const task = p.task === undefined ? undefined : done.get(p.task);
        if (!task) continue;
        if (task.status === "succeeded") this.pending.delete(id);
        else this.deps.log(`search: Meilisearch task ${task.uid} ${task.status} (${task.error?.message ?? "no message"}); ${id} stays in memory`);
      }
    }
    for (const [box, tasks] of this.firstTasks) {
      if (this.reads.has(box)) continue;
      const done = tasks.length ? await this.meili.done(tasks) : [];
      for (const task of done) if (task.status !== "succeeded") this.deps.log(`search: Meilisearch did not index ${box}'s rows (task ${task.uid} ${task.status}: ${task.error?.message ?? "no message"})`);
      if (done.length === tasks.length && this.firstTasks.get(box) === tasks) this.firstTasks.delete(box);
    }
  }

  /** Ends the fill once Meilisearch finished every task of it; a failed task leaves search reading memory and says so. */
  private async checkFill(): Promise<void> {
    if (!this.fillTasks) return;
    const done = await this.meili.done(this.fillTasks);
    for (const task of done) if (task.status !== "succeeded") this.deps.log(`search: Meilisearch did not index the first documents (task ${task.uid} ${task.status}: ${task.error?.message ?? "no message"})`);
    if (done.length === this.fillTasks.length && done.every(task => task.status === "succeeded")) {
      this.filling = false;
      this.fillTasks = undefined;
    }
  }

  /**
   * The first `limit` documents that hold every word of `q` and meet `where`, and the exact count of all of them: Meilisearch's for the
   * documents it holds, with the pending ones read here and merged by rank.
   */
  async search(q: string, where: Cond, opts: { sort: "relevance" | "recent"; limit: number }): Promise<EngineAnswer> {
    if (!this.ready) void this.start().catch(() => undefined);
    // This box's rows written since the last read are found at once; other boxes' rows come with their read every `SEND_SPACING_MS`.
    await Promise.all(this.own.filter(source => this.readCursors.has(source.box)).map(source => this.readBox(source)))
      .catch(error => this.deps.log(`search: ${String(error)}`));
    if (this.unsent.size) this.scheduleRefresh();
    // A first fill is waited for, so every answer comes from Meilisearch's matching, typo tolerance included; memory answers only while
    // Meilisearch cannot start, as on a box without its binary.
    if (this.filling) {
      try {
        await this.ready;
        for (const uid of this.fillTasks ?? []) await this.meili.waitTask({ taskUid: uid });
        await this.checkFill();
      } catch {
        // Meilisearch did not open; `start` logged why.
      }
    }
    if (!this.filling) {
      await this.ready;
      // The pending list as it stands is enough for this answer: a document Meilisearch already holds is read from memory once more.
      void this.settle().catch(error => this.deps.log(`search: ${String(error)}`));
    }
    const words = queryWords(q);
    const local = [...this.pending.values()].flatMap(p => (p.doc && holds(where, p.doc) ? [{ doc: p.doc, score: docMatches(p.doc, words) }] : [])).filter(m => m.score > 0);
    local.sort((a, b) => (opts.sort === "recent" ? b.doc.at - a.doc.at : a.doc.tier - b.doc.tier || b.score - a.score || b.doc.at - a.doc.at));
    const fresh = local.map(m => m.doc);
    if (this.filling) return { docs: fresh.slice(0, opts.limit), total: fresh.length };
    const pendingIds = [...this.pending.keys()];
    const answer = await this.meili.search<SearchDoc>(SEARCH_INDEX, {
      q, filter: filterText(pendingIds.length ? and(where, not(isIn("id", pendingIds))) : where), page: 1, hitsPerPage: opts.limit, matchingStrategy: "all",
      ...(opts.sort === "recent" ? { sort: ["at:desc"] } : {}),
    });
    let docs: SearchDoc[];
    if (opts.sort === "recent") docs = [...answer.hits, ...fresh].sort((a, b) => b.at - a.at);
    else {
      docs = [];
      // Meilisearch's hit leads each rank, so a document that is only waiting to be indexed never moves the top hit between two searches.
      for (let rank = 0; rank < Math.max(answer.hits.length, fresh.length); rank++) {
        if (rank < answer.hits.length) docs.push(answer.hits[rank]!);
        if (rank < fresh.length) docs.push(fresh[rank]!);
      }
      docs.sort((a, b) => a.tier - b.tier);
    }
    return { docs: docs.slice(0, opts.limit), total: answer.totalHits + fresh.length };
  }
}
