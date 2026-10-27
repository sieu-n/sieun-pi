// Guards the owner's 10-28 ask about Settings > Hosts on us-metal02 at 93% CPU: "what's the CPU usage mostly at?". The fixture is two real
// cpuSnapshot readings of us-metal02 3 s apart on 10-27 at 17:3xZ (processes whose ticks did not move left out, job commands cut to their program).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type CpuClassifier, cpuGroups, type CpuProc, cpuSnapshot, type CpuSnapshot, ENDED_PROCESSES, endedUnits, KERNEL_LABEL, parentsOf } from "../../prime-relay/cpu-groups.ts";
import { cpuSample, GROUP_LABELS, leafHolder, machineView, processHolder } from "../../prime-relay/host-stats.ts";

type Raw = { at: number; stat: string; usage: Record<string, number>; leaves: string[]; procs: Record<string, CpuProc> };
const fixture = JSON.parse(readFileSync(new URL("./fixtures/cpu-groups-metal02-1027.json", import.meta.url), "utf8")) as { transient: string[]; cores: number; snapshots: [Raw, Raw] };
const snapshot = (raw: Raw): CpuSnapshot => ({ at: raw.at, stat: raw.stat, usage: new Map(Object.entries(raw.usage)), leaves: new Set(raw.leaves),
  procs: new Map(Object.entries(raw.procs).map(([pid, proc]) => [Number(pid), proc])) });
const [before, after] = fixture.snapshots.map(snapshot) as [CpuSnapshot, CpuSnapshot];
const transient = new Set(fixture.transient);
const classifier: CpuClassifier = { leafHolder: path => leafHolder(path, transient), processHolder, groupLabels: GROUP_LABELS };
/** The card's busy cores over the fixture window: its CPU percent (host-stats.ts cpuSample of the "cpu" line) of all cores. */
const busyCores = (() => {
  const [from, to] = [before, after].map(reading => cpuSample(`${reading.stat}\ncpu0 0 0 0 0 0 0 0 0 0 0\n`));
  return ((to!.busy - from!.busy) / (to!.total - from!.total)) * fixture.cores;
})();
const groups = cpuGroups(before, after, classifier, busyCores, fixture.cores)!;
const group = (id: string) => groups.find(item => item.id === id);
const grown = (path: string): number => (after.usage.get(path)! - before.usage.get(path)!) / 1e3 / (after.at - before.at);

test("the fixture's groups add up to the /proc/stat busy cores, largest first", () => {
  assert.ok(busyCores > 60 && busyCores < 80, `busy ${busyCores}`);
  const sum = groups.reduce((total, item) => total + item.cores, 0);
  assert.ok(Math.abs(sum - busyCores) < 0.05 * groups.length, `groups ${sum} against busy ${busyCores}`);
  assert.deepEqual(groups.map(item => item.cores), groups.map(item => item.cores).toSorted((a, b) => b - a));
  for (const item of groups) assert.ok(item.top.length <= 3 && item.top.every(line => line.cores <= item.cores + 0.01), item.label);
});

test("the qemu guests' libvirt cgroups count to CI runners with their vcpu time", () => {
  const guests = [...after.leaves].filter(path => /machine-qemu.*\/libvirt$/.test(path));
  assert.ok(guests.length >= 10);
  const ci = group("ci")!;
  assert.equal(ci.label, GROUP_LABELS.ci);
  assert.ok(ci.cores >= guests.reduce((sum, path) => sum + grown(path), 0) - 0.05, `ci ${ci.cores}`);
  assert.ok(ci.top.some(line => /ci-g\d+$/.test(line.label)), JSON.stringify(ci.top));
  assert.ok(ci.top.some(line => line.label === endedUnits("system.slice/system-virev\\x2dci\\x2dvirt.slice")), "the CI VMs that ended in the window count to CI");
});

test("Prime workers and kernels count to Agent sessions, and the supervisor to Agent services", () => {
  const labels = group("agents")!.top.map(line => line.label);
  assert.ok(labels.includes("Prime workers"), labels.join(", "));
  const daemon = [...after.procs.values()].find(proc => proc.command.endsWith("/daemon.sock"));
  assert.ok(daemon, "the fixture has the supervisor");
  assert.deepEqual(processHolder(daemon.leaf, daemon), { id: "services", label: "Prime supervisor" });
});

test("a transient unit counts to jobs, and the daemon's processes that ended in the window too", () => {
  const jobs = group("jobs")!;
  assert.equal(jobs.id, groups[0]!.id, "jobs used the most cores in the fixture window");
  const run = jobs.top.find(line => /^run-p\d+-i\d+$/.test(line.label));
  assert.ok(run && run.cores > 20, JSON.stringify(jobs.top));
  assert.ok(jobs.top.some(line => line.label === ENDED_PROCESSES));
});

const reading = (at: number, usage: Record<string, number>, leaves: string[], procs: Record<number, CpuProc> = {}): CpuSnapshot =>
  ({ at, stat: "", usage: new Map(Object.entries(usage)), leaves: new Set(leaves), procs: new Map(Object.entries(procs).map(([pid, proc]) => [Number(pid), proc])) });
const DAEMON = "user.slice/user-1/user@1.service/app.slice/prime-agent-daemon.service";
const toy: CpuClassifier = {
  leafHolder: path => path === DAEMON ? "by-process" : { id: path.startsWith("virev.slice/") ? "ci" : "system", label: path.split("/").at(-1)! },
  processHolder: (_, proc) => proc.owner ? { id: "jobs", label: proc.owner } : { id: "agents", label: "Prime workers" },
  groupLabels: GROUP_LABELS,
};

