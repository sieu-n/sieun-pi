import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { promName, type Sample } from "../otlp.ts";
import { earlyoomKills, feedChatNames, fields, freshWatchLine, helperWorkers, isWorker, linuxUsableSamples, machineSamples, macUsable, macUsableSamples,
  meminfoBytes, parsePs, parseShow, parseSwaps, parseSysctlConf, psiSamples, shortHolder, testBrowserSamples, watchWorkers, type Footprints } from "../readers/memory-mac.ts";
import type { LinuxUsable, MachineView } from "../../prime-relay/host-stats.ts";

const fixture = (name: string): string => readFileSync(new URL(`fixtures/memory-mac/${name}`, import.meta.url), "utf8");
const find = (samples: Sample[], name: string, labels: Record<string, string> = {}): Sample | undefined =>
  samples.find(s => s.name === name && Object.entries(labels).every(([key, value]) => s.labels?.[key] === value));

test("swap devices, vmstat and memory.events parse to bytes and counts", () => {
  assert.deepEqual(parseSwaps(fixture("swaps.txt")), [
    { device: "/dev/nvme0n1p1", sizeBytes: 16777212 * 1024, usedBytes: 14297164 * 1024 },
    { device: "/swapfile", sizeBytes: 67108860 * 1024, usedBytes: 18882204 * 1024 }]);
  const vm = fields(fixture("vmstat.txt"));
  assert.equal(vm.get("oom_kill"), 45);
  assert.equal(vm.get("zswpwb"), 906);
  assert.equal(fields(fixture("memory.events")).get("oom_kill"), 37);
  assert.equal(meminfoBytes("Zswap:           6556824 kB\nZswapped:       18810156 kB\n", "Zswapped"), 18810156 * 1024);
  assert.equal(meminfoBytes("Zswap: 1 kB\n", "Zswapped"), null);
});

test("earlyoom kills count each sending line by signal and skip the startup limits line", () => {
  const { kills, cursor } = earlyoomKills(fixture("earlyoom-journal.txt"));
  assert.deepEqual([...kills], [["SIGTERM", 1], ["SIGKILL", 1]]);
  assert.equal(cursor, "s=abc;i=1f;b=boot;m=9;t=1;x=2");
  assert.equal(earlyoomKills("").cursor, null);
});

test("systemctl show blocks and the sysctl.d file parse by name", () => {
  const units = parseShow(fixture("systemctl-show.txt"));
  assert.deepEqual(units.get("earlyoom.service"), { pid: 2414775, active: true });
  assert.equal(units.get("oom-protect.service")?.active, false);
  assert.deepEqual([...parseSysctlConf(fixture("90-agent-memory.conf"))], [["vm.swappiness", "100"], ["vm.watermark_scale_factor", "125"], ["vm.min_free_kbytes", "1048576"]]);
});

test("the newest watch line is used only while it is fresh, and its workers keep the chat names", () => {
  const body = fixture("watch.jsonl");
  const at = Date.parse("2026-10-19T17:10:30.017Z");
  const line = freshWatchLine(body, at + 60_000);
  assert.ok(line);
  assert.equal(freshWatchLine(body, at + 10 * 60_000), null);
  assert.equal(freshWatchLine("not json\n", at), null);
  const samples = watchWorkers(line);
  assert.equal(find(samples, "harness.workers.count")?.value, 61);
  assert.equal(find(samples, "harness.workers.top_memory", { rank: "1" })?.labels?.chat, "Crawler VP");
  assert.equal(find(samples, "harness.workers.top_memory", { rank: "1" })?.value, Math.round(6.41 * 1024 ** 3));
  assert.ok(find(samples, "harness.workers.tree_memory", { rank: "5" }));
});

test("a Linux usable reading gives the cpu sides, the rig owners and the verdict by the watch's marks", () => {
  const reading: LinuxUsable = { kind: "linux", memSomeAvg10: 9, memFullAvg10: 71, cpuSomeAvg10: 50, swapoutsPerS: 10, runnablePerCore: 0.5, allowedCpus: 80,
    cpuCores: { harness: 40, apps: 10, owner: 0, ci: 5, system: 1 }, harnessSplit: { own: 6, rigs: 34, top: [{ owner: "01a1180e/fix", cores: 20, command: "vitest" }] } };
  const samples = linuxUsableSamples(reading);
  assert.equal(find(samples, "harness.usable.ok")?.value, 0);
  assert.equal(find(samples, "harness.usable.miss", { reason: "pressure" })?.value, 1);
  assert.equal(find(samples, "harness.usable.miss", { reason: "cpu" })?.value, 0);
  assert.equal(find(samples, "harness.usable.cpu_cores", { side: "harness" })?.value, 40);
  assert.equal(find(samples, "harness.usable.rig_cores", { rank: "1" })?.labels?.owner, "01a1180e/fix");
});

