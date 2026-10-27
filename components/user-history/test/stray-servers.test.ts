// Guards the stop of stdio MCP servers whose kernel is gone. At 07:30 KST on 10-28 the Mac held `aside mcp` pid 31506 5 days after its kernel
// exited, adopted by launchd at 42 MB. Aside's own exit at stdin end and its 30 s orphan check had not fired, and Aside is not our code, so the
// footprint read stops such a server (worker-footprint.py `stray_servers`) and d7 counts each one it stopped (stray_servers_30).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { strayServers } from "../scripts/duties/whole-system.ts";
import { type Footprints, type WatchLine, watchLine } from "../src/mac-usable-watch.ts";

const HELPER = new URL("../src/worker-footprint.py", import.meta.url).pathname;

/** Runs `code` in Python with worker-footprint.py loaded as `wf`, and returns what it prints as JSON. */
function py(code: string): unknown {
  const script = `import importlib.util, json\nspec = importlib.util.spec_from_file_location("wf", ${JSON.stringify(HELPER)})\nwf = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(wf)\n${code}`;
  return JSON.parse(execFileSync("python3", ["-B", "-c", script], { encoding: "utf8" }));
}

test("a stdio MCP server whose parent is init or the user's systemd is a stray, and one under a live kernel is not", () => {
  const found = py(`
wf.footprint = lambda pid: 42 << 20
env = ["HOME=/Users/sieunpark"]
table = {
    1: (0, 1, 0, (["/sbin/launchd"], [])),
    4578: (1, 4578, 0, (["/usr/lib/systemd/systemd", "--user"], [])),
    700: (1, 700, 0, (["/Users/sieunpark/.prime/agent/kernel-venv/bin/python", "-m", "rlm.repl"], env)),
    31506: (1, 31506, 1792000000, (["/Users/sieunpark/.local/bin/aside", "mcp"], env)),
    31507: (700, 700, 1792000001, (["/Users/sieunpark/.local/bin/aside", "mcp"], env)),
    31508: (4578, 31508, 1792000002, (["node", "/home/sieun/src/sieun-pi/components/global-rules/cua-guard.ts", "/x/cua-driver", "mcp"], env)),
    31509: (1, 31509, 1792000003, (["/Users/sieunpark/.local/bin/aside", "account", "status"], env)),
    31510: (1, 31510, 1792000004, (["node", "send-check.ts", "--serve-socket", "/tmp/judge.sock"], env)),
}
print(json.dumps(sorted((entry["pid"], entry["ppid"], entry["bytes"]) for entry in wf.stray_servers(table))))
`);
  // The judge (send-check.ts --serve-socket) serves every kernel on the box and exits after 2 idle minutes, so it is no stray.
  assert.deepEqual(found, [[31506, 1, 42 << 20], [31508, 4578, 42 << 20]]);
});

test("the read SIGTERMs a stray and SIGKILLs it only when the same process still runs after the wait", () => {
  const out = py(`
signals = []
alive = {31506: 100, 31508: 200}
def kill(pid, sig):
    signals.append([pid, sig])
    if sig == 15 and pid == 31506:
        alive.pop(pid)
found = wf.reap([{"pid": 31506, "started": 100}, {"pid": 31508, "started": 200}], kill=kill, start=lambda pid: alive.get(pid), wait=0.3, sleep=lambda s: None)
print(json.dumps({"signals": signals, "ended": [entry["signal"] for entry in found]}))
`) as { signals: number[][]; ended: string[] };
  assert.deepEqual(out.signals, [[31506, 15], [31508, 15], [31508, 9]]);
  assert.deepEqual(out.ended, ["SIGTERM", "SIGKILL"]);
});

const footprints = (strays: NonNullable<Footprints["stray_servers"]>): Footprints => ({ workers: {}, kernels: [], orphans: [], stray_servers: strays, swap_used_bytes: null, pressure_level: null, cpu_s: 0 });
const macLine = (at: string, strays: NonNullable<Footprints["stray_servers"]>) => watchLine({ now: Date.parse(at), rows: [], footprints: footprints(strays), queue: null, chats: new Set(), title: () => null, cpuMs: 0 });
const boxLine = (at: string, mac: ReturnType<typeof macLine>): WatchLine => ({ at, host: "us-metal02", usable: null, workers: 0, workerGb: 0, top: [], live: 0, working: 0,
  queue: null, mac: { swapGb: null, pressureLevel: null }, cpuMs: 0,
  hosts: [{ name: "mac", usable: null, workers: 0, workerGb: 0, top: [], live: 0, working: 0, swapGb: null, ...mac.strayServers ? { strayServers: mac.strayServers } : {} }] });

test("d7 names each stray the Mac's read stopped in its window once", () => {
  const started = Date.parse("2026-10-22T12:40:00Z") / 1000;
  const stray = { pid: 31506, ppid: 1, bytes: 42 << 20, started, command: "/Users/sieunpark/.local/bin/aside mcp", signal: "SIGTERM" as const };
  const lines = [boxLine("2026-10-27T22:40:30Z", macLine("2026-10-27T22:40:30Z", [stray])), boxLine("2026-10-27T22:41:30Z", macLine("2026-10-27T22:41:30Z", [])),
    boxLine("2026-10-27T21:00:30Z", macLine("2026-10-27T21:00:30Z", [{ ...stray, pid: 9 }]))];
  assert.deepEqual(lines[0]!.hosts![0]!.strayServers, [{ pid: 31506, started, mb: 42, signal: "SIGTERM", command: "/Users/sieunpark/.local/bin/aside mcp" }]);
  assert.equal(lines[1]!.hosts![0]!.strayServers, undefined);
  const found = strayServers(lines, Date.parse("2026-10-27T22:15:00Z"), Date.parse("2026-10-27T22:46:00Z"));
  assert.equal(found.length, 1);
  assert.match(found[0]!, /^mac: stray \/Users\/sieunpark\/\.local\/bin\/aside mcp pid 31506 since \d\d:\d\dZ?, 42 MB, its kernel gone; stopped with SIGTERM at \d\d:\d\dZ?$/);
});
