import { test } from "node:test";
import assert from "node:assert/strict";
import { hostsView, parseMachine, parsePool } from "../src/chat-hosts.ts";
import { defaultHost, hostGlance, hostRoles } from "../src/client/hosts.ts";
import type { HostsRegistry } from "../src/hosts.ts";
import type { AgentQueuePool, MachineView } from "../src/shared/types.ts";

const GB = 1024 ** 3;
const machine = (percent: number): MachineView => ({ platform: "linux", cpu: { percent, cores: 80, load: [6.7, 7, 4.5] },
  memory: { usedBytes: 30 * GB, totalBytes: 247 * GB, swapUsedBytes: 0, swapTotalBytes: 16 * GB, pressure: "normal", groups: null } });
const QUEUE = { enabled: true, working_max: 16, working_max_set: null, tree_working_max: 8, slots_used: 1,
  working: [{ session: "s1", tree: "t1", parent: null, class: "normal", kind: "slot", since: 1792289000 }], queued: [] };
const CONFIG = { queue_aging_s: 18, lease_s: 1800 };
const selfQueue = async (): Promise<AgentQueuePool> => ({ state: "unread", error: "fake" });
/** hosts.json as written on 10-18: us-metal02 holds every role, and the Mac holds none. */
const REGISTRY: HostsRegistry = { version: 1, hosts: [
  { name: "us-metal02", hostname: "us-metal02", address: "100.83.139.73", relayPort: 7790, token: "file:relay-tokens/us-metal02", daemonSocket: "/tmp/prime-agent-1001/daemon.sock",
    ssh: "sieun@100.83.139.73", roles: { pool: { port: 7781 }, wiki: { port: 5176 }, chat: { port: 5182 } } },
  { name: "mac", hostname: "this-test-box-is-not-listed", address: "100.66.173.18", relayPort: 7790, token: "file:relay-tokens/mac", daemonSocket: "/tmp/d.sock", ssh: null, roles: {} },
] };

test("parsePool names a box's queue rows and reads its timers, and carries a pool error as unread", () => {
  const pool = parsePool({ queue: QUEUE, config: CONFIG }, id => id === "t1" ? "AI harness" : null);
  assert.equal(pool.state, "read");
  if (pool.state !== "read") return;
  assert.equal(pool.workingMax, 16);
  assert.equal(pool.queueAgingS, 18);
  assert.deepEqual(pool.rows.map(row => [row.chat, row.job, row.state]), [["AI harness", "s1", "working"]]);
  assert.deepEqual(parsePool({ error: "pi-pool: not installed" }, () => null), { state: "unread", error: "pi-pool: not installed" });
  assert.equal(parsePool({ queue: {}, config: CONFIG }, () => null).state, "unread");
});

test("parseMachine refuses a reading without CPU or memory numbers", () => {
  assert.equal(parseMachine(machine(5)).cpu.cores, 80);
  assert.throws(() => parseMachine({ platform: "linux", cpu: {}, memory: {} }));
  assert.throws(() => parseMachine(null));
});

test("hostsView lists this box first, reads the others through their relays, and marks a box that does not answer", async () => {
  const self = { ...REGISTRY.hosts[1]!, hostname: (await import("node:os")).hostname() };
  const registry: HostsRegistry = { version: 1, hosts: [REGISTRY.hosts[0]!, self] };
  const view = await hostsView({ selfQueue, title: () => null, lastHost: async () => "us-metal02", load: async () => registry, selfMachine: async () => machine(40),
    remote: async () => { throw new Error("relay us-metal02 did not answer"); } })();
  assert.deepEqual(view.hosts.map(host => [host.name, host.self, host.state]), [["mac", true, "up"], ["us-metal02", false, "unreachable"]]);
  assert.deepEqual(view.hosts[1]!.roles, ["chat", "pool", "wiki"]);
  assert.equal(view.lastHost, "us-metal02");
  assert.equal(view.registryError, null);
});

test("hostsView with no hosts.json shows this box alone, and a broken file says why", async () => {
  const missing = Object.assign(new Error("no file"), { code: "ENOENT" });
  const alone = await hostsView({ selfQueue, title: () => null, lastHost: async () => "gone-box", load: async () => { throw missing; }, selfMachine: async () => machine(1) })();
  assert.equal(alone.hosts.length, 1);
  assert.equal(alone.hosts[0]!.self, true);
  assert.equal(alone.lastHost, null, "a last host no longer listed is dropped");
  const broken = await hostsView({ selfQueue, title: () => null, lastHost: async () => null, load: async () => { throw new Error("hosts.json: needs {\"version\": 1}"); }, selfMachine: async () => machine(1) })();
  assert.match(broken.registryError ?? "", /version/);
});

test("the New chat picker starts on the last host while it answers, else this box, and each host reads as one line", async () => {
  const up = (name: string, self: boolean) => ({ name, address: "x", roles: [], self, state: "up" as const, daemon: "answering" as const, pingMs: 200, machine: machine(12),
    queue: parsePool({ queue: QUEUE, config: CONFIG }, () => null) });
  const away = { name: "mac", address: "x", roles: [], self: false, state: "unreachable" as const, pingMs: 5000, error: "timeout" };
  assert.equal(defaultHost([up("us-metal02", true), away], "mac"), "us-metal02");
  assert.equal(defaultHost([up("us-metal02", true), up("mac", false)], "mac"), "mac");
  assert.equal(defaultHost([up("us-metal02", true)], null), "us-metal02");
  assert.equal(hostGlance(up("us-metal02", true)), "12% CPU · 30 of 247 GB · 1 working, 0 waiting");
  assert.equal(hostGlance(away), "Not answering");
  assert.equal(hostRoles({ roles: ["chat", "pool", "wiki"] }), "Runs agents and holds the chat app, the account pool and the wiki.");
  assert.equal(hostRoles({ roles: [] }), "Runs agents and borrows accounts from the pool.");
});
