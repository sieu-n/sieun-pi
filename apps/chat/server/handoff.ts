/**
 * A release of apps/chat without a closed port. systemd holds 127.0.0.1:5184 in sieun-pi-apps-chat.socket and passes it to the server as fd 3,
 * so a call that lands while no process accepts waits in the socket's queue instead of failing with ECONNREFUSED. A release reloads the
 * unit (SIGHUP), and the running server starts its successor beside it on the same fd:
 *
 * 1. The successor loads its modules, which is most of a start (1.2 to 2.9 s of the 3.2 s median start on 11-22, server/main.ts), tells
 *    systemd MAINPID= and waits until cpu-protect.py moved it into the unit's core scope (`boostBeforeStop`), and says `loaded`, all
 *    while the running server still answers every call.
 * 2. The running server stops taking connections, lets its calls in flight answer (`drain`), stops its loops and writes its queued files
 *    (`App.stop`), and says `stopped`. Calls that arrive from now on wait in the socket's queue.
 *    It releases the data dir's lock (`DataLock`).
 * 3. The successor takes the lock and reads the state files only now, so no write of the running server lands after it read them. It
 *    starts, takes the fd and says `taken`; only then does the running server exit. systemd took the successor as the main process in
 *    step 1, so it never reads that exit as the unit's end.
 *
 * A successor that ends between its MAINPID= and the stop leaves the running server serving, and the running server tells systemd
 * MAINPID= of its own (`reclaim`). A running server that ends before its stop closes the IPC channel, and the successor, the main process
 * by then, takes the lock the kernel dropped and serves.
 *
 * Two App instances never run at once, so nothing in the data dir, the wakes, the duties or the search index is written by both, and a
 * second server started on the same data dir by any other path finds the lock held and exits. A start of the unit that finds the lock held
 * by a server systemd lost track of ends that server and serves (`takeFromStray`). Without a
 * passed fd (a hand run, the fixture specs) the server listens on its port itself and a SIGHUP does nothing.
 */
import { execFile, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
  constructor(private readonly channel: Pick<NodeJS.Process, "on" | "off" | "send" | "connected"> = process) {}

  /**
   * Says this process loaded, and resolves once the running server stopped and wrote its files, or with "gone" once its channel closed
   * first: the running server ended before its stop, and the kernel dropped its data dir lock with it.
   */
  stopped(): Promise<"stopped" | "gone"> {
    if (!this.channel.connected) return Promise.resolve("gone");
    const done = new Promise<"stopped" | "gone">(resolve => {
      const end = (how: "stopped" | "gone") => {
        this.channel.off("message", on);
        this.channel.off("disconnect", gone);
        resolve(how);
      };
      const on = (message: unknown) => { if (kindOf(message) === "stopped") end("stopped"); };
      const gone = () => end("gone");
      this.channel.on("message", on);
      this.channel.on("disconnect", gone);
    });
    this.send({ kind: "loaded" });
    return done;
  }

  /** Says this process serves the port, so the running server exits. */
  taken(): void {
    this.send({ kind: "taken" });
  }

  /** A send on a channel the running server closed by ending fails in the callback, which drops it; the "disconnect" handler acts on it. */
  private send(message: ToOld): void {
    this.channel.send?.(message, undefined, undefined, () => undefined);
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

/** The variables systemd gives the unit's process for its notify socket and watchdog. */
const UNIT_VARS = ["NOTIFY_SOCKET", "WATCHDOG_USEC", "WATCHDOG_PID"] as const;
const unitEnv: NodeJS.ProcessEnv = {};

/**
 * Takes systemd's notify and watchdog variables out of process.env, so a command this server runs never talks to the unit's notify socket,
 * and keeps them for this process's own notify, watchdog and successor (`systemdEnv`). Every READY=1 here carries MAINPID= of its sender,
 * and systemd takes a MAINPID= from any process in the unit (NotifyAccess=all): at 21:24:22Z on 11-23 a wake check that boots a fixture
 * server (`node --import tsx server/main.ts --fixture`) ran in the unit with these variables, became the unit's main process with its
 * READY=1, and the check's kill of it read to systemd as the unit's end, while the real server kept the data dir from <unit>-core.scope.
 */
export function keepUnitEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of UNIT_VARS) {
    if (env[name] === undefined) continue;
    unitEnv[name] = env[name];
    delete env[name];
  }
}

/** process.env with the unit's variables `keepUnitEnv` took out of it. */
export const systemdEnv = (): NodeJS.ProcessEnv => ({ ...process.env, ...unitEnv });

