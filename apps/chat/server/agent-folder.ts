/**
 * An agent's folder (apps/chat/docs/agent-model.md, phase 3): `<agents dir>/<slug>/` with `brief.md`, the agent's responsibility in the
 * owner's words, and `harness/harness_state.json`, the agent's memory as a Prime harness store. pi-host loads both into every thread of the
 * agent: the brief as one more Prime context file, and the store as the local half of Prime's harness digest, which the thread's kernel
 * also writes through `rlm.harness`. A thread finds its agent's folder in the `agent.ref` doc of its root conversation, which `agents.ts`
 * writes.
 *
 * Harness writes follow Prime's Python writer (`_slug`, `_upsert`, `create`, `update`, `delete` of pi-rlm's vendored `harness.py`) and save
 * through pi-harness's `updateState`, which holds `<file>.lock` as the kernel's writer does, reads the file again under it, changes one
 * entry and replaces the file, so a kernel and this server never write over each other's change. A store on another box is read and
 * written whole through that box's relay, which takes no lock.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentFolder, AgentId, ConfigFile, HarnessEntryView, MemoryInput } from "../web/src/lib/api/types.ts";
import { folderContextFiles } from "../../../packages/pi-host/src/durable/context-files.ts";
import { memoryDbPath, memoryRequest, memoryTerms, type MemoryAnswer, type MemoryRequest } from "../../../packages/pi-harness/src/core/memory-store.ts";
import { migrateMemory, parseState, updateState, type HarnessEntry, type HarnessState } from "../../../packages/pi-harness/src/core/store.ts";
import type { AgentRecord, RoomId } from "./agent-store.ts";

const PREVIEW_CAP = 400;

/** The chat.doc in a thread's root conversation that names the thread's agent and folder; pi-host reads it to load the brief and memory. */
export const AGENT_REF_DOC = "agent.ref";

/**
 * `agent.ref`: the agent, its folder, and the thread's role (phase 4). The work thread names a comm thread once it has one, its DM's or
 * else its first room's, a root job filed under the agent is a job, and a comm thread names its room and the work thread it hands tasks to.
 * pi-host parses the same JSON and reads any other shape as no agent. `test` marks a walk's throwaway agent, whose refine pi-host keeps out of
 * shared skills and rules.
 */
export type AgentRef = (
  | { agent: AgentId; dir: string; role: "work"; comm?: string }
  | { agent: AgentId; dir: string; role: "job" }
  | { agent: AgentId; dir: string; role: "comm"; room: RoomId; work: string }
) & { test?: true };

const REF_KEYS = ["agent", "dir", "role", "comm", "room", "work", "test"] as const;

/** Whether a doc value is this ref, field by field, so key order does not count. */
export const sameRef = (a: unknown, b: AgentRef): boolean => {
  if (!a || typeof a !== "object") return false;
  const have = a as Record<string, unknown>;
  const want = b as Record<string, unknown>;
  return REF_KEYS.every(key => have[key] === want[key]);
};

export type HarnessKind = HarnessEntryView["kind"];
/** Prime's `_KINDS`, in the order its `save` writes them. */
export const HARNESS_KINDS: readonly HarnessKind[] = ["prompt", "memory", "skill", "subagent"];

/** A write on an entry id the store already holds; HTTP 409. */
export class EntryExists extends Error {}
/** An update or delete of an entry the store lacks; HTTP 404. */
export class EntryMissing extends Error {}

/** A file the config names: where it is, whether it is there, and its first lines. */
export function fileInfo(label: string, path: string, opts: { preview?: boolean; loaded?: boolean; note?: string } = {}): ConfigFile {
  let stat: ReturnType<typeof statSync> | undefined;
  try {
    stat = statSync(path);
  } catch {
    stat = undefined;
  }
  const out: ConfigFile = { label, path, exists: !!stat, size: stat?.isFile() ? stat.size : null, modifiedAt: stat ? stat.mtimeMs : null };
  if (opts.preview && stat?.isFile()) {
    try {
      const head = readFileSync(path, "utf8").slice(0, 4000).split("\n").filter(line => line.trim()).slice(0, 6).join("\n");
      out.preview = head.length > PREVIEW_CAP ? `${head.slice(0, PREVIEW_CAP - 1)}…` : head;
    } catch {
      // A file that cannot be read keeps its size and no preview.
    }
  }
  if (opts.loaded !== undefined) out.loaded = opts.loaded;
  if (opts.note) out.note = opts.note;
  return out;
}

