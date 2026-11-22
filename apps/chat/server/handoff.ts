/**
 * A release of apps/chat without a closed port. systemd holds 127.0.0.1:5184 in sieun-pi-apps-chat.socket and passes it to the server as fd 3,
 * so a call that lands while no process accepts waits in the socket's queue instead of failing with ECONNREFUSED. A release reloads the
 * unit (SIGHUP), and the running server starts its successor beside it on the same fd:
 *
 * 1. The successor loads its modules, which is most of a start (1.2 to 2.9 s of the 3.2 s median start on 11-22, server/main.ts), and says
 *    `loaded` while the running server still answers every call.
 * 2. The running server stops taking connections, lets its calls in flight answer (`drain`), stops its loops and writes its queued files
 *    (`App.stop`), and says `stopped`. Calls that arrive from now on wait in the socket's queue.
 *    It releases the data dir's lock (`DataLock`).
 * 3. The successor takes the lock and reads the state files only now, so no write of the running server lands after it read them. It
 *    starts, takes the fd, tells systemd MAINPID= until systemd shows it as the main process (`tellSystemd`), and says `taken`; only then
 *    does the running server exit, so systemd never reads that exit as the unit's end.
 *
 * Two App instances never run at once, so nothing in the data dir, the wakes, the duties or the search index is written by both, and a
 * second server started on the same data dir by any other path finds the lock held and exits. Without a
 * passed fd (a hand run, the fixture specs) the server listens on its port itself and a SIGHUP does nothing.
 */
import { execFile, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Server } from "node:http";
import { promisify } from "node:util";
import { takeListenFd } from "../../../legacy/prime/user-history/src/listen-fd.ts";

/** Set in a successor's environment by the running server that started it with the port's fd as its fd 3 and an IPC channel. */
export const HANDOFF_ENV = "APPS_CHAT_HANDOFF";
/**
 * The path the successor starts in. The unit sets it to the `current` link's apps/chat, so the successor runs the release `current` names
 * by now; the running server's own cwd is the release it started from.
 */
export const CURRENT_ENV = "APPS_CHAT_CURRENT";

type ToOld = { kind: "loaded" } | { kind: "taken" };
type ToNew = { kind: "stopped" };
const kindOf = (value: unknown): string | undefined =>
  typeof value === "object" && value !== null && typeof (value as { kind?: unknown }).kind === "string" ? (value as { kind: string }).kind : undefined;

/** How this process gets its port: the fd systemd or a running server passed, and that server when this process is its successor. */
export interface Listening {
  fd: number | null;
  predecessor: Predecessor | null;
}

export function listening(env: NodeJS.ProcessEnv = process.env): Listening {
  if (env[HANDOFF_ENV] === "1" && process.connected) {
    delete env[HANDOFF_ENV];
    return { fd: 3, predecessor: new Predecessor() };
  }
  return { fd: takeListenFd(env), predecessor: null };
}

/** The successor's side of a hand-over. */
export class Predecessor {
  constructor(private readonly channel: Pick<NodeJS.Process, "on" | "off" | "send"> = process) {}

  /** Says this process loaded, and resolves once the running server stopped and wrote its files. */
  stopped(): Promise<void> {
    const done = new Promise<void>(resolve => {
      const on = (message: unknown) => {
        if (kindOf(message) !== "stopped") return;
        this.channel.off("message", on);
        resolve();
      };
      this.channel.on("message", on);
    });
    this.send({ kind: "loaded" });
    return done;
  }

  /** Says this process serves the port, so the running server exits. */
  taken(): void {
    this.send({ kind: "taken" });
  }

  private send(message: ToOld): void {
    this.channel.send?.(message);
  }
}

/**
 * This serve's arguments after node, from /proc/self/cmdline, so the successor runs the same command. The same as chat-handoff.ts
 * `serveArgs` of the :5182 chat; importing that file pulls the Prime daemon client into apps/chat's typecheck, which fails in a release
 * folder that has no prime-agent package (release-441a086 on 11-22).
 */
export function serveArgs(cmdline = (() => { try { return readFileSync("/proc/self/cmdline", "utf8"); } catch { return null; } })()): string[] {
  const parts = cmdline?.split("\0").filter(Boolean);
  return parts && parts.length > 1 ? parts.slice(1) : [...process.execArgv, ...process.argv.slice(1)];
}

/** sd_notify through systemd-notify, as chat-handoff.ts `notifySystemd` does. */
async function notify(fields: readonly string[]): Promise<void> {
  // systemd-notify answered in 13 ms from a test unit on us-metal02 on 11-08 (chat-handoff.ts); 30 s fails only one that hangs.
  await promisify(execFile)("systemd-notify", [`--pid=${process.pid}`, ...fields], { timeout: 30_000 });
}

/** The unit's MainPID as systemd has it now, or 0. */
async function mainPidOf(unit: string): Promise<number> {
  const { stdout } = await promisify(execFile)("systemctl", ["--user", "show", "-p", "MainPID", "--value", unit], { timeout: 30_000 });
  return Number(stdout.trim()) || 0;
}

