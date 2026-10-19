// The detached-service handoff before an idle unload, on Prime's contract revision 3 (10-18): one receipt, one record and one scope per group
// after a crash at any step, never none and never two.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { type CandidateGroup, handOff, type HandoffPorts, type MovedGroup, parseCandidates, parseReceipt, type Receipt, speaksHandoff } from "../src/detached-handoff.ts";
import { type DaemonAnswer, IdleUnloader, unloadPlan } from "../src/idle-unload.ts";
import { endLeftovers, type LeftoverSource } from "../src/job-leftovers.ts";
import { servicesLine } from "../src/mac-usable-watch.ts";
import { listOrphanServices, type OrphanRecord, readRecord, stopOrphanServices, unitName, writeRecord } from "../src/orphan-services.ts";

const SESSION = "01a15036-8379-72fc-87d6-1009c1a88ebc";
const ACTIVE = "c336f37372aa";
const KERNEL_CGROUP = "/user.slice/app.slice/prime-agent.service";
const scopeCgroup = (unit: string): string => `/user.slice/app.slice/${unit}`;

interface Proc { pid: number; startTime: string; pgid: number; cgroup: string }

/**
 * Prime's side of contract revision 3, as a stub: prepare is stateless and lists each untransferred group with its identities, commit checks
 * the identities and that every live member sits in the target cgroup, saves a receipt and only then drops its cleanup, a repeat with the same
 * handoffId replays the receipt, the idle kill leaves transferred groups alive, and an owner stop kills them after a re-check from the receipt.
 */
