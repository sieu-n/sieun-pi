import type { HostModule, HostModuleOptions } from "./host-modules.ts";

export function goalModule(_options: HostModuleOptions): HostModule {
  return {
    name: "goal",
    types: ["goal.get", "goal.create", "goal.complete"],
    request: (_call, type) => { throw new Error(`${type} does not run in pi-host durable threads yet`); },
  };
}
