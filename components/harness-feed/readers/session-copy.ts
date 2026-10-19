import { open, stat } from "node:fs/promises";

const OPEN_BRACE = 0x7b, OPEN_BRACKET = 0x5b, CLOSE_BRACE = 0x7d, CLOSE_BRACKET = 0x5d, QUOTE = 0x22, BACKSLASH = 0x5c;
const CHUNK_BYTES = 1 << 20;

/** Where the rows array starts and where one row ends and the next begins, in a copy the catalog writes with `id` as each row's first key. */
const ROWS_START = Buffer.from('"rows":[{"id":"');
const ROW_GAP = Buffer.from('},{"id":"');

/**
 * Each row of a SessionPeer copy (`{"version":1,"fullAt":..,"rows":[{..},..]}`: the chat's session-copy.json, or a box's
 * `<host>.sessions.json`), read in 1 MiB chunks and parsed one row at a time, so a reader never holds the whole 14 to 39 MB file or its object
 * tree. Parsing the whole copy took the feed from 73 MB to 395 MB at peak on 10-19. `keep` sees a row's bytes, and a row it refuses is not
 * yielded; the byte scan of a copy with no `id` first key (`scanRows`) also leaves it unparsed.
 *
 * The rows are cut at each `},{"id":"`, found with Buffer.indexOf: a JSON string escapes its quotes, so the cut never falls inside a string,
 * and a cut inside a nested array of objects that start with `id` leaves a piece that does not parse, which is joined to the next one. On the
 * Mac's 39 MB copy on 10-19 a byte-at-a-time scan took 765 ms CPU and this takes about 100 ms. A copy whose rows do not start with `id` is read
 * with the byte scan (`scanRows`).
 */
export async function* sessionRows(file: string, keep?: (raw: Buffer) => boolean): AsyncGenerator<Record<string, unknown>> {
  const handle = await open(file, "r");
  try {
    const chunk = Buffer.alloc(CHUNK_BYTES);
    const first = await handle.read(chunk, 0, chunk.length, 0);
    const head = chunk.subarray(0, first.bytesRead);
    const start = head.indexOf(ROWS_START);
    if (start < 0) { yield* scanRows(handle, keep); return; }
    let pending: Buffer = Buffer.from(head.subarray(start + ROWS_START.length - '{"id":"'.length));
    let held: Buffer | null = null;
    const emit = function* (piece: Buffer): Generator<Record<string, unknown>> {
      const raw: Buffer = held ? Buffer.concat([held, Buffer.from(","), piece]) : piece;
      let row: unknown;
      try { row = JSON.parse(raw.toString("utf8")); } catch { held = raw; return; }
      held = null;
      if (typeof row === "object" && row !== null && !Array.isArray(row) && (!keep || keep(raw))) yield row as Record<string, unknown>;
    };
    let position = first.bytesRead;
    for (;;) {
      for (let gap = pending.indexOf(ROW_GAP); gap >= 0; gap = pending.indexOf(ROW_GAP)) {
        yield* emit(pending.subarray(0, gap + 1));
        pending = pending.subarray(gap + 2);
      }
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
    }
    // The last row ends where the rows array does: `}]` and the copy's own closing brace after it.
    const end = pending.lastIndexOf("]");
    if (end > 0) yield* emit(pending.subarray(0, end));
  } finally {
    await handle.close();
  }
}

/** The byte-at-a-time scan of a copy's rows, by its brace depth and strings, for a copy `sessionRows` cannot cut by its `id` keys. */
async function* scanRows(handle: Awaited<ReturnType<typeof open>>, keep?: (raw: Buffer) => boolean): AsyncGenerator<Record<string, unknown>> {
  const chunk = Buffer.alloc(CHUNK_BYTES);
  let depth = 0, inString = false, escaped = false, position = 0;
  let parts: Buffer[] = [];
  for (;;) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    let start = depth >= 3 ? 0 : -1;
    for (let i = 0; i < bytesRead; i++) {
      const byte = chunk[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (byte === BACKSLASH) escaped = true;
        else if (byte === QUOTE) inString = false;
      } else if (byte === QUOTE) inString = true;
      else if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
        if (depth === 2 && byte === OPEN_BRACE) start = i;
        depth++;
      } else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
        depth--;
        if (depth === 2 && start >= 0) {
          parts.push(Buffer.from(chunk.subarray(start, i + 1)));
          const raw = parts.length === 1 ? parts[0]! : Buffer.concat(parts);
          parts = [];
          start = -1;
          if (keep && !keep(raw)) continue;
          const row = JSON.parse(raw.toString("utf8")) as unknown;
          if (typeof row === "object" && row !== null && !Array.isArray(row)) yield row as Record<string, unknown>;
        }
      }
    }
    if (start >= 0) parts.push(Buffer.from(chunk.subarray(start, bytesRead)));
  }
}