class StubPrime {
  readonly procs = new Map<number, Proc>();
  readonly receipts = new Map<string, Receipt & { kind: string }>();
  readonly transferred = new Set<number>();
  readonly sessions = new Map<string, { active: string; groups: number[] }>();
  commits = 0;
  constructor() {
    this.sessions.set(SESSION, { active: ACTIVE, groups: [] });
    this.start(400, [401]);
  }
  start(pgid: number, members: number[], session = SESSION): void {
    for (const pid of [pgid, ...members]) this.procs.set(pid, { pid, startTime: `${pid}00`, pgid, cgroup: KERNEL_CGROUP });
    this.sessions.get(session)!.groups.push(pgid);
  }
  live(pgid: number): Proc[] { return [...this.procs.values()].filter(proc => proc.pgid === pgid); }
  prepare(sessionId: string, handoffId: string): DaemonAnswer & { errorInfo?: unknown } {
    const session = this.sessions.get(sessionId);
    if (!session) return { success: false, error: `Unknown active session: ${sessionId}` };
    const receipt = this.receipts.get(handoffId);
    if (receipt) return { success: false, error: "already committed", errorInfo: { code: "handoff_already_committed", sessionId, handoffId, receipt } } as never;
    const groups: CandidateGroup[] = session.groups.filter(pgid => !this.transferred.has(pgid) && this.procs.has(pgid)).map(pgid => ({
      pgid, leader: { pid: pgid, startTime: `${pgid}00` }, members: this.live(pgid).map(({ pid, startTime, cgroup }) => ({ pid, startTime, cgroup })),
      command: `nohup python3 -m http.server ${pgid} > /tmp/w/srv.log 2>&1 &`, cgroup: this.procs.get(pgid)!.cgroup }));
    return { success: true, data: { handoffId, sessionId, bootId: "boot-1", groups } };
  }
  commit(sessionId: string, handoffId: string, moved: readonly MovedGroup[]): DaemonAnswer & { errorInfo?: unknown; data?: unknown } {
    const stored = this.receipts.get(handoffId);
    if (stored) {
      const same = stored.groups.map(group => group.pgid).sort().join() === moved.map(group => group.pgid).sort().join();
      return same ? { success: true, data: { handoffId, sessionId, replayed: true, receipt: stored } }
        : { success: false, error: "conflict", errorInfo: { code: "handoff_id_conflict", sessionId, handoffId, receipt: stored } } as never;
    }
    for (const group of moved) {
      if (!this.sessions.get(sessionId)?.groups.includes(group.pgid) || this.transferred.has(group.pgid)) return { success: false, error: "not owned", errorInfo: { code: "handoff_group_not_owned" } } as never;
      if (this.procs.get(group.pgid)?.startTime !== group.leader.startTime) return { success: false, error: "identity", errorInfo: { code: "handoff_identity_mismatch" } } as never;
      const outside = this.live(group.pgid).filter(proc => proc.cgroup !== group.cgroup).map(proc => proc.pid);
      if (outside.length) return { success: false, error: "outside", errorInfo: { code: "handoff_not_in_target_cgroup", pids: outside } } as never;
    }
    const receipt = { kind: "prime-agent/detached-handoff-receipt", handoffId, receiptId: `rcpt-${++this.commits}`, state: "committed", sessionId, bootId: "boot-1", committedAt: "2026-10-18T22:00:00.000Z",
      groups: moved.map(group => ({ pgid: group.pgid, cgroup: group.cgroup, leader: group.leader,
        members: this.live(group.pgid).map(({ pid, startTime }) => ({ pid, startTime })), exited: group.members.filter(member => !this.procs.has(member.pid)) })) } satisfies Receipt & { kind: string };
    this.receipts.set(handoffId, receipt);
    for (const group of moved) this.transferred.add(group.pgid);
    return { success: true, data: { handoffId, sessionId, replayed: false, receipt } };
  }
  idleKill(active: string): DaemonAnswer {
    const [id, session] = [...this.sessions].find(([, entry]) => entry.active === active) ?? [];
    if (!id || !session) return { success: false, error: `Unknown active session: ${active}` };
    if (session.groups.some(pgid => !this.transferred.has(pgid) && this.procs.has(pgid))) return { success: false, error: "Idle unload skipped: the session holds detached processes", detachedHold: true };
    this.sessions.delete(id);
    return { success: true };
  }
  ownerStop(sessionId: string): void {
    for (const pgid of this.sessions.get(sessionId)?.groups ?? []) if (!this.transferred.has(pgid)) for (const proc of this.live(pgid)) this.procs.delete(proc.pid);
    for (const receipt of this.receipts.values()) {
      if (receipt.sessionId !== sessionId) continue;
      for (const group of receipt.groups) for (const proc of this.live(group.pgid)) if (proc.cgroup === group.cgroup) this.procs.delete(proc.pid);
    }
    this.sessions.delete(sessionId);
  }
}

const CRASH_POINTS = ["write:pending", "write:moving", "scope:made", "commit:linked", "write:received", "kill:sent", "write:unloaded"] as const;
type CrashPoint = typeof CRASH_POINTS[number];
class Crash extends Error {}

