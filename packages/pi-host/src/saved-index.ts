/**
 * An index of the saved session files under the host's session dirs, for `list` with `all`, so a session closed before a host restart still
 * lists, as Prime's list does. Pi's own `SessionManager.listAll` parses every file on every call: 22 s and 690 MB RSS for the 5,637 files
 * (3.2 GB) in ~/.prime/agent/sessions on us-metal02 on 10-27. This index reads a file again only when its size or mtime changed, keeps the
 * rows on disk between host starts, and answers from what it holds while a scan runs.
 *
 * It finds Prime's flat `<dir>/<id>.jsonl` files and upstream Pi's `<dir>/--<cwd slug>--/<ts>_<id>.jsonl` files.
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { SavedSessionSummary } from "./protocol.ts";

type Held = { mtimeMs: number; size: number; row: SavedSessionSummary | null };
const VERSION = 1;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: unknown }).text ?? "") : "")).join("");
}

/** One file's row, read line by line so a 170 MB transcript never sits in memory whole; null for a file that is not a session. */
export async function readSavedRow(path: string, mtimeMs: number): Promise<SavedSessionSummary | null> {
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  let header: { id?: unknown; cwd?: unknown; timestamp?: unknown; parentSession?: unknown } | undefined;
  let name: string | undefined;
  let first = "";
  let count = 0;
  try {
    for await (const line of lines) {
      if (!line) continue;
      if (!header) {
        try { header = JSON.parse(line); } catch { return null; }
        if ((header as { type?: unknown }).type !== "session" || typeof header!.id !== "string") return null;
        continue;
      }
      if (!line.includes('"type":"message"') && !line.includes('"type":"session_info"')) continue;
      let entry: { type?: string; name?: unknown; message?: { role?: string; content?: unknown } };
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type === "session_info") name = typeof entry.name === "string" && entry.name.trim() ? entry.name : name;
      else if (entry.type === "message") {
        count++;
        if (!first && entry.message?.role === "user") first = textOf(entry.message.content).slice(0, 500);
      }
    }
  } finally {
    lines.close();
  }
  if (!header) return null;
  const modified = new Date(mtimeMs).toISOString();
  const created = typeof header.timestamp === "string" ? header.timestamp : modified;
  return {
    id: header.id as string, sessionId: header.id as string, sessionFile: path, ...(name ? { sessionName: name } : {}), cwd: typeof header.cwd === "string" ? header.cwd : "",
    lifecycle: "archived", activity: "idle", isSessionActive: false, isStreaming: false, isCompacting: false, attachedClients: 0, messageCount: count,
    unfinishedActionCount: 0, sessionActions: { queuedCount: 0, steering: [], followUps: [] }, created, modified, lastActivityAt: modified, firstMessage: first,
    ...(typeof header.parentSession === "string" ? { parentSessionPath: header.parentSession } : {}),
  };
}

/** The session files in `dir`: its own `*.jsonl` and those one level down in Pi's `--<cwd slug>--` folders. */
async function sessionFiles(dir: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join(dir, entry.name));
    else if (entry.isDirectory() && entry.name.startsWith("--")) {
      try {
        for (const inner of await readdir(join(dir, entry.name), { withFileTypes: true })) if (inner.isFile() && inner.name.endsWith(".jsonl")) files.push(join(dir, entry.name, inner.name));
      } catch { /* a folder removed under the scan */ }
    }
  }
  return files;
}

export class SavedIndex {
  private readonly held = new Map<string, Held>();
  private scanning: Promise<void> | undefined;
  private scannedAt = 0;

  constructor(private readonly dirs: readonly string[], private readonly file: string | undefined, private readonly everyMs = 10_000) {
    if (file && existsSync(file)) {
      try {
        const saved = JSON.parse(readFileSync(file, "utf8")) as { version?: number; files?: Record<string, Held> };
        if (saved.version === VERSION) for (const [path, held] of Object.entries(saved.files ?? {})) this.held.set(path, held);
      } catch { /* a torn index file: scan from nothing */ }
    }
  }

  /** The rows the index holds now. It starts a scan when the last one is older than `everyMs`, and `wait` waits for that scan. */
  async rows(wait = false): Promise<SavedSessionSummary[]> {
    if (!this.scanning && Date.now() - this.scannedAt >= this.everyMs) {
      this.scanning = this.scan().finally(() => { this.scannedAt = Date.now(); this.scanning = undefined; });
    }
    if (wait || this.scannedAt === 0) await this.scanning;
    return [...this.held.values()].flatMap(held => (held.row ? [held.row] : []));
  }

  private async scan(): Promise<void> {
    const seen = new Set<string>();
    let changed = false;
    for (const dir of this.dirs) {
      for (const path of await sessionFiles(dir)) {
        seen.add(path);
        let info;
        try { info = await stat(path); } catch { continue; }
        const held = this.held.get(path);
        if (held && held.mtimeMs === info.mtimeMs && held.size === info.size) continue;
        const row = await readSavedRow(path, info.mtimeMs).catch(() => null);
        this.held.set(path, { mtimeMs: info.mtimeMs, size: info.size, row });
        changed = true;
      }
    }
    for (const path of [...this.held.keys()]) if (!seen.has(path)) { this.held.delete(path); changed = true; }
    if (changed && this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ version: VERSION, files: Object.fromEntries(this.held) }));
      renameSync(temp, this.file);
    }
  }
}