/**
 * The context files a pi thread loads for `cwd` on this box, nearest folder first, then the agent dir's global ones. Each folder gives
 * its AGENTS.md and then its CLAUDE.md, less one whose text the other holds (`folderContextFiles`, which pi-host's prompt uses too), so
 * a file is listed as not loaded only when the file beside it already says everything in it. For an agent on another box, that box's
 * agent relay runs this function (its `instructions` op).
 */
export function instructionFiles(cwd: string, agentDir: string): ConfigFile[] {
  const out: ConfigFile[] = [];
  const listFolder = (dir: string, label: (name: string) => string): void => {
    const loaded = new Set(folderContextFiles(dir).map(file => basename(file.path)));
    const names = ["AGENTS.md", "CLAUDE.md"].filter(name => existsSync(join(dir, name)));
    for (const name of names) {
      const other = names.find(n => n !== name);
      const note = !loaded.has(name) && other ? { note: `pi-host leaves it out, because the ${other} beside it already holds its text.` } : {};
      out.push(fileInfo(label(name), join(dir, name), { preview: true, loaded: loaded.has(name), ...note }));
    }
  };
  let dir = resolve(cwd || "/");
  for (;;) {
    const where = dir === resolve(cwd) ? "in its cwd" : "above its cwd";
    listFolder(dir, name => `${name} ${where}`);
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  listFolder(agentDir, name => `Prime's global ${name}`);
  return out;
}

/** The agent's folder on its host. */
export const agentFolderDir = (agentsDir: string, record: AgentRecord): string => join(agentsDir, record.slug);
const briefPath = (dir: string): string => join(dir, "brief.md");
/** pi-host's `WORKING_MEMORY_FILE`: what the agent knows now across rooms, which its work thread rewrites after each turn. */
const workingPath = (dir: string): string => join(dir, "working-memory.md");
/** Prime's `getHarnessStatePath(getLocalHarnessStateDir(<agent folder>))`. */
export const harnessPath = (dir: string): string => join(dir, "harness", "harness_state.json");

/**
 * The `agent.ref` value for the agent's work thread, which names a comm thread once the agent has one, its DM's or else its first room's,
 * or for a root job filed under it. An agent that talks only in channels still gets the work role, so its work thread has no tell_owner.
 */
export function agentRef(agentsDir: string, record: AgentRecord, role: "work" | "job"): AgentRef {
  const base = { agent: record.id, dir: agentFolderDir(agentsDir, record), ...(record.test ? { test: true as const } : {}) };
  const comm = record.comm?.[record.room] ?? Object.values(record.comm ?? {})[0];
  return role === "job" ? { ...base, role } : { ...base, role, ...(comm ? { comm } : {}) };
}

/** The `agent.ref` value for the agent's comm thread in `room`. */
export const commRef = (agentsDir: string, record: AgentRecord, room: RoomId): AgentRef =>
  ({ agent: record.id, dir: agentFolderDir(agentsDir, record), role: "comm", room, work: record.workThread, ...(record.test ? { test: true as const } : {}) });

/** Prime's `_slug`: lowercase letters and digits of any script, every other character to `_`, runs collapsed, at most 80 characters. */
export function harnessSlug(raw: string, fallback: string): string {
  const normalized = [...raw.trim()].map(ch => (/^[\p{L}\p{N}]$/u.test(ch) ? ch.toLowerCase() : "_")).join("");
  const joined = normalized.split("_").filter(Boolean).join("_");
  return [...(joined || fallback)].slice(0, 80).join("");
}

/** Prime's `_now`: `datetime.now(timezone.utc).isoformat()`, which has microseconds and a `+00:00` offset. */
export const harnessNow = (now = new Date()): string => now.toISOString().replace("Z", "000+00:00");

type RawEntry = Record<string, unknown>;
interface StoreFile { schema: number; entries: Record<HarnessKind, Record<string, RawEntry>>; refinements: unknown[] }

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** The store as on disk, other entries kept as they are; a missing, unreadable or non-object file reads as empty, as Prime's `load` does. */
function readStore(path: string): StoreFile {
  let text: string | undefined;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = undefined;
  }
  return parseStore(text);
}

