/**
 * The Prime shapes pi-agent-bus writes: the custom message a target receives, the sender and target endpoints, and the receipt.
 * sieun-pi's transcript readers match these shapes today (`custom_message` with `customType: "agent_message"`).
 */

import { randomUUID } from "node:crypto";
import type { AgentRole, BusMessage, Delivery, DeliveryMode } from "../../shared/registry.ts";
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
