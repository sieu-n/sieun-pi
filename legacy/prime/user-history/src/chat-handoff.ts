import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Server as NetServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Duplex } from "node:stream";
import { foldLatency, type ChatLatency } from "./chat-latency.ts";
import type { EarlyShell } from "./early-shell.ts";

/**
 * A release restart of the :5182 chat on systemd without a minute of slow reads. A restart stopped the running chat, and the new process
 * answered the port while its own start held its main thread: the 13:02:12Z start on 11-08 ran it 93 to 100% busy for 11 s after it listened
 * and again from 27 s to 40 s, spread over about 30 source files, and the owner's api/threads/01a11ba8/duties read took 1.1 s in it. Across
 * 133 starts from 11-03 to 11-08, 18 answered a read over 1 s in their first 65 s, and d7 counted each such minute dirty.
 *
 * Here `systemctl reload` (SIGHUP) makes the running chat start its successor beside it on the port's socket. The successor asks the running
 * chat to stop acting (`quiesce`), which then only answers reads, and starts with its wakes, duties and sweeps. It answers every other request
 * on a port of its own, where the running chat sends them, and takes the socket once its first pass ended (`Chats.firstPass`). Then it tells
 * systemd it is the main process, the running chat stops taking connections, closes and exits, and its last latency window goes into the
 * successor's next watch line.
 */

/** The variable that tells a serve it is the successor of a running chat, which passed it the port's socket as fd 3 and an IPC channel. */
export const HANDOFF_ENV = "SIEUN_PI_CHAT_HANDOFF";
/**
 * The longest a successor waits for its first pass before it takes the socket anyway. In the 494 starts service.log held on 11-08, the first
 * pass ended 18 to 213 s (median 50 s) after the first tick, which comes 30 s after the start.
 */
export const TAKEOVER_MS = 300_000;
/** The line that ends the stop of a chat that handed over, whose successor listened before it began (src/daemon-faults.ts). */
export const HANDED_OVER_LINE = "handoff: the stop of a chat that handed over ended";

type ToOld = { kind: "quiesce" } | { kind: "writes"; port: number } | { kind: "taken" };
type ToNew = { kind: "quiet" } | { kind: "latency"; latency: ChatLatency | null } | { kind: "again" };
type Handler = (req: IncomingMessage, res: ServerResponse) => void;
type Upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
const isMessage = (value: unknown): value is { kind: string } => typeof value === "object" && value !== null && typeof (value as { kind?: unknown }).kind === "string";

/**
 * Lets `server` finish what it holds without dropping a request: it stops listening (net's close only), waits a second for requests on
 * connections it accepted just before, then ends each connection once it is idle, and after `waitMs` ends the rest. http's close drops idle
 * connections at once, and one accepted just before with its request not read yet was reset (ECONNRESET in 2 of 6 scratch hand-overs on
 * 10-19, src/early-shell.ts). The 15 s default is the server's requestTimeout (src/chat-server.ts).
 */
export async function drainServer(server: Server, waitMs = 15_000): Promise<void> {
  const ended = new Promise<void>(resolve => { netClose.call(server, () => resolve()); });
  await new Promise(resolve => setTimeout(resolve, 1_000));
  const idle = setInterval(() => { server.closeIdleConnections(); }, 100);
  server.closeIdleConnections();
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([ended, new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); })]);
  clearTimeout(timer);
  clearInterval(idle);
  server.closeAllConnections();
}
const netClose = NetServer.prototype.close;

/** Tells systemd `fields` (sd_notify) from this process when it runs as a Type=notify service; false when it does not. */
export async function notifySystemd(fields: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!env.NOTIFY_SOCKET) return false;
  await promisify(execFile)("systemd-notify", [`--pid=${process.pid}`, ...fields], { env });
  return true;
}

/** The running chat's side of a hand-over (`listenForHandoff`). */
export interface HandingOver {
  /** The port's socket, which the successor gets as its fd 3. */
  listenFd: number;
  log(line: string): void;
  /** Stops all that acts in this process and waits for its sends; reads go on. */
  quiesce(): Promise<void>;
  /** Sends every request but a read to the successor's own port from now on; they wait until it names that port, and fail if it ends first. */
  forwardWrites(port: Promise<number>): void;
  /** This process's latency window so far, left open. */
  latency(): ChatLatency | undefined;
  /** The successor took the socket: stop taking connections and close the rest; the process exits when it resolves. */
  finish(): Promise<void>;
  /** The successor ended after this process began to quiesce, so this one exits and systemd starts the service again. */
  fail(reason: string): void;
  /** The successor's command line; `serveArgs` by default. */
  args?: string[];
  /** Fences this process once it quiesced (`fenceHandedOver`). */
  fence(successor: number): Promise<void>;
}