/** The store from its file's text, as `readStore` reads it. */
function parseStore(text: string | undefined): StoreFile {
  let raw: Record<string, unknown> | undefined;
  try {
    raw = text === undefined ? undefined : record(JSON.parse(text));
  } catch {
    raw = undefined;
  }
  const entries = Object.fromEntries(HARNESS_KINDS.map(kind => {
    const kept = record(record(raw?.entries)?.[kind]) ?? {};
    return [kind, Object.fromEntries(Object.entries(kept).flatMap(([id, entry]) => (record(entry) ? [[id, record(entry)!]] : [])))];
  })) as StoreFile["entries"];
  return { schema: 1, entries, refinements: Array.isArray(raw?.refinements) ? raw.refinements : [] };
}

/** A store's text as pi-harness's `readState` reads the file: text that is missing or no JSON reads as an empty store. */
function stateOf(text: string | undefined): HarnessState {
  try {
    return parseState(text === undefined ? undefined : JSON.parse(text), "local");
  } catch {
    return parseState(undefined, "local");
  }
}

/** pi-harness's `writeState` text, for a store on another box. */
const stateText = (state: HarnessState): string => JSON.stringify(state, null, 2) + "\n";

/** One stored entry as the page sees it, or undefined for one Prime's digest would skip (a title or content that is not a string). */
function entryView(kind: HarnessKind, id: string, raw: RawEntry): HarnessEntryView | undefined {
  if (typeof raw.title !== "string" || typeof raw.content !== "string") return undefined;
  const text = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);
  const path = typeof raw.path === "string" ? raw.path : text(raw.topic, "general");
  return {
    id, kind, title: raw.title, content: raw.content, path, source: text(raw.source, "agent"), createdAt: text(raw.created_at, ""), updatedAt: text(raw.updated_at, ""),
    version: typeof raw.version === "number" ? raw.version : Number.parseInt(String(raw.version ?? 1), 10) || 1,
  };
}

const timeOf = (iso: string): number => Date.parse(iso) || 0;

/** A file as a box reads it for the folder view: here through the disk, on another box through its relay's `file_get`. */
export interface FolderFile { exists: boolean; text?: string; size?: number; modifiedAt?: number }

/** The brief and harness store as files, read from this box's disk. */
function readLocalFile(path: string): FolderFile {
  try {
    const stat = statSync(path);
    return { exists: true, text: stat.isFile() ? readFileSync(path, "utf8") : undefined, size: stat.isFile() ? stat.size : undefined, modifiedAt: stat.mtimeMs };
  } catch {
    return { exists: false };
  }
}

/** A `ConfigFile` from a file another box read, as `fileInfo` builds it from this box's disk. */
function remoteInfo(label: string, path: string, file: FolderFile, opts: { preview?: boolean; loaded: boolean; note: string }): ConfigFile {
  const out: ConfigFile = { label, path, exists: file.exists, size: file.size ?? null, modifiedAt: file.modifiedAt ?? null, loaded: opts.loaded, note: opts.note };
  if (opts.preview && file.text !== undefined) {
    const head = file.text.slice(0, 4000).split("\n").filter(line => line.trim()).slice(0, 6).join("\n");
    out.preview = head.length > PREVIEW_CAP ? `${head.slice(0, PREVIEW_CAP - 1)}…` : head;
  }
  return out;
}

const BRIEF_NOTE = "Its responsibility in the owner's words. pi-host adds it after the AGENTS.md files as one more Prime context file in every thread of the agent.";
const WORKING_NOTE = "What the agent knows now across rooms. Its work thread rewrites it after each turn, and every comm thread and job of the agent reads it in full.";
const MEMORY_NOTE = "Its memory, which holds tens of thousands of entries. Each turn of every thread of the agent gets the 40 entries that best match it, and its kernel's rlm.harness reads and writes here.";

/**
 * The newest memory entries the folder view carries. An agent's memory can hold tens of thousands of entries in `memory.sqlite`, so the
 * Memory tab reads the rest by page and search (GET /api/agents/:id/memory, `AgentFolders.memory`).
 */
export const MEMORY_PAGE = 50;

const memoryViews = (entries: readonly HarnessEntry[]): HarnessEntryView[] => entries.flatMap(entry => entryView("memory", entry.id, entry as unknown as RawEntry) ?? []);

