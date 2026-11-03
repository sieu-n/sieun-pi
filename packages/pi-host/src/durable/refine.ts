import type { HostModule, HostModuleOptions } from "./host-modules.ts";

export function refineModule(_options: HostModuleOptions): HostModule {
  return {
    name: "refine",
    types: ["refine.run", "refine.status"],
    request: (_call, type) => { throw new Error(`${type} does not run in pi-host durable threads yet`); },
  };
}
