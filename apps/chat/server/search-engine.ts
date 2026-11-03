/**
 * The one Meilisearch index behind search: this box's thread entries, one document per entry however many threads hold a copy of it, and
 * every room post with its reactions. On us-metal02 on 11-03 it answered every keystroke of "delete" and "vent" with the exact count in
 * 6 to 9 ms against 50 to 1,540 ms for pi-host's FTS5 table (~/work/fast-search/).
 *
 * A change reaches Meilisearch as a task that took 1.5 to 3.1 s to finish on that box. Until its task is done a document sits in
 * `pending`, which search reads in memory and leaves out of the Meilisearch query by id, so a post or entry is found at once and counted once.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { openIndexReadOnly } from "../../../packages/pi-host/src/durable/index-db.ts";
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
};

/** Meilisearch's default http-payload-size-limit is 100 MB, so one request of documents stays under it. */
const PAYLOAD_BYTES = 100_000_000;

/** One row of pi-host's search index. */
export interface EntryRow { thread: string; conversation: number; entryId: number; kind: string; author: string; at: number; text: string }

/** Where entries come from: pi-host's index.sqlite, or a fixture host's threads. `read` answers every row after `cursor` and the next cursor. */
export interface EntrySource { read(cursor: string | undefined): { rows: EntryRow[]; cursor: string } }

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

/** pi-host's index.sqlite on a read-only connection, read by rowid; an index whose rows start over (a rebuild) is read again from its first row. */
export class SqliteEntries implements EntrySource {
  private db?: DatabaseSync;
  constructor(private readonly path: string) {}
  read(cursor: string | undefined): { rows: EntryRow[]; cursor: string } {
    if (!this.db && !existsSync(this.path)) return { rows: [], cursor: cursor ?? "0" };
    this.db ??= openIndexReadOnly(this.path);
    const top = Number((this.db.prepare("SELECT rowid AS top FROM entries ORDER BY rowid DESC LIMIT 1").get() as { top: number } | undefined)?.top ?? 0);
    let after = Number(cursor ?? 0);
    if (top < after) after = 0;
    // The bounds go in as BigInt: node:sqlite binds a number as REAL, and FTS5 then scans every row for the range (226 ms against 0.6 ms on 11-03).
    const rows = (this.db.prepare("SELECT rowid AS id, text, thread, conversation, entry_id, kind, author, at FROM entries WHERE rowid > ? AND rowid <= ? ORDER BY rowid")
      .all(BigInt(after), BigInt(top)) as Record<string, string | number>[]).map(row => ({
      thread: String(row.thread), conversation: Number(row.conversation), entryId: Number(row.entry_id), kind: String(row.kind), author: String(row.author),
      at: Number(row.at), text: String(row.text),
    }));
    return { rows, cursor: String(top) };
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
  entries: EntrySource;
  /** Every post's document, read when search starts. */
  allPosts: () => SearchDoc[];
  /** The entry cursor whose rows Meilisearch has been sent, and its store; undefined means an empty index. */
  cursor: { get(): string | undefined; set(cursor: string): void };
  channelCopy: RegExp;
  log: (line: string) => void;
}

export interface EngineAnswer { docs: SearchDoc[]; total: number }

export class SearchEngine {
  private readonly pending = new Map<string, Pending>();
  private ready?: Promise<void>;
  private sync?: Promise<void>;
  private resync = false;
  private meili!: Meili;
  /** While an empty index fills, every document is in `pending` and search reads only memory until the fill's tasks are done. */
  private filling = false;
  private fillTasks?: number[];
  /** The entry cursor read into memory, ahead of the saved one until `refresh` sends its documents. */
  private readCursor?: string;
  private readonly unsent = new Map<string, SearchDoc>();

  constructor(private readonly deps: EngineDeps) {}

