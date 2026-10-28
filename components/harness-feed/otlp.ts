/** One harness-feed reading: a gauge, or a cumulative counter that Alloy writes as `<name>_total`. */
export interface Sample {
  /** Dotted OTLP name, such as `harness.pool.waiting`; Alloy turns the dots into underscores. */
  name: string;
  kind: "gauge" | "counter";
  /** `By` adds `_bytes`, `s` adds `_seconds`, `1` adds `_ratio`; leave it out for a plain count. */
  unit?: "By" | "s" | "1";
  /** One plain sentence; the dashboard panel description reuses it. */
  help: string;
  value: number;
  labels?: Record<string, string>;
}

/** What a reader gets each round. `state` survives between rounds and is private to the reader that set a key. */
export interface Context {
  home: string;
  /** os.hostname() without `.local`. Alloy adds its own `box` label, which the dashboard uses. */
  host: string;
  platform: NodeJS.Platform;
  now: number;
  /** True when this box runs the live chat service: browser-chat/instance.json names a live pid. */
  chatHost: boolean;
  state: Map<string, unknown>;
}

export type Reader = (ctx: Context) => Promise<Sample[]>;

const SUFFIX = { By: "_bytes", s: "_seconds", "1": "_ratio" } as const;

/** The Prometheus name Alloy writes for a sample, for tests and the dashboard. */
export function promName(sample: Pick<Sample, "name" | "kind" | "unit">): string {
  return sample.name.replaceAll(".", "_") + (sample.unit ? SUFFIX[sample.unit] : "") + (sample.kind === "counter" ? "_total" : "");
}

/**
 * The samples with the first of each Prometheus series kept, and how many later samples of a series a round held, by metric. Prometheus
 * refuses a second sample of one series at one time with a 400, and Alloy then drops the whole batch of 500 samples it was in, the box's
 * node and cAdvisor series too: from 10-27 01Z to 10-28 20Z the delivery reader's repeated chat gauges cost about 45 batches an hour.
 */
export function firstOfEach(samples: readonly Sample[]): { kept: Sample[]; repeats: Map<string, number> } {
  const seen = new Set<string>();
  const kept: Sample[] = [];
  const repeats = new Map<string, number>();
  for (const sample of samples) {
    const name = promName(sample);
    const key = `${name}${JSON.stringify(Object.entries(sample.labels ?? {}).sort(([a], [b]) => a.localeCompare(b)))}`;
    if (seen.has(key)) { repeats.set(name, (repeats.get(name) ?? 0) + 1); continue; }
    seen.add(key);
    kept.push(sample);
  }
  return { kept, repeats };
}

/** An OTLP/HTTP JSON metrics body. Counters are cumulative monotonic sums that start at `startNs`. */
export function payload(samples: readonly Sample[], resource: Record<string, string>, startNs: bigint, nowNs: bigint): object {
  const byName = new Map<string, Sample[]>();
  for (const sample of samples) {
    if (!Number.isFinite(sample.value)) continue;
    const list = byName.get(sample.name) ?? [];
    list.push(sample);
    byName.set(sample.name, list);
  }
  const attributes = (labels: Record<string, string>) => Object.entries(labels).map(([key, value]) => ({ key, value: { stringValue: value } }));
  const metrics = [...byName.values()].map(list => {
    const first = list[0];
    const dataPoints = list.map(s => ({ attributes: attributes(s.labels ?? {}), timeUnixNano: String(nowNs), asDouble: s.value,
      ...(s.kind === "counter" ? { startTimeUnixNano: String(startNs) } : {}) }));
    return { name: first.name, description: first.help, ...(first.unit ? { unit: first.unit } : {}),
      ...(first.kind === "counter" ? { sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints } } : { gauge: { dataPoints } }) };
  });
  return { resourceMetrics: [{ resource: { attributes: attributes(resource) }, scopeMetrics: [{ scope: { name: "sieun-pi-harness-feed" }, metrics }] }] };
}
