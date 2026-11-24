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
import { Meili, MeiliError, type MeiliTask } from "./meili.ts";
import { indexedAuthor, SYSTEM_AUTHOR } from "./search-snippet.ts";

export const SEARCH_INDEX = "search";
/** The documents' shape; a saved cursor of another version fills the index again. */
export const SEARCH_DOC_VERSION = 1;

/** `sort` comes first so a `recent` search is newest first; tool output (tier 1) ranks after every message by relevance. */
export const SEARCH_SETTINGS = {
  searchableAttributes: ["text", "reactions"],
  filterableAttributes: ["id", "source", "kind", "author", "at", "tier", "threads", "convs", "keys", "channelCopy", "hidden", "room", "dm", "listed", "ownerPost", "has"],
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

/**
 * Meilisearch keeps every finished task until it holds a million of them, about 6.9 KB each in its task file. On 11-24 it held 80,885 tasks
 * and its task file had grown to 4.38 GB, with 2.4 GB of it in the process's memory after a read of them. A day of tasks is kept, which
 * ~/work/meili-memory/summary.md read to count the documents each start sent; 13,493 tasks on 11-23, the busiest day, are about 93 MB.
 */
const TASK_KEEP_MS = 24 * 60 * 60 * 1000;
/** How often the tasks older than `TASK_KEEP_MS` go, so the task file holds at most an hour more than a day of them. */
const TASK_SWEEP_MS = 60 * 60 * 1000;

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
  /**
   * A copy sits in a thread search leaves out (`SearchEngine.hiddenThreads`): a comm thread or a walk's test agent's thread. A document
   * Meilisearch got before 11-22 has no such field and reads as false until `flagHidden` marks it.
   */
  hidden?: boolean;
}
export interface PostDoc {
  id: string; source: "post"; text: string; reactions: string; at: number; tier: 0; author: string; room: string; post: string;
  /** A DM post; `listed` is false for a DM post search leaves out (rooms.ts `searchListed`); `ownerPost` is the owner's and no test send. */
  dm: boolean; listed: boolean; ownerPost: boolean;
  /**
   * `room.reply` for a reply in a thread (`RoomPost.threadRoot`), `room.post` for a top-level post (search.ts `POST_KINDS`). A start sends
   * each post whose `sum` Meilisearch does not hold, so a post Meilisearch holds without it gains it then, and `pending` answers for it meanwhile.
   */
  kind: "room.post" | "room.reply";
  /** The marks `has` filters on (search.ts `parseHas`). A start sends a post indexed without them again, since its `sum` differs. */
  has: PostHas[];
  /**
   * `postSum` of the rest of the document, set as it is sent, so a start sends only the posts that changed since Meilisearch got them. Until
   * 11-24 every start sent all 7,441 posts, and the 121 searches of that day that came before Meilisearch had indexed them all took 138 ms at
   * the median, with every post in `pending` and a 280 KB filter, against 20 ms for the other 342 (~/work/p279-search/p279-meili.md).
   */
  sum?: string;
}
/** A post's marks: it holds a link, it has a reaction, or the owner pinned it. */
export type PostHas = "link" | "reaction" | "pin";
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

/** `SearchEngine.hiddenThreads` as a set, with the `hiddenFilter` answer for the `flagged` changes it was built at. */
type HiddenKept = { threads: readonly string[]; set: ReadonlySet<string>; filter?: { flags: number; conds: Cond[]; unflagged: boolean } };

/** One entry's document with the threads of both: a copy in another thread adds its thread. */
function mergeCopies(was: Pick<EntryDoc, "threads" | "convs" | "keys" | "hidden">, doc: EntryDoc): EntryDoc {
  const union = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])];
  return { ...doc, threads: union(was.threads, doc.threads), convs: union(was.convs, doc.convs), keys: union(was.keys, doc.keys), hidden: !!(was.hidden || doc.hidden) };
}

