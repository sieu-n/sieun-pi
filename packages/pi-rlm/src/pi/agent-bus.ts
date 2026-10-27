/**
 * pi-agent-bus: Prime's `agent_message` and `agent_observe` on upstream Pi.
 *
 * Each session this extension loads into registers in `pi-family/registry.ts` with a `deliver` that queues a Prime-shaped custom message
 * (steer, follow-up, or a new turn when idle), and answers the kernel's `agent_message.*` and `agent_observe.*` requests through
 * `pi-family/kernel-bridge.ts`. The Python skills of the same names ship under the package's `skills/`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import * as registry from "@sieun-pi/pi-family/registry";
import type { AgentEntry, BusMessage, Delivery } from "@sieun-pi/pi-family/registry";
import { registerKernelHandler } from "@sieun-pi/pi-family/kernel-bridge";
import { relationship, type Member } from "../core/bus/family.ts";
import { customMessage, endpoint, CUSTOM_TYPE } from "../core/bus/message.ts";
import { memberOf } from "../core/bus/members.ts";
import { getAgent, listAgents, messageText, messagesOf, recentMessages } from "../core/bus/observe.ts";
import { send } from "../core/bus/route.ts";
import { keepUnlanded, landedIds, record, records } from "../core/bus/inbox.ts";
import { state, type Activity, type LiveSession } from "../core/bus/state.ts";
import { BUS_SKILLS } from "../core/python.ts";

function senderMember(bus: BusMessage): Member | undefined {
  const known = registry.get(bus.from.id);
  if (known) return memberOf(known);
  if (bus.from.role === "root") return { id: bus.from.id, name: bus.from.name, role: "root", depth: 0 };
  return undefined;
}

export default function agentBus(pi: ExtensionAPI): void {
  let ctx: ExtensionContext | undefined;
  let sessionId: string | undefined;
  let tools = 0;
  let cleanup: (() => void)[] = [];

  const activity = (): Activity => (!ctx || ctx.isIdle() ? "idle" : tools > 0 ? "tool" : "model");

  function shutdown(): void {
    if (!sessionId) return;
    for (const fn of cleanup) fn();
    cleanup = [];
    state().live.delete(sessionId);
    registry.unregister(sessionId);
    sessionId = undefined;
    ctx = undefined;
  }

  pi.on("resources_discover", () => ({ skillPaths: BUS_SKILLS }));

  pi.on("session_start", (event, startCtx) => {
    shutdown();
    ctx = startCtx;
    const sm = startCtx.sessionManager;
    const id = sm.getSessionId();
    sessionId = id;
    const identity = registry.identityOf(id, sm.getSessionName() ?? id);
    const live: LiveSession = { id, sessionManager: sm, activity, pending: new Set(), seen: landedIds(sm.getEntries()) };
    for (const rec of records(id)) live.seen.add(rec.id);
    state().live.set(id, live);

    const deliver = async (bus: BusMessage): Promise<Delivery> => {
      if (!ctx || sessionId !== id) throw new Error(`session ${id} has shut down`);
      if (live.seen.has(bus.id)) return ctx.isIdle() && !live.pending.has(bus.id) ? "started" : "queued";
      live.seen.add(bus.id);
      const self = memberOf(entry);
      const sender = senderMember(bus);
      const rel = sender ? relationship(self, sender) : undefined;
      const idle = ctx.isIdle();
      const message = customMessage(bus, rel, endpoint(self.id, self.name, self.role));
      const deliverAs = bus.mode === "follow_up" ? "followUp" : "steer";
      record({ id: bus.id, sessionId: id, sessionFile: sm.getSessionFile(), deliverAs, message, at: Date.now() });
      if (!idle) live.pending.add(bus.id);
      pi.sendMessage(message, { triggerTurn: true, deliverAs });
      return idle ? "started" : "queued";
    };

    const entry: AgentEntry = {
      ...identity,
      get name() {
        return identity.role === "root" ? (sm.getSessionName() ?? identity.name) : identity.name;
      },
      id,
      cwd: startCtx.cwd,
      sessionFile: sm.getSessionFile(),
      activity: () => (sessionId !== id ? "ended" : activity() === "idle" ? "idle" : "working"),
      deliver,
      preview: (limit: number) =>
        messagesOf({ kind: "live", member: memberOf(entry), entry })
          .slice(-Math.max(0, limit))
          .map((m: AgentMessage) => {
            const r = m as unknown as { role: string; timestamp?: number };
            return { role: r.role, text: messageText(m), ...(typeof r.timestamp === "number" ? { timestamp: r.timestamp } : {}) };
          }),
    };
    registry.register(entry);

    if (event.reason !== "reload") {
      const replay = keepUnlanded(id, landedIds(sm.getEntries()));
      if (replay.length > 0) {
        setImmediate(() => {
          if (sessionId !== id) return;
          for (const rec of replay) {
            if (!ctx!.isIdle()) live.pending.add(rec.id);
            pi.sendMessage(rec.message, { triggerTurn: true, deliverAs: rec.deliverAs });
          }
        });
      }
    }

    cleanup.push(
      registerKernelHandler(id, "agent_message.send", payload => send(id, payload)),
      registerKernelHandler(id, "agent_message.list_agents", () => {
        throw new Error("agent_message.list_agents was removed; the family roster now lives in agent_observe.list_agents(). Restart the Python kernel to load the current skills, then call await agent_observe.list_agents().");
      }),
      registerKernelHandler(id, "agent_observe.list", () => listAgents(id)),
      registerKernelHandler(id, "agent_observe.get", payload => {
        if (typeof payload.target !== "string") throw new Error("agent_observe.get target must be a string");
        return getAgent(id, payload.target);
      }),
      registerKernelHandler(id, "agent_observe.recent", payload => {
        if (typeof payload.target !== "string") throw new Error("agent_observe.recent target must be a string");
        return recentMessages(id, { target: payload.target, limit: payload.limit, max_chars: payload.max_chars ?? payload.maxChars });
      }),
    );
  });

  pi.on("tool_execution_start", () => {
    tools += 1;
  });
  pi.on("tool_execution_end", () => {
    tools = Math.max(0, tools - 1);
  });
  pi.on("agent_end", (_event, endCtx) => {
    tools = 0;
    if (!sessionId) return;
    const id = sessionId;
    const sm = endCtx.sessionManager;
    setImmediate(() => keepUnlanded(id, landedIds(sm.getEntries())));
  });
  pi.on("message_start", event => {
    const m = event.message as { role?: string; customType?: string; details?: { id?: unknown } };
    if (m.role !== "custom" || m.customType !== CUSTOM_TYPE || typeof m.details?.id !== "string" || !sessionId) return;
    state().live.get(sessionId)?.pending.delete(m.details.id);
  });
  pi.on("session_shutdown", () => shutdown());
}
