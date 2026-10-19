import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type DaemonAnswer, type UnloadClient, unloadRequest } from "./idle-unload.ts";
import { type Handoff, type OrphanRecord, type OrphanService, type PreparedGroup, logPath, ORPHAN_SERVICES_DIR, readRecord, unitName, writeRecord } from "./orphan-services.ts";

/**
 * Handing a session's detached services to systemd --user scopes of their own, then freeing its kernel through the idle unload's kill, on
 * Prime's detached handoff contract (revision 3, p8-metal/detached-handoff-contract.md, native commit 14aaf8f). Prepare is stateless and lists
 * each detached group with its process identities; this side moves the group into its scope; commit checks the identities and the cgroup,
 * saves a receipt, and only then does Prime drop its own cleanup. Every call reuses one handoffId and carries the lasting sessionId, and the
 * record is written before each step that acts, so a rerun after a crash at any point ends with one receipt, one record and one scope per
 * group, never none and never two.
 */
export const HANDOFF_CAPABILITY = "detached_handoff";
/** The protocol version the three handoff commands need (`DAEMON_COMMAND_COMPATIBILITY`). */
export const HANDOFF_PROTOCOL = 7;

export interface ProcessIdentity { pid: number; startTime: string }
export interface CandidateGroup { pgid: number; leader: ProcessIdentity; members: (ProcessIdentity & { cgroup: string })[]; command: string; cgroup: string }
export interface MovedGroup { pgid: number; leader: ProcessIdentity; members: ProcessIdentity[]; cgroup: string }
export interface ReceiptGroup { pgid: number; cgroup: string; leader: ProcessIdentity; members: ProcessIdentity[]; exited: ProcessIdentity[] }
export interface Receipt { handoffId: string; receiptId: string; state: "committed" | "stopped"; sessionId: string; bootId: string; committedAt: string; groups: ReceiptGroup[] }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;
const identity = (value: unknown): ProcessIdentity | null =>
  isRecord(value) && positive(value.pid) && typeof value.startTime === "string" ? { pid: value.pid, startTime: value.startTime } : null;
const identities = (value: unknown): ProcessIdentity[] | null => {
  if (!Array.isArray(value)) return null;
  const parsed = value.map(identity);
  return parsed.every(entry => entry !== null) ? parsed as ProcessIdentity[] : null;
};

export function parseReceipt(value: unknown): Receipt | null {
  if (!isRecord(value) || value.kind !== "prime-agent/detached-handoff-receipt" || (value.state !== "committed" && value.state !== "stopped") ||
    typeof value.handoffId !== "string" || typeof value.receiptId !== "string" || typeof value.sessionId !== "string" || typeof value.bootId !== "string" ||
    !Array.isArray(value.groups)) return null;
  const groups: ReceiptGroup[] = [];
  for (const group of value.groups) {
    if (!isRecord(group) || !positive(group.pgid) || typeof group.cgroup !== "string") return null;
    const leader = identity(group.leader);
    const members = identities(group.members);
    const exited = identities(group.exited ?? []);
    if (!leader || !members || !exited) return null;
    groups.push({ pgid: group.pgid, cgroup: group.cgroup, leader, members, exited });
  }
  return { handoffId: value.handoffId, receiptId: value.receiptId, state: value.state, sessionId: value.sessionId, bootId: value.bootId,
    committedAt: typeof value.committedAt === "string" ? value.committedAt : "", groups };
}

export function parseCandidates(value: unknown): { bootId: string; groups: CandidateGroup[] } | null {
  if (!isRecord(value) || typeof value.bootId !== "string" || !Array.isArray(value.groups)) return null;
  const groups: CandidateGroup[] = [];
  for (const group of value.groups) {
    if (!isRecord(group) || !positive(group.pgid) || typeof group.cgroup !== "string" || !Array.isArray(group.members)) return null;
    const leader = identity(group.leader);
    const members = group.members.map(member => { const id = identity(member); return id && isRecord(member) && typeof member.cgroup === "string" ? { ...id, cgroup: member.cgroup } : null; });
    if (!leader || !members.every(member => member !== null)) return null;
    groups.push({ pgid: group.pgid, leader, members: members as CandidateGroup["members"], command: typeof group.command === "string" ? group.command : "", cgroup: group.cgroup });
  }
  return { bootId: value.bootId, groups };
}

/**
 * Prime's answer to prepare. `receipt` comes back as `handoff_already_committed` when an earlier commit with this id went through. `gone` means
 * nothing can be handed off under this id: the session is unknown or the id was aborted.
 */