/**
 * The folder view from its three files and a page of the memory store; `info` builds the file rows from this box's disk or from the files
 * another box read. Memory entries the file still holds, from a writer that predates `memory.sqlite`, come with the page.
 */
function folderView(agent: AgentRecord, dir: string, brief: FolderFile, working: FolderFile, store: StoreFile, page: MemoryAnswer, info: (label: string, path: string, opts: { preview?: boolean; loaded: boolean; note: string }) => ConfigFile): AgentFolder {
  const text = brief.text ?? "";
  const now = working.text ?? "";
  const paged = new Set(page.entries.map(entry => entry.id));
  const legacy = Object.keys(store.entries.memory).filter(id => !paged.has(id));
  const entries = [
    ...HARNESS_KINDS.flatMap(kind => Object.entries(store.entries[kind]).flatMap(([id, raw]) => (kind === "memory" && paged.has(id) ? [] : entryView(kind, id, raw) ?? []))),
    ...memoryViews(page.entries),
  ].sort((a, b) => timeOf(b.updatedAt) - timeOf(a.updatedAt) || b.updatedAt.localeCompare(a.updatedAt));
  const others = HARNESS_KINDS.filter(kind => kind !== "memory").reduce((sum, kind) => sum + Object.keys(store.entries[kind]).length, 0);
  const memory = {
    ...info("the agent's memory store", memoryDbPath(dirname(harnessPath(dir))), { loaded: true, note: MEMORY_NOTE }),
    count: page.count + legacy.length + others, memoryCount: page.count + legacy.length, entries,
  };
  if (entries.length) memory.preview = entries.slice(0, 3).map(e => `- ${e.title}`).join("\n");
  return {
    agent: agent.id, dir, brief: { ...info("brief.md", briefPath(dir), { preview: true, loaded: text.trim() !== "", note: BRIEF_NOTE }), text },
    workingMemory: { ...info("working-memory.md", workingPath(dir), { preview: true, loaded: now.trim() !== "", note: WORKING_NOTE }), text: now }, memory,
  };
}

/** The agent's brief and memory store, entries of every kind with the newest `updatedAt` first. */
export function readAgentFolder(agentsDir: string, agent: AgentRecord): AgentFolder {
  const dir = agentFolderDir(agentsDir, agent);
  const page = memoryRequest(dirname(harnessPath(dir)), { action: "page", limit: MEMORY_PAGE });
  return folderView(agent, dir, readLocalFile(briefPath(dir)), readLocalFile(workingPath(dir)), readStore(harnessPath(dir)), page, (label, path, opts) => fileInfo(label, path, opts));
}

/** Memory entries of the agent's store on this box: the `limit` best matches of `query`, or the newest after `offset` when it is blank. */
export function readAgentMemory(agentsDir: string, agent: AgentRecord, query: string, limit: number, offset: number): MemoryAnswer {
  const harness = dirname(harnessPath(agentFolderDir(agentsDir, agent)));
  if (!query.trim()) return memoryRequest(harness, { action: "page", limit, offset });
  const found = memoryRequest(harness, { action: "search", query, limit: limit + offset });
  return { count: found.count, entries: found.entries.slice(offset) };
}

/** File access on an agent's box: its relay's `file_get` and `file_put`. */
export interface BoxFiles {
  get(path: string): Promise<FolderFile>;
  /** Writes the file, or removes it with `text` null. */
  put(path: string, text: string | null): Promise<void>;
  /** A request on the memory store in an agent's harness folder there (prime-relay `memory` op). */
  memory(dir: string, request: MemoryRequest): Promise<MemoryAnswer>;
}

/** A memory entry as Prime's writer makes it, with the owner or an agent as its source. */
function memoryEntry(id: string, input: MemoryInput, source: string, kept?: HarnessEntry): HarnessEntry {
  const now = harnessNow();
  return kept
    ? { ...kept, title: input.title, content: input.content, path: input.path ?? kept.path, source, updated_at: now, version: kept.version + 1 }
    : { id, kind: "memory", title: input.title, content: input.content, path: input.path ?? "general", scope: "local", reference: {}, arguments: {}, metadata: {}, source, created_at: now, updated_at: now, version: 1 };
}

