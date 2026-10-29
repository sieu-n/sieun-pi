/**
 * Agents as the chat server keeps them (apps/chat/docs/agent-model.md, phase 2): each `AgentRecord` in `agents.json` joined with its work
 * thread's live row into the `AgentSummary` the pages see, the thread ids that belong to each agent, new agents with their work thread and DM
 * room, and the `agent.ref` doc that points each of an agent's threads at its folder (phase 3, `agent-folder.ts`). A root chat becomes an
 * agent only through `POST /api/agents` or the migrate CLI (`scripts/migrate-agents.ts`); the server never registers one on its own.
 *
 * Phase 4 splits an agent into its work thread and one comm thread per room (`ensureComm`): the comm thread takes the room's posts and talks
 * in the room, and the work thread does the work. The DM's first delivery makes the comm thread, and `POST /api/agents/:id/split` makes it
 * for the migration (`scripts/split-agents.ts`), whose dry run reads `splitPlan`.
 */
import type { AgentId, AgentSummary, RunStatus, ThinkingLevel } from "../web/src/lib/api/types.ts";
import { AGENT_REF_DOC, agentRef, commRef, sameRef, type AgentRef } from "./agent-folder.ts";
import { freeSlug, isUntitled, type AgentRecord, type AgentStore, type RoomId } from "./agent-store.ts";
import { DEFAULT_MODEL, type Config } from "./config.ts";
import type { DurableThread, Host, TreeNode } from "./host/types.ts";
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
  /** The agent's comm threads, with each row pi-host listed. */
  comm?: { room: RoomId; thread: string; row?: DurableThread }[];
}

const runStatus = (row: DurableThread | undefined): RunStatus => (row?.status === "running" ? "working" : row?.status ?? "idle");

/**
 * An agent works while its work thread, any conversation in it, or any of its root job threads runs. A comm thread's turn does not count,
 * so the Work pill stays off while it answers; only the DM's own status counts it (rooms.ts).
 */
export function agentStatus(rows: AgentRows): RunStatus {
  if (rows.row?.status === "running" || rows.tree.some(n => n.status === "running") || rows.jobs.some(j => j.status === "running")) return "working";
  return rows.row?.status ?? "idle";
}

/** What `ensureComm` does for an agent's room, without doing it; `"<new>"` stands for the id of a comm thread not made yet. */
export interface SplitPlan {
  agent: AgentId; room: RoomId; workThread: string;
  /** The comm thread the record holds for the room, or the one ensureComm would create. */
  comm: { thread: string; created: false } | { thread: null; created: true; create: { name: string; model: string; thinkingLevel: string; cwd: string } };
  /** agent.ref of the comm thread after the split. */
  commRef: AgentRef;
  /** agent.ref of the work thread now (as docGet reads it, or null) and after. */
  workRef: { before: unknown; after: AgentRef };
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
    ...(rows.comm?.length ? { comm: rows.comm.map(c => ({ room: c.room, thread: c.thread, status: runStatus(c.row) })) } : {}),
  };
}

export class Agents {
  /** Whether `dropUntitled` ran on this server's first thread list. */
  private cleaned = false;
  /** The `agent.ref` each thread holds as this server last read or wrote it, so a sweep reads a thread once per run. */
  private refs = new Map<string, AgentRef>();
  private sweeping?: Promise<void>;
  /** The comm thread being made per `<agent id>/<room>`, so two deliveries at once make one. */
  private readonly making = new Map<string, Promise<string>>();

  constructor(
    readonly store: AgentStore,
    readonly state: Store,
    readonly host: Host,
    readonly config: Pick<Config, "box" | "agentsDir" | "agentRefs">,
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

  /** The agent and room whose comm thread `thread` is. */
  ofComm(thread: string): { record: AgentRecord; room: RoomId } | undefined {
    return this.store.commOwner(thread);
  }

  isComm(thread: string): boolean {
    return this.store.commOwner(thread) !== undefined;
  }

  /** The thread the room's feed reads and the room's posts go to: the comm thread once there is one, else the work thread. */
  roomThread(record: AgentRecord, room: RoomId = record.room): string {
    return record.comm?.[room] ?? record.workThread;
  }

  private commCreate(record: AgentRecord): { name: string; model: string; thinkingLevel: string; cwd: string } {
    return { name: `${record.name} · DM`, model: DEFAULT_MODEL, thinkingLevel: "high", cwd: record.home };
  }

  /** What `ensureComm(record)` would do, read with no writes, for the migration's dry run. */
  async splitPlan(record: AgentRecord, room: RoomId = record.room): Promise<SplitPlan> {
    const known = record.comm?.[room];
    const after = { ...record, comm: { ...record.comm, [room]: known ?? "<new>" } };
    return {
      agent: record.id, room, workThread: record.workThread,
      comm: known ? { thread: known, created: false } : { thread: null, created: true, create: this.commCreate(record) },
      commRef: commRef(this.config.agentsDir, record, room),
      workRef: { before: (await this.host.docGet(record.workThread, AGENT_REF_DOC)) ?? null, after: agentRef(this.config.agentsDir, after, "work") },
    };
  }

  /**
   * The agent's comm thread for `room`: the one the record holds, or a new thread on Opus 5.5 at high thinking (c31) in the agent's home,
   * saved in the record before anything else. Each call then writes the comm thread's `agent.ref` and the work thread's, which names the
   * comm thread, and throws while the comm thread's ref is not written, so the caller tries again before the comm thread gets an input
   * without its role.
   */
  async ensureComm(record: AgentRecord, room: RoomId = record.room): Promise<string> {
    const key = `${record.id}/${room}`;
    let thread = record.comm?.[room];
    if (!thread) {
      let making = this.making.get(key);
      if (!making) {
        making = this.host.create(this.commCreate(record)).then(created => {
          record.comm = { ...record.comm, [room]: created.id };
          this.store.saveAgents();
          return created.id;
        }).finally(() => this.making.delete(key));
        this.making.set(key, making);
      }
      thread = await making;
    }
    const wrote = await this.putRef(thread, commRef(this.config.agentsDir, record, room));
    if (room === record.room) await this.putRef(record.workThread, agentRef(this.config.agentsDir, record, "work"));
    if (!wrote) throw new Error(`The agent.ref of ${record.id}'s comm thread ${thread} is not written yet.`);
    return thread;
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
      id: `ag_${slug}`, slug, name: thread.name || slug, room: `dm_${slug}`, workThread: thread.id, host: this.config.box, home: thread.cwd, createdAt: thread.createdAt, archived: thread.archived,
    };
    this.store.agents.agents.push(record);
    this.store.agents.aliases[thread.id] = record.id;
    this.store.rooms.rooms.push({ id: record.room, kind: "dm", agent: record.id, createdAt: record.createdAt, archived: record.archived });
    this.store.rooms.feed[record.id] = { entry: 0, open: {} };
    this.store.saveAgents();
    this.store.saveRooms();
    void this.putRef(thread.id, agentRef(this.config.agentsDir, record, "work"));
    return record;
  }

