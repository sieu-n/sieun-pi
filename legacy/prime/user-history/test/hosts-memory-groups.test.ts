// The owner on 10-28 at about 02:00 KST (17:00Z on 10-27), on Settings > Hosts for us-metal02: "why do they not add up". The card read 186 of
// 247 GB used, and its groups summed 51.1 GB: Other 39.2, Docker 9.1, CI runners 0.0. The fixture is that box's cgroup tree, /proc/meminfo,
// /proc/zoneinfo and transient unit list read together at 17:31:07Z on 10-27 (155.5 GB used, 10.0 GB in swap), trimmed to the lines the reader
// reads, with each leaf's pids replaced by ones that do not exist, and the processes of the daemon's unit and the ssh login scopes (command,
// RLM_SESSION_DIR, RssAnon, VmSwap) at the same moment.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cgroupGroups, kernelItems, leafCgroups, leafHolder, type MemoryGroup, memoryLeaves, parseMeminfo, processHeld, processHolder, processShares } from "../../../../components/prime-relay/host-stats.ts";
import { ownerOf } from "../../../../components/prime-relay/rig-cpu.ts";

const GB = 1024 ** 3;
const FIXTURE = join(import.meta.dirname, "fixtures", "hosts-memory-1027");
const read = (name: string): string => readFileSync(join(FIXTURE, name), "utf8");
const transient = new Set(read("transient").split("\n").filter(Boolean));
const proc = { meminfo: read("meminfo"), zoneinfo: read("zoneinfo") };
const ramOf = (group: { bytes: number; swapBytes?: number }): number => group.bytes - (group.swapBytes ?? 0);
const gb = (groups: readonly MemoryGroup[], id: string): number => ramOf(groups.find(group => group.id === id) ?? { bytes: 0 }) / GB;
const DAEMON = "user.slice/user-1001.slice/user@1001.service/app.slice/prime-agent-daemon.service";

test("the groups' RAM adds up to used within 3 GB, with CI guests, jobs' units and the kernel each named and Other under 3 GB", async () => {
  const leaves = await leafCgroups(join(FIXTURE, "cgroup"), transient);
  const groups = cgroupGroups(leaves, proc)!;
  const used = parseMeminfo(proc.meminfo)!.usedBytes / GB;
  const sum = groups.reduce((total, group) => total + ramOf(group), 0) / GB;
  assert.ok(Math.abs(sum - used) < 3, `groups ${sum.toFixed(1)} GB against ${used.toFixed(1)} GB used`);
  assert.ok(gb(groups, "ci") > 30, `CI runners ${gb(groups, "ci").toFixed(1)} GB`);
  assert.ok(gb(groups, "jobs") > 20, `Jobs ${gb(groups, "jobs").toFixed(1)} GB`);
  assert.ok(gb(groups, "other") < 3, `Other ${gb(groups, "other").toFixed(1)} GB`);
  assert.ok(gb(groups, "agents") > 5 && gb(groups, "services") > 1);
  const system = groups.find(group => group.id === "system")!;
  assert.deepEqual(system.top.map(item => item.label).slice(0, 1), ["Free memory the kernel keeps in reserve (watermarks)"]);
  assert.ok(gb(groups, "system") > 15, `System ${gb(groups, "system").toFixed(1)} GB`);
  const swap = groups.reduce((total, group) => total + (group.swapBytes ?? 0), 0) / GB;
  assert.ok(Math.abs(swap - parseMeminfo(proc.meminfo)!.swapUsedBytes! / GB) < 1, `groups hold ${swap.toFixed(1)} GB of swap`);
  assert.match(groups.find(group => group.id === "ci")!.top[0]!.label, /^ci-/);
});

test("a qemu guest's leaf is its libvirt cgroup, never the vcpu and emulator threads under it", async () => {
  const leaves = await memoryLeaves(join(FIXTURE, "cgroup"));
  assert.ok(leaves.some(path => /machine-qemu.*\/libvirt$/.test(path)));
  assert.ok(!leaves.some(path => /\/(vcpu\d+|emulator)$/.test(path)));
  assert.deepEqual(leafHolder("virev.slice/virev-ci.slice/machine-qemu\\x2d73\\x2dci\\x2dg23.scope/libvirt", transient), { id: "ci", label: "ci-g23" });
});

