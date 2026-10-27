/**
 * A small client for pi-host's v7 lines: wait for `daemon_hello`, send one command, read its `response`.
 * It reaches the host on this box through the unix socket in `PI_HOST_SOCKET`, and a pi-host on another box through that box's prime-relay,
 * which tunnels `GET /v1/daemon` to the host socket byte for byte.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { createConnection } from "node:net";
import type { Duplex } from "node:stream";
import { HOST_SOCKET_ENV } from "@sieun-pi/pi-family/host-api";
import type { DeliveryMode } from "@sieun-pi/pi-family/registry";
import type { Receipt } from "./message.ts";

export interface HostRoot {
  sessionId: string;
  sessionName?: string;
  cwd: string;
  sessionFile?: string;
  rosterStatus: "running" | "idle" | "inactive";
  runtimeKind: "top-level" | "subagent";
  rlmDepth?: number;
  /** The box that holds this root, when it is not this box's host. */
  box?: string;
}

/** Another box: its name and its prime-relay, which tunnels to that box's pi-host socket. */
export interface Box {
  name: string;
  url: string;
  tokenFile: string;
}

/** Where a command goes: this box's host socket, or another box's relay. */
export type Route = { socket: string } | { box: Box };

const TIMEOUT_MS = 30_000;
export const BOXES_ENV = "PI_AGENT_BUS_BOXES";

export function needsHost(what: string): Error {
  return new Error(`${what} needs pi-host: this session runs outside pi-host and ${HOST_SOCKET_ENV} is not set`);
}

/**
 * The other boxes from the file in `PI_AGENT_BUS_BOXES`: `{"self": "<this box>", "boxes": [{"name", "url", "tokenFile"}]}`.
 * The entry named `self` is skipped, so every box can share one file.
 */
export function otherBoxes(): Box[] {
  const file = process.env[BOXES_ENV];
  if (!file) return [];
  const raw = JSON.parse(readFileSync(file, "utf8")) as { self?: string; boxes?: Box[] };
  return (raw.boxes ?? []).filter(box => box.name !== raw.self);
}

function openTunnel(box: Box): Promise<Duplex> {
  const token = readFileSync(box.tokenFile, "utf8").trim();
  return new Promise((resolve, reject) => {
    const req = request(new URL("/v1/daemon", box.url), {
      method: "GET",
      headers: { Connection: "Upgrade", Upgrade: "prime-daemon", Authorization: `Bearer ${token}` },
      timeout: TIMEOUT_MS,
    });
    req.on("upgrade", (_res, socket, head) => {
      if (head.length > 0) socket.unshift(head);
      resolve(socket);
    });
    req.on("response", res => {
      res.resume();
      reject(new Error(`prime-relay on ${box.name} answered ${res.statusCode} instead of opening a tunnel`));
    });
    req.on("timeout", () => req.destroy(new Error(`prime-relay on ${box.name} did not answer within ${TIMEOUT_MS}ms`)));
    req.on("error", reject);
    req.end();
  });
}

function where(route: Route): string {
  return "box" in route ? `pi-host on ${route.box.name}` : "pi-host";
}

/** A failed response from the host. Anything else, such as a refused connection or a close before the answer, may have been a host death. */
export class HostRefusal extends Error {}

/**
 * Sends one command and resolves with its response data. With `envelope`, the line is a v7 envelope with that client id and command id, so a
 * retry of the same command carries the same key.
 */
export async function lineRequest(route: Route, command: Record<string, unknown>, envelope?: { clientId: string; id: string }): Promise<unknown> {
  const socket: Duplex = "box" in route ? await openTunnel(route.box) : createConnection(route.socket);
  const id = envelope?.id ?? `bus-${process.pid}-${Math.random().toString(36).slice(2)}`;
  return await new Promise((resolve, reject) => {
    let buffer = "";
    let hello = false;
    const timer = setTimeout(() => finish(new Error(`${where(route)} did not answer ${String(command.type)} within ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
    const finish = (error?: Error, value?: unknown) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.on("error", error => finish(error));
    socket.on("close", () => finish(new Error(`${where(route)} closed the connection before answering ${String(command.type)}`)));
    socket.on("data", chunk => {
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as { type?: string; id?: string; success?: boolean; data?: unknown; error?: string };
        if (!hello && msg.type === "daemon_hello") {
          hello = true;
          const line = envelope ? { type: "command", id, protocol: { name: "prime-agent.daemon", version: 7 }, clientId: envelope.clientId, command: { ...command, id } } : { ...command, id };
          socket.write(`${JSON.stringify(line)}\n`);
        } else if (msg.type === "response" && msg.id === id) {
          if (msg.success) finish(undefined, msg.data);
          else finish(new HostRefusal(msg.error ?? `${where(route)} refused ${String(command.type)}`));
        }
      }
    });
  });
}

export function localRoute(): Route {
  const socket = process.env[HOST_SOCKET_ENV];
  if (!socket) throw needsHost("this send");
  return { socket };
}

export async function hostRequest(command: Record<string, unknown>, route?: Route): Promise<unknown> {
  if (!route && !process.env[HOST_SOCKET_ENV]) throw needsHost(String(command.type));
  return await lineRequest(route ?? localRoute(), command);
}

export async function hostRoots(route?: Route): Promise<HostRoot[]> {
  const data = (await hostRequest({ type: "list", all: true }, route)) as { sessions?: HostRoot[] } | undefined;
  const box = route && "box" in route ? route.box.name : undefined;
  return (data?.sessions ?? []).filter(row => row.runtimeKind === "top-level").map(row => (box ? { ...row, box } : row));
}

/** How long a send keeps retrying with the same key while the host does not answer, such as during a host restart. */
export const SEND_RETRY_MS = 60_000;

export async function hostSend(input: { target: string; message: string; mode: DeliveryMode; from: { id: string; name: string }; route?: Route }): Promise<Receipt> {
  const route = input.route ?? localRoute();
  const clientId = `agent-bus:${input.from.id}`;
  const commandId = randomUUID();
  const command = {
    type: "send_message",
    targetActiveSessionId: input.target,
    message: input.message,
    fromActiveSessionId: input.from.id,
    fromName: input.from.name,
    agentOrigin: true,
    deliveryMode: input.mode,
    idempotencyKey: `${clientId}:${commandId}`,
  };
  const deadline = Date.now() + SEND_RETRY_MS;
  let data: Partial<Receipt> | undefined;
  for (let attempt = 0; ; attempt += 1) {
    try {
      data = (await lineRequest(route, command, { clientId, id: commandId })) as Partial<Receipt>;
      break;
    } catch (error) {
      if (error instanceof HostRefusal || Date.now() > deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(2000, 100 * 2 ** attempt)));
    }
  }
  if (!data || typeof data.deliveryStatus !== "string") throw new Error(`${where(route)} answered send_message without a receipt; it needs pi-agent-bus's route.ts loaded`);
  return "box" in route ? { ...(data as Receipt), host: route.box.name, crossHost: true } : (data as Receipt);
}
