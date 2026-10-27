/**
 * The pi-host side of each session's schedules, loaded into every session the host opens and into every pi-rlm child.
 *
 * At `session_start` it attaches a `SessionHandle` to the host's scheduler, so a due heartbeat reaches the session while it is loaded, and it
 * answers the kernel's `rlm_heartbeat.*` host requests through `pi-family/kernel-bridge.ts`. It registers `/heartbeat` and lists the
 * `rlm-heartbeat` Python skill from `pi-host/skills`. In a plain `pi` CLI there is no host, so the requests fail with a message that says so.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { registerKernelHandler, type KernelPayload } from "../../pi-family/kernel-bridge.ts";
import * as registry from "../../pi-family/registry.ts";
import { hostApi } from "./api.ts";
import { parseDeliveryMode, parseHeartbeatCommand, rlmHeartbeatView, type Job } from "./schedule.ts";
import type { ScheduledMessage, Scheduler, SendMode } from "./scheduler.ts";

export const HOST_SKILLS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "skills");
const RLM_HEARTBEAT_METHODS = ["rlm_heartbeat.list", "rlm_heartbeat.create", "rlm_heartbeat.update", "rlm_heartbeat.delete"] as const;

const optionalString = (payload: KernelPayload, key: string): string | undefined => {
  const value = payload[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`rlm_heartbeat ${key} must be a string when provided`);
  return value;
};

function rootOf(sessionId: string): string | undefined {
  let identity = registry.identityOf(sessionId, sessionId);
  let id = sessionId;
  for (let hops = 0; identity.role === "child" && identity.parentId && hops < 32; hops++) {
    id = identity.parentId;
    identity = registry.identityOf(id, id);
  }
  return id === sessionId ? undefined : id;
}

/** The `rlm_heartbeat` skill's host requests for one session, Prime's `handleRlmHeartbeatHostRequest`. */
export function rlmHeartbeatHandler(scheduler: Scheduler, sessionId: string, method: string, payload: KernelPayload): unknown {
  const view = (job: Job | undefined) => ({ heartbeat: job ? rlmHeartbeatView(job) : null });
  switch (method) {
    case "rlm_heartbeat.list": {
      const includeInactive = payload.include_inactive === true || payload.includeInactive === true;
      return { heartbeats: scheduler.list({ sessionId, source: "rlm_heartbeat", includeInactive }).map(rlmHeartbeatView) };
    }
    case "rlm_heartbeat.create": {
      if (typeof payload.instruction !== "string") throw new Error("rlm_heartbeat.create instruction must be a string");
      return view(scheduler.createRlmHeartbeat(sessionId, {
        instruction: payload.instruction, interval: optionalString(payload, "interval"), label: optionalString(payload, "label"),
        deliveryMode: parseDeliveryMode(payload.delivery_mode ?? payload.deliveryMode),
      }));
    }
    case "rlm_heartbeat.update": {
      if (typeof payload.id !== "string") throw new Error("rlm_heartbeat.update id must be a string");
      const status = payload.status;
      if (status !== undefined && status !== "pause" && status !== "resume") throw new Error('rlm_heartbeat.update status must be "pause" or "resume" when provided');
      const update = {
        instruction: optionalString(payload, "instruction"), interval: optionalString(payload, "interval"), label: optionalString(payload, "label"),
        status: status as "pause" | "resume" | undefined, deliveryMode: parseDeliveryMode(payload.delivery_mode ?? payload.deliveryMode),
      };
      if (Object.values(update).every(value => value === undefined)) throw new Error("rlm_heartbeat.update requires at least one field to update");
      return view(scheduler.updateRlmHeartbeat(sessionId, payload.id, update));
    }
    case "rlm_heartbeat.delete":
      if (typeof payload.id !== "string") throw new Error("rlm_heartbeat.delete id must be a string");
      return view(scheduler.deleteRlmHeartbeat(sessionId, payload.id));
    default:
      throw new Error(`unknown rlm_heartbeat request ${method}`);
  }
}

function describe(job: Job | undefined): string {
  if (!job) return "No heartbeat is set for this session.";
  const next = job.nextRunAt ? `, next at ${job.nextRunAt}` : "";
  return `Heartbeat ${job.status} ${job.schedule.expression} (${job.deliveryMode ?? "steer"}${next}, ${job.runCount} runs): ${job.prompt}`;
}

const schedulerExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  const detach = new Map<string, () => void>();

  pi.on("resources_discover", () => ({ skillPaths: [HOST_SKILLS_DIR] }));

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    detach.get(sessionId)?.();
    const scheduler = hostApi()?.scheduler;
    const undo: (() => void)[] = [];
    for (const method of RLM_HEARTBEAT_METHODS) {
      undo.push(registerKernelHandler(sessionId, method, payload => {
        const live = hostApi()?.scheduler;
        if (!live) throw new Error("rlm_heartbeat needs pi-host: a plain pi CLI has no scheduler that outlives the process.");
        return rlmHeartbeatHandler(live, sessionId, method, payload);
      }));
    }
    if (scheduler) {
      const identity = registry.identityOf(sessionId, sessionId);
      undo.push(scheduler.attach({
        sessionId,
        sessionFile: ctx.sessionManager.getSessionFile(),
        cwd: ctx.cwd,
        role: identity.role,
        rootSessionId: identity.role === "child" ? rootOf(sessionId) : undefined,
        activity: () => {
          const session = hostApi()?.runtime(sessionId)?.session;
          return { streaming: !ctx.isIdle(), compacting: session?.isCompacting ?? false, retrying: session?.isRetrying ?? false, pending: ctx.hasPendingMessages() };
        },
        send: (message: ScheduledMessage, mode: SendMode) => {
          if ("text" in message) pi.sendUserMessage(message.text, mode === "start" ? undefined : { deliverAs: mode });
          else pi.sendMessage(message, { triggerTurn: true, ...(mode === "start" ? {} : { deliverAs: mode }) });
        },
      }));
    }
    detach.set(sessionId, () => { for (const fn of undo) fn(); detach.delete(sessionId); });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    detach.get(ctx.sessionManager.getSessionId())?.();
  });

  pi.registerCommand("heartbeat", {
    description: "Set, show, pause, resume or clear this session's heartbeat: /heartbeat [every 10m] [--follow-up] <instruction>",
    handler: async (args, ctx) => {
      const scheduler = hostApi()?.scheduler;
      if (!scheduler) {
        ctx.ui.notify("/heartbeat needs pi-host: a plain pi CLI has no scheduler that outlives the process.", "error");
        return;
      }
      const sessionId = ctx.sessionManager.getSessionId();
      const command = parseHeartbeatCommand(args);
      const job = command.type === "set" ? scheduler.setHeartbeat(sessionId, command.schedule, command.instruction, command.deliveryMode)
        : command.type === "status" ? scheduler.heartbeat(sessionId)
        : scheduler.updateHeartbeat(sessionId, command.type);
      ctx.ui.notify(describe(job), "info");
    },
  });
};

export default schedulerExtension;
export const SCHEDULER_EXTENSION_PATH = join(dirname(fileURLToPath(import.meta.url)), "scheduler-extension.ts");
