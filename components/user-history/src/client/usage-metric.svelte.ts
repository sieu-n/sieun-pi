import { type UsageMetric } from "../shared/usage.ts";
import { isMetric } from "./usage.ts";

const KEY = "usage.metric";
function stored(): UsageMetric {
  try { const saved = localStorage.getItem(KEY); return isMetric(saved) ? saved : "output"; } catch { return "output"; }
}

/** The token kind Settings > Usage and the sidebar Throughput line show: output unless the person picked another; saved per browser. */
class UsageMetricChoice {
  value = $state<UsageMetric>(stored());

  constructor() {
    // Another tab's pick: the storage event never fires in the tab that wrote it.
    if (typeof window !== "undefined") window.addEventListener("storage", event => { if (event.key === KEY) this.value = stored(); });
  }

  set(next: UsageMetric): void {
    this.value = next;
    try { localStorage.setItem(KEY, next); } catch { /* Private mode keeps the choice for this tab only. */ }
  }
}

export const usageMetric = new UsageMetricChoice();
