// The AI harness developer environment VP on 10-21, on d7's quiet_agent_gb: "The chat service and the daemon supervisor aren't agent sessions,
// so take them out of quiet_agent_gb (c67: the metric measures exactly the owner's words). Show them as their own line next to it". At 00:20Z
// on 10-21 us-metal02 read 7.18 GB of Agent sessions with no session working; at 03:52Z the chat service's cgroup held 1.37 GB and the Prime
// supervisor (pid 1471207, the daemon's PIDFile) 0.43 GB of the daemon's 14.41 GB.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cgroupGroups, groupOf, type LeafMemory, processHeld, supervisorMemory } from "../../prime-relay/host-stats.ts";
import { measure } from "../scripts/duties/whole-system.ts";
import { type Footprints, agentLine, watchLine, type WatchLine } from "../src/mac-usable-watch.ts";

const GB = 1024 ** 3;
const MIN = 60_000;
const APP = "user.slice/user-1001.slice/user@1001.service/app.slice/";
const leaf = (unit: string, gb: number, extra: Partial<LeafMemory> = {}): LeafMemory =>
  ({ path: APP + unit, bytes: gb * GB, swapBytes: 0, cacheBytes: 0, fileBytes: 0, fileSwapBytes: 0, ...extra });
const LEAVES = [leaf("prime-agent-daemon.service", 14.41, { services: { bytes: 0.43 * GB, swapBytes: 0 } }), leaf("sieun-pi-chat.service", 1.37),
  leaf("prime-relay.service", 0.01), leaf("pi-pool-serve.service", 0.01)];

test("Agent sessions leave out the chat service, the relay, pi-pool and the Prime supervisor, which Agent services shows on its own", () => {
  const groups = cgroupGroups(LEAVES)!;
  const agents = groups.find(group => group.id === "agents")!, services = groups.find(group => group.id === "services")!;
  assert.equal(Math.round(100 * agents.bytes / GB) / 100, 13.98);
  assert.equal(services.label, "Agent services");
  assert.equal(Math.round(100 * services.bytes / GB) / 100, 1.82);
  assert.deepEqual(services.top.map(item => item.label), ["sieun-pi-chat", "Prime supervisor", "prime-relay"]);
  const line = agentLine({ groups, cacheBytes: 0 }, []);
  assert.equal(line.gb, 13.98);
  assert.equal(line.servicesGb, 1.82);
  for (const owner of ["other:chat-service", "other:pi-pool", "other:pool.py"]) assert.equal(groupOf(owner), "services", owner);
  for (const owner of ["chat:01a1164b", "other:prime-agent", "other:rlm"]) assert.equal(groupOf(owner), "agents", owner);
});

test("the supervisor is read from its pid file only when that pid is one of the cgroup's processes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "supervisor-pid-"));
  try {
    const file = join(dir, "prime-agent-daemon.pid");
    await writeFile(file, `${process.pid}\n`);
    const own = processHeld(await readFile(`/proc/${process.pid}/status`, "utf8"));
    assert.ok(own.bytes > 0);
    const read = await supervisorMemory(`1\n${process.pid}\n`, file);
    assert.ok(read && read.bytes > 0 && read.bytes >= read.swapBytes);
    assert.equal(await supervisorMemory("1\n2\n", file), null, "another cgroup");
    assert.equal(await supervisorMemory(`${process.pid}\n`, join(dir, "missing.pid")), null);
    assert.deepEqual(processHeld("RssAnon:\t  1000 kB\nVmSwap:\t  24 kB\n"), { bytes: 1024 * 1024, swapBytes: 24 * 1024 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("d7 reads quiet_agent_gb without the services and gives quiet_services_gb_us_metal02 beside it", () => {
  const groups = cgroupGroups(LEAVES)!;
  const footprints: Footprints = { workers: {}, kernels: [], swap_used_bytes: 0, pressure_level: null, cpu_s: 0 };
  const run = Date.parse("2026-10-21T00:33:08Z");
  const lines: WatchLine[] = [];
  for (let at = Date.parse("2026-10-20T23:50:30Z"); at < run; at += MIN) lines.push({ host: "us-metal02",
    ...watchLine({ now: at, rows: [], footprints, queue: null, chats: new Set(), title: () => null, cpuMs: 0, usable: null, memory: { groups, cacheBytes: 0 } }) });
  const output = measure({ now: run, watch: lines, log: { holds: [] }, chats: [], quietMs: 15 * MIN });
  assert.equal(output.metrics.quiet_agent_gb_us_metal02, 13.98);
  assert.equal(output.metrics.quiet_services_gb_us_metal02, 1.82);
  const flag = output.flagged?.find(entry => entry.kind === "quiet_agents")!;
  assert.match(flag.excerpt, /1\.82 GB in Agent services \(the chat service, relay, pi-pool and Prime supervisor\), counted apart/);
});
