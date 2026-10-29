// 10-29 19:53Z: apps/chat's agent relay work gave the Mac's hosts.json entry `roles.agents: {}`. This parser threw "unknown role" on it, so
// every hosts.json read here failed: d9 read no box offline and held none of designer bro's steps on the sleeping Mac, and the chat service's
// Mac daemon list failed. A role this service does not run is left out, and the roles it runs still parse.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHosts } from "../src/hosts.ts";

const host = (name: string, roles: Record<string, unknown>) => ({ name, hostname: name, address: "100.0.0.2", relayPort: 7790, token: `file:relay-tokens/${name}`,
  daemonSocket: "/tmp/daemon.sock", ssh: null, roles });

test("hosts.json leaves out a role this service does not run, and keeps the ones it runs", () => {
  const registry = parseHosts({ version: 1, hosts: [host("mac", { agents: {} }), host("box", { chat: { port: 5182 }, agents: { port: 7791 } })] });
  assert.deepEqual(registry.hosts.map(entry => [entry.name, entry.roles]), [["mac", {}], ["box", { chat: { port: 5182 } }]]);
  assert.throws(() => parseHosts({ version: 1, hosts: [host("box", { chat: {} })] }), /roles\.chat\.port: needs a port number/);
});
