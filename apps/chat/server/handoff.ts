/**
 * A release of apps/chat without a closed port. systemd holds 127.0.0.1:5184 in sieun-pi-apps-chat.socket and passes it to the server as fd 3,
 * so a call that lands while no process accepts waits in the socket's queue instead of failing with ECONNREFUSED. A release reloads the
 * unit (SIGHUP), and the running server starts its successor beside it on the same fd:
 *
 * 1. The successor loads its modules, which is most of a start (1.2 to 2.9 s of the 3.2 s median start on 11-22, server/main.ts), and says
 *    `loaded` while the running server still answers every call.
 * 2. The running server stops taking connections, lets its calls in flight answer (`drain`), stops its loops and writes its queued files
 *    (`App.stop`), and says `stopped`. Calls that arrive from now on wait in the socket's queue.
 * 3. The successor reads the state files only now, so no write of the running server lands after it read them, starts, takes the fd, tells
 *    systemd it is the main process and says `taken`; the running server exits.
 *
 * Two App instances never run at once, so nothing in the data dir, the wakes, the duties or the search index is written by both. Without a
 * passed fd (a hand run, the fixture specs) the server listens on its port itself and a SIGHUP does nothing.
 */
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
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

/** sd_notify through systemd-notify, as chat-handoff.ts `notifySystemd` does; false when the unit is no Type=notify one. */
async function notifySystemd(fields: readonly string[], log: (line: string) => void): Promise<boolean> {
  if (!process.env.NOTIFY_SOCKET) return false;
  const at = Date.now();
  // systemd-notify answered in 13 ms from a test unit on us-metal02 on 11-08 (chat-handoff.ts); 30 s fails only one that hangs.
  await promisify(execFile)("systemd-notify", [`--pid=${process.pid}`, ...fields], { timeout: 30_000 });
  log(`systemd: told it ${fields.join(" ")} in ${Date.now() - at} ms`);
  return true;
}

/** Tells systemd this process serves: READY=1, and MAINPID= for a successor, which systemd must take as the main process before its predecessor exits. */
export async function tellSystemd(successor: boolean, log: (line: string) => void): Promise<void> {
  await notifySystemd(successor ? [`MAINPID=${process.pid}`, "READY=1"] : ["READY=1"], log);
}

/** The running server's side. */
export interface Running {
  fd: number;
  server: Server;
  /** Stops the app and writes its queued files; the port is closed and drained by then. */
  stop(): Promise<void>;
  /** Closes the server and waits for its calls in flight (http.ts `drain`). */
  drain(server: Server): Promise<void>;
  log(line: string): void;
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

/** One hand-over; resolves once the successor took the port, or once it ended before that. */
export async function handOver(side: Running, args: string[] = serveArgs(), cwd = process.env[CURRENT_ENV] ?? process.cwd()): Promise<void> {
  const began = Date.now();
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, [HANDOFF_ENV]: "1" }, stdio: ["ignore", "inherit", "inherit", side.fd, "ipc"] });
  side.log(`handoff: started the successor ${child.pid} in ${cwd}; this process serves until it loaded`);
  let stoppedAt = 0, taken = false;
  await new Promise<void>(resolve => {
    child.on("message", (message: unknown) => {
      const kind = kindOf(message);
      if (kind === "loaded") {
        const loadedAt = Date.now();
        void (async () => {
          await side.drain(side.server);
          await side.stop();
          stoppedAt = Date.now();
          side.log(`handoff: ${child.pid} loaded in ${loadedAt - began} ms; this process stopped in ${Date.now() - loadedAt} ms, and calls wait in the socket's queue until ${child.pid} takes it`);
          child.send({ kind: "stopped" } satisfies ToNew);
        })().catch(error => {
          side.log(`handoff: stop: ${error instanceof Error ? error.message : String(error)}`);
          child.kill("SIGKILL");
        });
      } else if (kind === "taken") {
        taken = true;
        side.log(`handoff: ${child.pid} took the port ${Date.now() - stoppedAt} ms after this process stopped, ${Date.now() - began} ms after the reload; this process exits`);
        child.disconnect();
        child.unref();
        resolve();
        side.exit(0);
      }
    });
    child.once("error", error => side.log(`handoff: the successor: ${error.message}`));
    child.once("exit", (code, signal) => {
      if (taken) return;
      side.log(`handoff: the successor ${child.pid} ended (${signal ?? `exit ${code}`}) before it took the port; ${stoppedAt ? "this process had stopped, so it exits and systemd starts the unit again" : "this process keeps serving"}`);
      resolve();
      if (stoppedAt) side.exit(1);
    });
  });
}
