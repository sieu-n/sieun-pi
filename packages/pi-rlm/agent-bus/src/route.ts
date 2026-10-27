/**
 * Sends one agent message: resolve the target in the sender's family, check the soft caps, deliver it on the right path and return
 * Prime's receipt.
 *
 * The paths, in order: a session in `pi-family/registry.ts` gets its own `deliver`; a dormant row wakes first; inside pi-host a closed
 * session is restored through `hostApi()`; a plain `pi` CLI reaches pi-host's roots over `PI_HOST_SOCKET`. Other boxes need prime-relay.
 */

import * as registry from "@sieun-pi/pi-family/registry";
import type { AgentEntry, AgentRole, BusMessage, Delivery, DeliveryMode } from "@sieun-pi/pi-family/registry";
import { hostApi } from "../../../pi-host/src/api.ts";
import { family, REACH_ERROR, relationship, type Member, type Relationship } from "./family.ts";
import { hostSend, needsHost } from "./host-socket.ts";
import { overLimits } from "./limits.ts";
import { allMembers, memberOf, type Known } from "./members.ts";
import { endpoint, keyedMessageId, newMessageId, parseMode, receipt, type Endpoint, type Receipt } from "./message.ts";
import { pendingCount, rememberReceipt, state } from "./state.ts";

const ROLES = ["parent", "sibling", "child"] as const;

export interface SendPayload {
  message?: unknown;
  target?: unknown;
  receiver_role?: unknown;
  receiver_name?: unknown;
  mode?: unknown;
}

export type BroadcastResult = { receipts: (Receipt | { target: string; error: string })[] };

function cleanText(message: unknown): string {
  if (typeof message !== "string") throw new Error("agent_message.send message must be a string");
  const text = message.trim();
  if (!text) throw new Error("Agent session message cannot be empty");
  return text;
}

function selfMember(sessionId: string): Member {
  const entry = registry.get(sessionId);
  if (!entry) throw new Error(`agent messaging is not available in session ${sessionId}: pi-agent-bus has not registered it`);
  return memberOf(entry);
}

/** The kernel's `agent_message.send`: one role-addressed message, or `target: "all"` for the whole family roster. */
export async function send(fromId: string, payload: SendPayload): Promise<Receipt | BroadcastResult> {
  const self = selfMember(fromId);
  const mode = parseMode(payload.mode);
  if (typeof payload.message !== "string") throw new Error("agent_message.send message must be a string");
  if (typeof payload.target === "string") {
    if (payload.target !== "all") throw new Error("positional agent_message.send targets are not supported; use receiver_role and receiver_name");
    if (payload.receiver_role != null || payload.receiver_name != null) throw new Error("agent_message.send broadcast cannot be combined with receiver_role/receiver_name");
    const members = family(self, await allMembers());
    const settled = await Promise.allSettled(members.map(m => deliverFrom(self, m.relationship, m.item, payload.message, mode)));
    return {
      receipts: settled.map((r, i) =>
        r.status === "fulfilled" ? r.value : { target: members[i].item.member.id, error: r.reason instanceof Error ? r.reason.message : String(r.reason) },
      ),
    };
  }
  const role = payload.receiver_role;
  if (!ROLES.includes(role as Relationship)) throw new Error('agent_message.send receiver_role must be "parent", "sibling", or "child"');
  const name = payload.receiver_name;
  if (role === "parent" && name != null) throw new Error("agent_message.send receiver_name must be omitted for parent messages");
  if (role !== "parent" && (typeof name !== "string" || !name.trim())) throw new Error("agent_message.send receiver_name is required for sibling and child messages");
  const wanted = typeof name === "string" ? name.trim() : undefined;
  const matches = family(self, await allMembers()).filter(
    m => m.relationship === role && (role === "parent" || m.item.member.name === wanted || m.item.member.id === wanted),
  );
  if (matches.length !== 1) {
    throw new Error(matches.length === 0 ? `No ${role} matches ${role === "parent" ? "the current agent" : JSON.stringify(name)}` : `${role} selector ${JSON.stringify(name)} is ambiguous`);
  }
  return await deliverFrom(self, matches[0].relationship, matches[0].item, payload.message, mode);
}

function endpointOf(member: Member, clientId?: string): Endpoint {
  return endpoint(member.id, member.name, member.role, clientId);
}

