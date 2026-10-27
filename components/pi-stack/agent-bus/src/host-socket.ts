/**
 * A small client for pi-host's socket, used only by a plain `pi` CLI that has `PI_HOST_SOCKET` set.
 * It speaks the v7 lines in `host/src/protocol.ts`: wait for `daemon_hello`, send one command, read its `response`.
 */

import { createConnection } from "node:net";
import { HOST_SOCKET_ENV } from "../../host/src/api.ts";
import type { DeliveryMode } from "../../shared/registry.ts";
import type { Receipt } from "./message.ts";

export interface HostRoot {
  sessionId: string;
  sessionName?: string;
  cwd: string;
  sessionFile?: string;
  rosterStatus: "running" | "idle" | "inactive";
  runtimeKind: "top-level" | "subagent";
  rlmDepth?: number;
}

const TIMEOUT_MS = 30_000;

export function needsHost(what: string): Error {
  return new Error(`${what} needs pi-host: this session runs outside pi-host and ${HOST_SOCKET_ENV} is not set`);
}

export async function hostRequest(command: Record<string, unknown>, socketPath = process.env[HOST_SOCKET_ENV]): Promise<unknown> {
  if (!socketPath) throw needsHost(String(command.type));
  const id = `bus-${process.pid}-${Math.random().toString(36).slice(2)}`;
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let hello = false;
    const timer = setTimeout(() => finish(new Error(`pi-host did not answer ${String(command.type)} within ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
    const finish = (error?: Error, value?: unknown) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.on("error", error => finish(error));
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
          socket.write(`${JSON.stringify({ ...command, id })}\n`);
        } else if (msg.type === "response" && msg.id === id) {
          if (msg.success) finish(undefined, msg.data);
          else finish(new Error(msg.error ?? `pi-host refused ${String(command.type)}`));
        }
      }
    });
  });
}

export async function hostRoots(): Promise<HostRoot[]> {
  const data = (await hostRequest({ type: "list", all: true })) as { sessions?: HostRoot[] } | undefined;
  return (data?.sessions ?? []).filter(row => row.runtimeKind === "top-level");
}

export async function hostSend(input: { target: string; message: string; mode: DeliveryMode; from: { id: string; name: string } }): Promise<Receipt> {
  const data = (await hostRequest({
    type: "send_message",
    targetActiveSessionId: input.target,
    message: input.message,
    fromActiveSessionId: input.from.id,
    fromName: input.from.name,
    agentOrigin: true,
    deliveryMode: input.mode,
  })) as Partial<Receipt> & { delivery?: "started" | "queued" };
  if (data && typeof data.deliveryStatus === "string") return data as Receipt;
  throw new Error("pi-host answered send_message without a receipt; it needs pi-agent-bus's route.ts loaded");
}
