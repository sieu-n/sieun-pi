// Guards ops guy's d1 runs of 10-18 05:21Z and 13:24Z on us-metal02: the wiki ran outside pm2-dev, so the precheck gave no wiki_footprint_mb and
// never counted the wiki's restarts. Since 11-21 it runs as the container box-sieun-pi-wiki-1, which the old systemctl read missed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { containerRestartsSince, measureUptime, type UptimeDeps } from "../scripts/duties/local-dev-uptime.ts";

const rollup = (pss: number) => `00400000-7ffda3845000 ---p 00000000 00:00 0  [rollup]\nRss:  1 kB\nPss:  ${pss} kB\nSwapPss:  0 kB\n`;
const enoent = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
const CGROUP = "/user.slice/user-serve.slice/docker-c285685a37f0.scope";

function deps(inspect: string | Error, pm2: object[]): UptimeDeps {
  const files: Record<string, string> = {
    "/proc/100/cgroup": `0::${CGROUP}\n`, [`/sys/fs/cgroup${CGROUP}/cgroup.procs`]: "100\n101\n", [`/sys/fs/cgroup${CGROUP}/memory.current`]: "1200000000\n",
    "/proc/100/smaps_rollup": rollup(512_000), "/proc/101/smaps_rollup": rollup(256_000), "/proc/200/smaps_rollup": rollup(1_024_000),
  };
  return {
    fetch: (async () => new Response("ok")) as typeof fetch, now: () => Date.parse("2026-10-18T16:20:00Z"), platform: "linux", env: {},
    wiki: "https://us-metal02-dev.tail0c093d.ts.net:5176", pm2: { bin: "pm2", home: "/pm2" }, watch: async () => [], wait: async () => {},
    read: async path => { if (path in files) return files[path]!; throw enoent(path); },
    exec: async (file, args) => {
      if (file === "docker" && args[0] === "inspect") { if (inspect instanceof Error) throw inspect; return inspect; }
      if (file === "pm2") return JSON.stringify(pm2);
      if (file === "ps") return "  1 0\n200 1\n";
      throw new Error(`spawn ${file} ${args.join(" ")} ENOENT`);
    },
  };
}
const container = (startedAt: string, restartCount: number) => `true 100 ${restartCount} ${startedAt}\n`;
const search = { name: "search", pid: 300, pm2_env: { restart_time: 6 } };

test("on us-metal02 the wiki's memory and restarts come from the container box-sieun-pi-wiki-1", async () => {
  const previous = { restarts: { "box-sieun-pi-wiki-1": { restartTime: 0, at: 0, invocation: "2026-11-21T23:33:00Z" }, search: { restartTime: 6, at: 0 } } };
  const { output, state } = await measureUptime(deps(container("2026-11-22T00:07:11Z", 2), [search]), previous);
  assert.equal(output.metrics.wiki_footprint_mb, 750);
  assert.equal(output.metrics.restarts, 2);
  assert.deepEqual(state?.restarts["box-sieun-pi-wiki-1"], { restartTime: 2, at: Date.parse("2026-10-18T16:20:00Z"), invocation: "2026-11-22T00:07:11Z" });
  assert.ok(!output.flagged?.some(slice => slice.excerpt.includes("no live llm-wiki")), JSON.stringify(output.flagged));
});

test("where pm2 runs the wiki its tree is read from pm2", async () => {
  const missing = new Error("Command failed: docker inspect -f x box-sieun-pi-wiki-1\nerror: no such object: box-sieun-pi-wiki-1\n");
  const { output } = await measureUptime(deps(missing, [search, { name: "llm-wiki", pid: 200, pm2_env: { restart_time: 1 } }]), undefined);
  assert.equal(output.metrics.wiki_footprint_mb, 1000);
});

test("a manual restart resets RestartCount and still counts once", () => {
  assert.equal(containerRestartsSince({ restartTime: 0, invocation: "a" }, 0, "a"), 0);
  assert.equal(containerRestartsSince({ restartTime: 0, invocation: "a" }, 0, "b"), 1);
  assert.equal(containerRestartsSince({ restartTime: 3, invocation: "a" }, 1, "b"), 2);
});
