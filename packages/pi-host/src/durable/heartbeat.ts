import type { HostModule, HostModuleOptions } from "./host-modules.ts";

export function heartbeatModule(_options: HostModuleOptions): HostModule {
  return {
    name: "heartbeat",
    types: ["rlm_heartbeat.list", "rlm_heartbeat.create", "rlm_heartbeat.update", "rlm_heartbeat.delete"],
    request: (_call, type) => { throw new Error(`${type} does not run in pi-host durable threads yet`); },
  };
}