test("the Mac's ps rows give its workers and its test browsers with their helpers", () => {
  const rows = parsePs(fixture("ps-mac.txt"));
  assert.deepEqual(rows.filter(row => isWorker(row.args)).map(row => row.pid), [29865, 37191]);
  const browsers = testBrowserSamples(rows);
  assert.equal(find(browsers, "harness.mac.test_browsers")?.value, 1);
  assert.equal(find(browsers, "harness.mac.test_browser_processes")?.value, 2);
  assert.equal(find(browsers, "harness.mac.test_browser_rss")?.value, (150000 + 130000) * 1024);
  const footprints = JSON.parse(fixture("footprints.json")) as Footprints;
  const samples = helperWorkers(footprints, rows, feedChatNames(JSON.parse(fixture("mac-pressure.json"))));
  assert.equal(find(samples, "harness.workers.count")?.value, 2);
  assert.deepEqual(samples.filter(s => s.name === "harness.workers.top_memory").map(s => [s.labels?.rank, s.labels?.chat, s.value]),
    [["1", "frontend bro", 5095298384], ["2", "slack green guy", 1298007832]]);
});

test("the Mac verdict reads the pressure feed while it is fresh", () => {
  const feed = JSON.parse(fixture("mac-pressure.json")) as Record<string, unknown>;
  const at = Date.parse(feed.ts as string);
  assert.equal(macUsable(feed, at + 60_000), null);
  const reading = macUsable(feed, at + 1000);
  assert.ok(reading);
  const samples = macUsableSamples(reading);
  assert.equal(find(samples, "harness.usable.ok")?.value, 0);
  assert.equal(find(samples, "harness.usable.miss", { reason: "swapouts" })?.value, 1);
  assert.equal(find(samples, "harness.usable.miss", { reason: "pressure" })?.value, 0);
});

const view = (platform: "linux" | "darwin"): MachineView => ({ platform, cpu: { percent: 50, cores: 8, load: [1, 2, 3] },
  memory: { usedBytes: 10, totalBytes: 20, swapUsedBytes: 1, swapTotalBytes: 2, pressure: "warn", cacheBytes: 5,
    groups: [{ id: "agents", label: "Agent sessions", bytes: 7, swapBytes: 1, top: [{ label: "docker-" + "a".repeat(64), bytes: 7 }] }] } });

test("machine samples send every group, and leave the Mac's load, pressure and swap to devbox_*", () => {
  const linux = machineSamples(view("linux"));
  assert.equal(find(linux, "harness.host.cpu_used")?.value, 0.5);
  assert.equal(find(linux, "harness.host.memory_pressure_level")?.value, 2);
  assert.equal(find(linux, "harness.host.memory_group", { group: "docker" })?.value, 0);
  assert.equal(find(linux, "harness.host.memory_group_top", { group: "agents", rank: "1" })?.labels?.holder, "docker-aaaaaaaaaaaa");
  const mac = machineSamples(view("darwin"));
  for (const name of ["harness.host.load", "harness.host.memory_pressure_level", "harness.host.swap_used", "harness.host.memory_group_swap"]) assert.equal(find(mac, name), undefined, name);
  assert.equal(shortHolder("tailscaled"), "tailscaled");
});

test("PSI lines give avg10 and avg60 for some and full", () => {
  const samples = psiSamples("memory", "some avg10=6.00 avg60=3.91 avg300=2.33 total=1\nfull avg10=4.63 avg60=3.12 avg300=1.51 total=1\n");
  assert.equal(samples.length, 4);
  assert.equal(find(samples, "harness.host.psi", { kind: "full", window: "avg60" })?.value, 3.12);
});

test("each metric name keeps one kind and unit, so its Prometheus name is stable", () => {
  const all = [...machineSamples(view("linux")), ...linuxUsableSamples({ kind: "linux", memSomeAvg10: 0, memFullAvg10: 0, cpuSomeAvg10: 0, swapoutsPerS: 0, runnablePerCore: 0, allowedCpus: 1 }),
    ...watchWorkers(freshWatchLine(fixture("watch.jsonl"), Date.parse("2026-10-19T17:11:00Z"))!)];
  const names = new Map<string, string>();
  for (const sample of all) {
    const prom = promName(sample);
    assert.equal(names.get(sample.name) ?? prom, prom, sample.name);
    names.set(sample.name, prom);
  }
  assert.equal(names.get("harness.workers.top_memory"), "harness_workers_top_memory_bytes");
});