/** sd_notify through systemd-notify, as chat-handoff.ts `notifySystemd` does. */
async function notify(fields: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  // systemd-notify answered in 13 ms from a test unit on us-metal02 on 11-08 (chat-handoff.ts); 30 s fails only one that hangs.
  await promisify(execFile)("systemd-notify", [`--pid=${process.pid}`, ...fields], { env, timeout: 30_000 });
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
/** The cgroup a process runs in, from /proc/<pid>/cgroup, or "" when it cannot be read. */
export function cgroupOf(pid: number | "self" = "self"): string {
  try { return readFileSync(`/proc/${pid}/cgroup`, "utf8").trim().split("\n").find(line => line.startsWith("0::"))?.slice(3) ?? ""; } catch { return ""; }
}

/**
 * How long a successor that systemd took as the main process waits for cpu-protect.py to move it into the unit's core scope before it lets
 * the running server stop. The passes come every 2 s (INTERVAL_S). The same pass moves the running server out of the scope, so the wait
 * costs release time and no call's time; the bound only ends a wait for a pass that never comes, as with release-36c711c on 11-22, before
 * `nudgeCpuProtect`.
 */
const BOOST_MS = 10_000;

/**
 * A successor's first step once it loaded, while the running server still serves every call: it becomes the unit's main process, so
 * cpu-protect.py moves it into <unit>-core.scope, and it waits there before the running server stops. Its lock, state read and listen then
 * run at the core scope's weight. Before 11-23 it told systemd only at the stop, and at box load 277 on 11-22 a successor that ran outside
 * the scope took 4.4 s from that stop to its listen, against 0.15 to 0.6 s in the four other hand-overs of that walk. The running server
 * leaves the scope in the same pass and serves outside it until it stopped. Without a core scope around the running server (no
 * cpu-protect.py, or a box without it) the wait is left out. Throws when systemd did not take this process in TAKE_MS.
 */
export async function boostBeforeStop(log: (line: string) => void, env: NodeJS.ProcessEnv = systemdEnv()): Promise<void> {
  if (!env.NOTIFY_SOCKET) return;
  const scope = `${(env[UNIT_ENV] ?? "").replace(/\.service$/, "")}-core.scope`;
  const protectedRunning = cgroupOf(process.ppid).endsWith(`/${scope}`);
  await tellSystemd(true, log, env);
  if (!protectedRunning) return;
  const began = Date.now();
  const endNudge = nudgeCpuProtect();
  try {
    while (!cgroupOf().endsWith(`/${scope}`)) {
      if (Date.now() - began > BOOST_MS) return log(`systemd: not in ${scope} after ${BOOST_MS} ms; the running server stops anyway`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } finally {
    endNudge();
  }
  log(`systemd: in ${scope} after ${Date.now() - began} ms; the running server stops now`);
}

/**
 * cpu-protect.py reads a unit's MainPID from systemd only when a new child of the user manager shows in the unit or its core scope (its
 * `candidates`), as a start or a restart makes one; a MAINPID= alone does not make it read again. A successor is the running server's child,
 * so until 11-23 cpu-protect.py moved it in only once the old server had exited and the successor passed to the user manager. An orphan
 * started here is such a child: systemd --user takes the orphans of its units. It sleeps until the returned stop ends it, at most BOOST_MS.
 */
function nudgeCpuProtect(): () => void {
  let orphan = 0;
  const shell = spawn("sh", ["-c", `sleep ${Math.ceil(BOOST_MS / 1000)} >/dev/null 2>&1 & echo $!`], { stdio: ["ignore", "pipe", "ignore"] });
  shell.on("error", () => {});
  shell.stdout.on("data", chunk => { orphan = Number(String(chunk).trim()) || orphan; });
  return () => { if (orphan) try { process.kill(orphan); } catch { /* ended */ } };
}

/**
 * Makes this running server the unit's main process again, and has cpu-protect.py read that, after a successor that took the place ended.
 * systemd refuses a MAINPID= for a process outside the unit's cgroup ("does not belong to service" on the copy rig on 11-22), and
 * cpu-protect.py keeps this process in the core scope while it holds it as the main one. A first nudge makes cpu-protect.py read the main
 * process again, find the successor there and move this process back to the unit, where its MAINPID= counts; a second one brings it into
 * the scope again.
 */
export async function reclaimMain(log: (line: string) => void, env: NodeJS.ProcessEnv = systemdEnv()): Promise<void> {
  if (!env.NOTIFY_SOCKET) return;
  const endNudge = nudgeCpuProtect();
  try {
    await tellSystemd(true, log, env);
  } finally {
    endNudge();
  }
  nudgeCpuProtect();
}

export async function tellSystemd(successor: boolean, log: (line: string) => void, env: NodeJS.ProcessEnv = systemdEnv()): Promise<void> {
  if (!env.NOTIFY_SOCKET) return;
  const began = Date.now();
  if (!successor) {
    await notify(["READY=1"], env);
    return log(`systemd: told it READY=1 in ${Date.now() - began} ms`);
  }
  const unit = env[UNIT_ENV];
  if (!unit) throw new Error(`${UNIT_ENV} is not set, so this successor cannot see whether systemd took it as the main process`);
  for (let tries = 1; ; tries += 1) {
    await notify([`MAINPID=${process.pid}`, "READY=1"], env);
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
export function startWatchdog(log: (line: string) => void, env: NodeJS.ProcessEnv = systemdEnv()): () => void {
  const usec = Number(env.WATCHDOG_USEC);
  if (!env.NOTIFY_SOCKET || !Number.isFinite(usec) || usec <= 0) return () => {};
  const pinger = spawn("sh", ["-c", "while read -r _; do systemd-notify WATCHDOG=1; done"], { env, stdio: ["pipe", "ignore", "inherit"] });
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

  /** The pid the holder wrote beside the lock when it took it, or 0. */
  holder(): number {
    try { return Number(readFileSync(`${this.file}.pid`, "utf8").trim()) || 0; } catch { return 0; }
  }
}

/** Whether the process runs this server's command on the given data dir, from /proc/<pid>/cmdline. */
function servesDataDir(pid: number, dataDir: string): boolean {
  let args: string[];
  try { args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"); } catch { return false; }
  const at = args.indexOf("--data-dir");
  return args.some(arg => arg.endsWith("server/main.ts")) && at > 0 && resolve(args[at + 1] ?? "") === resolve(dataDir);
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };

/**
 * How long a start of the unit waits for a stray holder of the data dir's lock to end after SIGTERM before it sends SIGKILL: the unit's
 * TimeoutStopSec=20, the time systemd gives the same server to stop.
 */
const STRAY_STOP_MS = 20_000;

/**
 * A start of the unit that finds the data dir's lock held ends the holder when it is a server of this data dir, and takes the lock. systemd
 * starts the unit only once it holds no main process, so a server that still holds the lock then runs where systemd no longer sees it: at
 * 21:24Z on 11-23 a wake check's fixture server became the main process (`keepUnitEnv`), its end read as the unit's end, and the unit's 27
 * restarts in 2 min each exited on "pid 885883 holds server.lock", while 885883 served from <unit>-core.scope until a builder ended it. The holder gets SIGTERM, which
 * drains and stops it as a unit stop does, and SIGKILL after STRAY_STOP_MS. A hand run or a second server outside systemd still exits on a
 * held lock (`DataLock.take`). Returns what `take` returns after the end: null once this process holds the lock.
 */
export async function takeFromStray(lock: DataLock, dataDir: string, log: (line: string) => void, env: NodeJS.ProcessEnv = systemdEnv()): Promise<string | null> {
  let held = lock.take();
  const pid = lock.holder();
  if (!held || !pid || pid === process.pid || !servesDataDir(pid, dataDir)) return held;
  const where = cgroupOf(pid) || "an unknown cgroup";
  const began = Date.now();
  let signal: NodeJS.Signals = "SIGTERM";
  try { process.kill(pid, signal); } catch { /* ended meanwhile */ }
  for (held = lock.take(); held && alive(pid); held = lock.take()) {
    if (signal === "SIGTERM" && Date.now() - began > STRAY_STOP_MS) {
      signal = "SIGKILL";
      try { process.kill(pid, signal); } catch { /* ended meanwhile */ }
    }
    await new Promise(done => setTimeout(done, 100));
  }
  log(`data dir: pid ${pid} held ${dataDir}/server.lock from ${where} while systemd started ${env[UNIT_ENV] ?? "the unit"} with no main process; ` +
    `this start ended it with ${signal} in ${Date.now() - began} ms and ${held ? `still finds the lock held (${held})` : "serves the data dir"}`);
  return held;
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
  /** Called with true when the successor starts, so the answers from then on close their connections (http.ts `windDown`), and with false when it ended before the stop. */
  windDown?(on: boolean): void;
  /** Makes this process the unit's main process again after a successor that took that place ended before the stop. */
  reclaim?(): Promise<void>;
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
  const child = spawn(process.execPath, args, { cwd, env: { ...systemdEnv(), [HANDOFF_ENV]: "1" }, stdio: ["ignore", "inherit", "inherit", side.fd, "ipc"] });
  side.log(`handoff: started the successor ${child.pid} in ${cwd}; this process serves until it loaded`);
  side.windDown?.(true);
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
          // A successor that hangs after the stop is ended here; systemd then reads the end of its main process and starts the unit again.
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
      if (!stoppedAt) {
        side.windDown?.(false);
        void side.reclaim?.().catch(error => side.log(`handoff: reclaim: ${error instanceof Error ? error.message : String(error)}`));
      }
      resolve();
      if (stoppedAt) side.exit(1);
    });
  });
}