export type PrepareAnswer = { bootId: string; groups: CandidateGroup[] } | { receipt: Receipt } | { gone: string } | { error: string };
/** Prime's answer to commit. `again` names a refusal a fresh prepare and move can fix (the group changed, or a member sits outside the scope). */
export type CommitAnswer = { receipt: Receipt } | { again: string } | { error: string };

export interface HandoffPorts {
  read(sessionId: string): Promise<OrphanRecord | null>;
  write(record: OrphanRecord): Promise<void>;
  prepare(sessionId: string, handoffId: string): Promise<PrepareAnswer>;
  commit(sessionId: string, handoffId: string, groups: readonly MovedGroup[]): Promise<CommitAnswer>;
  /** Puts the live pids into the scope, or finds them already in it, and answers the scope's cgroup path. */
  scope(unit: string, pids: readonly number[]): Promise<{ cgroup: string } | { error: string }>;
  logPath(pid: number): Promise<string | null>;
  kill(activeSessionId: string): Promise<DaemonAnswer>;
  now(): number;
  newId(): string;
}

export type HandoffOutcome = { done: true; handoff: Handoff } | { done: false; state: Handoff["state"] | "none"; error: string };

/**
 * The record's services, from the receipt alone; `prepared` adds the command. The service is the last member after the old shell that writes
 * to a file, else the last member after the shell: `cd W && nohup svc > log 2>&1 &` leaves a subshell between the shell and svc, and the first
 * member after the shell named that subshell with no log (run F1 on f6ab3c0b, 10-19).
 */
async function servicesOf(sessionId: string, receipt: Receipt, prepared: readonly PreparedGroup[], ports: Pick<HandoffPorts, "logPath">): Promise<OrphanService[]> {
  return Promise.all(receipt.groups.map(async group => {
    const after = group.members.filter(member => member.pid !== group.pgid);
    const logs = await Promise.all(after.map(member => ports.logPath(member.pid)));
    const at = logs.findLastIndex(log => log !== null);
    const service = after[at] ?? after.at(-1) ?? group.leader;
    return { pid: service.pid, pgid: group.pgid, processStartId: `proc:${service.startTime}`, members: group.members.map(member => member.pid),
      unit: unitName(sessionId, group.pgid), cgroup: group.cgroup, log: logs[at] ?? (service === group.leader ? await ports.logPath(service.pid) : null),
      command: prepared.find(entry => entry.pgid === group.pgid)?.command ?? "", committedAt: receipt.committedAt };
  }));
}

/** The handoff a call goes on with: the one furthest from its receipt first. */
const RANK: Record<Handoff["state"], number> = { pending: 0, moving: 1, received: 2, unloaded: 3 };
const next = (record: OrphanRecord): Handoff | undefined =>
  [...record.handoffs].filter(entry => entry.state !== "unloaded").sort((a, b) => RANK[a.state] - RANK[b.state])[0];
const UNKNOWN_SESSION = /Unknown active session/;
/** How many prepare, move and commit rounds one call runs when commit asks for a fresh prepare. */
const ROUNDS = 3;

/**
 * Runs the session's unfinished handoffs to their end, or starts one. Each step reads the state the last write left, so any thrown error, a
 * crash included, leaves a state the next call goes on from. When the guard refuses the kill because the session started another detached
 * service after its receipt, a second handoff takes that one, once per call; a successful kill marks every received handoff of the session unloaded.
 * With `resume` it only finishes an unfinished handoff and answers null when the record holds none. A crash after commit leaves no detached
 * group for the guard to refuse, so the idle kill alone would succeed and the record would stay `moving` (run F2 on f6ab3c0b, 10-19): the
 * idle unload resumes before its kill, and a session no longer loaded is resumed from its record.
 */