/** The unit's name, which the unit file sets as %n, so a successor can read whether systemd took it as the main process. */
export const UNIT_ENV = "APPS_CHAT_UNIT";
/**
 * How long a successor keeps telling systemd MAINPID= before it gives up. cpu-protect.py moves the unit's main process into
 * agents.slice/<unit>-core.scope, so a successor starts there, and systemd --user drops a notification from outside the unit's cgroup;
 * the same pass moves every other process in that scope back to the unit, once every 2 s (cpu-protect.py INTERVAL_S). On 11-22 the
 * hand-overs that sent MAINPID= once lost it twice in three, and systemd read the old server's exit as the unit's end and started a
 * fresh server beside the successor. 15 s is seven passes.
 */
const TAKE_MS = 15_000;

/**
 * Tells systemd this process serves: READY=1, or for a successor MAINPID= and READY=1 again every 250 ms until systemd shows it as the
 * unit's main process, which must happen before the old server exits. Throws when systemd did not take it in TAKE_MS.
 */
export async function tellSystemd(successor: boolean, log: (line: string) => void, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!env.NOTIFY_SOCKET) return;
  const began = Date.now();
  if (!successor) {
    await notify(["READY=1"]);
    return log(`systemd: told it READY=1 in ${Date.now() - began} ms`);
  }
  const unit = env[UNIT_ENV];
  if (!unit) throw new Error(`${UNIT_ENV} is not set, so this successor cannot see whether systemd took it as the main process`);
  for (let tries = 1; ; tries += 1) {
    await notify([`MAINPID=${process.pid}`, "READY=1"]);
    if ((await mainPidOf(unit)) === process.pid) return log(`systemd: took this process as ${unit}'s main one after ${tries} MAINPID= in ${Date.now() - began} ms`);
    if (Date.now() - began > TAKE_MS) throw new Error(`systemd did not take this process as ${unit}'s main one in ${TAKE_MS / 1000} s of MAINPID=`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

/**
 * Pings systemd's watchdog (WatchdogSec in the unit) every fifth of its interval while this process's event loop runs, so systemd kills
 * and restarts a server that hangs, as it restarts one that ends. The pings go out from a shell this process starts, which stays in the
 * unit's cgroup: cpu-protect.py moves the main process into <unit>-core.scope and every other process back to the unit, and systemd
 * --user drops a notify from outside the unit. A ping from a systemd-notify the main process ran would start in the scope. The shell
 * pings only on a line from this process, so a hung event loop sends none. Returns the stop.
 */
export function startWatchdog(log: (line: string) => void, env: NodeJS.ProcessEnv = process.env): () => void {
  const usec = Number(env.WATCHDOG_USEC);
  if (!env.NOTIFY_SOCKET || !Number.isFinite(usec) || usec <= 0) return () => {};
  const pinger = spawn("sh", ["-c", "while read -r _; do systemd-notify WATCHDOG=1; done"], { stdio: ["pipe", "ignore", "inherit"] });
  pinger.on("error", error => log(`watchdog: the pinger: ${error.message}`));
  pinger.stdin.on("error", () => {});
  const ping = () => { if (pinger.stdin.writable) pinger.stdin.write("\n"); };
  ping();
  const timer = setInterval(ping, Math.max(1000, Math.round(usec / 1000 / 5)));
  timer.unref();
  pinger.unref();
  log(`watchdog: pings every ${Math.round(usec / 1000 / 5)} ms through pinger ${pinger.pid}`);
  return () => {
    clearInterval(timer);
    pinger.stdin.end();
  };
}

/**
 * The data dir's lock, held for the life of the server that serves it: an exclusive SQLite transaction on <data dir>/server.lock, which
 * the kernel drops when the process ends. Hard limit, data integrity: two servers on one data dir split posts on 11-22, 25 of 87 with
 * duplicate seqs. A running server releases it in a hand-over once it stopped, before its successor reads the state files.
 */
export class DataLock {
  private db: DatabaseSync | null = null;
  constructor(private readonly file: string) {}

  /** Takes the lock, or returns who holds it when another process does. */
  take(): string | null {
    // A first start on a new box or a fixture run names a data dir nobody made yet, and SQLite cannot open a file in it.
    mkdirSync(dirname(this.file), { recursive: true });
    const db = new DatabaseSync(this.file);
    try {
      db.exec("PRAGMA journal_mode = DELETE; PRAGMA busy_timeout = 0;");
      db.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      db.close();
      let holder = "another process";
      try { holder = `pid ${readFileSync(`${this.file}.pid`, "utf8").trim()}`; } catch { /* no note */ }
      return `${holder} holds ${this.file} (${error instanceof Error ? error.message : String(error)})`;
    }
    this.db = db;
    writeFileSync(`${this.file}.pid`, `${process.pid}\n`);
    return null;
  }

  release(): void {
    try { this.db?.exec("ROLLBACK"); } catch { /* ended already */ }
    this.db?.close();
    this.db = null;
  }
}

/** The running server's side. */
export interface Running {
  fd: number;
  server: Server;
  /** Stops the app and writes its queued files; the port is closed and drained by then. */
  stop(): Promise<void>;
  /** Releases the data dir's lock, once the app stopped, so the successor can take it. */
  unlock(): void;
  /** Closes the server and waits for its calls in flight (http.ts `drain`). */
  drain(server: Server): Promise<string | void>;
  log(line: string): void;
  /**
   * Stops this process's watchdog pings (`startWatchdog`) once its App stopped. A successor that hangs after systemd took it as the main
   * process then trips the watchdog, where the old process's pings would hide it: on the rig on 11-22 a successor stopped with SIGSTOP in
   * that window was never replaced in 60 s.
   */
  quiet?(): void;
  /** After the successor took over, waits while this process passes late calls on its kept connections to it (http.ts `lingerForwarding`). */
  linger?(): Promise<string>;
  /** Ends this process once the successor serves, or once a successor that ended after this process stopped left nothing to serve. */
  exit(code: number): void;
}

/** Starts a successor on each SIGHUP. A SIGHUP while one is under way only logs, since a release holds its lock until the hand-over ended. */
export function handOverOnHangup(side: Running): () => void {
  let going = false;
  const start = () => {
    if (going) return side.log("handoff: a reload came while a hand-over is under way; it is left out");
    going = true;
    void handOver(side).catch(error => side.log(`handoff: ${error instanceof Error ? error.message : String(error)}`)).finally(() => { going = false; });
  };
  process.on("SIGHUP", start);
  return () => { process.off("SIGHUP", start); };
}

const LOAD_MS = 60_000;

/** One hand-over; resolves once the successor took the port, or once it ended before that. */
export async function handOver(side: Running, args: string[] = serveArgs(), cwd = process.env[CURRENT_ENV] ?? process.cwd()): Promise<void> {
  const began = Date.now();
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, [HANDOFF_ENV]: "1" }, stdio: ["ignore", "inherit", "inherit", side.fd, "ipc"] });
  side.log(`handoff: started the successor ${child.pid} in ${cwd}; this process serves until it loaded`);
  let stoppedAt = 0, taken = false;
  // A successor that never says it loaded is ended, and this process keeps serving. Loads took 0.5 to 3.2 s on 11-22, and a whole start
  // took at most 8.7 s across the 70 starts of that day.
  const loading = setTimeout(() => {
    side.log(`handoff: ${child.pid} did not load in ${LOAD_MS / 1000} s; it is killed and this process keeps serving`);
    child.kill("SIGKILL");
  }, LOAD_MS);
  loading.unref();
  await new Promise<void>(resolve => {
    child.on("message", (message: unknown) => {
      const kind = kindOf(message);
      if (kind === "loaded") {
        const loadedAt = Date.now();
        clearTimeout(loading);
        void (async () => {
          const drained = await side.drain(side.server);
          await side.stop();
          // The pings go on while a write in flight runs (up to http.ts WRITE_WAIT_MS, past WatchdogSec), and end once this process serves nothing.
          side.quiet?.();
          side.unlock();
          stoppedAt = Date.now();
          side.log(`handoff: ${child.pid} loaded in ${loadedAt - began} ms; this process stopped in ${Date.now() - loadedAt} ms${drained ? ` (${drained})` : ""}, and calls wait in the socket's queue until ${child.pid} takes it`);
          child.send({ kind: "stopped" } satisfies ToNew);
          // The successor gives up on its MAINPID= after TAKE_MS and ends, which ends this process too; one that hangs instead is ended here.
          setTimeout(() => {
            if (taken) return;
            side.log(`handoff: ${child.pid} did not take the port in ${(TAKE_MS + 5000) / 1000} s after this process stopped; it is killed`);
            child.kill("SIGKILL");
          }, TAKE_MS + 5000).unref();
        })().catch(error => {
          side.log(`handoff: stop: ${error instanceof Error ? error.message : String(error)}`);
          child.kill("SIGKILL");
        });
      } else if (kind === "taken") {
        taken = true;
        side.log(`handoff: ${child.pid} took the port ${Date.now() - stoppedAt} ms after this process stopped, ${Date.now() - began} ms after the reload; this process ${side.linger ? "passes late calls on its kept connections to it, then exits" : "exits"}`);
        child.disconnect();
        child.unref();
        resolve();
        if (!side.linger) return side.exit(0);
        // A count of `server/main.ts --port` processes, as the one-server checks run, no longer finds this one; its lock and listener are gone too.
        process.title = `apps-chat old server ${process.pid}, passing calls to ${child.pid}`;
        void side.linger().then(line => side.log(`handoff: ${line}; this process exits`), error => side.log(`handoff: linger: ${error instanceof Error ? error.message : String(error)}`)).finally(() => side.exit(0));
      }
    });
    child.once("error", error => side.log(`handoff: the successor: ${error.message}`));
    child.once("exit", (code, signal) => {
      clearTimeout(loading);
      if (taken) return;
      side.log(`handoff: the successor ${child.pid} ended (${signal ?? `exit ${code}`}) before it took the port; ${stoppedAt ? "this process had stopped, so it exits and systemd starts the unit again" : "this process keeps serving"}`);
      resolve();
      if (stoppedAt) side.exit(1);
    });
  });
}