/** A post document's content as a short hash, `sum` left out, which tells a start whether Meilisearch holds the post as it is now. */
export function postSum(doc: PostDoc): string {
  const { sum: _sum, ...rest } = doc;
  return createHash("sha1").update(JSON.stringify(rest)).digest("base64url").slice(0, 16);
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

/** `since` is the time the next pages of a relevance search pass back, when its first page drew documents Meilisearch did not hold yet. */
export interface EngineAnswer { docs: SearchDoc[]; total: number; since?: number }

/** Where one search's handler time went, in ms by part, with the pending count and filter size, for its request log line (request-log.ts `split`). */
export type SearchSplit = Record<string, number>;

export class SearchEngine {
  private readonly pending = new Map<string, Pending>();
  /** The pending documents Meilisearch was seen to hold a copy of, which a relevance search's first page takes as its guess of the cut. */
  private readonly inIndex = new Set<string>();
  private ready?: Promise<void>;
  private sync?: Promise<void>;
  private resync = false;
  private sendTimer?: ReturnType<typeof setTimeout>;
  private pullTimer?: ReturnType<typeof setInterval>;
  private sweepTimer?: ReturnType<typeof setInterval>;
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
  /**
   * The threads whose entries search leaves out unless it is scoped to one: every comm thread and every thread of a walk's test agent. Set
   * by the app. On 11-22 they were 1,012 of them, 41 KB of filter text that took Meilisearch 27 ms at the median against 11 ms without
   * it, so each entry carries `hidden` and the filter names only the threads `flagHidden` has not marked yet.
   */
  hiddenThreads: () => readonly string[] = () => [];
  /** The hidden threads whose every document in Meilisearch has `hidden` set; empty at each start until `flagHidden` checked them. */
  private readonly flagged = new Set<string>();
  /** Counts the changes to `flagged`, which `hiddenFilter`'s kept answer reads. */
  private flags = 0;
  /** `hiddenThreads` as a set, and `hiddenFilter`'s answer for it and `flags`, kept until the app hands another list or `flagged` changes. */
  private hidden?: HiddenKept;
  private flagging?: Promise<void>;
  /** The newest task a send got, and the sends still on their way, so `flagHidden` reads the index only after every earlier send. */
  private lastTask?: number;
  private readonly sending = new Set<Promise<unknown>>();

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
   * an index that has documents gets the entries after the saved cursors and every post that changed since Meilisearch got it
   * (`changedPosts`), so a change made while this server was down is found. Every other box is read after it, and again every `SEND_SPACING_MS`.
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
        if (stats.numberOfDocuments > 0) {
          await this.putDocs(await this.changedPosts(posts));
          void this.markSystemInputs().catch(error => this.deps.log(`search: ${String(error)}`));
        } else {
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
      void this.sweepTasks();
      this.sweepTimer = setInterval(() => void this.sweepTasks(), TASK_SWEEP_MS);
      this.sweepTimer.unref?.();
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
    clearInterval(this.sweepTimer);
    clearTimeout(this.sendTimer);
  }

  /**
   * Deletes the tasks that finished more than `TASK_KEEP_MS` before `now`. Search waits only on tasks it sent seconds ago, so none of them
   * goes. A deletion is a task that holds up indexing while it runs (15.5 s for 64,414 tasks on 11-24), so none is sent when no task is old enough.
   */
  private async sweepTasks(now = Date.now()): Promise<void> {
    const old = `statuses=succeeded,failed,canceled&beforeFinishedAt=${new Date(now - TASK_KEEP_MS).toISOString()}`;
    try {
      const { total } = await this.meili.call<{ total: number }>("GET", `/tasks?${old}&limit=0`);
      if (total) await this.meili.waitTask(await this.meili.call<MeiliTask>("DELETE", `/tasks?${old}`));
    } catch (error) {
      this.deps.log(`search: deleting Meilisearch's finished tasks failed (${String(error)})`);
    }
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

  /** The posts whose `postSum` Meilisearch does not hold: new posts, changed ones, and those it got before posts carried a sum. */
  private async changedPosts(posts: SearchDoc[]): Promise<SearchDoc[]> {
    const held = new Map<string, string | undefined>();
    const PAGE = 5_000;
    for (let offset = 0; ; offset += PAGE) {
      const page = await this.meili.call<{ results: Pick<PostDoc, "id" | "sum">[] }>("POST", `/indexes/${SEARCH_INDEX}/documents/fetch`, { filter: `source = "post"`, fields: ["id", "sum"], limit: PAGE, offset });
      for (const doc of page.results) held.set(doc.id, doc.sum);
      if (page.results.length < PAGE) break;
    }
    return posts.filter(post => post.source !== "post" || held.get(post.id) !== postSum(post));
  }

  /**
   * Gives the entries indexed before 11-20 under the owner whose text is a turn the chat or Prime wrote for him, such as a duty push, the
   * author `system`, as `entryDocs` does for new rows. It reads only the owner's inputs, 1,926 documents and 418 KB in 57 ms on us-metal02
   * on 11-20, of which 413 were such turns, and sends nothing once none is left, so it runs at every start in place of a refill.
   */
  private async markSystemInputs(): Promise<void> {
    const filter = `source = "entry" AND author = "owner" AND kind IN ["pi.user", "agent.message"]`;
    const updates: { id: string; author: string }[] = [];
    const PAGE = 5_000;
    for (let offset = 0; ; offset += PAGE) {
      const page = await this.meili.call<{ results: Pick<EntryDoc, "id" | "kind" | "text">[] }>("POST", `/indexes/${SEARCH_INDEX}/documents/fetch`, { filter, fields: ["id", "kind", "text"], limit: PAGE, offset });
      for (const doc of page.results) if (indexedAuthor(doc.kind, "owner", doc.text) === SYSTEM_AUTHOR) updates.push({ id: doc.id, author: SYSTEM_AUTHOR });
      if (page.results.length < PAGE) break;
    }
    if (!updates.length) return;
    this.deps.log(`search: ${updates.length} turns the chat wrote as the owner's are now indexed under ${SYSTEM_AUTHOR}`);
    await this.meili.waitTask(await this.meili.call<MeiliTask>("PUT", `/indexes/${SEARCH_INDEX}/documents`, updates));
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
          // A send Meilisearch refused, as while it restarts, goes again with the next refresh; until then search reads the documents in memory.
          if (docs.length) await this.putDocs(docs).catch((error: unknown) => {
            for (const doc of docs) if (!this.unsent.has(doc.id)) this.unsent.set(doc.id, doc);
            throw error;
          });
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
    if (!doc) this.inIndex.delete(id);
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
    const hidden = this.hiddenKept().set;
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
        id, source: "entry", text: first.text, at: first.at, tier: first.kind === "pi.tool-result" ? 1 : 0, kind: first.kind, author: indexedAuthor(first.kind, first.author, first.text), entry: first.entryId,
        threads: [...new Set(copies.map(c => c.thread))], convs: [...new Set(copies.map(c => `${c.thread}:${c.conversation}`))],
        keys: [...new Set(copies.map(c => `${c.thread}:${c.entryId}`))],
        channelCopy: first.kind === "agent.message" && this.deps.channelCopy.test(first.text),
        hidden: copies.some(c => hidden.has(c.thread)),
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
    const copies: string[] = [];
    if (lookup.length && !this.filling) {
      for (const doc of await this.meili.fetch<EntryDoc>(SEARCH_INDEX, lookup, ["id", "threads", "convs", "keys"])) {
        known.set(doc.id, doc);
        copies.push(doc.id);
      }
    }
    const hidden = this.hiddenKept().set;
    const merged = docs.map(doc => {
      const was = doc.source === "entry" ? known.get(doc.id) : undefined;
      const one = was && doc.source === "entry" ? mergeCopies(was, doc) : doc;
      if (one.source === "entry") one.hidden = one.threads.some(thread => hidden.has(thread));
      else one.sum = postSum(one);
      return one;
    });
    // A document `pending` holds already stays there in its merged form, so memory never shows an older copy than Meilisearch.
    for (const doc of merged) if (opts.hold || this.pending.has(doc.id)) this.pending.set(doc.id, { doc });
    for (const id of copies) if (this.pending.has(id)) this.inIndex.add(id);
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
      const { taskUid } = await this.sent(this.meili.put(SEARCH_INDEX, `[${parts.join(",")}]`));
      for (const doc of batch) if (this.pending.get(doc.id)?.doc === doc) this.pending.set(doc.id, { doc, task: taskUid });
      tasks.push(taskUid);
    }
    this.drain();
    return tasks;
  }

  /** A send to Meilisearch, kept until it answered, with its task as the newest. */
  private async sent<T extends { taskUid: number }>(send: Promise<T>): Promise<T> {
    this.sending.add(send);
    try {
      const task = await send;
      this.lastTask = Math.max(this.lastTask ?? 0, task.taskUid);
      return task;
    } finally {
      this.sending.delete(send);
    }
  }

  /**
   * The conditions that leave the hidden threads' entries out of an unscoped search: `hidden` for the threads `flagHidden` marked, and the
   * ids of the rest. A thread that stopped being hidden since it was marked puts every hidden thread's id back in the filter until
   * `flagHidden` clears its documents, so the answer and its count stay exact (c191) at each step.
   */
  hiddenFilter(): Cond[] {
    const kept = this.hiddenKept();
    if (kept.filter?.flags !== this.flags) {
      const hidden = kept.set;
      const fresh = [...hidden].filter(thread => !this.flagged.has(thread));
      const gone = [...this.flagged].some(thread => !hidden.has(thread));
      const conds = !hidden.size ? [] : gone ? [not(isIn("threads", [...hidden]))] : [not(eq("hidden", true)), ...(fresh.length ? [not(isIn("threads", fresh))] : [])];
      kept.filter = { flags: this.flags, conds, unflagged: !!(fresh.length || gone) };
    }
    if (kept.filter.unflagged) void this.flagHidden();
    return kept.filter.conds;
  }

  private hiddenKept(): HiddenKept {
    const threads = this.hiddenThreads();
    if (this.hidden?.threads !== threads) this.hidden = { threads, set: new Set(threads) };
    return this.hidden;
  }

  /**
   * Gives `hidden` to every document Meilisearch holds of a thread that became hidden, and takes it off the documents of a thread that no
   * longer is, unless another of their threads is. It reads the index only after every earlier send has landed, so no document sent before
   * the thread became hidden is missed; a document sent since carries `hidden` from `putDocs`.
   */
  flagHidden(): Promise<void> {
    return (this.flagging ??= (async () => {
      if (!this.ready) return;
      await this.ready;
      if (this.filling) return;
      await Promise.all(this.sending);
      if (this.lastTask !== undefined) await this.meili.waitTask({ taskUid: this.lastTask });
      const hidden = this.hiddenKept().set;
      const BATCH = 200;
      const PAGE = 5_000;
      const mark = async (threads: string[], filter: string, flag: (doc: Pick<EntryDoc, "id" | "threads">) => boolean | undefined) => {
        for (let at = 0; at < threads.length; at += BATCH) {
          const batch = threads.slice(at, at + BATCH);
          const updates: { id: string; hidden: boolean }[] = [];
          const where = `${filter} AND ${filterText(isIn("threads", batch))}`;
          for (let offset = 0; ; offset += PAGE) {
            const page = await this.meili.call<{ results: Pick<EntryDoc, "id" | "threads">[] }>("POST", `/indexes/${SEARCH_INDEX}/documents/fetch`, { filter: where, fields: ["id", "threads"], limit: PAGE, offset });
            for (const doc of page.results) {
              const value = flag(doc);
              if (value !== undefined) updates.push({ id: doc.id, hidden: value });
            }
            if (page.results.length < PAGE) break;
          }
          if (updates.length) await this.meili.waitTask(await this.sent(this.meili.call<MeiliTask>("PUT", `/indexes/${SEARCH_INDEX}/documents`, updates)));
          for (const thread of batch) {
            if (hidden.has(thread)) this.flagged.add(thread);
            else this.flagged.delete(thread);
          }
          this.flags += 1;
        }
      };
      await mark([...this.flagged].filter(thread => !hidden.has(thread)), `source = "entry" AND hidden = true`, doc => (doc.threads.some(thread => hidden.has(thread)) ? undefined : false));
      await mark([...hidden].filter(thread => !this.flagged.has(thread)), `source = "entry" AND NOT hidden = true`, () => true);
      // Memory holds documents built before their thread became hidden; they change in place, so a send in flight keeps its task.
      for (const p of this.pending.values()) {
        if (p.doc?.source === "entry") p.doc.hidden = p.doc.threads.some(thread => hidden.has(thread));
      }
    })().catch(error => this.deps.log(`search: ${String(error)}`)).finally(() => {
      this.flagging = undefined;
    }));
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
        if (task.status === "succeeded") {
          this.pending.delete(id);
          this.inIndex.delete(id);
        }
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
   * documents it holds, with the pending ones read here and merged by rank. A relevance search's first page leaves `since` out and answers
   * the one its next pages pass back, so every page ranks the same documents in the same order however many of them Meilisearch indexed
   * between two pages; `null` ranks every document by Meilisearch's order.
   */
  async search(q: string, where: Cond, opts: { sort: "relevance" | "recent"; limit: number; since?: number | null }, split?: SearchSplit): Promise<EngineAnswer> {
    let mark = performance.now();
    const took = (part: string) => {
      const now = performance.now();
      if (split) split[part] = (split[part] ?? 0) + now - mark;
      mark = now;
    };
    if (!this.ready) void this.start().catch(() => undefined);
    // This box's rows written since the last read are found at once; other boxes' rows come with their read every `SEND_SPACING_MS`.
    await Promise.all(this.own.filter(source => this.readCursors.has(source.box)).map(source => this.readBox(source)))
      .catch(error => this.deps.log(`search: ${String(error)}`));
    took("read");
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
    took("ready");
    const words = queryWords(q);
    const local = [...this.pending.values()].flatMap(p => (p.doc && holds(where, p.doc) ? [{ doc: p.doc, score: words.length ? docMatches(p.doc, words) : 1 }] : [])).filter(m => m.score > 0);
    local.sort((a, b) => (opts.sort === "recent" ? b.doc.at - a.doc.at : a.doc.tier - b.doc.tier || b.score - a.score || b.doc.at - a.doc.at));
    const fresh = local.map(m => m.doc);
    if (this.filling) return { docs: fresh.slice(0, opts.limit), total: fresh.length };
    const pendingIds = [...this.pending.keys()];
    const noteFilter = (filter: string) => {
      if (split) {
        split.pending = pendingIds.length;
        split.filterKb = Math.round(filter.length / 102.4) / 10;
      }
      took("local");
    };
    const ask = (filter: string, hitsPerPage: number, sort?: string[], attributesToRetrieve?: string[]) =>
      this.meili.search<SearchDoc>(SEARCH_INDEX, { q, filter, page: 1, hitsPerPage, matchingStrategy: "all", ...(sort ? { sort } : {}), ...(attributesToRetrieve ? { attributesToRetrieve } : {}) });
    if (opts.sort === "recent") {
      const filter = filterText(pendingIds.length ? and(where, not(isIn("id", pendingIds))) : where);
      noteFilter(filter);
      const answer = await ask(filter, opts.limit, ["at:desc"]);
      took("meili");
      return { docs: [...answer.hits, ...fresh].sort((a, b) => b.at - a.at).slice(0, opts.limit), total: answer.totalHits + fresh.length };
    }
    // A page's order cannot hang on which hits Meilisearch holds yet: the next page, read once it held them, found them at its own ranks
    // and listed 4 hits twice and 4 never (search-page.spec.ts, 11-23). So the documents written since `since`, the oldest one Meilisearch
    // did not hold at the first page, rank by the engine's own rule wherever they sit, and the older ones by Meilisearch's.
    const ids = fresh.map(doc => doc.id);
    const freshIds = new Set(ids);
    const cutBy = (inIndex: (id: string) => boolean): number | null =>
      opts.since !== undefined ? opts.since : fresh.reduce<number | null>((oldest, doc) => (inIndex(doc.id) || (oldest !== null && oldest <= doc.at) ? oldest : doc.at), null);
    // A pending document that no longer matches leaves Meilisearch's answer now, as it will once indexed. A matching pending document whose
    // copy in Meilisearch no longer matches is out of that answer already, so only the pending documents that match nowhere are named.
    const elsewhere = pendingIds.filter(id => !freshIds.has(id));
    const filterAt = (cut: number | null) => filterText(and(where, ...(cut === null ? [] : [{ op: "lt", field: "at", value: cut } as Cond]), ...(elsewhere.length ? [not(isIn("id", elsewhere))] : [])));
    const answers = (cut: number | null) => {
      const newerFilter = cut === null ? undefined : filterText(and(where, { op: "gte", field: "at", value: cut }, ...(pendingIds.length ? [not(isIn("id", pendingIds))] : [])));
      return Promise.all([
        ask(filterAt(cut), opts.limit).then(found => ({ ...found, hits: found.hits.map(doc => this.pending.get(doc.id)?.doc ?? doc) })),
        newerFilter === undefined ? undefined : ask(newerFilter, opts.limit).then(first => (first.totalHits > first.hits.length ? ask(newerFilter, first.totalHits) : first)),
      ]);
    };
    // Which fresh documents Meilisearch holds is asked beside the answer, which goes with the cut the documents it was seen to hold give.
    // Asked before it, that round trip took p50 10.7 ms and up to 189 ms of the 54 searches that had one in 11-23 21:50Z to 11-24 07:00Z.
    // A guess the held answer proves wrong, such as a post edited since the server started, asks again with the right cut.
    const guess = cutBy(id => this.inIndex.has(id));
    noteFilter(filterAt(guess));
    const first = answers(guess);
    first.catch(() => undefined);
    const [held, matched] = ids.length
      ? await Promise.all([
        this.meili.fetch<{ id: string }>(SEARCH_INDEX, ids, ["id"]).then(docs => new Set(docs.map(doc => doc.id))),
        ask(filterText(and(where, isIn("id", ids))), ids.length, undefined, ["id"]).then(answer => new Set(answer.hits.map(doc => doc.id))),
      ])
      : [new Set<string>(), new Set<string>()];
    took("held");
    for (const id of held) if (this.pending.has(id)) this.inIndex.add(id);
    const cut = cutBy(id => held.has(id));
    // A pending document whose copy in Meilisearch matches keeps that copy's rank and shows its own text, and one that matches only now,
    // such as a post just reacted to under has:reaction, ranks by the engine's rule.
    const own = fresh.filter(doc => !matched.has(doc.id) || (cut !== null && doc.at >= cut));
    const [answer, newer] = await (cut === guess ? first : answers(cut));
    took("meili");
    const recent = [...(newer?.hits ?? []), ...own]
      .map(doc => ({ doc, score: words.length ? docMatches(doc, words) : 1 }))
      .sort((a, b) => a.doc.tier - b.doc.tier || b.score - a.score || b.doc.at - a.doc.at || (a.doc.id < b.doc.id ? -1 : a.doc.id > b.doc.id ? 1 : 0))
      .map(m => m.doc);
    const docs: SearchDoc[] = [];
    // Meilisearch's hit leads each rank, so a document that is only waiting to be indexed never moves the top hit between two searches.
    for (let rank = 0; rank < Math.max(answer.hits.length, recent.length); rank++) {
      if (rank < answer.hits.length) docs.push(answer.hits[rank]!);
      if (rank < recent.length) docs.push(recent[rank]!);
    }
    docs.sort((a, b) => a.tier - b.tier);
    return { docs: docs.slice(0, opts.limit), total: answer.totalHits + recent.length, ...(cut === null ? {} : { since: cut }) };
  }
}