function world() {
  const prime = new StubPrime();
  const disk = new Map<string, string>();
  const scopes = new Map<string, number>();
  let ids = 0;
  let crash: CrashPoint | null = null;
  let fork: (() => void) | null = null;
  const quiet = new Set<number>();
  const hit = (point: CrashPoint): void => { if (crash === point) { crash = null; throw new Crash(point); } };
  const asked: string[] = [];
  const ports: HandoffPorts = {
    read: async session => { const text = disk.get(session); return text ? JSON.parse(text) as OrphanRecord : null; },
    write: async record => {
      const changed = record.handoffs.at(-1)?.state;
      if (crash === `write:${changed}`) hit(crash);
      disk.set(record.sessionId, JSON.stringify(record));
    },
    prepare: async (sessionId, handoffId) => {
      asked.push(handoffId);
      const answer = prime.prepare(sessionId, handoffId) as { success: boolean; data?: unknown; error?: string; errorInfo?: { code: string; receipt?: unknown } };
      if (answer.success) return parseCandidates(answer.data)!;
      if (answer.errorInfo?.code === "handoff_already_committed") return { receipt: parseReceipt(answer.errorInfo.receipt)! };
      return { gone: answer.error ?? "" };
    },
    commit: async (sessionId, handoffId, groups) => {
      const answer = prime.commit(sessionId, handoffId, groups) as { success: boolean; data?: { receipt: unknown }; error?: string; errorInfo?: { code: string; receipt?: unknown } };
      hit("commit:linked");
      if (answer.success) return { receipt: parseReceipt(answer.data!.receipt)! };
      if (answer.errorInfo?.receipt) return { receipt: parseReceipt(answer.errorInfo.receipt)! };
      return answer.errorInfo?.code === "handoff_not_in_target_cgroup" ? { again: answer.errorInfo.code } : { error: answer.errorInfo?.code ?? "?" };
    },
    scope: async (unit, pids) => {
      scopes.set(unit, (scopes.get(unit) ?? 0) + (scopes.has(unit) ? 0 : 1));
      for (const pid of pids) { const proc = prime.procs.get(pid); if (proc) proc.cgroup = scopeCgroup(unit); }
      fork?.(); fork = null;
      hit("scope:made");
      return { cgroup: scopeCgroup(unit) };
    },
    logPath: async pid => quiet.has(pid) ? null : "/tmp/w/srv.log",
    kill: async active => { const answer = prime.idleKill(active); hit("kill:sent"); return answer; },
    now: () => Date.parse("2026-10-18T22:05:00.000Z"),
    newId: () => `h-${++ids}`,
  };
  return { prime, disk, scopes, ports, asked, quiet, crashAt: (point: CrashPoint) => { crash = point; }, forkAfterScope: (run: () => void) => { fork = run; } };
}

const record = (disk: Map<string, string>): OrphanRecord => JSON.parse(disk.get(SESSION)!) as OrphanRecord;
const row = { sessionId: SESSION, activeSessionId: ACTIVE };

test("a handoff prepares, moves the group into its scope, commits, writes the record from the receipt and unloads; the service outlives the kernel", async () => {
  const w = world();
  const out = await handOff(row, w.ports);
  assert.equal(out?.done, true, JSON.stringify(out));
  const entries = record(w.disk).handoffs;
  assert.equal(entries.length, 1);
  const entry = entries[0]!;
  assert.equal(entry.state, "unloaded");
  assert.ok(entry.state === "unloaded");
  assert.equal(entry.receiptId, "rcpt-1");
  assert.equal(entry.bootId, "boot-1");
  assert.deepEqual(entry.services, [{ pid: 401, pgid: 400, processStartId: "proc:40100", members: [400, 401], unit: unitName(SESSION, 400),
    cgroup: scopeCgroup(unitName(SESSION, 400)), log: "/tmp/w/srv.log", command: "nohup python3 -m http.server 400 > /tmp/w/srv.log 2>&1 &", committedAt: "2026-10-18T22:00:00.000Z" }]);
  assert.ok(!w.prime.sessions.has(SESSION), "the kernel is freed");
  assert.ok(w.prime.procs.has(401), "the service still runs");
  assert.deepEqual([...w.asked], ["h-1"]);
});

for (const point of CRASH_POINTS) {
  test(`a crash at ${point} and a rerun end in one receipt, one record entry and one scope`, async () => {
    const w = world();
    w.crashAt(point);
    await assert.rejects(handOff(row, w.ports), Crash);
    const out = await handOff(row, w.ports);
    assert.equal(out?.done, true, JSON.stringify(out));
    assert.equal(w.prime.receipts.size, 1, "Prime saved one receipt");
    const entries = record(w.disk).handoffs;
    assert.deepEqual(entries.map(entry => entry.state), ["unloaded"]);
    assert.deepEqual([...new Set(w.asked)], [entries[0]!.handoffId], "Prime only ever saw the recorded handoffId");
    assert.deepEqual([...w.scopes], [[unitName(SESSION, 400), 1]], "one scope");
    assert.ok(w.prime.procs.has(401) && !w.prime.sessions.has(SESSION));
  });
}

