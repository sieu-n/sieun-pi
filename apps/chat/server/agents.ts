/**
 * Agents as the chat server keeps them (apps/chat/docs/agent-model.md, phase 2): each `AgentRecord` in `agents.json` joined with its work
 * thread's live row into the `AgentSummary` the pages see, the thread ids that belong to each agent, new agents with their work thread and DM
 * room, and the migration that turns a root chat with no record into an agent (`migrate.ts`).
 */
import type { AgentId, AgentSummary, RunStatus, ThinkingLevel } from "../web/src/lib/api/types.ts";
import { freeSlug, type AgentRecord, type AgentStore } from "./agent-store.ts";
import type { DurableThread, Host, TreeNode } from "./host/types.ts";
import { migrateAgents } from "./migrate.ts";
import type { Store } from "./store.ts";

export const isAgentId = (id: string): boolean => id.startsWith("ag_");
export const isRoomId = (id: string): boolean => id.startsWith("dm_");

const avatar = (name: string): AgentSummary["avatar"] => {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  const initials = ((words[0]?.[0] ?? "?") + (words[1]?.[0] ?? words[0]?.[1] ?? "")).toUpperCase();
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return { initials, hue: hash % 360 };
};

export interface AgentRows {
  /** The work thread's row, when pi-host listed it. */
  row?: DurableThread;
  tree: TreeNode[];
  /** Rows of the root job threads aliased to the agent. */
  jobs: DurableThread[];
}

/** An agent works while its work thread, any conversation in it, or any of its root job threads runs. */
export function agentStatus(rows: AgentRows): RunStatus {
  if (rows.row?.status === "running" || rows.tree.some(n => n.status === "running") || rows.jobs.some(j => j.status === "running")) return "working";
  return rows.row?.status ?? "idle";
}

/** The agent as the pages see it: its record, with the name, model, status, preview and archived flag of its work thread. */
export function agentSummary(record: AgentRecord, rows: AgentRows, extra: { model: AgentSummary["model"]; channels: string[] }): AgentSummary {
  const row = rows.row;
  const name = row?.name || record.name;
  return {
    id: record.id, kind: "chat", name, avatar: avatar(name), model: extra.model, thinkingLevel: (row?.thinkingLevel as ThinkingLevel | undefined) ?? null,
    status: agentStatus(rows), parent: null, thread: record.workThread, conversation: 1, archived: row?.archived ?? record.archived,
    createdAt: record.createdAt, updatedAt: Math.max(row?.updatedAt ?? record.createdAt, ...rows.jobs.map(j => j.updatedAt)),
    preview: row?.preview.split("\n").find(line => line.trim()) ?? "", channels: extra.channels, host: record.host, room: record.room, home: record.home,
  };
}

export class Agents {
  private migrating?: Promise<void>;
  /** Root chats the last migration left without a record, so the poll does not start it again for them. */
  private tried = new Set<string>();

  constructor(
    readonly store: AgentStore,
    readonly state: Store,
    readonly host: Host,
    readonly box: string,
    private readonly log: (line: string) => void = () => {},
  ) {}

  /** The agent an agent id, a DM room id or one of its thread ids belongs to. */
  record(id: string): AgentRecord | undefined {
    if (isRoomId(id)) return this.store.agentByRoom(id);
    return this.store.agentOf(id);
  }

  list(): AgentRecord[] {
    return this.store.agents.agents;
  }

  /** The record whose main work thread is `thread`. */
  ofWorkThread(thread: string): AgentRecord | undefined {
    return this.store.agents.agents.find(a => a.workThread === thread);
  }

  /** Root job threads aliased to the agent. */
  jobThreads(record: AgentRecord): string[] {
    return Object.entries(this.store.agents.aliases).filter(([thread, id]) => id === record.id && thread !== record.workThread).map(([thread]) => thread);
  }

  /**
   * A record for a work thread just made: its slug is its name's (with -2, -3 on a clash), its room is `dm_<slug>`, and its feed starts at
   * the thread's first entry.
   */
  add(thread: DurableThread): AgentRecord {
    const known = this.ofWorkThread(thread.id);
    if (known) return known;
    const slug = freeSlug(thread.name || "agent", new Set(this.store.agents.agents.map(a => a.slug)));
    const record: AgentRecord = {
      id: `ag_${slug}`, slug, name: thread.name || slug, room: `dm_${slug}`, workThread: thread.id, host: this.box, home: thread.cwd, createdAt: thread.createdAt, archived: thread.archived,
    };
    this.store.agents.agents.push(record);
    this.store.agents.aliases[thread.id] = record.id;
    this.store.rooms.rooms.push({ id: record.room, kind: "dm", agent: record.id, createdAt: record.createdAt, archived: record.archived });
    this.store.rooms.feed[record.id] = { entry: 0, open: {} };
    this.store.saveAgents();
    this.store.saveRooms();
    return record;
  }

  /** Files a root job thread under the agent `parent` names (an agent id or one of its thread ids). */
  alias(thread: string, parent: string): AgentId | undefined {
    const record = this.record(parent);
    if (!record) return undefined;
    this.store.agents.aliases[thread] = record.id;
    this.store.saveAgents();
    return record.id;
  }

  /** Names and archived flags follow the work threads; answers whether a record changed. */
  follow(rows: ReadonlyMap<string, DurableThread>): boolean {
    let changed = false;
    for (const record of this.store.agents.agents) {
      const row = rows.get(record.workThread);
      if (!row) continue;
      if ((row.name && row.name !== record.name) || row.archived !== record.archived) {
        record.name = row.name || record.name;
        record.archived = row.archived;
        const room = this.store.rooms.rooms.find(r => r.id === record.room);
        if (room) room.archived = row.archived;
        changed = true;
      }
    }
    if (changed) {
      this.store.saveAgents();
      this.store.saveRooms();
    }
    return changed;
  }

  /** Root chats that belong to no agent: not archived, not a job, and in no record or alias. */
  unrecorded(rows: Iterable<DurableThread>): DurableThread[] {
    return [...rows].filter(t => !t.archived && this.state.state.threads[t.id]?.kind !== "job" && !this.store.agents.aliases[t.id] && !this.ofWorkThread(t.id));
  }

  get migrationRunning(): boolean {
    return this.migrating !== undefined;
  }

  /**
   * Runs the migration in the background when a root chat has no record yet, at start and whenever the poll finds a new one, one run at a
   * time. It writes through this server's own store and state, so nothing here reads its files again. `done` runs after a run that changed
   * anything.
   */
  migrateIfNeeded(rows: Iterable<DurableThread>, dataDir: string, done: () => void): Promise<void> | undefined {
    if (this.migrating) return this.migrating;
    const missing = this.unrecorded(rows).filter(t => !this.tried.has(t.id));
    if (!missing.length) return undefined;
    const before = this.store.agents.agents.length;
    this.migrating = migrateAgents(this.host, dataDir, { apply: true, log: this.log, store: this.store, state: this.state })
      .then(() => {
        for (const thread of missing) if (!this.ofWorkThread(thread.id) && !this.store.agents.aliases[thread.id]) this.tried.add(thread.id);
        if (this.store.agents.agents.length !== before) done();
      })
      .catch(error => this.log(`agents migration failed: ${error instanceof Error ? error.stack : String(error)}`))
      .finally(() => { this.migrating = undefined; });
    return this.migrating;
  }
}