/**
 * The fields of one SessionPeer row that the feed's readers use: the tokens reader's usage, and the status, activity and tree fields the chat's
 * catalog projects its sidebar rows from (chat-catalog.ts `projectRow`, `sessionPulse`, `subtreeOf`).
 */
export interface CopyRow {
  id: string; parent: string | null; name: string | null; file: string | null; lifecycle: string;
  /** The RLM child id of a subagent session (`rlmChildId`), which the chat's subagent list keys on. */
  childId: string | null;
  /** The daemon holds a session for it (`activeSessionId`), the catalog's `live`. */
  live: boolean;
  /** chat-catalog.ts `isTopLevel`: no subagent kind, no RLM child id and no RLM depth above 0. */
  topLevel: boolean;
  roster: string | null; activity: string | null; sessionActive: boolean; streaming: boolean; tools: boolean; bash: boolean; compacting: boolean; runningChildren: boolean;
  statusLabel: string | null; workerState: string | null; taskState: string | null; summary: string | null; heardAt: string | null;
  /** `lastActivityAt`, else `modified`, in ms; 0 when neither reads. */
  activityAt: number; created: number; messages: number;
  input: number; output: number; cost: number;
  /** The session's model id (`model.id`) and its context window (`model.contextWindow`, 0 when unknown), for the tokens reader's context ring. */
  model: string | null; window: number;
}

const text = (value: unknown): string | null => typeof value === "string" ? value : null;
const flag = (value: unknown): boolean => value === true;
const amount = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;

/** One raw row's `CopyRow`, or null for a row with no session id. */
export function copyRow(row: Record<string, unknown>): CopyRow | null {
  if (typeof row.sessionId !== "string") return null;
  const usage = (typeof row.usage === "object" && row.usage !== null ? row.usage : {}) as Record<string, unknown>;
  const model = (typeof row.model === "object" && row.model !== null ? row.model : {}) as Record<string, unknown>;
  const at = Date.parse(text(row.lastActivityAt) ?? text(row.modified) ?? "");
  const created = Date.parse(text(row.created) ?? "");
  const summary = text(row.summary)?.trim();
  return { id: row.sessionId, parent: text(row.parentSessionId), name: text(row.sessionName), file: text(row.sessionFile), lifecycle: text(row.lifecycle) ?? "",
    childId: text(row.rlmChildId),
    live: typeof row.activeSessionId === "string",
    topLevel: row.runtimeKind !== "subagent" && typeof row.rlmChildId !== "string" && !(typeof row.rlmDepth === "number" && row.rlmDepth > 0),
    roster: text(row.rosterStatus), activity: text(row.activity), sessionActive: flag(row.isSessionActive), streaming: flag(row.isStreaming), tools: flag(row.isRunningTools), bash: flag(row.isBashRunning),
    compacting: flag(row.isCompacting), runningChildren: flag(row.hasRunningRlmChildren), statusLabel: text(row.statusLabel), workerState: text(row.workerState),
    taskState: text(row.taskState), summary: summary ? summary.slice(0, 400) : null, heardAt: text(row.lastHeardFromAt),
    activityAt: Number.isFinite(at) ? at : 0, created: Number.isFinite(created) ? created : 0, messages: amount(row.messageCount),
    input: amount(usage.inputTokens), output: amount(usage.outputTokens), cost: amount(usage.cost),
    model: text(model.id), window: amount(model.contextWindow) };
}

/** Each copy's rows by file, read again only when its size or mtime changed, so the readers of one feed process share one parse of a copy. */
const indexes = new Map<string, { key: string; rows: Promise<CopyRow[]> }>();

/** The `CopyRow`s of a SessionPeer copy, streamed once per change of the file (`sessionRows`); empty when the file is missing. */
export async function copyIndex(file: string): Promise<CopyRow[]> {
  const info = await stat(file).catch(() => null);
  if (!info) { indexes.delete(file); return []; }
  const key = `${info.size}:${info.mtimeMs}`;
  const known = indexes.get(file);
  if (known?.key === key) return known.rows;
  const rows = (async () => {
    const out: CopyRow[] = [];
    for await (const raw of sessionRows(file)) { const row = copyRow(raw); if (row) out.push(row); }
    return out;
  })();
  indexes.set(file, { key, rows });
  rows.catch(() => { if (indexes.get(file)?.rows === rows) indexes.delete(file); });
  return rows;
}
