/**
 * The chat server's own small state in its data dir: thread kinds and read marks. Agents and every room (DMs, channels and Solo rooms) with
 * their post logs are agent-store.ts, duties and check-ins boards.ts. pi-host owns every thread's entries; nothing here copies them. One process writes these files.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentId, ConversationId, ThinkingLevel } from "../web/src/lib/api/types.ts";

export interface ThreadMeta { kind: "chat" | "job"; parent?: AgentId }
export interface ReadMark { at: number; seq?: number }
export interface StateFile {
  v: 1;
  threads: Record<string, ThreadMeta>;
  reads: Record<ConversationId, ReadMark>;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`);
  renameSync(tmp, path);
}
export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export class Store {
  state: StateFile;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.state = readJson<StateFile>(join(dir, "state.json"), { v: 1, threads: {}, reads: {} });
  }

  /** A copy of what pi-host last said, such as the thread list, so pages render while pi-host starts. */
  cache<T>(name: string, fallback: T): T {
    return readJson<T>(join(this.dir, "cache", `${name}.json`), fallback);
  }
  saveCache(name: string, value: unknown): void {
    writeJson(join(this.dir, "cache", `${name}.json`), value);
  }

  saveState(): void {
    writeJson(join(this.dir, "state.json"), this.state);
  }

  imagePath(name: string): string {
    return join(this.dir, "images", name);
  }
}

export type { ThinkingLevel };
