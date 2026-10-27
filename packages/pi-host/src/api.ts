/**
 * pi-host's in-process API. The table on `globalThis` and its types live in `@sieun-pi/pi-family/host-api`, because pi-rlm reaches the
 * host through it without importing pi-host. This file adds pi-host's own `scheduler` field to `HostApi`.
 */

import type { Scheduler } from "./scheduler.ts";

export * from "@sieun-pi/pi-family/host-api";

declare module "@sieun-pi/pi-family/host-api" {
  interface HostApi {
    /** Heartbeats, RLM heartbeats and cron prompts that fire into loaded and unloaded sessions (`scheduler.ts`). */
    readonly scheduler?: Scheduler;
  }
}
