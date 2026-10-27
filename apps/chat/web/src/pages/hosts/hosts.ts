/** Pure helpers for the Hosts page: each box's one-line state, its status words and the CPU spark. */
import type { HostView, RunStatus } from "$lib/api";
import type { Status } from "$lib/ui";

export const gb = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1);

/** The box's dot: green while its relay answers and its pi-host (if any) answers, red when pi-host is down, hollow when away. */
export function hostStatus(host: HostView): Status {
  if (host.relay.state === "unreachable") return "offline";
  if (host.piHost.state === "down") return "busy";
  return "online";
}

export function relayText(host: HostView): string {
  return host.relay.state === "up" ? (host.self ? "Answering, read on this box" : `Answering in ${Math.round(host.relay.pingMs)} ms`) : `Not answering: ${host.relay.error}`;
}

export function piHostText(host: HostView): string {
  switch (host.piHost.state) {
    case "answering": return `Answering, version ${host.piHost.version}, on ${host.piHost.socket}`;
    case "down": return `Not answering: ${host.piHost.error}`;
    case "absent": return "Not installed on this box";
  }
}

export const RUN_LABEL: Readonly<Record<RunStatus, string>> = { working: "Working", idle: "Idle", sleeping: "Sleeping", failed: "Failed" };
export const RUN_TONE: Readonly<Record<RunStatus, "accent" | "neutral" | "danger" | "outline">> = { working: "accent", idle: "outline", sleeping: "neutral", failed: "danger" };

/** The one line under a host's name. */
export function glance(host: HostView): string {
  if (host.relay.state === "unreachable" || !host.machine) return "Not answering";
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
