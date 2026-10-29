import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { decodeLineDeltas } from "../../../../components/prime-relay/line-delta.ts";
import { header } from "../../../../packages/pi-rlm/src/core/bus/message.ts";
import { type Host, loadHosts, openDaemonTunnel, selfHost } from "./hosts.ts";
import { isMain } from "./main-module.ts";

/*
 * Agent messages from a Prime root to a pi-host thread. Prime's daemon knows no pi-host thread (c93), so message-limit-check.py calls this
 * file's CLI: `siblings` lists the threads as sibling rows for agent_observe.list_agents and the send's target lookup, and `send` hands the
 * message to the thread as a durable_submit with an agent.message entry, so pi's turn wrappers read it as an agent's and not the owner's.
 *
 * pi-host answers on this box's socket (PI_HOST_SOCKET, else $XDG_RUNTIME_DIR/pi-host/host.sock), and on a box without one through the
 * pi-host relays in pi-rlm's boxes file (PI_AGENT_BUS_BOXES, else ~/.config/pi-host-relay/boxes.json), which tunnel GET /v1/daemon to the
 * socket. The line request below follows pi-rlm's lineRequest (core/bus/host-socket.ts), which the Mac runtime cannot import: it has no
 * @sieun-pi/pi-family package (10-29: "Cannot find package '@sieun-pi/pi-family' imported from .../host-socket.ts").
 */

/** Where pi-host answers: this box's socket, or another box's pi-host relay as pi-rlm's boxes file names it. */
export type Route = { box: string; socket: string } | { box: string; relay: { url: string; tokenFile: string } };

/** A pi-host thread as durable_threads lists it, with the box that runs it. */
export interface Thread { id: string; name: string; status: string; box: string }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

async function ownBox(): Promise<string> {
  try { return selfHost(await loadHosts())?.name ?? hostname().split(".")[0]!; } catch { return hostname().split(".")[0]!; }
}

/** This box's pi-host socket when one is there, then every other box in the boxes file. */
export async function routes(env: NodeJS.ProcessEnv = process.env): Promise<Route[]> {
  const found: Route[] = [];
  const socket = env.PI_HOST_SOCKET || (env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, "pi-host", "host.sock") : "");
  if (socket && existsSync(socket)) found.push({ box: await ownBox(), socket });
  const file = env.PI_AGENT_BUS_BOXES || join(homedir(), ".config/pi-host-relay/boxes.json");
  if (!existsSync(file)) return found;
  const raw = JSON.parse(readFileSync(file, "utf8")) as { self?: string; boxes?: { name: string; url: string; tokenFile: string }[] };
  for (const box of raw.boxes ?? []) if (box.name !== raw.self) found.push({ box: box.name, relay: { url: box.url, tokenFile: box.tokenFile } });
  return found;
}

async function open(route: Route): Promise<{ write: Duplex; read: NodeJS.ReadableStream }> {
  if ("socket" in route) {
    const socket = createConnection(route.socket);
    return { write: socket, read: socket };
  }
  const url = new URL(route.relay.url);
  const host: Host = { name: route.box, hostname: route.box, address: url.hostname, relayPort: Number(url.port), token: `file:${route.relay.tokenFile}`,
    daemonSocket: "/", ssh: null, roles: {} };
  const tunnel = await openDaemonTunnel(host);
  return { write: tunnel, read: tunnel.pipe(decodeLineDeltas()) };
}

/** One command's response data. A refused connection or a close before the answer is "pi-host did not answer", which the wrapper retries. */
export async function hostCall(route: Route, command: Record<string, unknown>): Promise<unknown> {
  const where = "socket" in route ? `${route.socket} on ${route.box}` : `the pi-host relay ${route.relay.url}`;
  const down = (error: unknown) => new Error(`pi-host did not answer (${where}): ${error instanceof Error ? error.message : String(error)}`);
  let stream;
  try { stream = await open(route); } catch (error) { throw down(error); }
  const { write, read } = stream;
  const id = `pi-thread-message-${process.pid}`;
  return await new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      write.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    write.on("error", error => finish(down(error)));
    write.on("close", () => finish(down("closed the connection before answering")));
    read.on("data", chunk => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line) as { type?: string; id?: string; success?: boolean; data?: unknown; error?: string };
        if (message.type === "daemon_hello") write.write(`${JSON.stringify({ ...command, id })}\n`);
        else if (message.type === "response" && message.id === id) {
          if (message.success) finish(undefined, message.data);
          else finish(new Error(`pi-host refused ${String(command.type)}: ${message.error ?? "no reason given"}`));
        }
      }
    });
  });
}

/** Every route's live threads; the archived ones take no message. */
export async function listThreads(found: readonly Route[]): Promise<{ route: Route; thread: Thread }[]> {
  const rows: { route: Route; thread: Thread }[] = [];
  for (const route of found) {
    const data = await hostCall(route, { type: "durable_threads", archived: false });
    for (const row of isRecord(data) && Array.isArray(data.threads) ? data.threads : []) {
      if (isRecord(row) && typeof row.id === "string") rows.push({ route, thread: { id: row.id, name: String(row.name ?? ""), status: String(row.status ?? ""), box: route.box } });
    }
  }
  return rows;
}