test("a member forked outside the scope between the move and the commit gets a fresh prepare and move under the same handoffId", async () => {
  const w = world();
  w.forkAfterScope(() => { w.prime.procs.set(402, { pid: 402, startTime: "40200", pgid: 400, cgroup: KERNEL_CGROUP }); });
  const out = await handOff(row, w.ports);
  assert.equal(out?.done, true, JSON.stringify(out));
  assert.deepEqual(w.asked, ["h-1", "h-1"]);
  const entry = record(w.disk).handoffs[0]!;
  assert.ok(entry.state === "unloaded" && entry.services[0]!.members.includes(402));
});

test("a session Prime no longer knows drops its pending entry, moves nothing and sends no kill", async () => {
  const w = world();
  const out = await handOff({ sessionId: "01a15036-0000-0000-0000-000000000000", activeSessionId: "gone12345678" }, w.ports);
  assert.equal(out?.done, false);
  assert.deepEqual(JSON.parse(w.disk.get("01a15036-0000-0000-0000-000000000000")!).handoffs, []);
  assert.equal(w.scopes.size, 0);
});

test("a prepare that lists no group drops the entry and keeps the kernel", async () => {
  const w = world();
  w.prime.procs.clear();
  assert.equal((await handOff(row, w.ports))?.done, false);
  assert.deepEqual(record(w.disk).handoffs, []);
  assert.ok(w.prime.sessions.has(SESSION));
});

test("a prepare Prime refuses keeps the entry, and the rerun asks with the same handoffId", async () => {
  const w = world();
  const refuse = { ...w.ports, prepare: async (_s: string, handoffId: string) => { w.asked.push(handoffId); return { error: "handoff_unsupported: no cgroup v2" }; } };
  assert.deepEqual(await handOff(row, refuse), { done: false, state: "pending", error: "handoff_unsupported: no cgroup v2" });
  assert.equal((await handOff(row, w.ports))?.done, true);
  assert.deepEqual(w.asked, ["h-1", "h-1"]);
});

test("a scope that fails sends no commit and no kill, and the rerun finishes", async () => {
  const w = world();
  const out = await handOff(row, { ...w.ports, scope: async () => ({ error: "Access denied" }) });
  assert.deepEqual(out, { done: false, state: "moving", error: `${unitName(SESSION, 400)}: Access denied` });
  assert.equal(w.prime.receipts.size, 0);
  assert.ok(w.prime.sessions.has(SESSION));
  assert.equal((await handOff(row, w.ports))?.done, true);
  assert.equal(w.prime.receipts.size, 1);
});

test("a commit refusal that names no fix stays moving, and the native side keeps the group", async () => {
  const w = world();
  const out = await handOff(row, { ...w.ports, commit: async () => ({ error: "handoff_receipt_write_failed: EIO" }) });
  assert.deepEqual(out, { done: false, state: "moving", error: "handoff_receipt_write_failed: EIO" });
  assert.ok(!w.prime.transferred.has(400) && w.prime.sessions.has(SESSION));
});

test("a service started after the receipt gets a second handoff in the same call, and both unload together", async () => {
  const w = world();
  const ports = { ...w.ports, kill: async (active: string) => {
    if (!w.prime.procs.has(500)) w.prime.start(500, [501]);
    return w.ports.kill(active);
  } };
  const out = await handOff(row, ports);
  assert.equal(out?.done, true, JSON.stringify(out));
  assert.deepEqual(record(w.disk).handoffs.map(entry => [entry.handoffId, entry.state]), [["h-1", "unloaded"], ["h-2", "unloaded"]]);
  assert.deepEqual([...w.scopes.keys()].sort(), [unitName(SESSION, 400), unitName(SESSION, 500)]);
  assert.ok(w.prime.procs.has(401) && w.prime.procs.has(501));
});

