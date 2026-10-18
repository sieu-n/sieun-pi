// Guards ops guy's d1 runs of 10-18 05:21Z and 13:24Z on us-metal02: the wiki ran as llm-wiki.service under systemd, not in pm2-dev, so the precheck gave no wiki_footprint_mb and never counted the wiki's restarts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measureUptime, unitRestartsSince, type UptimeDeps } from "../scripts/duties/local-dev-uptime.ts";

const rollup = (pss: number) => `00400000-7ffda3845000 ---p 00000000 00:00 0  [rollup]\nRss:  1 kB\nPss:  ${pss} kB\nSwapPss:  0 kB\n`;
const enoent = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
const CGROUP = "/user.slice/user-1001.slice/user@1001.service/app.slice/llm-wiki.service";

function deps(show: string, pm2: object[]): UptimeDeps {
  const files: Record<string, string> = {
    [`/sys/fs/cgroup${CGROUP}/cgroup.procs`]: "100\n101\n", "/proc/100/smaps_rollup": rollup(512_000), "/proc/101/smaps_rollup": rollup(256_000),
    "/proc/200/smaps_rollup": rollup(1_024_000),
  };
  return {
    fetch: (async () => new Response("ok")) as typeof fetch, now: () => Date.parse("2026-10-18T16:20:00Z"), platform: "linux", env: {},
    wiki: "https://us-metal02-dev.tail0c093d.ts.net:5176", pm2: { bin: "pm2", home: "/pm2" },
    read: async path => { if (path in files) return files[path]!; throw enoent(path); },
    exec: async (file, args) => {
      if (file === "systemctl") return show;
      if (file === "pm2") return JSON.stringify(pm2);
      if (file === "ps") return "  1 0\n200 1\n";
      throw new Error(`spawn ${file} ${args.join(" ")} ENOENT`);
    },
  };
}
const unit = (invocation: string, nRestarts: number) =>
  `LoadState=loaded\nActiveState=active\nControlGroup=${CGROUP}\nNRestarts=${nRestarts}\nInvocationID=${invocation}\nMemoryCurrent=1200000000\n`;
const search = { name: "search", pid: 300, pm2_env: { restart_time: 6 } };

test("on us-metal02 the wiki's memory and restarts come from llm-wiki.service", async () => {
  const previous = { restarts: { "llm-wiki.service": { restartTime: 0, at: 0, invocation: "a" }, search: { restartTime: 6, at: 0 } } };
  const { output, state } = await measureUptime(deps(unit("b", 2), [search]), previous);
  assert.equal(output.metrics.wiki_footprint_mb, 750);
  assert.equal(output.metrics.restarts, 2);
  assert.deepEqual(state?.restarts["llm-wiki.service"], { restartTime: 2, at: Date.parse("2026-10-18T16:20:00Z"), invocation: "b" });
  assert.ok(!output.flagged?.some(slice => slice.excerpt.includes("no live llm-wiki")), JSON.stringify(output.flagged));
});

test("where pm2 runs the wiki its tree is read from pm2", async () => {
  const { output } = await measureUptime(deps("LoadState=not-found\n", [search, { name: "llm-wiki", pid: 200, pm2_env: { restart_time: 1 } }]), undefined);
  assert.equal(output.metrics.wiki_footprint_mb, 1000);
});

test("a manual restart resets NRestarts and still counts once", () => {
  assert.equal(unitRestartsSince({ restartTime: 0, invocation: "a" }, 0, "a"), 0);
  assert.equal(unitRestartsSince({ restartTime: 0, invocation: "a" }, 0, "b"), 1);
  assert.equal(unitRestartsSince({ restartTime: 3, invocation: "a" }, 1, "b"), 2);
});