test("leafHolder names jobs' transient units, installed services and the units that split by process", () => {
  const app = "user.slice/user-1001.slice/user@1001.service/app.slice/";
  assert.deepEqual(leafHolder(app + "ph-ab-r2.service", transient), { id: "jobs", label: "ph-ab-r2" });
  assert.deepEqual(leafHolder(app + "app-org.chromium.Chromium-104531.scope", transient), { id: "jobs", label: "app-org.chromium.Chromium-104531" });
  assert.deepEqual(leafHolder(app + "run-p1097888-i900400.scope", new Set(["run-p1097888-i900400.scope"])), { id: "jobs", label: "run-p1097888-i900400" });
  assert.deepEqual(leafHolder(app + "pi-rlm-kernel-01a17e5d-mvqy8a55.scope", transient), { id: "agents", label: "Prime kernels" });
  assert.deepEqual(leafHolder(app + "sieun-pi-chat.service", transient), { id: "services", label: "sieun-pi-chat" });
  assert.deepEqual(leafHolder(app + "harness-feed.service", transient), { id: "services", label: "harness-feed" });
  assert.deepEqual(leafHolder(app + "auto-sns-dev-pm2.service", transient), { id: "dev", label: "auto-sns-dev-pm2" });
  assert.deepEqual(leafHolder(app + "ci-cache.service", transient), { id: "ci", label: "ci-cache" });
  assert.equal(leafHolder(DAEMON, transient), "by-process");
  assert.equal(leafHolder("user.slice/user-1001.slice/session-c922.scope", transient), "by-process");
  assert.equal((leafHolder("system.slice/system-virev\\x2dci\\x2dvirt.slice/virev-ci-virt@g1.service", transient) as { id: string }).id, "ci");
  assert.deepEqual(leafHolder("dev.slice/docker-" + "ab".repeat(32) + ".scope", transient), { id: "docker", label: "docker-abababababab" });
  assert.equal((leafHolder("system.slice/tailscaled.service", transient) as { id: string }).id, "system");
});

test("the daemon's unit splits into the supervisor, workers and kernels, and the jobs that started the rest", () => {
  const processes = JSON.parse(read("processes.json")) as { path: string; command: string; sessionDir?: string; rssAnonKb: number; vmSwapKb: number }[];
  const shares = processes.filter(item => item.path === DAEMON).map(item => ({
    holder: processHolder(item.path, { command: item.command, ...item.sessionDir ? { owner: ownerOf(item.sessionDir, undefined) } : {} }),
    ...processHeld(`RssAnon:\t${item.rssAnonKb} kB\nVmSwap:\t${item.vmSwapKb} kB\n`) }));
  const leaf = { bytes: 20 * GB, swapBytes: 1 * GB };
  const parts = processShares(leaf, shares, { id: "agents", label: "Prime workers" });
  assert.ok(Math.abs(parts.reduce((sum, part) => sum + part.bytes, 0) - leaf.bytes) < 100, "the parts add up to the leaf, to rounding");
  assert.ok(Math.abs(parts.reduce((sum, part) => sum + part.swapBytes, 0) - leaf.swapBytes) < 100);
  const labels = new Set(parts.map(part => `${part.holder.id}:${part.holder.label}`));
  for (const label of ["services:Prime supervisor", "agents:Prime workers", "agents:Prime kernels"]) assert.ok(labels.has(label), label);
  assert.ok(parts.some(part => part.holder.id === "jobs"), "jobs' tests and servers in the daemon's unit read Jobs");
  assert.deepEqual(processHolder(DAEMON, { command: "/home/sieun/.local/bin/prime-agent --mode daemon --daemon-socket /tmp/prime-agent-1001/daemon.sock" }),
    { id: "services", label: "Prime supervisor" });
  assert.deepEqual(processHolder(DAEMON, { command: "/scratch/i/bun1/prime-agent --mode daemon --daemon-socket /tmp/t/daemon.sock", owner: "01a17b28/rig" }),
    { id: "jobs", label: "01a17b28/rig" }, "a job's test daemon carries its job's session");
  assert.deepEqual(processHolder("user.slice/user-1001.slice/session-c922.scope", { command: "node svelte-check" }), { id: "jobs", label: "ssh logins" });
  assert.deepEqual(processHolder(DAEMON, { command: "node server.js" }), { id: "jobs", label: "no live owner" });
});

test("a by-process leaf whose processes hold nothing goes to its fallback whole", () => {
  assert.deepEqual(processShares({ bytes: 5, swapBytes: 1 }, [], { id: "agents", label: "Prime workers" }), [{ holder: { id: "agents", label: "Prime workers" }, bytes: 5, swapBytes: 1 }]);
});

test("kernelItems reads MemAvailable's reserve as the kernel computes it", () => {
  const items = kernelItems(proc.meminfo, proc.zoneinfo, 0)!;
  const byLabel = new Map(items.system.map(item => [item.label, item.bytes / GB]));
  // si_mem_available on the fixture: MemFree less the reserve, plus file cache and reclaimable slab less a low watermark of each, is MemAvailable.
  const kb = (name: string): number => Number(new RegExp(`^${name.replace(/[()]/g, "\\$&")}:\\s+(\\d+) kB`, "m").exec(proc.meminfo)![1]) * 1024 / GB;
  const available = kb("MemFree") - byLabel.get("Free memory the kernel keeps in reserve (watermarks)")! + kb("Active(file)") + kb("Inactive(file)") + kb("KReclaimable")
    - byLabel.get("File cache and slab MemAvailable keeps back (low watermarks)")!;
  assert.ok(Math.abs(available - kb("MemAvailable")) < 0.01, `${available} against ${kb("MemAvailable")}`);
  assert.ok(byLabel.get("Free pages on the per-CPU lists")! > 1);
  assert.equal(kernelItems("", proc.zoneinfo, 0), null);
});
