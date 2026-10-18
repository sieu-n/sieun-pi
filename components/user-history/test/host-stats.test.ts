import { test } from "node:test";
import assert from "node:assert/strict";
import { cgroupGroups, cgroupLabel, machineView, memoryGroups, parseMeminfo, parsePsi, parseSysctl, parseVmStat } from "../../prime-relay/host-stats.ts";

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     4972.
Pages wired down:                             353615.
Pages purgeable:                                  26.
Anonymous pages:                              455047.
Pages occupied by compressor:                1001179.
`;

test("vm_stat counts app, wired and compressed pages as used memory", () => {
  assert.equal(parseVmStat(VM_STAT), (455047 - 26 + 353615 + 1001179) * 16384);
  assert.equal(parseVmStat("no numbers here"), null);
});

test("sysctl gives the pressure level and swap in use", () => {
  assert.deepEqual(parseSysctl("2\ntotal = 39936.00M  used = 39051.81M  free = 884.19M  (encrypted)\n"), { pressure: "warn", swapUsedBytes: Math.round(39051.81 * 1024 * 1024), swapTotalBytes: 39936 * 1024 * 1024 });
  assert.deepEqual(parseSysctl("1\ntotal = 0.00M  used = 0.00M  free = 0.00M\n"), { pressure: "normal", swapUsedBytes: 0, swapTotalBytes: 0 });
  assert.deepEqual(parseSysctl(""), { pressure: null, swapUsedBytes: null, swapTotalBytes: null });
});

test("machineView reads this machine", async () => {
  const view = await machineView();
  assert.ok(view.cpu.cores > 0);
  assert.ok(view.cpu.percent >= 0 && view.cpu.percent <= 100);
  assert.ok(view.memory.usedBytes > 0 && view.memory.usedBytes <= view.memory.totalBytes);
});

const GB = 1024 ** 3;
/** Owners from ~/.cache/virev/mac-pressure.json at 00:29Z on 10-18, cut to one or two a group. */
const FEED = { v: 1, ts: "2026-10-18T00:29:19.055Z", mem_gb: { total: 32, free: 0.07, compressed: 8.35, wired: 3.64 }, owners: [
  { owner: "browser:helium", label: "Helium", mem_gb: 8.32 }, { owner: "browser:aside", label: "Aside", mem_gb: 3.68 },
  { owner: "other:com.apple.WebKit.WebContent", label: "com.apple.WebKit.WebContent", mem_gb: 0.36 },
  { owner: "other:rest", label: "other names under 0.1 GiB each", mem_gb: 3.43 },
  { owner: "chat:01a14c09-1f34-7475-8f3e-a6a193df5fc9", label: "blog visits lift 10-18", mem_gb: 2.65 },
  { owner: "other:prime-agent-daemon", label: "prime-agent daemon", mem_gb: 0.63 }, { owner: "other:chat-service-cli.mjs", label: "chat-service-cli.mjs", mem_gb: 1.3 },
  { owner: "pm2:virev-demo", label: "virev-demo", mem_gb: 2.34 }, { owner: "other:Visual Studio Code", label: "Visual Studio Code", mem_gb: 2.03 },
  { owner: "other:Claude", label: "Claude", mem_gb: 1.06 }, { owner: "other:Dock", label: "Dock", mem_gb: 0.13 }, { owner: "other:Sunsama", label: "Sunsama", mem_gb: 0.83 },
] };
const NOW = Date.parse(FEED.ts) + 5_000;

test("memoryGroups sums the feed's owners into the big groups, largest first, with each group's top 3", () => {
  const groups = memoryGroups(FEED, NOW)!;
  const gb = (id: string) => Math.round(groups.find(group => group.id === id)!.bytes / GB * 100) / 100;
  assert.deepEqual(groups.map(group => group.id), ["browsers", "agents", "other", "system", "coding", "dev", "docker"]);
  assert.equal(gb("browsers"), 12.36);
  assert.equal(gb("agents"), 4.58);
  assert.equal(gb("system"), 3.77);
  assert.equal(gb("docker"), 0);
  assert.deepEqual(groups[0]!.top.map(item => item.label), ["Helium", "Aside", "com.apple.WebKit.WebContent"]);
  assert.deepEqual(groups.find(group => group.id === "system")!.top.map(item => item.label), ["Wired memory (macOS kernel)", "Dock"]);
});

test("memoryGroups puts Docker and OrbStack VMs in Docker, and gives null for a stale or unknown feed", () => {
  const docker = memoryGroups({ ...FEED, owners: [{ owner: "docker-vm", label: "Docker VM", mem_gb: 4 }, { owner: "other:OrbStack Helper", label: "OrbStack Helper", mem_gb: 1 }] }, NOW)!;
  assert.equal(docker.find(group => group.id === "docker")!.bytes, 5 * GB);
  assert.equal(memoryGroups(FEED, NOW + 60_000), null);
  assert.equal(memoryGroups({ v: 2 }, NOW), null);
  assert.equal(memoryGroups(null, NOW), null);
});

test("meminfo gives used as MemTotal minus MemAvailable, and swap in use", () => {
  const text = "MemTotal:       259246796 kB\nMemFree:        1000 kB\nMemAvailable:   228306324 kB\nSwapTotal:       16777212 kB\nSwapFree:        16777212 kB\n";
  assert.deepEqual(parseMeminfo(text), { usedBytes: (259246796 - 228306324) * 1024, totalBytes: 259246796 * 1024, swapUsedBytes: 0, swapTotalBytes: 16777212 * 1024 });
  assert.equal(parseMeminfo("nothing"), null);
});

test("memory PSI reads warn at some avg10 7 and critical at full avg10 70", () => {
  assert.equal(parsePsi("some avg10=0.00 avg60=0.00 avg300=0.00 total=1272\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1208\n"), "normal");
  assert.equal(parsePsi("some avg10=7.10 avg60=0 avg300=0 total=1\nfull avg10=2.00 avg60=0 avg300=0 total=1\n"), "warn");
  assert.equal(parsePsi("some avg10=90.00 avg60=0 avg300=0 total=1\nfull avg10=71.00 avg60=0 avg300=0 total=1\n"), "critical");
  assert.equal(parsePsi(""), null);
});

/** Leaf cgroups of us-metal02 at 02:22Z on 10-18, cut to a few a group. */
const LEAVES = [
  { path: "dev.slice/containerd.service", bytes: 17.4 * GB },
  { path: "dev.slice/docker-327767630da3.scope", bytes: 0.66 * GB },
  { path: "virev.slice/virev-ci.slice/machine-qemu\\x2d66\\x2dci\\x2dg5.scope/libvirt", bytes: 2.83 * GB },
  { path: "system.slice/system-virev\\x2dci\\x2dvirt.slice/virev-ci-virt@1772-0.service", bytes: 0.01 * GB },
  { path: "user.slice/user-1001.slice/user@1001.service/app.slice/prime-agent-daemon.service", bytes: 2.4 * GB },
  { path: "user.slice/user-1001.slice/user@1001.service/app.slice/sieun-pi-chat.service", bytes: 0.3 * GB },
  { path: "user.slice/user-0.slice/session-241.scope", bytes: 11.9 * GB },
  { path: "system.slice/snapd.service", bytes: 1.5 * GB },
];

test("cgroupGroups puts Docker, CI VMs, agent services and login sessions in their groups, with readable names", () => {
  const groups = cgroupGroups(LEAVES)!;
  const of = (id: string) => groups.find(group => group.id === id)!;
  assert.deepEqual(groups.map(group => group.id), ["docker", "other", "ci", "agents", "system"]);
  assert.deepEqual(of("ci").top.map(item => item.label), ["machine-qemu-66-ci-g5", "virev-ci-virt@1772-0"]);
  assert.deepEqual(of("agents").top.map(item => item.label), ["prime-agent-daemon", "sieun-pi-chat"]);
  assert.deepEqual(of("other").top.map(item => item.label), ["root login session 241"]);
  assert.equal(cgroupLabel("user.slice/user-1001.slice/session-3.scope"), "uid 1001 login session 3");
  assert.equal(cgroupGroups([]), null);
});
