/** Pure helpers for the Hosts page: each box's state, its service lines, its memory and CPU groups, and the CPU spark. */
import type { HostThreadFilter, HostView, MachineView, RunCounts, RunStatus } from "$lib/api";
import type { Status } from "$lib/ui";

export const gb = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1);

/** Whether the chat server reaches the box: by its agent relay link when it has one, else by its machine relay. */
export const reachable = (host: HostView): boolean => (host.agentRelay ? host.agentRelay.state === "up" : host.relay.state === "up");

const hhmm = (at: number): string => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const ago = (at: number, now: number): string => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 120 ? `${s} s ago` : s < 7200 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

/**
 * The box's dot and its state in a few words. Green while the chat server reaches it and its pi-host (if any) answers, red when pi-host is
 * down, amber while its agent relay link is away, hollow when nothing answers. `text` is null for a healthy box, and `tip` holds the raw error.
 */
export interface HostState { dot: Status; text: string | null; tip: string | null }
export function hostState(host: HostView): HostState {
  const link = host.agentRelay;
  if (link?.state === "away") return { dot: "away", text: `Offline, last seen ${hhmm(link.lastPongAt ?? link.since)}`, tip: `Agent relay away since ${hhmm(link.since)}` };
  if (!host.agentRelay && host.relay.state === "reading") return { dot: "offline", text: "Reading…", tip: null };
  if (!reachable(host)) return { dot: "offline", text: "Not answering", tip: host.relay.state === "unreachable" ? host.relay.error : null };
  if (host.piHost.state === "down") return { dot: "busy", text: "pi-host down", tip: host.piHost.error };
  return { dot: "online", text: null, tip: null };
}

/** One service row: its dot, a short line and the long line for the tooltip. */
export interface ServiceLine { name: string; dot: Status; text: string; tip: string | null }

export function piHostLine(host: HostView): ServiceLine {
  const link = host.agentRelay;
  if (link?.state === "away") {
    const last = link.piHost;
    const text = !last ? "Never heard" : last.up ? `Last heard up, ${last.version ?? "unknown version"}` : "Last heard down";
    return { name: "pi-host", dot: "away", text, tip: last?.error ?? null };
  }
  switch (host.piHost.state) {
    case "answering": return { name: "pi-host", dot: "online", text: host.piHost.version, tip: host.piHost.socket ?? "Read from the agent relay's hello" };
    case "down": return { name: "pi-host", dot: "busy", text: "Down", tip: host.piHost.error };
    case "absent": return { name: "pi-host", dot: "offline", text: "Not installed", tip: null };
  }
}

/** The agent relay link: since when it is linked or away and the last pong, with the relay's version and saved feed cursor in the tooltip. */
export function agentRelayLine(host: HostView, now: number): ServiceLine | null {
  const link = host.agentRelay;
  if (!link) return null;
  const pong = link.lastPongAt ? `pong ${ago(link.lastPongAt, now)}` : "no pong yet";
  const text = `${link.state === "up" ? "Linked" : "Away"} since ${hhmm(link.since)} · ${pong}`;
  const tip = [link.version ? `relay ${link.version}` : null, `feed cursor ${link.feedCursor}`].filter(Boolean).join(" · ");
  return { name: "Agent relay", dot: link.state === "up" ? "online" : "away", text, tip };
}

export function machineRelayLine(host: HostView): ServiceLine {
  if (host.relay.state === "unreachable") return { name: "Machine relay", dot: "offline", text: "Not answering", tip: host.relay.error };
  if (host.relay.state === "reading") return { name: "Machine relay", dot: "offline", text: "Reading…", tip: null };
  return { name: "Machine relay", dot: "online", text: host.self ? "This box" : `${Math.round(host.relay.pingMs)} ms`, tip: null };
}

export const RUN_LABEL: Readonly<Record<RunStatus, string>> = { working: "Working", idle: "Idle", sleeping: "Sleeping", failed: "Failed" };
export const RUN_DOT: Readonly<Record<RunStatus, Status>> = { working: "online", idle: "offline", sleeping: "away", failed: "busy" };

const FILTER_ORDER: readonly HostThreadFilter[] = ["working", "failed", "sleeping", "idle", "all"];

/** A box's thread counts by run status, its walks' test threads added when `tests`. */
export const countsOf = (host: HostView, tests: boolean): RunCounts => {
  const { real, test } = host.counts;
  return tests ? { working: real.working + test.working, idle: real.idle + test.idle, sleeping: real.sleeping + test.sleeping, failed: real.failed + test.failed } : real;
};

export const totalOf = (counts: RunCounts): number => counts.working + counts.idle + counts.sleeping + counts.failed;

/** The filter tabs with exact counts (c191). Working and All always show; another status shows only when a thread has it. */
export function threadTabs(counts: RunCounts): { id: HostThreadFilter; label: string; count: number }[] {
  return FILTER_ORDER.map(id => ({ id, count: id === "all" ? totalOf(counts) : counts[id] }))
    .filter(tab => tab.id === "working" || tab.id === "all" || tab.count > 0)
    .map(tab => ({ ...tab, label: `${tab.id === "all" ? "All" : RUN_LABEL[tab.id]} ${tab.count}` }));
}

/** What a memory group holds in RAM: its bytes less its part in swap, so the groups add up to the used memory. */
export const ramOf = (item: { bytes: number; swapBytes?: number }): number => item.bytes - (item.swapBytes ?? 0);

/** One row of the memory and CPU table: a memory group and the CPU group with the same id, either one possibly missing. */
export interface UseRow { id: string; label: string; ram: number | null; swap: number; cores: number | null; top: { label: string; ram: number }[] }

/** Memory groups by RAM, largest first, each with its CPU cores, then the CPU groups that hold no memory. */
export function useRows(machine: MachineView): UseRow[] {
  const cpu = new Map((machine.cpu.groups ?? []).map(group => [group.id, group]));
  const rows: UseRow[] = [...(machine.memory.groups ?? [])]
    .sort((a, b) => ramOf(b) - ramOf(a))
    .map(group => ({ id: group.id, label: group.label, ram: ramOf(group), swap: group.swapBytes ?? 0, cores: cpu.get(group.id)?.cores ?? null, top: group.top.map(item => ({ label: item.label, ram: ramOf(item) })) }));
  const seen = new Set(rows.map(row => row.id));
  for (const group of machine.cpu.groups ?? []) if (!seen.has(group.id)) rows.push({ id: group.id, label: group.label, ram: null, swap: 0, cores: group.cores, top: [] });
  return rows;
}

/** A polyline through the readings since the page opened, up to the last `length`, 0 to 100, across a 100 by 32 box. */
export function sparkPoints(values: readonly number[], length: number): string {
  const shown = values.slice(-length);
  if (shown.length < 2) return "";
  const step = 100 / (shown.length - 1);
  return shown.map((value, index) => `${(step * index).toFixed(2)},${(31 - (Math.min(100, Math.max(0, value)) / 100) * 30).toFixed(2)}`).join(" ");
}