/**
 * An agent's folder wherever it lives: on this box through the disk, and on another box through that box's relay (`files` answers the
 * relay for the agent's box, or undefined for this box). A write on another box reads the store, changes one entry and writes the whole
 * file back, as Prime's writer does here.
 */
export class AgentFolders {
  private readonly where: (agent: AgentRecord) => { agentsDir: string; files?: BoxFiles };

  constructor(where: (agent: AgentRecord) => { agentsDir: string; files?: BoxFiles }) {
    this.where = where;
  }

  async read(agent: AgentRecord): Promise<AgentFolder> {
    const { agentsDir, files } = this.where(agent);
    if (!files) return readAgentFolder(agentsDir, agent);
    const dir = agentFolderDir(agentsDir, agent);
    const [brief, working, store, page] = await Promise.all([
      files.get(briefPath(dir)), files.get(workingPath(dir)), files.get(harnessPath(dir)),
      // A relay older than the memory op keeps memory in the file, which folderView lists whole; an away box reads as an empty page.
      this.boxMemory(files, dirname(harnessPath(dir)), { action: "page", limit: MEMORY_PAGE }, true).catch(() => ({ count: 0, entries: [] })),
    ]);
    const byPath = new Map([[briefPath(dir), brief], [workingPath(dir), working]]);
    return folderView(agent, dir, brief, working, parseStore(store.text), page, (label, path, opts) => remoteInfo(label, path, byPath.get(path) ?? store, opts));
  }

  /** Memory entries: the `limit` best matches of `query` after `offset`, or the newest after `offset` when it is blank. */
  async memory(agent: AgentRecord, query: string, limit: number, offset: number): Promise<{ count: number; entries: HarnessEntryView[] }> {
    const { agentsDir, files } = this.where(agent);
    if (!files) {
      await migrateMemory(dirname(harnessPath(agentFolderDir(agentsDir, agent))));
      const found = readAgentMemory(agentsDir, agent, query, limit, offset);
      return { count: found.count, entries: memoryViews(found.entries) };
    }
    const dir = dirname(harnessPath(agentFolderDir(agentsDir, agent)));
    const found = query.trim()
      ? await this.boxMemory(files, dir, { action: "search", query, limit: limit + offset }).then(answer => ({ ...answer, entries: answer.entries.slice(offset) }))
      : await this.boxMemory(files, dir, { action: "page", limit, offset });
    return { count: found.count, entries: memoryViews(found.entries) };
  }

