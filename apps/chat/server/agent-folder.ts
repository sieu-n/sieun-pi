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
import { parseState, updateState, type HarnessState } from "../../../packages/pi-harness/src/core/store.ts";
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
const MEMORY_NOTE = "Its memory. Every thread of the agent gets Prime's harness digest of Prime's global store merged with this one, and its kernel's rlm.harness writes here.";

/** The folder view from its three files; `info` builds the file rows from this box's disk or from the files another box read. */
function folderView(agent: AgentRecord, dir: string, brief: FolderFile, working: FolderFile, store: StoreFile, info: (label: string, path: string, opts: { preview?: boolean; loaded: boolean; note: string }) => ConfigFile): AgentFolder {
  const text = brief.text ?? "";
  const now = working.text ?? "";
  const entries = HARNESS_KINDS.flatMap(kind => Object.entries(store.entries[kind]).flatMap(([id, raw]) => entryView(kind, id, raw) ?? []))
    .sort((a, b) => timeOf(b.updatedAt) - timeOf(a.updatedAt) || b.updatedAt.localeCompare(a.updatedAt));
  const memory = { ...info("the agent's harness store", harnessPath(dir), { loaded: true, note: MEMORY_NOTE }), count: entries.length, entries };
  if (entries.length) memory.preview = entries.slice(0, 3).map(e => `- ${e.title}`).join("\n");
  return {
    agent: agent.id, dir, brief: { ...info("brief.md", briefPath(dir), { preview: true, loaded: text.trim() !== "", note: BRIEF_NOTE }), text },
    workingMemory: { ...info("working-memory.md", workingPath(dir), { preview: true, loaded: now.trim() !== "", note: WORKING_NOTE }), text: now }, memory,
  };
}

/** The agent's brief and memory store, entries of every kind with the newest `updatedAt` first. */
export function readAgentFolder(agentsDir: string, agent: AgentRecord): AgentFolder {
  const dir = agentFolderDir(agentsDir, agent);
  return folderView(agent, dir, readLocalFile(briefPath(dir)), readLocalFile(workingPath(dir)), readStore(harnessPath(dir)), (label, path, opts) => fileInfo(label, path, opts));
}

/** File access on an agent's box: its relay's `file_get` and `file_put`. */
export interface BoxFiles {
  get(path: string): Promise<FolderFile>;
  /** Writes the file, or removes it with `text` null. */
  put(path: string, text: string | null): Promise<void>;
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
    const [brief, working, store] = await Promise.all([files.get(briefPath(dir)), files.get(workingPath(dir)), files.get(harnessPath(dir))]);
    const byPath = new Map([[briefPath(dir), brief], [workingPath(dir), working]]);
    return folderView(agent, dir, brief, working, parseStore(store.text), (label, path, opts) => remoteInfo(label, path, byPath.get(path) ?? store, opts));
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
    const state = stateOf((await files.get(path)).text);
    const id = addEntry(state, kind, input, source);
    await files.put(path, stateText(state));
    return id;
  }

  async update(agent: AgentRecord, kind: HarnessKind, id: string, input: MemoryInput, source = "owner"): Promise<void> {
    const { agentsDir, files } = this.where(agent);
    if (!files) return updateEntry(agentsDir, agent, kind, id, input, source);
    const path = harnessPath(agentFolderDir(agentsDir, agent));
    const state = stateOf((await files.get(path)).text);
    changeEntry(state, kind, id, input, source);
    await files.put(path, stateText(state));
  }

  async delete(agent: AgentRecord, kind: HarnessKind, id: string): Promise<void> {
    const { agentsDir, files } = this.where(agent);
    if (!files) return deleteEntry(agentsDir, agent, kind, id);
    const path = harnessPath(agentFolderDir(agentsDir, agent));
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

/** Prime's `create`. */
export function createEntry(agentsDir: string, agent: AgentRecord, kind: HarnessKind, input: MemoryInput, source = "owner"): Promise<string> {
  return changeStore(agentsDir, agent, state => addEntry(state, kind, input, source));
}

/** Prime's `update`. */
export async function updateEntry(agentsDir: string, agent: AgentRecord, kind: HarnessKind, id: string, input: MemoryInput, source = "owner"): Promise<void> {
  await changeStore(agentsDir, agent, state => changeEntry(state, kind, id, input, source));
}

/** Prime's `delete`. */
export async function deleteEntry(agentsDir: string, agent: AgentRecord, kind: HarnessKind, id: string): Promise<void> {
  await changeStore(agentsDir, agent, state => dropEntry(state, kind, id));
}