export async function handOff(row: { sessionId: string; activeSessionId?: string }, ports: HandoffPorts, resume = false): Promise<HandoffOutcome | null> {
  let record: OrphanRecord = await ports.read(row.sessionId) ?? { version: 1, sessionId: row.sessionId, handoffs: [] };
  const at = (): string => new Date(ports.now()).toISOString();
  const save = async (handoffs: Handoff[]): Promise<void> => {
    record = { ...record, handoffs };
    await ports.write(record);
  };
  const replace = (entry: Handoff | null, handoffId: string): Handoff[] =>
    [...record.handoffs.filter(other => other.handoffId !== handoffId), ...entry ? [entry] : []];
  const begin = async (activeSessionId: string): Promise<void> => {
    await save([...record.handoffs, { state: "pending", handoffId: ports.newId(), activeSessionId, at: at() }]);
  };
  const received = async (entry: Handoff, receipt: Receipt, prepared: readonly PreparedGroup[]): Promise<void> => {
    const services = await servicesOf(row.sessionId, receipt, prepared, ports);
    await save(replace({ state: "received", handoffId: entry.handoffId, activeSessionId: entry.activeSessionId, at: entry.at, receiptId: receipt.receiptId,
      bootId: receipt.bootId, services }, entry.handoffId));
  };
  if (!next(record)) {
    if (resume || row.activeSessionId === undefined) return null;
    await begin(row.activeSessionId);
  }
  let again = true;
  let unloaded: Handoff | undefined;
  let rounds = 0;
  for (let entry = next(record); entry; entry = next(record)) {
    switch (entry.state) {
      case "pending":
      case "moving": {
        if (++rounds > ROUNDS) return { done: false, state: entry.state, error: "the groups kept changing between prepare and commit" };
        const prepared = await ports.prepare(row.sessionId, entry.handoffId);
        if ("receipt" in prepared) { await received(entry, prepared.receipt, entry.state === "moving" ? entry.prepared : []); break; }
        // Prepare needs the live session, and commit does not: the daemon answers a commit it already holds from its receipt.
        if ("gone" in prepared && entry.state === "moving" && entry.moved?.length) {
          const replayed = await ports.commit(row.sessionId, entry.handoffId, entry.moved);
          if ("receipt" in replayed) { await received(entry, replayed.receipt, entry.prepared); break; }
        }
        if ("gone" in prepared) { await save(replace(null, entry.handoffId)); continue; }
        if ("error" in prepared) return { done: false, state: entry.state, error: prepared.error };
        if (!prepared.groups.length) { await save(replace(null, entry.handoffId)); continue; }
        const groups = prepared.groups.map(group => ({ pgid: group.pgid, command: group.command }));
        const keep = entry.state === "moving" ? entry.prepared.filter(old => !groups.some(group => group.pgid === old.pgid)) : [];
        const moving: Handoff = { state: "moving", handoffId: entry.handoffId, activeSessionId: entry.activeSessionId, at: entry.at, prepared: [...keep, ...groups] };
        await save(replace(moving, entry.handoffId));
        const moved: MovedGroup[] = [];
        for (const group of prepared.groups) {
          const scoped = await ports.scope(unitName(row.sessionId, group.pgid), group.members.map(member => member.pid));
          if ("error" in scoped) return { done: false, state: "moving", error: `${unitName(row.sessionId, group.pgid)}: ${scoped.error}` };
          moved.push({ pgid: group.pgid, leader: group.leader, members: group.members.map(({ pid, startTime }) => ({ pid, startTime })), cgroup: scoped.cgroup });
        }
        await save(replace({ ...moving, moved }, entry.handoffId));
        const committed = await ports.commit(row.sessionId, entry.handoffId, moved);
        if ("again" in committed) continue;
        if ("error" in committed) return { done: false, state: "moving", error: committed.error };
        await received(moving, committed.receipt, moving.prepared);
        break;
      }
      case "received": {
        const killed = await ports.kill(entry.activeSessionId);
        if (!killed.success && killed.detachedHold && again) { again = false; await begin(entry.activeSessionId); continue; }
        if (!killed.success && !UNKNOWN_SESSION.test(killed.error)) return { done: false, state: "received", error: killed.error };
        const unloadedAt = at();
        const session = entry.activeSessionId;
        await save(record.handoffs.map(other => other.state === "received" && other.activeSessionId === session ? { ...other, state: "unloaded", unloadedAt } : other));
        unloaded = record.handoffs.find(other => other.handoffId === entry!.handoffId);
        break;
      }
      case "unloaded":
        break;
    }
  }
  return unloaded ? { done: true, handoff: unloaded } : { done: false, state: "none", error: "the session holds no detached group Prime can hand off" };
}

function run(command: string, args: readonly string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise(resolve => {
    execFile(command, [...args], { timeout: 30_000 }, (error, stdout, stderr) => resolve({ ok: !error, out: `${stdout}${stderr}`.trim() }));
  });
}

/**
 * Puts the pids into a new transient scope through StartTransientUnit with a PIDs property, and answers its cgroup path. `systemd-run --scope`
 * only starts a new command, and AttachProcessesToUnit answers "Process migration not available on non-delegated units" for a plain scope
 * (both tried on us-metal02, systemd 259, 10-18). A rerun finds the scope by name and checks each live pid's cgroup.
 */