  /** Files a root job thread under the agent `parent` names (an agent id or one of its thread ids). */
  alias(thread: string, parent: string): AgentId | undefined {
    const record = this.record(parent);
    if (!record) return undefined;
    this.store.agents.aliases[thread] = record.id;
    this.store.saveAgents();
    void this.putRef(thread, agentRef(this.config.agentsDir, record, thread === record.workThread ? "work" : "job"));
    return record.id;
  }

  /**
   * The `agent.ref` each thread of each agent should hold: the work thread as "work", each root job thread aliased to it as "job", and each
   * comm thread as "comm".
   */
  wantedRefs(): Map<string, AgentRef> {
    const out = new Map<string, AgentRef>();
    for (const record of this.list()) {
      out.set(record.workThread, agentRef(this.config.agentsDir, record, "work"));
      for (const thread of this.jobThreads(record)) out.set(thread, agentRef(this.config.agentsDir, record, "job"));
      for (const [room, thread] of Object.entries(record.comm ?? {})) out.set(thread, commRef(this.config.agentsDir, record, room));
    }
    return out;
  }

  /**
   * Writes `agent.ref` into every thread of every agent that pi-host lists (`listed`) and does not hold it yet, one sweep at a time. A
   * thread whose ref this run already read or wrote is skipped, and one whose read or write failed is tried again on the next sweep. The
   * server sweeps at start, after each thread list read and after the migration, so a new alias lands within one poll.
   */
  sweepRefs(listed: (thread: string) => boolean = () => true): Promise<void> {
    if (!this.config.agentRefs) return Promise.resolve();
    this.sweeping ??= (async () => {
      for (const [thread, ref] of this.wantedRefs()) if (listed(thread)) await this.putRef(thread, ref);
    })().finally(() => { this.sweeping = undefined; });
    return this.sweeping;
  }

  /**
   * Reads the thread's `agent.ref` and writes `ref` only when it is missing or different; answers whether the thread holds it now. A failure
   * logs and never throws. With `agentRefs` off, no ref is written and every thread counts as holding it.
   */
  private async putRef(thread: string, ref: AgentRef): Promise<boolean> {
    if (!this.config.agentRefs || sameRef(this.refs.get(thread), ref)) return true;
    try {
      if (!sameRef(await this.host.docGet(thread, AGENT_REF_DOC), ref)) await this.host.docPut(thread, AGENT_REF_DOC, ref);
      this.refs.set(thread, ref);
      return true;
    } catch (error) {
      this.log(`agent.ref for ${thread} (${ref.agent}) not written, next sweep tries again: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
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

  /**
   * Once per server start, on the first thread list: drops each untitled record whose work thread is still untitled, with its aliases, and
   * archives its DM room, so the thread shows again as a solo chat. The old poll-time migration made ag_new-thread on 10-29, and the composer's
   * "new chat", which called `POST /api/agents` with no name, made ag_new-thread-2 to -4. A second run finds nothing, since the record is gone.
   */
  dropUntitled(rows: ReadonlyMap<string, DurableThread>): AgentRecord[] {
    if (this.cleaned) return [];
    this.cleaned = true;
    const dropped = this.store.agents.agents.filter(record => {
      const row = rows.get(record.workThread);
      return isUntitled(record.name) && row !== undefined && isUntitled(row.name);
    });
    if (!dropped.length) return [];
    const ids = new Set(dropped.map(r => r.id));
    this.store.agents.agents = this.store.agents.agents.filter(r => !ids.has(r.id));
    for (const [thread, id] of Object.entries(this.store.agents.aliases)) if (ids.has(id)) delete this.store.agents.aliases[thread];
    for (const room of this.store.rooms.rooms) if (ids.has(room.agent)) room.archived = true;
    this.store.saveAgents();
    this.store.saveRooms();
    for (const record of dropped) this.log(`dropped ${record.id} (${record.name}): an untitled root chat the old migration made an agent; ${record.workThread} is a solo chat again`);
    return dropped;
  }

  /** Root chats that belong to no agent: not archived, not a job, and in no record, alias or comm thread. */
  unrecorded(rows: Iterable<DurableThread>): DurableThread[] {
    return [...rows].filter(t => !t.archived && this.state.state.threads[t.id]?.kind !== "job" && !this.store.agents.aliases[t.id] && !this.ofWorkThread(t.id) && !this.isComm(t.id));
  }
}