test("the owner's stop still kills a transferred service in the stub, re-checked from the receipt", async () => {
  const w = world();
  await handOff({ ...row }, { ...w.ports, kill: async () => ({ success: false, error: "kept for the test" }) });
  w.prime.ownerStop(SESSION);
  assert.ok(!w.prime.procs.has(401) && !w.prime.procs.has(400));
});

test("parseReceipt and parseCandidates take only the contract's shapes", () => {
  const receipt = { kind: "prime-agent/detached-handoff-receipt", state: "committed", handoffId: "h", receiptId: "rcpt-1", sessionId: SESSION, bootId: "b",
    groups: [{ pgid: 4, cgroup: "/x", leader: { pid: 4, startTime: "1" }, members: [{ pid: 4, startTime: "1" }], exited: [] }] };
  assert.equal(parseReceipt(receipt)?.groups[0]?.pgid, 4);
  assert.equal(parseReceipt({ ...receipt, kind: "other" }), null);
  assert.equal(parseReceipt({ ...receipt, groups: [{ ...receipt.groups[0], leader: { pid: "4", startTime: "1" } }] }), null);
  assert.equal(parseCandidates({ bootId: "b", groups: [{ pgid: 4, cgroup: "/k", leader: { pid: 4, startTime: "1" }, members: [{ pid: 4, startTime: "1" }] }] }), null, "a member needs its cgroup");
  assert.equal(parseCandidates({ bootId: "b", groups: [] })?.groups.length, 0);
});

test("only a hello with detached_handoff at protocol 7 or later turns the handoff on", () => {
  assert.equal(speaksHandoff({ serverCapabilities: ["detached_handoff"], protocol: { version: 7 } }), true);
  assert.equal(speaksHandoff({ serverCapabilities: ["detached_handoff"], protocol: { version: 6 } }), false);
  assert.equal(speaksHandoff({ serverCapabilities: ["kill_origin"], protocol: { version: 7 } }), false);
  assert.equal(speaksHandoff(null), false);
});

test("the record file is written whole through a rename, listed with liveness, and stopped with its scope on delete", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orphan-services-"));
  const service = { pid: 401, pgid: 400, processStartId: "proc:9", members: [400, 401], unit: unitName(SESSION, 400), cgroup: "/x", log: null, command: "svc", committedAt: "" };
  await writeRecord(dir, { version: 1, sessionId: SESSION, handoffs: [{ state: "unloaded", handoffId: "h", activeSessionId: ACTIVE, at: "", receiptId: "r", bootId: "b", services: [service], unloadedAt: "" }] });
  assert.deepEqual(readdirSync(dir), [`${SESSION}.json`]);
  assert.equal((await readRecord(dir, SESSION))?.handoffs.length, 1);
  const listed = await listOrphanServices(dir, async pid => pid === 401 ? "proc:9" : null);
  assert.deepEqual(listed.map(line => [line.unit, line.live]), [[service.unit, true]]);
  assert.deepEqual(servicesLine(listed), { count: 1, live: 1, top: [{ session: SESSION, unit: service.unit, pid: 401, live: true }] });
  assert.equal(servicesLine([]), null);
  const stoppedUnits: string[] = [];
  assert.deepEqual(await stopOrphanServices([SESSION, "../etc"], dir, async unit => { stoppedUnits.push(unit); }), [service.unit]);
  assert.deepEqual(stoppedUnits, [service.unit]);
  assert.ok(!existsSync(join(dir, `${SESSION}.json`)));
  await assert.rejects(writeRecord(dir, { version: 1, sessionId: "../x", handoffs: [] }));
});

