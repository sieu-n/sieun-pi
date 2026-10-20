import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";

/**
 * Runs a command the way node:child_process execFile does, from a small helper process (spawn-host-child.mjs) instead of the chat's own
 * process. A fork copies the forking process's page tables: on us-metal02 on 10-20 the chat service (2 to 7 GB) spent 39 ms at the median
 * and up to 217 ms of its main thread in each spawn, 1,546 spawns and 64.7 s in 70 min of its CPU profile, and the spawns a pass started
 * together held its event loop up to 0.44 s. A worker thread does not help: its fork still copies the whole process and held the main
 * thread's loop longer in a 0.6 GB test process (186 against 85 ms).
 */
export interface HostExecOptions { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number; killSignal?: NodeJS.Signals }
export type HostExecError = Error & { code?: number | string; signal?: NodeJS.Signals | null; killed?: boolean; cmd?: string };
export type HostExecCallback = (error: HostExecError | null, stdout: string, stderr: string) => void;
/** The part of a ChildProcess the callers use: its stdin's end, which sends the input with the command. */
export interface HostExecChild { stdin: { end(input?: string): void } }

type Answer = { id: number; stdout: string; stderr: string; error: { message: string; code?: number | string; signal: NodeJS.Signals | null; killed: boolean; cmd?: string } | null };

const CHILD = join(import.meta.dirname, "spawn-host-child.mjs");
let host: ChildProcess | null = null;
let buffered = "";
let nextId = 1;
const waiting = new Map<number, HostExecCallback>();

/** Holds the service open only while a command runs, as a direct execFile does. */
function hold(): void {
  if (!host) return;
  const busy = waiting.size > 0;
  for (const handle of [host, host.stdin, host.stdout] as ({ ref?(): void; unref?(): void } | null)[]) busy ? handle?.ref?.() : handle?.unref?.();
}

function failAll(message: string): void {
  const callbacks = [...waiting.values()];
  waiting.clear();
  for (const callback of callbacks) callback(Object.assign(new Error(message), { code: "ESPAWNHOST" }), "", "");
}

function started(): ChildProcess {
  if (host) return host;
  const child = spawn(process.execPath, [CHILD], { stdio: ["pipe", "pipe", "inherit"] });
  host = child;
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    buffered += chunk;
    for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      let answer: Answer;
      try { answer = JSON.parse(line) as Answer; } catch { continue; }
      const callback = waiting.get(answer.id);
      if (!callback) continue;
      waiting.delete(answer.id);
      hold();
      const error = answer.error ? Object.assign(new Error(answer.error.message), answer.error) : null;
      callback(error, answer.stdout, answer.stderr);
    }
  });
  child.stdin!.on("error", () => {});
  const gone = (why: string) => {
    if (host !== child) return;
    host = null;
    buffered = "";
    failAll(`spawn host ${why}`);
  };
  child.once("error", error => gone(`failed: ${error.message}`));
  child.once("exit", (code, signal) => gone(`exited (${signal ?? code})`));
  return child;
}

export function hostExecFile(file: string, args: readonly string[], options: HostExecOptions, callback: HostExecCallback): HostExecChild {
  let input: string | undefined;
  const id = nextId++;
  queueMicrotask(() => {
    const child = started();
    waiting.set(id, callback);
    hold();
    child.stdin!.write(JSON.stringify({ id, file, args, cwd: options.cwd ?? process.cwd(), env: options.env ?? process.env, timeout: options.timeout ?? 0,
      ...options.maxBuffer === undefined ? {} : { maxBuffer: Number.isFinite(options.maxBuffer) ? options.maxBuffer : null },
      killSignal: options.killSignal ?? "SIGTERM", ...input === undefined ? {} : { input } }) + "\n");
  });
  return { stdin: { end: (text = "") => { input = text; } } };
}

/** Stops the helper; the next command starts a new one. */
export function stopSpawnHost(): void {
  const child = host;
  if (!child) return;
  host = null;
  failAll("spawn host stopped");
  child.stdin?.end();
  child.kill();
}
