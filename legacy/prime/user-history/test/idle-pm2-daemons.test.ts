// Guards d7's idle pm2 daemon count: on 10-28 the Mac ran two pm2 God Daemons with no app, 50 MB each for days. A job's
// `PM2_HOME=~/.pm2 npx pm2 jlist` on 10-22 started one in ~/.pm2, and a `PM2_HOME=.cache/pm2-dev pm2 ...` run in apps/virev-demo on 10-26 started
// one in that app's folder, because any pm2 command starts a daemon in the home it reads when none runs there.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { idlePm2, PM2_IDLE_MS } from "../scripts/duties/whole-system.ts";
import { type Footprints, type RawPm2, type WatchLine, watchLine } from "../src/mac-usable-watch.ts";

const HELPER = new URL("../src/worker-footprint.py", import.meta.url).pathname;
const NOW = Date.parse("2026-10-28T05:00:00Z");
const REPO_HOME = "/Users/sieunpark/Documents/Github/auto-sns-agent/.cache/pm2-dev";
const footprints = (daemons: RawPm2[]): Footprints => ({ workers: {}, kernels: [], orphans: [], pm2_daemons: daemons, swap_used_bytes: null, pressure_level: null, cpu_s: 0 });
const rows = [{ sessionId: "01a11ba8", sessionName: "frontend bro", lifecycle: "live", activeSessionId: "a" }];
const macLine = (daemons: RawPm2[]) => watchLine({ now: NOW, rows, footprints: footprints(daemons), queue: null, chats: new Set(["01a11ba8"]), title: () => null, cpuMs: 0 });
const boxLine = (mac: ReturnType<typeof macLine>): WatchLine => ({ at: "2026-10-28T05:00:30Z", host: "us-metal02", usable: null, workers: 0, workerGb: 0, top: [], live: 0, working: 0,
  queue: null, mac: { swapGb: null, pressureLevel: null }, cpuMs: 0,
  hosts: [{ name: "mac", usable: null, workers: 0, workerGb: 0, top: [], live: 0, working: 0, swapGb: null, ...mac.idlePm2 ? { idlePm2: mac.idlePm2 } : {} }] });
const daemon = (pid: number, home: string, apps: number, ageMs: number, session = ""): RawPm2 =>
  ({ pid, bytes: 50 * 2 ** 20, started: (NOW - ageMs) / 1000, command: `PM2 v7.0.3: God Daemon (${home})`, home, apps, root: session ? "01a11ba8" : "", session });

test("the footprint helper lists each pm2 God Daemon with its home and the processes it runs", () => {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("wf", sys.argv[1]); wf = importlib.util.module_from_spec(spec); spec.loader.exec_module(wf)
wf.footprint = lambda pid: 50 << 20
env = ["RLM_HARNESS_STATE_DIR=/Users/x/.prime/agent/session-artifacts/01a11ba8/sub-1/01a17b8b/harness"]
table = {
  81849: (1, 81849, 100, (["PM2 v7.0.3: God Daemon (${REPO_HOME})"], [])),
  6977: (81849, 6977, 101, (["node", "convex"], [])),
  29811: (1, 29811, 102, (["PM2 v7.0.3: God Daemon (.cache/pm2-dev) ", "SILENT=true"], env)),
  500: (1, 500, 103, (["node", "pm2-like"], [])),
}
print(json.dumps(wf.pm2_daemons(table)))`;
  const found = JSON.parse(execFileSync("python3", ["-c", script, HELPER], { encoding: "utf8" })) as RawPm2[];
  assert.deepEqual(found.map(entry => [entry.pid, entry.home, entry.apps, entry.root, entry.session]),
    [[81849, REPO_HOME, 1, "", ""], [29811, ".cache/pm2-dev", 0, "01a11ba8", "01a17b8b"]]);
});

test("a daemon that runs no process for 10 minutes, or has a relative home, is flagged with its starter", () => {
  const mac = macLine([daemon(81849, REPO_HOME, 5, 9 * 86_400_000), daemon(40771, "/Users/sieunpark/.pm2", 0, 5 * 86_400_000),
    daemon(29811, ".cache/pm2-dev", 0, 60_000, "01a17b8b")]);
  assert.deepEqual(mac.idlePm2?.map(line => line.pid), [40771, 29811]);
  const found = idlePm2(boxLine(mac), NOW);
  assert.equal(found.length, 2);
  assert.match(found[0]!.text, /^mac: pm2 God Daemon pid 40771 in \/Users\/sieunpark\/\.pm2 since \d\d:\d\dZ, up 120 h, runs no process \(50 MB\), started by no agent session/);
  assert.equal(found[1]!.root, "01a11ba8");
  assert.match(found[1]!.text, /in \.cache\/pm2-dev .*runs no process \(50 MB\), and its PM2_HOME is relative, so its folder is its starter's cwd \(lsof -a -p 29811 -d cwd\), started by frontend bro session 01a17b8b$/);
});

test("a fresh daemon with an absolute home waits out its first pm2 start", () => {
  const mac = macLine([daemon(7, REPO_HOME, 0, PM2_IDLE_MS - 60_000)]);
  assert.equal(mac.idlePm2?.length, 1);
  assert.deepEqual(idlePm2(boxLine(mac), NOW), []);
});

test("a box whose only daemon runs its apps writes none and flags none", () => {
  const mac = macLine([daemon(81849, REPO_HOME, 5, 86_400_000)]);
  assert.equal(mac.idlePm2, undefined);
  assert.deepEqual(idlePm2(boxLine(mac), NOW), []);
});
