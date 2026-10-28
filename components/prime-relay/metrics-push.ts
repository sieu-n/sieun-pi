import { groupReading, MEMORY_GROUPS, type MemoryGroupId } from "./host-stats.ts";

/**
 * Pushes the box's CPU and memory split by group (host-stats.ts `groupReading`) as OTLP gauges to the box's Alloy, which remote-writes them to
 * staging Prometheus with its own box label (auto-sns-agent ops/dev-boxes/config.alloy, otelcol.receiver.otlp "local"). Asked by the owner on
 * 10-28 for the Dev boxes board on obs.virev.ai, which reads host_cpu_group_cores{box,group} and host_mem_group_bytes{box,group} there.
 */
export const OTLP_METRICS_URL = "http://127.0.0.1:14318/v1/metrics";
// measured: Alloy scrapes node_exporter every 60 s on each dev box (devbox.alloy scrape_interval), so the split shares the boards' 60 s step.
export const PUSH_INTERVAL_MS = 60_000;

type Reading = Awaited<ReturnType<typeof groupReading>>;
type Point = { group: MemoryGroupId; value: number };

/**
 * Every group of a reading, a group the reading lacks at 0, so a group that went quiet drops to 0 at once instead of holding its last value for
 * Prometheus's 5 min lookback. CPU has no Files group: tmpfs files use no CPU.
 */
export function groupPoints(groups: { id: MemoryGroupId; value: number }[], ids: readonly MemoryGroupId[]): Point[] {
  const values = new Map<MemoryGroupId, number>();
  for (const group of groups) values.set(group.id, (values.get(group.id) ?? 0) + group.value);
  return ids.map(group => ({ group, value: values.get(group) ?? 0 }));
}

const gauge = (name: string, unit: string, points: Point[], timeUnixNano: string) => ({
  name, unit, gauge: { dataPoints: points.map(point => ({ timeUnixNano, asDouble: point.value, attributes: [{ key: "group", value: { stringValue: point.group } }] })) },
});

/** The OTLP/HTTP JSON body of one reading, service.name prime-relay (job in Prometheus); null when the reading has neither side. */
export function otlpBody(reading: Reading, now = Date.now()): string | null {
  const time = `${BigInt(now) * 1_000_000n}`;
  const metrics = [
    ...reading.cpu ? [gauge("host_cpu_group_cores", "", groupPoints(reading.cpu.map(group => ({ id: group.id, value: group.cores })), MEMORY_GROUPS.filter(id => id !== "files")), time)] : [],
    ...reading.memory ? [gauge("host_mem_group_bytes", "", groupPoints(reading.memory.map(group => ({ id: group.id, value: group.bytes })), MEMORY_GROUPS), time)] : [],
  ];
  if (!metrics.length) return null;
  return JSON.stringify({ resourceMetrics: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "prime-relay" } }] },
    scopeMetrics: [{ scope: { name: "prime-relay" }, metrics }] }] });
}

/**
 * Reads and pushes once a minute until the returned stop is called. A failed read or push is logged when it starts failing and when it
 * recovers, not once a minute, and the next minute tries again.
 */
export function startGroupPush(log: (line: string) => void, url = OTLP_METRICS_URL, read: () => Promise<Reading> = groupReading): () => void {
  let failing = false;
  const tick = async (): Promise<void> => {
    try {
      const body = otlpBody(await read());
      if (body === null) return;
      const answer = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      if (!answer.ok) throw new Error(`${url} answered ${answer.status} ${(await answer.text()).slice(0, 200)}`);
      if (failing) log("metrics push: works again");
      failing = false;
    } catch (error) {
      if (!failing) log(`metrics push: ${error instanceof Error ? error.message : String(error)}`);
      failing = true;
    }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, PUSH_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
