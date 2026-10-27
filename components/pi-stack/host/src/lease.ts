/**
 * One writer per session file.
 *
 * Upstream Pi has no lock on a session file, and two runtimes on one JSONL file both append and diverge with no error (research probe P4).
 * pi-host keeps a map keyed by the file's real path, so a second open inside the host gets `session_already_active`, and writes a lockfile next
 * to the file, so another process (a second host or a plain `pi` CLI with `leaseExtension`) refuses it too. A lockfile whose process is gone
 * is stale, and the next opener takes it over.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export interface LockRecord {
  pid: number;
  owner: string;
  sessionId: string;
  at: string;
}

export class SessionLockedError extends Error {
  constructor(readonly sessionPath: string, readonly holder: LockRecord | undefined, readonly inHost: boolean) {
    super(inHost
      ? `Session ${sessionPath} is already open in this pi-host.`
      : `Session ${sessionPath} is open in another process (pid ${holder?.pid ?? "unknown"}, ${holder?.owner ?? "unknown"}).`);
    this.name = "SessionLockedError";
  }
}

/** The real path of a session file that may not exist yet: its folder resolved, its name kept. */
export function realSessionPath(path: string): string {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  return join(realpathSync(dir), basename(path));
}

export const lockPathOf = (sessionPath: string) => `${sessionPath}.lock`;

function alive(pid: number): boolean {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export function readLock(sessionPath: string): LockRecord | undefined {
  try { return JSON.parse(readFileSync(lockPathOf(sessionPath), "utf8")) as LockRecord; } catch { return undefined; }
}

/**
 * Takes the lockfile for `sessionPath`. A lockfile from a dead process, or from this process when `ownedHere` says it holds no lease on the
 * file (a lease lost to a crash in an earlier host with the same pid), is stale and replaced. Throws `SessionLockedError` otherwise.
 */
export function takeLock(sessionPath: string, record: Omit<LockRecord, "pid" | "at">, ownedHere = false): void {
  const lock = lockPathOf(sessionPath);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      try { writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), ...record } satisfies LockRecord)); } finally { closeSync(fd); }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = readLock(sessionPath);
      const stale = !holder || !alive(holder.pid) || (holder.pid === process.pid && !ownedHere);
      if (!stale) throw new SessionLockedError(sessionPath, holder, false);
      try { unlinkSync(lock); } catch { /* another opener removed it first */ }
    }
  }
  throw new SessionLockedError(sessionPath, readLock(sessionPath), false);
}

export function dropLock(sessionPath: string): void {
  const holder = readLock(sessionPath);
  if (holder && holder.pid !== process.pid) return;
  try { unlinkSync(lockPathOf(sessionPath)); } catch { /* already gone */ }
}

/** The host's lease map: real session path to the session id that holds it. */
export class Leases {
  private readonly held = new Map<string, string>();

  constructor(private readonly owner = "pi-host") {}

  /** Returns the real path the lease is keyed by. */
  acquire(sessionPath: string, sessionId: string): string {
    const real = realSessionPath(sessionPath);
    const holder = this.held.get(real);
    if (holder !== undefined) throw new SessionLockedError(real, { pid: process.pid, owner: this.owner, sessionId: holder, at: "" }, true);
    takeLock(real, { owner: this.owner, sessionId });
    this.held.set(real, sessionId);
    return real;
  }

  holderOf(sessionPath: string): string | undefined {
    return existsSync(dirname(sessionPath)) ? this.held.get(realSessionPath(sessionPath)) : undefined;
  }

  release(realPath: string): void {
    if (!this.held.delete(realPath)) return;
    dropLock(realPath);
  }

  releaseAll(): void {
    for (const path of [...this.held.keys()]) this.release(path);
  }

  get size(): number {
    return this.held.size;
  }
}

/**
 * The same lock for a plain `pi` CLI: load it with `pi -e components/pi-stack/host/src/lease.ts`. At `session_start` it takes the lockfile of
 * the session file, and a file another live process holds ends the CLI session with a notice instead of a second writer.
 */
export const leaseExtension: ExtensionFactory = pi => {
  let held: string | undefined;
  pi.on("session_start", async (_event, ctx) => {
    const file = ctx.sessionManager.getSessionFile();
    if (!file) return;
    const real = realSessionPath(file);
    try {
      takeLock(real, { owner: "pi-cli", sessionId: ctx.sessionManager.getSessionId() });
      held = real;
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      ctx.shutdown();
    }
  });
  pi.on("session_shutdown", async () => {
    if (held) dropLock(held);
    held = undefined;
  });
};

export default leaseExtension;
