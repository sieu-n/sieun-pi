import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { withFileLock } from "./lock.ts";

/**
 * The continual harness store: `harness_state.json` in the format and at the paths of Prime's `harness.py`.
 *
 * prime-sync merges the global file with `sieu-n/prime-shared-state`, and the vendored `harness.py` in the Python kernel edits the same
 * files, so this module keeps the file shape byte-compatible: `{schema, entries: {prompt, memory, skill, subagent}, refinements}`.
 * Every write goes through `updateState`, which holds `<file>.lock`, reads the file again under it and replaces it atomically.
 */

export const KINDS = ["prompt", "memory", "skill", "subagent"] as const;
export type Kind = (typeof KINDS)[number];
export type Scope = "local" | "global";

export interface HarnessEntry {
  id: string;
  kind: Kind;
  title: string;
  content: string;
  path: string;
  scope: Scope;
  reference: Record<string, unknown>;
  arguments: Record<string, unknown>;
  metadata: Record<string, unknown>;
  source: string;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface RefinementEvent {
  id: string;
  trigger: string;
  changes: string[];
  evidence?: string;
  outcome?: string;
  created_at?: string;
}

export interface HarnessState {
  schema: number;
  entries: Record<Kind, Record<string, HarnessEntry>>;
  refinements: RefinementEvent[];
}

export const STATE_FILE = "harness_state.json";
export const REFINEMENT_LOG = "refinements.jsonl";

type Env = Record<string, string | undefined>;

const envDir = (env: Env, name: string) => (env[name] ?? "").trim() || undefined;

/** harness.py's `_agent_dir`: PRIME_AGENT_CODING_AGENT_DIR, then PI_CODING_AGENT_DIR, then ~/.prime/agent. */
export function agentDir(env: Env = process.env): string {
  return resolve(envDir(env, "PRIME_AGENT_CODING_AGENT_DIR") ?? envDir(env, "PI_CODING_AGENT_DIR") ?? join(homedir(), ".prime", "agent"));
}

/** harness.py's global store directory: RLM_GLOBAL_HARNESS_STATE_DIR, else `<agent dir>/harness`. */
export function globalHarnessDir(env: Env = process.env): string {
  const set = envDir(env, "RLM_GLOBAL_HARNESS_STATE_DIR");
  return set ? resolve(set) : join(agentDir(env), "harness");
}

/** A session's local store directory, `<artifact dir>/harness`, the RLM_HARNESS_STATE_DIR the kernel gets. */
export function localHarnessDir(artifactDir: string): string {
  return join(artifactDir, "harness");
}

export const stateFile = (dir: string) => join(dir, STATE_FILE);

export function emptyState(): HarnessState {
  return { schema: 1, entries: { prompt: {}, memory: {}, skill: {}, subagent: {} }, refinements: [] };
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** Parses file contents the way harness.py's `load` does: a malformed file reads as empty, and a malformed entry is skipped. */
export function parseState(raw: unknown, scope: Scope): HarnessState {
  const state = emptyState();
  const data = record(raw);
  if (!data) return state;
  if (typeof data.schema === "number") state.schema = data.schema;
  const entries = record(data.entries) ?? {};
  for (const kind of KINDS) {
    for (const [id, value] of Object.entries(record(entries[kind]) ?? {})) {
      const e = record(value);
      if (!e || typeof e.title !== "string" || typeof e.content !== "string") continue;
      const { topic, ...rest } = e;
      const path = typeof e.path === "string" ? e.path : typeof topic === "string" ? topic : "general";
      const rawVersion = typeof e.version === "string" ? Number.parseInt(e.version, 10) : e.version;
      const version = typeof rawVersion === "number" && Number.isInteger(rawVersion) ? rawVersion : 1;
      state.entries[kind][id] = {
        ...(rest as object),
        id,
        kind,
        title: e.title,
        content: e.content,
        path,
        scope: e.scope === "local" || e.scope === "global" ? e.scope : scope,
        reference: record(e.reference) ?? {},
        arguments: record(e.arguments) ?? {},
        metadata: record(e.metadata) ?? {},
        source: typeof e.source === "string" ? e.source : "agent",
        created_at: typeof e.created_at === "string" ? e.created_at : "",
        updated_at: typeof e.updated_at === "string" ? e.updated_at : "",
        version,
      };
    }
  }
  if (Array.isArray(data.refinements)) {
    for (const value of data.refinements) {
      const r = record(value);
      if (!r || typeof r.id !== "string" || typeof r.trigger !== "string") continue;
      const changes = typeof r.changes === "string" ? [r.changes] : Array.isArray(r.changes) ? r.changes.map(String) : undefined;
      if (!changes) continue;
      state.refinements.push({ ...(r as object), id: r.id, trigger: r.trigger, changes } as RefinementEvent);
    }
  }
  return state;
}

/** Reads one store. A missing or unreadable file reads as an empty store. */
export function readState(dir: string, scope: Scope): HarnessState {
  const file = stateFile(dir);
  if (!existsSync(file)) return emptyState();
  try {
    return parseState(JSON.parse(readFileSync(file, "utf8")), scope);
  } catch {
    return emptyState();
  }
}

/** The file's real path, as Python's `os.path.realpath` gives it, so both languages lock the same `<file>.lock`. */
function realTarget(file: string): string {
  try {
    return realpathSync(file);
  } catch {}
  try {
    return join(realpathSync(dirname(file)), basename(file));
  } catch {
    return file;
  }
}

/** Replaces the file atomically through a temp file in the same folder, keeping the old file's mode (0600 for a new one). */
function writeState(dir: string, state: HarnessState): void {
  mkdirSync(dir, { recursive: true });
  const target = realTarget(stateFile(dir));
  let mode = 0o600;
  try {
    mode = statSync(target).mode & 0o777;
  } catch {}
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, "wx", mode);
    try {
      const body = Buffer.from(JSON.stringify(state, null, 2) + "\n", "utf8");
      let offset = 0;
      while (offset < body.length) offset += writeSync(fd, body, offset, body.length - offset);
    } finally {
      closeSync(fd);
    }
    chmodSync(temporary, mode);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Runs `change` on the store under its file lock and saves the result.
 * The file is read again after the lock is taken, so a change never writes over another writer's change, including prime-sync's merge.
 * `change` returns false to leave the file untouched.
 */
export async function updateState<R>(dir: string, scope: Scope, change: (state: HarnessState) => R): Promise<R> {
  return withFileLock(realTarget(stateFile(dir)), () => {
    const state = readState(dir, scope);
    const result = change(state);
    if (result !== false) writeState(dir, state);
    return result;
  });
}

/** Prime's merged view for the digest and the planner: global entries, then local ones, with a clashing local id shown as `local:<id>`. */
export function mergeStates(global: HarnessState, local?: HarnessState): HarnessState {
  const merged = emptyState();
  merged.schema = Math.max(global.schema, local?.schema ?? 1);
  for (const kind of KINDS) {
    for (const [id, entry] of Object.entries(global.entries[kind])) merged.entries[kind][id] = { ...entry, scope: entry.scope ?? "global" };
    for (const [id, entry] of Object.entries(local?.entries[kind] ?? {})) {
      const copy = { ...entry, scope: entry.scope ?? "local" };
      merged.entries[kind][merged.entries[kind][id] ? `${copy.scope}:${id}` : id] = copy;
    }
  }
  merged.refinements = [...global.refinements, ...(local?.refinements ?? [])];
  return merged;
}

/** Identity of the two files (inode, size, mtime, ctime), so a session notices a write from any process. */
export function filesIdentity(dirs: string[]): string {
  return dirs
    .map(dir => {
      try {
        const s = statSync(stateFile(dir));
        return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
      } catch {
        return "none";
      }
    })
    .join("|");
}

/** Appends one refine record to `<dir>/refinements.jsonl`, Prime's rollback history for global refines. */
export function appendRefinementLog(dir: string, record: unknown): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, REFINEMENT_LOG), JSON.stringify(record) + "\n", "utf8");
}

/** Reads `<dir>/refinements.jsonl`, skipping lines that are not refine records. */
export function readRefinementLog<T extends { id: string }>(dir: string): T[] {
  const file = join(dir, REFINEMENT_LOG);
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (record(value) && typeof value.id === "string" && Array.isArray(value.appliedEdits)) out.push(value as T);
    } catch {}
  }
  return out;
}

