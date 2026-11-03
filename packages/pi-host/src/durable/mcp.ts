import type { HostModule, HostModuleOptions } from "./host-modules.ts";

export function mcpModule(_options: HostModuleOptions): HostModule {
  return {
    name: "mcp",
    types: ["mcp.config", "mcp.refresh", "mcp.list_plugins", "mcp.search_plugins", "mcp.list_connections"],
    request: (_call, type) => { throw new Error(`${type} does not run in pi-host durable threads yet`); },
  };
}
