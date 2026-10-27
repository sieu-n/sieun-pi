/**
 * The Prime shapes pi-agent-bus writes: the custom message a target receives, the sender and target endpoints, and the receipt.
 * sieun-pi's transcript readers match these shapes today (`custom_message` with `customType: "agent_message"`).
 */

import { createHash, randomUUID } from "node:crypto";
import type { AgentRole, BusMessage, Delivery, DeliveryMode } from "@sieun-pi/pi-family/registry";
import type { Relationship } from "./family.ts";

export const CUSTOM_TYPE = "agent_message";
export const SOURCE = "agent_message";

export interface Endpoint {
  activeSessionId: string;
  sessionId: string;
  sessionName: string;
  runtimeKind: "top-level" | "subagent";
  clientId?: string;
}

export interface Receipt {
  id: string;
  source: typeof SOURCE;
  target: Endpoint;
  from: Endpoint;
  message: string;
  deliveryStatus: "delivered" | "queued";
  deliveredAt?: string;
  queuedAt?: string;
  deliveryMode: "steer" | "follow_up";
  /** Soft caps the send went over (owner rule c98). Absent when none. */
  overLimit?: string[];
  /** The box that holds the target, for a send through another box's prime-relay. */
  host?: string;
  crossHost?: true;
  /** Set when a keyed send repeated one the target already holds, so nothing was delivered again. */
  duplicate?: true;
}

export interface AgentMessageDetails {
  id: string;
  message: string;
  from: Endpoint;
  fromRelationship?: Relationship;
  target: Endpoint;
}

export function newMessageId(): string {
  return `agentmsg_${randomUUID()}`;
}

/** The message id of a keyed send: the same target and idempotency key always give the same id, in Prime's `agentmsg_<uuid>` form. */
export function keyedMessageId(targetId: string, key: string): string {
  const h = createHash("sha256").update(`${targetId}\n${key}`).digest("hex");
  return `agentmsg_${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function endpoint(id: string, name: string, role: AgentRole | "host" | "owner", clientId?: string): Endpoint {
  return { activeSessionId: id, sessionId: id, sessionName: name, runtimeKind: role === "child" ? "subagent" : "top-level", ...(clientId ? { clientId } : {}) };
}

export function header(fromName: string, rel: Relationship | undefined): string {
  const name = fromName.replace(/[\]\n]/g, " ").trim() || "unknown";
  return `[agent-message from ${rel ? `${rel}:${name}` : name}]`;
}

/** The custom message Prime's host built (`_Un`): a labeled header, a blank line and the text, with the ids in details. */
export function customMessage(bus: BusMessage, rel: Relationship | undefined, target: Endpoint) {
  const from = endpoint(bus.from.id, bus.from.name, bus.from.role, bus.from.role === "host" || bus.from.role === "owner" ? bus.from.role : "agent");
  const details: AgentMessageDetails = { id: bus.id, message: bus.text, from, ...(rel ? { fromRelationship: rel } : {}), target };
  return { customType: CUSTOM_TYPE, content: `${header(bus.from.name, rel)}\n\n${bus.text}`, display: true, details };
}

export function receipt(bus: BusMessage, from: Endpoint, target: Endpoint, delivery: Delivery, overLimit: string[]): Receipt {
  const at = new Date().toISOString();
  return {
    id: bus.id,
    source: SOURCE,
    target,
    from,
    message: bus.text,
    deliveryStatus: delivery === "started" ? "delivered" : "queued",
    ...(delivery === "started" ? { deliveredAt: at } : { queuedAt: at }),
    deliveryMode: bus.mode === "follow_up" ? "follow_up" : "steer",
    ...(overLimit.length > 0 ? { overLimit } : {}),
  };
}

export function parseMode(value: unknown): DeliveryMode {
  if (value === undefined || value === null) return "auto";
  if (value === "auto" || value === "steer" || value === "follow_up") return value;
  throw new Error('agent_message.send mode must be "auto", "steer", or "follow_up"');
}
