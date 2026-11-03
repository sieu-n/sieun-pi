/**
 * Prime's generic MCP client in durable threads (`mcp.ts`):
 * 1. `mcp.config` serves a server `settings.json` declares and `{}` for one it does not, and a server added later is seen without a restart.
 * 2. `mcp.list_connections`, `mcp.list_plugins` and `mcp.search_plugins` answer from Prime's own McpManager and catalog.
 * 3. `mcp.refresh` fails for a server with no stored credential, so the kernel reports a refresh error.
 * 4. A kernel cell lists and calls the tools of a stdio MCP server the agent dir declares, and an undeclared server raises KeyError.
 */
import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { testPython } from "@sieun-pi/pi-rlm/test-helpers";
import type { HostCall } from "../../src/durable/host-modules.ts";
import { mcpModule } from "../../src/durable/mcp.ts";
import { DurableRlm } from "../../src/durable/rlm.ts";
import { cell, context, entriesOf, lastText, openThread, results, rlmOptions, say } from "./rlm-rig.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-mcp-"));
process.env.HOME = join(dir, "home");
mkdirSync(process.env.HOME);
mkdirSync(join(dir, "threads"));
const agentDir = join(dir, "agent");
cpSync(join(import.meta.dirname, "../fixtures/prime-agent"), agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PRIME_AGENT_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";

/** A stdio MCP server with one tool, on the kernel's own `mcp` SDK (2.x names FastMCP MCPServer). */
const SERVER = `from mcp.server.mcpserver import MCPServer

server = MCPServer("tiny")


@server.tool()
def add(a: int, b: int) -> int:
    """Adds two numbers."""
    return a + b


server.run()
`;

const settingsPath = join(agentDir, "settings.json");
const setServers = (servers: Record<string, unknown>) => {
  const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  writeFileSync(settingsPath, JSON.stringify({ ...settings, mcpServers: servers }, null, 2));
};

let tiny: Record<string, unknown>;
let rlm: DurableRlm;
before(async () => {
  const python = await testPython();
  writeFileSync(join(dir, "server.py"), SERVER);
  tiny = { type: "stdio", command: python, args: [join(dir, "server.py")], startupTimeoutMs: 20000 };
  setServers({ aside: { type: "stdio", command: "/bin/true" }, tiny });
  rlm = await DurableRlm.load(rlmOptions(dir));
});
after(async () => {
  await rlm?.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

const call = {} as HostCall;

test("mcp.config serves a declared server, {} for an undeclared one, and a server added later without a restart", async () => {
  const module = mcpModule({ agentDir, log: () => {} });
  try {
    assert.deepEqual(await module.request(call, "mcp.config", { server: "tiny" }), tiny);
    assert.deepEqual(await module.request(call, "mcp.config", { server: "nope" }), {});
    const late = { type: "http", url: "https://example.invalid/mcp", headers: { "X-Team": "a" } };
    setServers({ aside: { type: "stdio", command: "/bin/true" }, tiny, late });
    assert.deepEqual(await module.request(call, "mcp.config", { server: "late" }), late);
    await assert.rejects(Promise.resolve(module.request(call, "mcp.config", {})), /requires a server/);
  } finally {
    setServers({ aside: { type: "stdio", command: "/bin/true" }, tiny });
    await module.shutdown?.();
  }
});

test("list_connections, list_plugins and search_plugins answer from Prime's McpManager and its catalog", async () => {
  const module = mcpModule({ agentDir, log: () => {} });
  try {
    const { connections } = await module.request(call, "mcp.list_connections", {}) as { connections: { connectionId: string }[] };
    assert.deepEqual(connections.map(c => c.connectionId).filter(id => id === "tiny" || id === "aside").sort(), ["aside", "tiny"]);
    const page = await module.request(call, "mcp.list_plugins", { limit: 3 }) as { plugins: { serviceId: string }[]; nextCursor: string | null };
    assert.equal(page.plugins.length, 3);
    assert.equal(typeof page.nextCursor, "string");
    const next = await module.request(call, "mcp.list_plugins", { limit: 3, cursor: page.nextCursor }) as { plugins: { serviceId: string }[] };
    assert.equal(next.plugins.some(p => page.plugins.some(q => q.serviceId === p.serviceId)), false);
    const found = await module.request(call, "mcp.search_plugins", { query: "notion", limit: 5 }) as { plugins: { serviceId: string }[]; nextCursor: null };
    assert.ok(found.plugins.some(p => p.serviceId === "notion"), JSON.stringify(found.plugins.map(p => p.serviceId)));
    assert.equal(found.nextCursor, null);
    await assert.rejects(Promise.resolve(module.request(call, "mcp.list_plugins", { connectionStatus: "bogus" })), /unknown connectionStatus/);
  } finally {
    await module.shutdown?.();
  }
});

test("mcp.refresh fails for a server with no stored credential", async () => {
  const module = mcpModule({ agentDir, log: () => {} });
  try {
    await assert.rejects(Promise.resolve(module.request(call, "mcp.refresh", { server: "tiny" })), /Could not refresh credentials for tiny/);
  } finally {
    await module.shutdown?.();
  }
});

test("a kernel cell lists and calls a stdio MCP server's tools, and an undeclared server raises KeyError", async () => {
  const { harness, root } = await openThread(join(dir, "threads", "mcp.sqlite"), "mcp", rlm, ({ messages }) => {
    const last = lastText(messages);
    if (last === "use mcp") {
      return cell([
        "import json",
        "tools = await mcp.list_tools('tiny')",
        "print(json.dumps([t['name'] for t in tools]))",
        "print(json.dumps(await mcp.call_tool('tiny', 'add', {'a': 2, 'b': 3})))",
        "print(json.dumps(sorted(c['connectionId'] for c in await mcp.list_connections() if c['connectionId'] in ('tiny', 'aside'))))",
        "try:\n    await mcp.list_tools('nope')\nexcept KeyError as e:\n    print('KeyError', e)",
      ].join("\n"));
    }
    if (messages.at(-1)?.role === "toolResult") return say("done");
    return say(`unexpected: ${last}`);
  }, dir);
  await (await root.submit({ type: "input", content: "use mcp" }, context)).wait(context);
  const out = results(await entriesOf(harness));
  await harness.close(context);
  await rlm.closeThread("mcp", "idle");
  assert.equal(out.length, 1);
  assert.equal(out[0]!.isError, false, out[0]!.text);
  assert.deepEqual(out[0]!.text.trim().split("\n"), [
    '["add"]',
    '{"result": 5}',
    '["aside", "tiny"]',
    `KeyError "MCP server 'nope' is not declared in user settings"`,
  ]);
});