export async function scopeUnit(unit: string, pids: readonly number[]): Promise<{ cgroup: string } | { error: string }> {
  const cgroup = (pid: number): Promise<string | null> => readFile(`/proc/${pid}/cgroup`, "utf8").then(text => /^0::(.*)$/m.exec(text)?.[1] ?? null, () => null);
  const inside = (group: string | null): boolean => group !== null && group.endsWith(`/${unit}`);
  const live = (await Promise.all(pids.map(async pid => [pid, await cgroup(pid)] as const))).filter(([, group]) => group !== null);
  if (!live.length) return { error: "no member of the group is alive" };
  let said = "";
  if (!live.every(([, group]) => inside(group))) {
    said = (await run("busctl", ["--user", "call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager",
      "StartTransientUnit", "ssa(sv)a(sa(sv))", unit, "fail", "2", "PIDs", "au", String(live.length), ...live.map(([pid]) => String(pid)),
      "CollectMode", "s", "inactive-or-failed", "0"])).out;
  }
  // StartTransientUnit only queues a job, so the move shows in /proc a moment after busctl returns (run2c on 10-18 read the old cgroup at once).
  let now: string[] = [];
  for (let tries = 0; tries < 20; tries++) {
    now = (await Promise.all(live.map(([pid]) => cgroup(pid)))).filter((group): group is string => group !== null);
    if (now.length && now.every(inside)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return now.length && now.every(inside) ? { cgroup: now[0]! } : { error: `the scope does not hold every live member${said ? ` (busctl: ${said.slice(0, 200)})` : ""}` };
}

/** The refusal codes a fresh prepare and move can fix. */
const AGAIN = new Set(["handoff_not_in_target_cgroup", "handoff_identity_mismatch", "handoff_group_not_owned"]);
type Failure = { success: false; error?: string; errorInfo?: { code?: string; receipt?: unknown } };
const codeOf = (answer: Failure): string | undefined => answer.errorInfo?.code;

/** Sends one handoff command and resolves the daemon's response. */
export type HandoffSend = (body: Record<string, unknown>) => Promise<unknown>;

/**
 * The real ports: the record directory, the daemon connection of the session's box, systemd and /proc. Use only when the hello lists
 * HANDOFF_CAPABILITY. `send` defaults to `client.request`, which needs a pinned prime-agent whose command table lists the three handoff
 * commands: 0.9.8's client refuses them before the write ("Cannot read properties of undefined (reading 'minProtocol')", run2 on 10-18).
 */
export function systemPorts(client: UnloadClient, dir = ORPHAN_SERVICES_DIR, send: HandoffSend = body => client.request(body as never, 30_000, { recoverable: false })): HandoffPorts {
  const ask = async (body: Record<string, unknown>): Promise<{ success: true; data?: unknown } | Failure> => {
    try { return await send(body) as { success: true; data?: unknown } | Failure; }
    catch (error) { return { success: false, error: String(error) }; }
  };
  const receiptOf = (value: unknown): Receipt | null => parseReceipt(isRecord(value) ? value.receipt ?? value : value);
  return {
    read: sessionId => readRecord(dir, sessionId),
    write: record => writeRecord(dir, record),
    prepare: async (sessionId, handoffId) => {
      const answer = await ask({ type: "prepare_detached_handoff", sessionId, handoffId });
      if (answer.success) {
        const candidates = parseCandidates(answer.data);
        return candidates ?? { error: "the daemon's prepare answer lists no groups" };
      }
      const code = codeOf(answer);
      const receipt = code === "handoff_already_committed" ? receiptOf(answer.errorInfo) : null;
      if (receipt) return { receipt };
      if (code === "handoff_aborted" || UNKNOWN_SESSION.test(answer.error ?? "")) return { gone: code ?? answer.error ?? "" };
      return { error: `${code ?? "prepare failed"}: ${answer.error ?? ""}` };
    },
    commit: async (sessionId, handoffId, groups) => {
      const answer = await ask({ type: "commit_detached_handoff", sessionId, handoffId, groups });
      if (answer.success) {
        const receipt = receiptOf(answer.data);
        return receipt ? { receipt } : { error: "the daemon's commit answer holds no receipt" };
      }
      const code = codeOf(answer);
      const receipt = code === "handoff_already_committed" || code === "handoff_id_conflict" ? receiptOf(answer.errorInfo) : null;
      if (receipt) return { receipt };
      if (code && AGAIN.has(code)) return { again: code };
      return { error: `${code ?? "commit failed"}: ${answer.error ?? ""}` };
    },
    scope: scopeUnit,
    logPath,
    kill: activeSessionId => unloadRequest(client, activeSessionId, "kill"),
    now: Date.now,
    newId: () => `sieun-pi-${randomUUID()}`,
  };
}

/** Whether the daemon of this hello speaks the handoff: the capability at protocol 7 or later. */
export function speaksHandoff(hello: { serverCapabilities?: readonly string[]; protocol?: { version: number } } | null | undefined): boolean {
  return !!hello && (hello.serverCapabilities ?? []).includes(HANDOFF_CAPABILITY) && (hello.protocol?.version ?? 0) >= HANDOFF_PROTOCOL;
}