test("a deleted job's leftovers stop the scopes its sessions handed off", async () => {
  const dir = mkdtempSync(join(tmpdir(), "leftover-tree-"));
  const asked: string[][] = [];
  const source: LeftoverSource = {
    strays: async () => [], stopServices: async sessions => { asked.push([...sessions]); return ["orphan-x-400.scope"]; }, started: async () => null, kill: () => {},
    closeTabs: async () => 0, later: () => {}, removeCopies: async () => [], inside: async () => [], removeTmp: async () => [],
    artifactCopies: async () => [], kernelStates: async () => [], stopUnits: async () => [], writeOwned: async () => {},
  };
  const left = await endLeftovers(source, dir, SESSION);
  assert.deepEqual(asked, [[SESSION]]);
  assert.deepEqual(left.units, ["orphan-x-400.scope"]);
});

// The idle unload with a handoff source plans a session that holds a detached service, and on the guard's refusal hands it off and counts it stopped.
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "daemon-rows-1015-2122.json"), "utf8")) as { takenAt: string; chats: string[]; pool: string[]; rows: SessionSummary[] };
const at = Date.parse(fixture.takenAt);
const TEN_MIN = 10 * 60_000;
const base = unloadPlan(fixture.rows, { attached: new Set(fixture.chats), pool: new Set(fixture.pool), now: at, idleMs: TEN_MIN })
  .find(row => (row.rlmDepth ?? 0) === 0 && row.runtimeKind !== "subagent")!;
const holder = { ...base, sessionId: SESSION, activeSessionId: ACTIVE, holdsDetachedProcesses: true, lastActivityAt: new Date(at - TEN_MIN - 60_000).toISOString() } as SessionSummary;

test("with a handoff source the idle unload hands off a refused session's services, then counts it stopped", async () => {
  const handed: string[] = [];
  const stopped: string[] = [];
  const lines: string[] = [];
  const unloader = new IdleUnloader({
    rows: () => [holder], localRows: () => [], idleMs: () => TEN_MIN, chats: async () => new Set(), dormant: () => false, pool: async () => new Set(),
    waking: async () => new Set(), held: async () => new Map(), own: async () => new Map(), restNow: async () => false, release: async () => true, title: () => null,
    request: async (_row, type) => type === "get_state" ? { success: true, data: { isSessionActive: false, holdsDetachedProcesses: true } }
      : { success: false, error: "Idle unload skipped: the session holds detached processes", detachedHold: true },
    handOff: async (row, resume) => { if (resume) return null; handed.push(row.sessionId); return { done: true }; },
    stopped: async row => { stopped.push(row.sessionId); }, log: line => { lines.push(line); }, now: () => at,
  });
  await unloader.sweep();
  await unloader.settled();
  assert.deepEqual(handed, [SESSION]);
  assert.deepEqual(stopped, [SESSION]);
  assert.ok(lines.some(line => line.includes("handed its detached services")), lines.join("\n"));
  assert.deepEqual(unloadPlan([holder], { attached: new Set(), pool: new Set(), now: at, idleMs: TEN_MIN }), [], "without a handoff source the row stays out of the plan");
});

test("a handoff that does not finish keeps the session and logs why", async () => {
  const stopped: string[] = [];
  const lines: string[] = [];
  const unloader = new IdleUnloader({
    rows: () => [holder], localRows: () => [], idleMs: () => TEN_MIN, chats: async () => new Set(), dormant: () => false, pool: async () => new Set(),
    waking: async () => new Set(), held: async () => new Map(), own: async () => new Map(), restNow: async () => false, release: async () => true, title: () => null,
    request: async (_row, type) => type === "get_state" ? { success: true, data: { isSessionActive: false } }
      : { success: false, error: "held", detachedHold: true },
    handOff: async (_row, resume) => resume ? null : { done: false, error: "busy" },
    stopped: async row => { stopped.push(row.sessionId); }, log: line => { lines.push(line); }, now: () => at,
  });
  await unloader.sweep();
  await unloader.settled();
  assert.deepEqual(stopped, []);
  assert.ok(lines.some(line => line.endsWith("kept, it holds detached processes; handoff: busy")), lines.join("\n"));
});

