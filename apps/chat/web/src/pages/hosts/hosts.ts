/** Pure helpers for the Hosts page: each box's one-line state, its status words and the CPU spark. */
import type { HostView, RunStatus } from "$lib/api";
import type { Status } from "$lib/ui";

export const gb = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1);

/** Whether the chat server reaches the box: by its agent relay link when it has one, else by its machine relay. */
export const reachable = (host: HostView): boolean => (host.agentRelay ? host.agentRelay.state === "up" : host.relay.state === "up");

/**
 * The box's dot: green while the chat server reaches it and its pi-host (if any) answers, red when pi-host is down, amber while its agent
 * relay link is away, hollow when nothing answers.
 */
export function hostStatus(host: HostView): Status {
  if (host.agentRelay?.state === "away") return "away";
  if (!reachable(host)) return "offline";
  if (host.piHost.state === "down") return "busy";
  return "online";
}

export function relayText(host: HostView): string {
  return host.relay.state === "up" ? (host.self ? "Answering, read on this box" : `Answering in ${Math.round(host.relay.pingMs)} ms`) : `Not answering: ${host.relay.error}`;
}

const clock = (at: number): string => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const ago = (at: number, now: number): string => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 120 ? `${s} s ago` : s < 7200 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

/** The agent relay link in one line: its state since when, the last pong, the relay's version and the saved feed cursor. */
export function agentRelayText(host: HostView, now: number): string {
  const link = host.agentRelay;
  if (!link) return "None, this server dials no agent relay on this box";
  const state = link.state === "up" ? `Linked since ${clock(link.since)}` : `Away since ${clock(link.since)}, ${ago(link.since, now)}`;
  const pong = link.lastPongAt ? `last pong ${ago(link.lastPongAt, now)}` : "no pong yet";
  return [state, pong, link.version ? `relay ${link.version}` : null, `feed cursor ${link.feedCursor}`].filter(Boolean).join(" · ");
}

export function piHostText(host: HostView): string {
  const link = host.agentRelay;
  if (link?.state === "away") {
    const last = link.piHost ? (link.piHost.up ? `answering, version ${link.piHost.version ?? "unknown"}` : `down${link.piHost.error ? `: ${link.piHost.error}` : ""}`) : "never heard";
    return `Unknown while the box is away; its last hello said ${last}`;
  }
  switch (host.piHost.state) {
    case "answering": return `Answering, version ${host.piHost.version}${host.piHost.socket ? `, on ${host.piHost.socket}` : ", read from the agent relay's hello"}`;
    case "down": return `Not answering: ${host.piHost.error}`;
    case "absent": return "Not installed on this box";
  }
}

export const RUN_LABEL: Readonly<Record<RunStatus, string>> = { working: "Working", idle: "Idle", sleeping: "Sleeping", failed: "Failed" };
export const RUN_TONE: Readonly<Record<RunStatus, "accent" | "neutral" | "danger" | "outline">> = { working: "accent", idle: "outline", sleeping: "neutral", failed: "danger" };

/** The one line under a host's name. */
export function glance(host: HostView): string {
  if (host.agentRelay?.state === "away") return `Away since ${clock(host.agentRelay.since)}`;
  if (!reachable(host) || !host.machine) return "Not answering";
  const { cpu, memory } = host.machine;
  const working = host.threads.filter(thread => thread.status === "working").length;
  const threads = host.piHost.state === "absent" ? "no pi-host" : `${host.threads.length} ${host.threads.length === 1 ? "thread" : "threads"}, ${working} working`;
  return `${Math.round(cpu.percent)}% CPU · ${gb(memory.usedBytes)} of ${gb(memory.totalBytes)} GB · ${threads}`;
}

/** What a memory group holds in RAM: its bytes less its part in swap, so the groups add up to the used memory. */
export const ramOf = (item: { bytes: number; swapBytes?: number }): number => item.bytes - (item.swapBytes ?? 0);

/** A polyline through the last readings, 0 to 100, right-aligned in a 100 by 32 box. */
export function sparkPoints(values: readonly number[], length: number): string {
  if (values.length < 2) return "";
  const step = 100 / (length - 1);
  const start = 100 - step * (values.length - 1);
  return values.map((value, index) => `${(start + step * index).toFixed(2)},${(31 - (Math.min(100, Math.max(0, value)) / 100) * 30).toFixed(2)}`).join(" ");
}
