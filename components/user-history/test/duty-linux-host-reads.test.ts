// Guards frontend bro's d1 runs of 10-18 06:36Z and 06:44Z on us-metal02: the demo-sandbox precheck called macOS footprint, which Linux lacks
// ("spawn footprint ENOENT"), so dev_tree_mb read 0 and source_errors read 1. local-dev-uptime's load line called sysctl vm.loadavg the same way.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measureSandbox, pssMb, treeMb, type SandboxDeps } from "../scripts/duties/demo-sandbox.ts";
import { hostLoad } from "../scripts/duties/local-dev-uptime.ts";

const rollup = (pss: number, swapPss: number) =>
  `00400000-7ffda3845000 ---p 00000000 00:00 0  [rollup]\nRss:  71628 kB\nPss:  ${pss} kB\nPss_Anon:  20004 kB\nSwap:  ${swapPss} kB\nSwapPss:  ${swapPss} kB\n`;
const enoent = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });

test("a Linux tree sums Pss and SwapPss from smaps_rollup and skips a pid that exited", async () => {
  assert.equal(pssMb([rollup(22398, 3428), rollup(1_000_000, 0)]), 1002);
  const files: Record<string, string> = { "/proc/10/smaps_rollup": rollup(512_000, 0), "/proc/11/smaps_rollup": rollup(500_000, 12_000) };
  const read = async (path: string) => { if (path in files) return files[path]!; throw enoent(path); };
  const exec = async (file: string) => { throw new Error(`exec ${file} on Linux`); };
  assert.equal(await treeMb({ platform: "linux", read, exec }, [10, 11, 12]), 1000);
  await assert.rejects(treeMb({ platform: "linux", read, exec }, [12]), /no \/proc/);
});

test("a Mac tree still reads footprint", async () => {
  const calls: string[] = [];
  const exec = async (file: string, args: readonly string[]) => { calls.push([file, ...args].join(" ")); return "phys_footprint: 1048576000 B\nphys_footprint: 10485760 B\n"; };
  assert.equal(await treeMb({ platform: "darwin", exec, read: async path => { throw enoent(path); } }, [10, 11]), 1010);
  assert.deepEqual(calls, ["footprint --noCategories -f bytes -p 10 -p 11"]);
});

test("the Linux precheck reads dev_tree_mb with no source error", async () => {
  const files: Record<string, string> = {
    "/pm2/logs/virev-demo-error.log": "", "/pm2/logs/virev-demo-out.log": "", "/pm2/pm2.log": "",
    "/proc/606266/smaps_rollup": rollup(22398, 3428), "/proc/606330/smaps_rollup": rollup(900_000, 0),
  };
  const deps: SandboxDeps = {
    fetch: (async () => new Response("ok")) as typeof fetch, now: () => Date.parse("2026-10-18T07:50:00Z"), repo: "/repo", platform: "linux",
    pm2: { bin: "pm2", home: "/pm2", zone: "UTC" },
    read: async path => { if (path in files) return files[path]!; throw enoent(path); },
    exec: async file => {
      if (file === "pm2") return JSON.stringify([{ name: "virev-demo", pid: 606266 }]);
      if (file === "ps") return "  1 0\n606266 1\n606330 606266\n";
      throw new Error(`spawn ${file} ENOENT`);
    },
  };
  const { metrics, flagged } = await measureSandbox(deps);
  assert.equal(metrics.dev_tree_mb, 904);
  assert.equal(metrics.source_errors, 0, JSON.stringify(flagged?.filter(slice => slice.kind === "source")));
});

test("the uptime load line reads /proc on Linux and sysctl on a Mac", async () => {
  const files: Record<string, string> = { "/proc/loadavg": "3.10 2.50 2.00 4/1200 99\n", "/proc/meminfo": "MemTotal: 1 kB\nSwapTotal:  8388608 kB\nSwapFree:  7340032 kB\n" };
  const read = async (path: string) => { if (path in files) return files[path]!; throw enoent(path); };
  const exec = async (file: string) => { if (file === "sysctl") return "{ 1.0 2.0 3.0 }\ntotal = 0.00M  used = 0.00M\n"; throw new Error(`spawn ${file} ENOENT`); };
  assert.equal(await hostLoad({ platform: "linux", read, exec }), "3.10 2.50 2.00, swap used 1024 MB of 8192 MB");
  assert.equal(await hostLoad({ platform: "darwin", read, exec }), "{ 1.0 2.0 3.0 } total = 0.00M used = 0.00M");
});