/** An idle unloader over the stub: the row is listed while Prime holds the session, and the handoff source runs on the stub's ports. */
function unloaderOver(w: ReturnType<typeof world>, lines: string[]): IdleUnloader {
  const listed = (): SessionSummary[] => w.prime.sessions.has(SESSION) ? [holder] : [];
  const detached = (): boolean => (w.prime.sessions.get(SESSION)?.groups ?? []).some(pgid => !w.prime.transferred.has(pgid) && w.prime.procs.has(pgid));
  return new IdleUnloader({
    rows: listed, localRows: () => [], idleMs: () => TEN_MIN, chats: async () => new Set(), dormant: () => false, pool: async () => new Set(),
    waking: async () => new Set(), held: async () => new Map(), own: async () => new Map(), restNow: async () => false, release: async () => true, title: () => null,
    request: async (target, type) => type === "get_state" ? { success: true, data: { isSessionActive: false, holdsDetachedProcesses: detached() } } : w.ports.kill(target.activeSessionId!),
    handOff: (target, resume) => handOff(target, w.ports, resume),
    unfinishedHandoffs: async () => {
      const entry = w.disk.has(SESSION) ? record(w.disk).handoffs.find(handoff => handoff.state !== "unloaded") : undefined;
      return entry ? [{ sessionId: SESSION, activeSessionId: entry.activeSessionId }] : [];
    },
    stopped: async () => {}, log: line => { lines.push(line); }, now: () => at,
  });
}

for (const point of CRASH_POINTS) {
  test(`a crash at ${point} and the next idle unload sweep end in one receipt, one unloaded record entry and one scope`, async () => {
    const w = world();
    const lines: string[] = [];
    w.crashAt(point);
    const first = unloaderOver(w, lines);
    await first.sweep();
    await first.settled();
    assert.ok(lines.some(line => line.includes(point)), lines.join("\n"));
    const next = unloaderOver(w, lines);
    await next.sweep();
    await next.settled();
    assert.equal(w.prime.receipts.size, 1, "Prime saved one receipt");
    assert.deepEqual(record(w.disk).handoffs.map(entry => entry.state), ["unloaded"], lines.join("\n"));
    assert.deepEqual([...w.scopes], [[unitName(SESSION, 400), 1]], "one scope");
    assert.ok(w.prime.procs.has(401) && !w.prime.sessions.has(SESSION), "the service runs and the kernel is freed");
  });
}

test("a commit whose session Prime no longer holds is replayed from the moved groups the record kept, and the record ends unloaded", async () => {
  const w = world();
  w.crashAt("commit:linked");
  await assert.rejects(handOff(row, w.ports), Crash);
  w.prime.sessions.delete(SESSION);
  const out = await handOff({ sessionId: SESSION }, w.ports, true);
  assert.equal(out?.done, true, JSON.stringify(out));
  assert.deepEqual(record(w.disk).handoffs.map(entry => entry.state), ["unloaded"]);
  assert.equal(w.prime.receipts.size, 1);
  assert.equal(await handOff({ sessionId: SESSION }, w.ports, true), null, "a finished record leaves nothing to resume");
});

test("the service is the last member after the shell that writes to a file, so a `cd W && nohup svc > log &` subshell is not named", async () => {
  const w = world();
  w.prime.procs.clear();
  w.prime.sessions.set(SESSION, { active: ACTIVE, groups: [] });
  w.prime.start(500, [501, 502]);
  w.quiet.add(500).add(501);
  const out = await handOff(row, w.ports);
  assert.equal(out?.done, true, JSON.stringify(out));
  const entry = record(w.disk).handoffs[0]!;
  assert.ok(entry.state === "unloaded");
  assert.deepEqual([entry.services[0]!.pid, entry.services[0]!.log, entry.services[0]!.processStartId], [502, "/tmp/w/srv.log", "proc:50200"]);
});