  /**
   * A memory request on another box. A box whose relay and pi-host predate `memory.sqlite` (the Mac on release-8ceff51, 11-26) answers
   * "unknown op memory", and its memory stays in `harness_state.json`, so the request runs on that file through `file_get` and `file_put`
   * and nothing moves out of it. `pageOnly` answers such a box with an empty page, because folderView lists the file's entries itself.
   */
  private async boxMemory(files: BoxFiles, dir: string, request: MemoryRequest, pageOnly = false): Promise<MemoryAnswer> {
    try {
      return await files.memory(dir, request);
    } catch (error) {
      if (!/unknown op memory/.test(error instanceof Error ? error.message : String(error))) throw error;
    }
    if (pageOnly) return { count: 0, entries: [] };
    const path = join(dir, "harness_state.json");
    const state = stateOf((await files.get(path)).text);
    const all = Object.values(state.entries.memory).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    const count = () => Object.keys(state.entries.memory).length;
    switch (request.action) {
      case "page": return { count: all.length, entries: all.slice(request.offset ?? 0, (request.offset ?? 0) + request.limit) };
      case "get": return { count: all.length, entries: all.filter(entry => entry.id === request.id) };
      case "search": {
        const terms = memoryTerms(request.query);
        const score = (entry: HarnessEntry) => {
          const own = new Set(memoryTerms(`${entry.id} ${entry.title} ${entry.content}`));
          return terms.filter(term => own.has(term)).length;
        };
        const hits = all.map(entry => ({ entry, score: score(entry) })).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score);
        return { count: all.length, entries: hits.slice(0, request.limit).map(hit => hit.entry) };
      }
      case "put":
        for (const entry of request.entries) state.entries.memory[entry.id] = entry;
        await files.put(path, stateText(state));
        return { count: count(), entries: [] };
      case "delete":
        for (const id of request.ids) delete state.entries.memory[id];
        await files.put(path, stateText(state));
        return { count: count(), entries: [] };
    }
  }

  /** A memory entry's current copy on the agent's box, from `memory.sqlite` or, before the move, from the file. */
  private async keptMemory(files: BoxFiles, dir: string, id: string): Promise<{ entry?: HarnessEntry; inFile: boolean; state: HarnessState }> {
    const path = join(dir, "harness_state.json");
    const state = stateOf((await files.get(path)).text);
    const stored = (await this.boxMemory(files, dir, { action: "get", id })).entries[0];
    const filed = state.entries.memory[id];
    return { entry: stored && (!filed || stored.updated_at >= filed.updated_at) ? stored : filed, inFile: !!filed, state };
  }

  async writeBrief(agent: AgentRecord, text: string): Promise<void> {
    const { agentsDir, files } = this.where(agent);
    if (!files) return writeBrief(agentsDir, agent, text);
    await files.put(briefPath(agentFolderDir(agentsDir, agent)), text.trim() ? text : null);
  }

  async writeWorkingMemory(agent: AgentRecord, text: string): Promise<void> {
    const { agentsDir, files } = this.where(agent);
    if (!files) return writeWorkingMemory(agentsDir, agent, text);
    await files.put(workingPath(agentFolderDir(agentsDir, agent)), text.trim() ? text : null);
  }

  async create(agent: AgentRecord, kind: HarnessKind, input: MemoryInput, source = "owner"): Promise<string> {
    const { agentsDir, files } = this.where(agent);
    if (!files) return createEntry(agentsDir, agent, kind, input, source);
    const path = harnessPath(agentFolderDir(agentsDir, agent));
    if (kind === "memory") {
      const id = harnessSlug(input.title, kind);
      if ((await this.keptMemory(files, dirname(path), id)).entry) throw new EntryExists(`${kind} entry '${id}' already exists`);
      await this.boxMemory(files, dirname(path), { action: "put", entries: [memoryEntry(id, input, source)] });
      return id;
    }
    const state = stateOf((await files.get(path)).text);
    const id = addEntry(state, kind, input, source);
    await files.put(path, stateText(state));
    return id;
  }

  async update(agent: AgentRecord, kind: HarnessKind, id: string, input: MemoryInput, source = "owner"): Promise<void> {
    const { agentsDir, files } = this.where(agent);
    if (!files) return updateEntry(agentsDir, agent, kind, id, input, source);
    const path = harnessPath(agentFolderDir(agentsDir, agent));
    if (kind === "memory") {
      const { entry } = await this.keptMemory(files, dirname(path), id);
      if (!entry) throw new EntryMissing(`${kind} entry '${id}' does not exist`);
      await this.boxMemory(files, dirname(path), { action: "put", entries: [memoryEntry(id, input, source, entry)] });
      return;
    }
    const state = stateOf((await files.get(path)).text);
    changeEntry(state, kind, id, input, source);
    await files.put(path, stateText(state));
  }

  async delete(agent: AgentRecord, kind: HarnessKind, id: string): Promise<void> {
    const { agentsDir, files } = this.where(agent);
    if (!files) return deleteEntry(agentsDir, agent, kind, id);
    const path = harnessPath(agentFolderDir(agentsDir, agent));
    if (kind === "memory") {
      const { entry, inFile, state } = await this.keptMemory(files, dirname(path), id);
      if (!entry) throw new EntryMissing(`${kind} entry '${id}' does not exist`);
      await this.boxMemory(files, dirname(path), { action: "delete", ids: [id] });
      if (inFile) {
        delete state.entries.memory[id];
        await files.put(path, stateText(state));
      }
      return;
    }
    const state = stateOf((await files.get(path)).text);
    dropEntry(state, kind, id);
    await files.put(path, stateText(state));
  }
}

/** Writes `brief.md`; empty text deletes it, since a missing or empty brief is no brief. */
export function writeBrief(agentsDir: string, agent: AgentRecord, text: string): void {
  writeFolderFile(briefPath(agentFolderDir(agentsDir, agent)), text);
}

/** Writes `working-memory.md`, as the owner edits it on the agent's page; empty text deletes it. */
export function writeWorkingMemory(agentsDir: string, agent: AgentRecord, text: string): void {
  writeFolderFile(workingPath(agentFolderDir(agentsDir, agent)), text);
}