  /**
   * Opens the index. An empty index gets every entry and post, which search reads in memory until Meilisearch has them all; an index
   * that has documents gets the entries after the saved cursor and every post again, so a change made while this server was down is found.
   */
  start(): Promise<void> {
    if (this.ready) return this.ready;
    const fresh = this.deps.cursor.get() === undefined;
    const first = fresh ? this.entryDocs(this.deps.entries.read(undefined)) : undefined;
    this.readCursor = first ? first.cursor : this.deps.cursor.get();
    const posts = this.deps.allPosts();
    if (first) {
      this.filling = true;
      for (const doc of [...first.docs, ...posts]) this.pending.set(doc.id, { doc });
    }
    this.ready = (async () => {
      this.meili = await this.deps.connect();
      const stats = await this.openIndex();
      if (!first) {
        if (stats.numberOfDocuments > 0) return void (await this.putDocs(posts));
        // Meilisearch lost its documents: fill it again.
        this.deps.log("search: the Meilisearch index is empty while a cursor is saved; indexing every entry again");
        const all = this.entryDocs(this.deps.entries.read(undefined));
        this.readCursor = all.cursor;
        this.filling = true;
        for (const doc of [...all.docs, ...posts]) this.pending.set(doc.id, { doc });
        this.fillTasks = await this.putDocs([...all.docs, ...posts]);
        this.deps.cursor.set(all.cursor);
        return;
      }
      // Documents of an older shape go before the index fills again.
      if (stats.numberOfDocuments > 0) await this.meili.waitTask(await this.meili.call("DELETE", `/indexes/${SEARCH_INDEX}/documents`));
      this.fillTasks = await this.putDocs([...first.docs, ...posts]);
      this.deps.cursor.set(first.cursor);
    })();
    this.ready.catch(error => {
      this.ready = undefined;
      this.deps.log(`search: Meilisearch did not open (${String(error)})`);
    });
    return this.ready;
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

  /** Reads the entries pi-host added since the last read into `pending`, where search finds them at once; `refresh` sends them. */
  private readNew(): void {
    if (this.readCursor === undefined && !this.ready) return;
    const read = this.entryDocs(this.deps.entries.read(this.readCursor));
    this.readCursor = read.cursor;
    for (const doc of read.docs) {
      const held = this.pending.get(doc.id)?.doc;
      const merged = held?.source === "entry" ? mergeCopies(held, doc) : doc;
      this.pending.set(doc.id, { doc: merged });
      this.unsent.set(doc.id, merged);
    }
  }

  /** Sends what `readNew` read to the index and saves the cursor; a call while one runs runs once more after it. */
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
          this.readNew();
          const cursor = this.readCursor!;
          const docs = [...this.unsent.values()];
          this.unsent.clear();
          if (docs.length) await this.putDocs(docs);
          if (cursor !== this.deps.cursor.get()) this.deps.cursor.set(cursor);
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

  /** Waits until Meilisearch holds every document search has sent it; a test reads the index itself after it. */
  async settled(): Promise<void> {
    await this.refresh();
    for (const uid of this.fillTasks ?? []) await this.meili.waitTask({ taskUid: uid });
    await this.checkFill();
    while (this.pending.size) {
      const uids = [...new Set([...this.pending.values()].flatMap(p => (p.task === undefined ? [] : [p.task])))];
      for (const uid of uids) await this.meili.waitTask({ taskUid: uid });
      await this.settle();
      if (!uids.length) await new Promise(resolve => setImmediate(resolve));
    }
  }

  /** Entry rows as documents, merged with the copies already sent: a copy in another thread adds its thread to the entry's one document. */
  private entryDocs(read: { rows: EntryRow[]; cursor: string }): { docs: EntryDoc[]; cursor: string; known?: true } {
    const groups = new Map<string, EntryRow[]>();
    for (const row of read.rows) {
      const id = entryDocId(row);
      groups.set(id, [...(groups.get(id) ?? []), row]);
    }
    const docs = [...groups].map(([id, copies]) => {
      const first = copies[0]!;
      return {
        id, source: "entry", text: first.text, at: first.at, tier: first.kind === "pi.tool-result" ? 1 : 0, kind: first.kind, author: first.author, entry: first.entryId,
        threads: [...new Set(copies.map(c => c.thread))], convs: [...new Set(copies.map(c => `${c.thread}:${c.conversation}`))],
        keys: [...new Set(copies.map(c => `${c.thread}:${c.entryId}`))],
        channelCopy: first.kind === "agent.message" && this.deps.channelCopy.test(first.text),
      } satisfies EntryDoc;
    });
    return { docs, cursor: read.cursor };
  }

  /** Puts documents in `pending` and sends them; an entry merges the threads of the copy Meilisearch or `pending` already holds. */
  private async putDocs(docs: SearchDoc[]): Promise<number[]> {
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
    for (const doc of merged) this.pending.set(doc.id, { doc });
    const tasks: number[] = [];
    for (let at = 0; at < merged.length;) {
      // The array's brackets and one comma per document count toward the limit too.
      let bytes = 2;
      const batch: SearchDoc[] = [];
      while (at < merged.length) {
        const size = Buffer.byteLength(JSON.stringify(merged[at])) + 1;
        if (batch.length && bytes + size > PAYLOAD_BYTES) break;
        bytes += size;
        batch.push(merged[at++]!);
      }
      const { taskUid } = await this.meili.put(SEARCH_INDEX, batch);
      for (const doc of batch) if (this.pending.get(doc.id)?.doc === doc) this.pending.set(doc.id, { doc, task: taskUid });
      tasks.push(taskUid);
    }
    return tasks;
  }

  private async deleteDocs(ids: string[]): Promise<void> {
    const { taskUid } = await this.meili.deleteIds(SEARCH_INDEX, ids);
    for (const id of ids) if (this.pending.get(id)?.doc === null) this.pending.set(id, { doc: null, task: taskUid });
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
    this.readNew();
    void this.refresh().catch(error => this.deps.log(`search: ${String(error)}`));
    if (this.filling) await this.checkFill().catch(() => undefined);
    if (!this.filling) {
      await this.ready;
      await this.settle();
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
      for (let rank = 0; rank < Math.max(answer.hits.length, fresh.length); rank++) {
        if (rank < fresh.length) docs.push(fresh[rank]!);
        if (rank < answer.hits.length) docs.push(answer.hits[rank]!);
      }
      docs.sort((a, b) => a.tier - b.tier);
    }
    return { docs: docs.slice(0, opts.limit), total: answer.totalHits + fresh.length };
  }
}