test("a by-process leaf splits by process, and its time no live process used counts as ended processes in jobs", () => {
  const worker = { leaf: DAEMON, start: 5, command: "prime-agent --mode daemon" }, test1 = { leaf: DAEMON, start: 9, command: "node --test", owner: "abcd1234/job" };
  const from = reading(0, { [DAEMON]: 0 }, [DAEMON], { 10: { ...worker, ticks: 100 }, 11: { ...test1, ticks: 0 } });
  const to = reading(1000, { [DAEMON]: 4_000_000 }, [DAEMON], { 10: { ...worker, ticks: 200 }, 11: { ...test1, ticks: 150 } });
  const split = cpuGroups(from, to, toy, 4, 8)!;
  assert.deepEqual(split.map(({ id, cores }) => [id, cores]), [["jobs", 3], ["agents", 1]]);
  assert.deepEqual(split[0]!.top, [{ label: "abcd1234/job", cores: 1.5 }, { label: ENDED_PROCESSES, cores: 1.5 }]);
});

test("a parent's time beyond its live leaves counts as its ended units, and the root's rest as Kernel and interrupts", () => {
  const guest = "virev.slice/virev-ci.slice/machine-qemu\\x2d1\\x2dci\\x2dg1.scope/libvirt";
  const usage = (scale: number) => Object.fromEntries([guest, ...parentsOf([guest])].map((path, index) => [path, scale * (index === 3 ? 3 : 2) * 1e6]));
  assert.deepEqual(parentsOf([guest]).toSorted(), ["virev.slice", "virev.slice/virev-ci.slice", "virev.slice/virev-ci.slice/machine-qemu\\x2d1\\x2dci\\x2dg1.scope"]);
  const split = cpuGroups(reading(0, usage(0), [guest]), reading(1000, usage(1), [guest]), toy, 4, 8)!;
  assert.deepEqual(split.map(({ id, cores }) => [id, cores]), [["ci", 3], ["system", 1]]);
  assert.deepEqual(split[0]!.top, [{ label: "libvirt", cores: 2 }, { label: endedUnits("virev.slice/virev-ci.slice/machine-qemu\\x2d1\\x2dci\\x2dg1.scope"), cores: 1 }]);
  assert.deepEqual(split[1]!.top, [{ label: KERNEL_LABEL, cores: 1 }]);
});

test("cgroups that read more than the busy cores shrink by one share, and a cgroup new in the window counts its whole usage", () => {
  const split = cpuGroups(reading(0, { a: 1e6 }, ["a"]), reading(1000, { a: 4e6, b: 3e6 }, ["a", "b"]), toy, 3, 8)!;
  assert.deepEqual(split.map(({ cores }) => cores), [3]);
  assert.deepEqual(split[0]!.top, [{ label: "a", cores: 1.5 }, { label: "b", cores: 1.5 }]);
  const lifetime = cpuGroups(reading(0, { a: 0 }, ["a"]), reading(1000, { a: 0, b: 9e9 }, ["a", "b"]), toy, 3, 8)!;
  assert.deepEqual(lifetime[0]!.top, [{ label: KERNEL_LABEL, cores: 3 }], "a counter larger than the window's CPU time is a cgroup the last reading missed");
  assert.equal(cpuGroups(reading(5, {}, []), reading(5, {}, []), toy, 3, 8), null);
});

test("cpuSnapshot reads /proc/stat, every leaf's and parent's usage_usec, and the by-process leaf's processes", async t => {
  const root = mkdtempSync(join(tmpdir(), "cpu-groups-")), cgroups = join(root, "cgroup"), proc = join(root, "proc");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pid = 4_000_000_001;
  for (const [path, usec] of [[DAEMON, 7], ["user.slice/user-1", 9], ["user.slice/user-1/user@1.service", 8], ["user.slice/user-1/user@1.service/app.slice", 8], ["user.slice", 9]] as const) {
    mkdirSync(join(cgroups, path), { recursive: true });
    writeFileSync(join(cgroups, path, "cpu.stat"), `usage_usec ${usec}\nuser_usec 1\n`);
  }
  writeFileSync(join(cgroups, DAEMON, "cgroup.procs"), `${pid}\n`);
  mkdirSync(join(proc, String(pid)), { recursive: true });
  writeFileSync(join(proc, "stat"), "cpu  1 2 3 4 5 6 7 0 0 0\nbtime 1793000000\n");
  writeFileSync(join(proc, String(pid), "stat"), `${pid} (node) S 1 ${"0 ".repeat(9)}30 12 ${"0 ".repeat(6)}777 0 0`);
  writeFileSync(join(proc, String(pid), "cmdline"), "node\0--test\0a.test.ts\0");
  const read = await cpuSnapshot([DAEMON, "user.slice/gone.scope"], toy.leafHolder, cgroups, proc, 42);
  assert.equal(read.stat.split("\n")[0], "cpu  1 2 3 4 5 6 7 0 0 0");
  assert.deepEqual([...read.leaves], [DAEMON]);
  assert.equal(read.usage.get("user.slice/user-1/user@1.service/app.slice"), 8);
  assert.deepEqual(read.procs.get(pid), { leaf: DAEMON, start: 777, ticks: 42, command: "node --test a.test.ts" });
});

test("machineView on Linux sends CPU groups on its second reading that add up to its percent of the cores", { skip: process.platform !== "linux" }, async () => {
  await machineView();
  await new Promise(resolve => setTimeout(resolve, 500));
  const { cpu } = await machineView();
  assert.ok(cpu.groups?.length, "no CPU groups");
  const sum = cpu.groups.reduce((total, item) => total + item.cores, 0);
  assert.ok(Math.abs(sum - (cpu.percent * cpu.cores) / 100) < 0.05 * cpu.groups.length + 0.1, `groups ${sum} against ${cpu.percent}% of ${cpu.cores}`);
});