/** The roster row a pi-host thread adds to a Prime root's agent_observe.list_agents, in the shape of siblingRow in cross-host-message.ts. */
export function threadRow(thread: Thread): Record<string, unknown> {
  return { sessionId: thread.id, activeSessionId: thread.id, sessionName: thread.name, runtimeKind: "top-level", relationship: "sibling", status: thread.status,
    host: thread.box, piThread: true };
}

/** The one thread `to` names by its full id or its exact name. An id prefix names none (c149). */
export function pickThread<T extends { thread: Thread }>(rows: readonly T[], to: string): T | { error: string } {
  const wanted = to.trim();
  const byId = rows.filter(row => row.thread.id === wanted);
  const named = byId.length ? byId : rows.filter(row => row.thread.name.trim() === wanted);
  if (named.length === 1) return named[0]!;
  if (!named.length) return { error: `No pi-host thread has the id or the name "${wanted}".` };
  return { error: `"${wanted}" names ${named.length} pi-host threads (${named.map(row => `${row.thread.name} ${row.thread.id} on ${row.thread.box}`).join(", ")}); send to one thread id.` };
}

/** The input text: the line that names the sender and how to answer, a blank line, then the message. */
export function threadText(from: { id: string; name: string }, box: string, message: string): string {
  return `${header(from.name, "sibling").slice(0, -1)} (${from.id}, a Prime session on ${box}); answer with agent_message.send(text, ` +
    `receiver_role="sibling", receiver_name=${JSON.stringify(from.id)})]\n\n${message}`;
}

/**
 * Submits `message` from Prime root `from` to the thread `to` names. The request id comes from the sender's message id, so a send the wrapper
 * repeats after pi-host did not answer lands once.
 */
export async function sendToThread(found: readonly Route[], input: { from: { id: string; name: string }; to: string; message: string; id: string }): Promise<Record<string, unknown>> {
  const target = pickThread(await listThreads(found), input.to);
  if ("error" in target) throw new Error(target.error);
  const box = await ownBox();
  const data = await submit(target.route, target.thread.id, threadText(input.from, box, input.message), `agentmsg:${input.id}`, { from: input.from.id, via: "agent_message" });
  const endpoint = (id: string, name: string) => ({ activeSessionId: id, sessionId: id, sessionName: name, runtimeKind: "top-level" });
  return { id: `agentmsg_${input.id}`, source: "agent_message", target: endpoint(target.thread.id, target.thread.name), from: endpoint(input.from.id, input.from.name),
    message: input.message, deliveryStatus: data.status === "queued" ? "queued" : "delivered", deliveryMode: "steer", host: target.thread.box, piThread: true,
    requestId: data.requestId, submission: data.submission, status: data.status };
}

/** One durable_submit of an agent.message input to the thread, which steers a turn that runs. */
async function submit(route: Route, thread: string, text: string, requestId: string, data: { from: string; via: string }): Promise<Record<string, unknown>> {
  return await hostCall(route, { type: "durable_submit", thread, text, requestId, whenBusy: "steer", entry: { kind: "agent.message", data } }) as Record<string, unknown>;
}

/** The thread's route, by its full id. */
async function routeOf(found: readonly Route[], thread: string): Promise<Route> {
  const row = (await listThreads(found)).find(row => row.thread.id === thread);
  if (!row) throw new Error(`No live pi-host thread has the id ${thread}.`);
  return row.route;
}

/** The alert bridge's message to a thread that owns a firing rule (src/alert-bridge.ts `threadAlertText`), as an agent message from "alert-bridge". */
export async function sendAlert(found: readonly Route[], thread: string, message: string, requestId: string): Promise<void> {
  await submit(await routeOf(found, thread), thread, `${header("alert bridge", undefined)}\n\n${message}`, requestId, { from: "alert-bridge", via: "alert-bridge" });
}

/**
 * The thread's newest `limit` root entries, newest first, as durable_entries gives them. A root turn that ended after the alert bridge sent a
 * fire ends in this page, unless the thread wrote more than `limit` entries after it, which leaves newer turns in the page anyway.
 */
export async function threadEntries(found: readonly Route[], thread: string, limit = 50): Promise<unknown[]> {
  const data = await hostCall(await routeOf(found, thread), { type: "durable_entries", thread, limit });
  return isRecord(data) && Array.isArray(data.entries) ? data.entries : [];
}

/** The live threads by id, with their names, from every route that answers. */
export async function threadNames(found: readonly Route[]): Promise<Map<string, string>> {
  return new Map((await listThreads(found)).map(row => [row.thread.id, row.thread.name]));
}

/** `node pi-thread-message.ts siblings|send` with {} or {from: {id, name}, to, message, id} on stdin prints the answer or {error}. */
async function cli(op: string): Promise<unknown> {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}") as Record<string, unknown>;
  const found = await routes();
  if (op === "siblings") return { agents: (await listThreads(found)).map(row => threadRow(row.thread)) };
  if (op === "send") {
    const from = input.from as { id: string; name: string };
    return await sendToThread(found, { from, to: String(input.to), message: String(input.message), id: String(input.id) });
  }
  throw new Error(`Unknown op ${op}.`);
}

if (isMain(import.meta.url)) {
  cli(process.argv[2] ?? "").then(
    answer => process.stdout.write(`${JSON.stringify(answer)}\n`),
    error => process.stdout.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`));
}