/** This serve's arguments after node, from /proc/self/cmdline, so the successor runs the same command through the same `current` link. */
export function serveArgs(cmdline = (() => { try { return readFileSync("/proc/self/cmdline", "utf8"); } catch { return null; } })()): string[] {
  const parts = cmdline?.split("\0").filter(Boolean);
  return parts && parts.length > 1 ? parts.slice(1) : [...process.execArgv, ...process.argv.slice(1)];
}

/**
 * Starts a successor on each SIGHUP and hands over to it. A SIGHUP while one is under way is passed on to that successor once it took the
 * socket, so it starts one on the release `current` names by then. Returns the undo.
 */
export function listenForHandoff(side: HandingOver): () => void {
  let going: { again: boolean } | null = null;
  const start = () => {
    if (going) { going.again = true; side.log("handoff: a reload came while one is under way; the successor hands over again once it serves"); return; }
    const run = going = { again: false };
    void handOver(side, () => run.again).catch(error => side.log(`handoff: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { if (going === run) going = null; });
  };
  process.on("SIGHUP", start);
  return () => { process.off("SIGHUP", start); };
}

/** One hand-over: resolves once this process finished closing after the successor took the socket, or once a failed successor ended. */
export async function handOver(side: HandingOver, again: () => boolean = () => false): Promise<void> {
  const child: ChildProcess = spawn(process.execPath, side.args ?? serveArgs(), {
    env: { ...process.env, [HANDOFF_ENV]: "1" }, stdio: ["ignore", "inherit", "inherit", side.listenFd, "ipc"] });
  side.log(`handoff: started the successor ${child.pid}; this process answers the port until it takes over`);
  let forwarding = false, quiesced = false, taken = false;
  let named: (port: number) => void = () => {}, lost: (error: Error) => void = () => {};
  const port = new Promise<number>((resolve, reject) => { named = resolve; lost = reject; });
  port.catch(() => {});
  const send = (message: ToNew) => { if (child.connected) child.send(message); };
  await new Promise<void>(resolve => {
    child.on("message", (message: unknown) => {
      if (!isMessage(message)) return;
      const next = message as ToOld;
      if (next.kind === "quiesce") {
        void (async () => {
          const at = Date.now();
          forwarding = true;
          side.forwardWrites(port);
          await side.quiesce();
          quiesced = true;
          await side.fence(child.pid!);
          side.log(`handoff: this process stopped acting in ${Date.now() - at} ms and only answers reads; ${child.pid} starts`);
          send({ kind: "quiet" });
        })().catch(error => { side.log(`handoff: quiesce: ${error instanceof Error ? error.message : String(error)}`); child.kill("SIGKILL"); });
      } else if (next.kind === "writes") {
        named(next.port);
        side.log(`handoff: requests other than reads go to ${child.pid} on 127.0.0.1:${next.port}`);
      } else if (next.kind === "taken") {
        taken = true;
        send({ kind: "latency", latency: side.latency() ?? null });
        if (again()) send({ kind: "again" });
        side.log(`handoff: ${child.pid} took the port; this process stops`);
        void side.finish().finally(() => { if (child.connected) child.disconnect(); child.unref(); resolve(); });
      }
    });
    child.once("error", error => side.log(`handoff: the successor: ${error.message}`));
    child.once("exit", (code, signal) => {
      if (taken) return;
      const reason = `the successor ${child.pid} ended (${signal ?? `exit ${code}`}) before it took the port`;
      side.log(`handoff: ${reason}${forwarding ? "" : "; this process keeps serving"}`);
      lost(new Error(reason));
      if (forwarding) side.fail(reason);
      resolve();
    });
  });
}

/**
 * Makes a chat that quiesced as inert as a stopped one while it still answers reads: no file write under the agent dir but its CPU profile,
 * its call log, its first pages and the watch's lines, no daemon command but a read (`DAEMON_READS`), and none of its helper processes
 * (prechecks, relay tunnels, scripts), which a stop's SIGKILL ends: a job sweep or duty run it had under way then fails where the stop cut
 * it before, and the successor's resume picks it up.
 */
export async function fenceHandedOver(successor: number, dataDir: string, log: (line: string) => void = line => process.stderr.write(`${new Date().toISOString()} ${line}\n`)): Promise<void> {
  const [{ fencedAgentDirs, fenceWrites }, { DAEMON_READS }, { refuseWrites }, { DaemonClient }] = await Promise.all([import("./scratch-fence.ts"),
    import("./read-only-daemon.ts"), import("./daemon-write.ts"), import("./daemon-sdk.ts")]);
  fenceWrites(fencedAgentDirs(), log, { label: "handoff", who: "a chat that handed over",
    allow: ["cpu-profiles", "prime-calls.jsonl", "first-pages", "mac-usable"].map(name => join(dataDir, name)) });
  const reason = "This chat process handed over to its successor and only reads.";
  refuseWrites(reason);
  const proto = DaemonClient.prototype as unknown as { request: (command: { type: string }, ...rest: unknown[]) => Promise<unknown> };
  const request = proto.request;
  proto.request = function (this: unknown, command: { type: string }, ...rest: unknown[]) {
    if (!DAEMON_READS.has(command.type)) return Promise.resolve({ type: "response", command: command.type, success: false, error: reason });
    return request.call(this, command, ...rest);
  };
  for (const pid of descendants(process.pid, successor)) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
}

/** The processes under `root` from /proc, leaving out `except` and everything under it. */
export function descendants(root: number, except: number, table: ReadonlyMap<number, number> = processParents()): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, parent] of table) children.set(parent, [...children.get(parent) ?? [], pid]);
  const out: number[] = [];
  const walk = (pid: number) => { for (const child of children.get(pid) ?? []) if (child !== except) { out.push(child); walk(child); } };
  walk(root);
  return out;
}

/** Each process's parent, from /proc/<pid>/stat; the command name in parentheses may hold spaces, so the fields after its last ")" count. */
function processParents(): Map<number, number> {
  const table = new Map<number, number>();
  for (const name of (() => { try { return readdirSync("/proc"); } catch { return []; } })()) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      if (Number.isInteger(parent)) table.set(Number(name), parent);
    } catch { /* gone */ }
  }
  return table;
}

/** The successor's side: the running chat that started it, reached over IPC. Null for a serve that is no successor. */
export function handoffParent(env: NodeJS.ProcessEnv = process.env): HandoffParent | null {
  if (env[HANDOFF_ENV] !== "1" || !process.connected) return null;
  delete env[HANDOFF_ENV];
  return new HandoffParent();
}

export class HandoffParent {
  /** The port's socket, which the running chat passed as fd 3. */
  readonly listenFd = 3;
  private readonly waiting = new Map<string, () => void>();
  private againAsked = false;
  private onAgain: (() => void) | null = null;
  constructor(private readonly channel: Pick<NodeJS.Process, "on" | "once" | "send"> = process) {
    channel.on("message", (message: unknown) => {
      if (!isMessage(message)) return;
      const next = message as ToNew;
      if (next.kind === "latency") { if (next.latency) foldLatency(next.latency); }
      else if (next.kind === "again") { this.againAsked = true; this.onAgain?.(); }
      this.waiting.get(next.kind)?.();
      this.waiting.delete(next.kind);
    });
  }

  private ask(message: ToOld, answer?: ToNew["kind"]): Promise<void> {
    const answered = answer ? new Promise<void>(resolve => this.waiting.set(answer, resolve)) : Promise.resolve();
    this.channel.send?.(message);
    return answered;
  }

  /** Asks the running chat to stop acting, and resolves once it did, so this process's loops never run beside its. */
  quiet(): Promise<void> { return this.ask({ kind: "quiesce" }, "quiet"); }

  /** Runs `start` when the running chat passed on a reload that came during this hand-over, once this process serves. */
  whenAskedAgain(start: () => void): void {
    this.onAgain = start;
    if (this.againAsked) start();
  }

  /**
   * The shell `startChatServer` takes the port through: its `take` answers the requests the running chat passes on at once, on a port of its
   * own, takes the socket once `ready` resolved (or after TAKEOVER_MS), tells systemd this process is the service's main one, and only then
   * tells the running chat, which stops taking connections.
   */
  shell(ready: Promise<void>, log: (line: string) => void, notify: (fields: readonly string[]) => Promise<unknown> = notifySystemd, takeoverMs = TAKEOVER_MS): EarlyShell {
    const server = createServer();
    return {
      server,
      async settled() {},
      take: async (handler: Handler, upgrade: Upgrade) => {
        const own: Server = createServer(handler);
        own.on("upgrade", upgrade);
        await new Promise<void>((resolve, reject) => { own.once("error", reject); own.listen(0, "127.0.0.1", () => { own.off("error", reject); resolve(); }); });
        await this.ask({ kind: "writes", port: (own.address() as AddressInfo).port });
        const began = Date.now();
        let timer: NodeJS.Timeout | undefined;
        const waited = await Promise.race([ready.then(() => "ready" as const), new Promise<"late">(resolve => { timer = setTimeout(() => resolve("late"), takeoverMs); timer.unref(); })]);
        clearTimeout(timer);
        server.on("request", handler);
        server.on("upgrade", upgrade);
        await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen({ fd: this.listenFd }, () => { server.off("error", reject); resolve(); }); });
        await notify([`MAINPID=${process.pid}`, "READY=1"]).catch(error => log(`handoff: systemd-notify: ${error instanceof Error ? error.message : String(error)}`));
        log(`handoff: took the port ${Math.round((Date.now() - began) / 1000)} s after the server was ready, ${waited === "ready" ? "once its first pass ended" : `with its first pass still going after ${takeoverMs / 1000} s`}`);
        await this.ask({ kind: "taken" });
        this.channel.once("disconnect", () => { own.close(); });
      },
    };
  }
}
