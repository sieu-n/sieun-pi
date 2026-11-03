/**
 * The host side of Prime's generic MCP client (`rlm.mcp` in the kernel): `mcp.config`, `mcp.refresh`, `mcp.list_plugins`,
 * `mcp.search_plugins` and `mcp.list_connections`. The answers come from Prime's own `McpManager` (core/mcp/mcp-manager.js in the
 * prime-agent package this repo installs), built on the agent dir's files as a Prime session builds it in agent-session-services.ts:
 * `settings.json` for `mcpServers` and `mcpCatalogSources`, `auth.json` for credentials, `mcp-connections.json` for connection records
 * and `mcp/mcp-service-catalog.v2.json` for the catalog cache. The protocol itself runs in the kernel, which starts a stdio server or
 * opens an HTTP one from the `mcp.config` answer.
 *
 * Prime builds one manager per session, so a new session sees settings, logins and records written since. pi-host lives across many
 * sessions, so each request reloads those files first. The kernel never calls `mcp.begin_login` or `mcp.connect` (pi-rlm's mcp.py), and
 * Prime registers them only when an interactive login is wired, so they stay out here too.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HostModule, HostModuleOptions } from "./host-modules.ts";

type Handlers = Record<string, (payload: Record<string, unknown>) => Promise<Record<string, unknown>>>;
interface Manager { refresh(): void; dispose(): void; hostHandlers(): Handlers }
interface AuthStore { reload(): void }
interface Store { records(): readonly unknown[] }
interface PrimeMcp {
  McpManager: new (options: Record<string, unknown>) => Manager;
  AuthStorage: { create(path: string): AuthStore };
  McpConnectionStore: { open(path: string): Store };
  defaultServiceCatalogProvider(sources: () => readonly string[], records: () => readonly unknown[], cachePath: string): () => unknown[];
}

let modules: Promise<PrimeMcp> | undefined;
/** Prime's MCP modules, loaded by their path next to the package index as `prime-prompt.ts` loads its prompt modules. */
function primeMcp(): Promise<PrimeMcp> {
  modules ??= (async () => {
    const index = import.meta.resolve("prime-agent");
    const load = (path: string) => import(new URL(path, index).href) as Promise<Record<string, unknown>>;
    const loaded = await Promise.all(["./core/mcp/mcp-manager.js", "./core/auth-storage.js", "./core/mcp/connection-store.js", "./core/mcp/service-catalog.js"].map(load));
    return Object.assign({}, ...loaded) as PrimeMcp;
  })();
  return modules;
}

/** The parts of `<agentDir>/settings.json` the manager reads; Prime's `getGlobalMcpServers` and `getMcpCatalogSources`. */
interface McpSettings { mcpServers?: Record<string, unknown>; mcpCatalogSources?: string[] }

/** The `mcp.*` host requests the kernel's `rlm.mcp` and `rlm.mcp_base` send. */
export const MCP_TYPES = ["mcp.config", "mcp.refresh", "mcp.list_plugins", "mcp.search_plugins", "mcp.list_connections"] as const;

export function mcpModule(options: HostModuleOptions): HostModule {
  const settingsPath = join(options.agentDir, "settings.json");
  let settings: McpSettings = {};
  // A settings file that does not parse keeps the last one read, as Prime's SettingsManager.reload keeps its global settings.
  const readSettings = () => {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as McpSettings;
      settings = { mcpServers: parsed.mcpServers, mcpCatalogSources: parsed.mcpCatalogSources };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") settings = {};
      else options.log(`mcp: ${settingsPath} not read: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  let opened: Promise<{ manager: Manager; auth: AuthStore }> | undefined;
  const open = () => opened ??= (async () => {
    const prime = await primeMcp();
    readSettings();
    const auth = prime.AuthStorage.create(join(options.agentDir, "auth.json"));
    const connectionStore = prime.McpConnectionStore.open(join(options.agentDir, "mcp-connections.json"));
    const manager = new prime.McpManager({
      authStorage: auth,
      connectionStore,
      getUserServers: () => structuredClone(settings.mcpServers),
      getCatalogSources: () => structuredClone(settings.mcpCatalogSources ?? []),
      getServiceCatalog: prime.defaultServiceCatalogProvider(
        () => settings.mcpCatalogSources ?? [],
        () => connectionStore.records(),
        join(options.agentDir, "mcp", "mcp-service-catalog.v2.json"),
      ),
    });
    return { manager, auth };
  })();
  return {
    name: "mcp",
    types: MCP_TYPES,
    request: async (_call, type, payload) => {
      const { manager, auth } = await open();
      readSettings();
      auth.reload();
      manager.refresh();
      const handler = manager.hostHandlers()[type];
      if (!handler) throw new Error(`${type} has no handler in Prime's McpManager`);
      return handler(payload);
    },
    shutdown: async () => {
      const current = opened;
      opened = undefined;
      (await current?.catch(() => undefined))?.manager.dispose();
    },
  };
}
