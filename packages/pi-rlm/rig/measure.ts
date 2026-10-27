/**
 * A rig extension that samples this Node process once a second: RSS, heap, and event-loop delay from `monitorEventLoopDelay`.
 * It writes one JSON line per sample to `PI_RLM_MEASURE_LOG`. Children load it too, so it keeps one sampler per process.
 */
import { appendFileSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const KEY = Symbol.for("sieun-pi.pi-stack.rlm.rig-measure");

export function startSampler(path: string, label: string): () => void {
  const g = globalThis as unknown as Record<symbol, (() => void) | undefined>;
  if (g[KEY]) return g[KEY]!;
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  const timer = setInterval(() => {
    const m = process.memoryUsage();
    appendFileSync(path, JSON.stringify({ t: Date.now(), label, pid: process.pid, rssMb: +(m.rss / 2 ** 20).toFixed(1), heapMb: +(m.heapUsed / 2 ** 20).toFixed(1), lagP50Ms: +(h.percentile(50) / 1e6).toFixed(2), lagP99Ms: +(h.percentile(99) / 1e6).toFixed(2), lagMaxMs: +(h.max / 1e6).toFixed(2) }) + "\n");
    h.reset();
  }, 1000);
  timer.unref();
  const stop = () => {
    clearInterval(timer);
    h.disable();
    delete g[KEY];
  };
  g[KEY] = stop;
  return stop;
}

export default function measure(_pi: ExtensionAPI): void {
  const path = process.env.PI_RLM_MEASURE_LOG;
  if (path) startSampler(path, process.env.PI_RLM_MEASURE_LABEL ?? "pi");
}