async function deliverFrom(self: Member, targetRel: Relationship, target: Known, message: unknown, mode: DeliveryMode): Promise<Receipt> {
  const text = cleanText(message);
  if (target.kind === "remote") return await hostSend({ target: target.member.id, message: text, mode, from: { id: self.id, name: self.name }, route: target.route });
  const bus: BusMessage = { id: newMessageId(), from: { id: self.id, name: self.name, role: self.role }, text, mode, sentAt: Date.now() };
  const over = overLimits({ chars: text.length, pending: pendingCount(target.member.id), rateKey: `${self.id}->${target.member.id}` });
  const delivery = await deliverLocal(target, bus);
  if (targetRel === "parent") state().replied.set(self.id, true);
  if (targetRel === "child") state().replied.set(target.member.id, false);
  return receipt(bus, endpointOf(self, "agent"), endpointOf(target.member), delivery, over);
}

async function deliverLocal(target: Known, bus: BusMessage): Promise<Delivery> {
  if (target.kind === "live") return await target.entry.deliver(bus);
  if (target.kind === "dormant") return await (await target.row.wake()).deliver(bus);
  throw new Error(`session ${target.member.id} is in another process`);
}

/** Opens a session this process can reach by id: a registry entry, a dormant row, or a session pi-host restores from its file. */
async function resolveById(id: string): Promise<{ entry?: AgentEntry; member: Member } | undefined> {
  const live = registry.get(id);
  if (live) return { entry: live, member: memberOf(live) };
  const row = registry.dormantOf(id);
  if (row) {
    const entry = await row.wake();
    return { entry, member: memberOf(entry) };
  }
  const host = hostApi();
  if (!host) return undefined;
  await host.restore(id);
  const restored = registry.get(id);
  return restored ? { entry: restored, member: memberOf(restored) } : { member: { id, name: id, role: "root", depth: 0 } };
}

export interface ClientSend {
  target: string;
  message: string;
  mode?: DeliveryMode;
  clientId?: string;
  /** The sending session when it lives in another process, such as a plain `pi` CLI on pi-host's socket. */
  from?: { id: string; name?: string };
  /**
   * The sender's client id and command id, which stay the same when it retries. A repeat of a send the target already holds, in its
   * transcript or its durable inbox, returns the first receipt with `duplicate: true` and delivers nothing, even after a host restart.
   */
  idempotencyKey?: string;
}

/**
 * A send with no sender session in this process: pi-host's `send_message` from the chat service, `prime-agent send` or a plain `pi` CLI.
 * A client send reaches any session. A send that names `from` must stay in the sender's family, and a sender this process does not know
 * counts as a root.
 */
export async function sendFromClient(req: ClientSend): Promise<Receipt> {
  const text = cleanText(req.message);
  const mode = parseMode(req.mode);
  const byName = registry.list().filter(e => e.name === req.target);
  const targetId = registry.get(req.target) || registry.dormantOf(req.target) || byName.length !== 1 ? req.target : byName[0].id;
  const target = await resolveById(targetId);
  if (!target) throw needsHost(`sending to session ${req.target}`);
  let from: { id: string; name: string; role: AgentRole | "host" | "owner" };
  let rel: Relationship | undefined;
  if (req.from) {
    const known = registry.get(req.from.id);
    const sender: Member = known ? memberOf(known) : { id: req.from.id, name: req.from.name ?? req.from.id, role: "root", depth: 0 };
    rel = relationship(sender, target.member);
    if (!rel) throw new Error(REACH_ERROR);
    from = { id: sender.id, name: sender.name, role: sender.role };
  } else {
    const client = req.clientId ?? "client";
    from = { id: `client:${client}`, name: client, role: "host" };
  }
  const key = typeof req.idempotencyKey === "string" && req.idempotencyKey ? req.idempotencyKey : undefined;
  const bus: BusMessage = { id: key ? keyedMessageId(target.member.id, key) : newMessageId(), from, text, mode, sentAt: Date.now() };
  const fromEndpoint = endpoint(from.id, from.name, from.role, req.from ? "agent" : req.clientId ?? "client");
  if (key && state().live.get(target.member.id)?.seen.has(bus.id)) {
    const first = state().receipts.get(bus.id) as Receipt | undefined;
    return { ...(first ?? receipt(bus, fromEndpoint, endpointOf(target.member), "queued", [])), duplicate: true };
  }
  const over = overLimits({ chars: text.length, pending: pendingCount(target.member.id), rateKey: `${from.id}->${target.member.id}` });
  const delivery = target.entry ? await target.entry.deliver(bus) : await hostApi()!.deliver(target.member.id, bus);
  if (rel === "parent") state().replied.set(from.id, true);
  if (rel === "child") state().replied.set(target.member.id, false);
  const out = receipt(bus, fromEndpoint, endpointOf(target.member), delivery, over);
  if (key) rememberReceipt(bus.id, out);
  return out;
}
