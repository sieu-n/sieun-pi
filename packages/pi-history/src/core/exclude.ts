import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { chatOf, readSettings, type Registry, RegistryReader, registrySource, settingsPath } from "./scope.ts";

/** Vent: the owner keeps its tool calls and results out of the index because they carry secrets (board todo t113, 10-28). */
export const DEFAULT_EXCLUDED_CHATS = ["01a14dd5-e9d3-705d-bd63-245c21b2eee2"];

export const TOOL_KINDS = ["tool_call", "tool_result"] as const;

/** settings.json `excludeToolOutput.chats`, read on each call, or the default list. */
export function excludedChats(path = settingsPath()): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { excludeToolOutput?: { chats?: unknown } };
    const chats = raw.excludeToolOutput?.chats;
    if (Array.isArray(chats)) return new Set(chats.map(String));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return new Set(DEFAULT_EXCLUDED_CHATS);
}

const NAME_LINE = /"type":"session_info"[^\n]*?"name":"((?:[^"\\]|\\.)*)"/;

/**
 * Decides which roots lose their tool docs: a root whose chat, resolved by scope.ts `chatOf` through chat-jobs.json, is in
 * `excludeToolOutput.chats`. A subagent counts through its root, so a whole job tree goes with its chat.
 */
export class ToolOutputPolicy {
  private registry: Registry = { jobs: {} };
  private chats = new Set<string>();
  private readonly names = new Map<string, string>();
  private readonly verdicts = new Map<string, boolean>();
  private readonly reader: RegistryReader;
  private readonly db: DatabaseSync;
  private readonly sessionsDir: string;
  /** When the last registry read started, so a file born after it waits for a newer read. */
  refreshedAt = 0;

  constructor(db: DatabaseSync, sessionsDir: string, reader?: RegistryReader) {
    this.db = db;
    this.sessionsDir = sessionsDir;
    this.reader = reader ?? new RegistryReader(() => registrySource(readSettings()));
  }

  async refresh(): Promise<void> {
    const started = Date.now();
    const registry = await this.reader.read();
    this.registry = registry;
    this.chats = excludedChats();
    this.verdicts.clear();
    this.refreshedAt = started;
  }

  excludes(root: string): boolean {
    let verdict = this.verdicts.get(root);
    if (verdict === undefined) {
      verdict = this.chats.has(chatOf(root, this.registry, (r) => this.nameOf(r)));
      this.verdicts.set(root, verdict);
    }
    return verdict;
  }

  /** Every root in the index that loses its tool docs. */
  excludedRoots(): string[] {
    const roots = this.db.prepare("SELECT DISTINCT root FROM files").all() as { root: string }[];
    return roots.map((r) => String(r.root)).filter((root) => this.excludes(root));
  }

  /** A root's name from the index, else from the session_info line near the top of its transcript, which may not be indexed yet. */
  private nameOf(root: string): string | null {
    const known = this.names.get(root);
    if (known) return known;
    const row = this.db.prepare("SELECT name FROM files WHERE session = ? AND depth = 0 AND name IS NOT NULL LIMIT 1").get(root) as { name: string } | undefined;
    const name = row?.name ?? this.peekName(root);
    if (name) this.names.set(root, name);
    return name;
  }

  private peekName(root: string): string | null {
    let fd: number;
    try {
      fd = openSync(join(this.sessionsDir, `${root}.jsonl`), "r");
    } catch {
      return null;
    }
    try {
      const buf = Buffer.alloc(64 << 10);
      const n = readSync(fd, buf, 0, buf.length, 0);
      const m = NAME_LINE.exec(buf.toString("utf8", 0, n));
      return m ? (JSON.parse(`"${m[1]}"`) as string) : null;
    } finally {
      closeSync(fd);
    }
  }
}