/** Replaces a folder file through a temp file beside it, so a thread that reads it sees the old text or the new; blank text deletes it. */
function writeFolderFile(path: string, text: string): void {
  if (!text.trim()) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    const fd = openSync(temp, "w");
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Prime's `create` on a store in memory: the id is `_slug(title)`, and a title whose id the kind already holds fails. */
function addEntry(state: HarnessState, kind: HarnessKind, input: MemoryInput, source: string): string {
  const id = harnessSlug(input.title, kind);
  if (state.entries[kind][id]) throw new EntryExists(`${kind} entry '${id}' already exists`);
  const now = harnessNow();
  state.entries[kind][id] = {
    id, kind, title: input.title, content: input.content, path: input.path ?? "general", scope: "local", reference: {}, arguments: {}, metadata: {}, source,
    created_at: now, updated_at: now, version: 1,
  };
  return id;
}

/** Prime's `update` on a store in memory: new title and content, the path kept unless given, the source set, `updated_at` now and `version` one higher. */
function changeEntry(state: HarnessState, kind: HarnessKind, id: string, input: MemoryInput, source: string): void {
  const entry = state.entries[kind][id];
  if (!entry) throw new EntryMissing(`${kind} entry '${id}' does not exist`);
  entry.title = input.title;
  entry.content = input.content;
  if (input.path !== undefined) entry.path = input.path;
  entry.source = source;
  entry.updated_at = harnessNow();
  entry.version += 1;
}

/** Prime's `delete` on a store in memory. */
function dropEntry(state: HarnessState, kind: HarnessKind, id: string): void {
  if (!state.entries[kind][id]) throw new EntryMissing(`${kind} entry '${id}' does not exist`);
  delete state.entries[kind][id];
}

/** Changes the agent's store under its lock. */
const changeStore = <R>(agentsDir: string, agent: AgentRecord, change: (state: HarnessState) => R): Promise<R> =>
  updateState(dirname(harnessPath(agentFolderDir(agentsDir, agent))), "local", change);

/** The agent's memory store folder on this box, with any entries the file still held moved into `memory.sqlite` first. */
async function memoryDir(agentsDir: string, agent: AgentRecord): Promise<string> {
  const dir = dirname(harnessPath(agentFolderDir(agentsDir, agent)));
  await migrateMemory(dir);
  return dir;
}

/** Prime's `create`. A memory entry goes straight into `memory.sqlite`, one row, however large the store. */
export async function createEntry(agentsDir: string, agent: AgentRecord, kind: HarnessKind, input: MemoryInput, source = "owner"): Promise<string> {
  if (kind !== "memory") return changeStore(agentsDir, agent, state => addEntry(state, kind, input, source));
  const dir = await memoryDir(agentsDir, agent);
  const id = harnessSlug(input.title, kind);
  if (memoryRequest(dir, { action: "get", id }).entries.length) throw new EntryExists(`${kind} entry '${id}' already exists`);
  memoryRequest(dir, { action: "put", entries: [memoryEntry(id, input, source)] });
  return id;
}

/** Prime's `update`. */
export async function updateEntry(agentsDir: string, agent: AgentRecord, kind: HarnessKind, id: string, input: MemoryInput, source = "owner"): Promise<void> {
  if (kind !== "memory") return void (await changeStore(agentsDir, agent, state => changeEntry(state, kind, id, input, source)));
  const dir = await memoryDir(agentsDir, agent);
  const [kept] = memoryRequest(dir, { action: "get", id }).entries;
  if (!kept) throw new EntryMissing(`${kind} entry '${id}' does not exist`);
  memoryRequest(dir, { action: "put", entries: [memoryEntry(id, input, source, kept)] });
}

/** Prime's `delete`. */
export async function deleteEntry(agentsDir: string, agent: AgentRecord, kind: HarnessKind, id: string): Promise<void> {
  if (kind !== "memory") return void (await changeStore(agentsDir, agent, state => dropEntry(state, kind, id)));
  const dir = await memoryDir(agentsDir, agent);
  if (!memoryRequest(dir, { action: "get", id }).entries.length) throw new EntryMissing(`${kind} entry '${id}' does not exist`);
  memoryRequest(dir, { action: "delete", ids: [id] });
}
