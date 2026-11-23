import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { DurableCommands } from "../src/durable/commands.ts";
import { PiHost, type Connection } from "../src/host.ts";
import { LoopStalls, noteLine, readCounts, track } from "../src/loop-stall.ts";
import { StallProfiler } from "../src/stall-profile.ts";

process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";

const root = mkdtempSync(join(tmpdir(), "pi-host-loop-stall-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** Holds the loop for `ms`, as a command that builds thousands of rows in one go does. */
function block(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) { /* the loop is held */ }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 150));

test("a command that holds the loop over 500 ms writes a host.log line naming it, its thread and its rows, and counts it", async () => {
  const lines: string[] = [];
  const dataDir = join(root, "host");
  const durable = {
    handles: (type: string) => type === "durable_slow",
    handle: async (command: { id?: string; type: string }) => {
      block(700);
      return { type: "response", id: command.id, command: command.type, success: true, data: { agents: Array.from({ length: 2558 }, (_, i) => i) } };
    },
    threads: { shutdown: async () => {} },
  } as unknown as DurableCommands;
  const host = new PiHost({ agentDir: join(root, "agent"), dataDir, durable, log: line => lines.push(line) });
  const connection: Connection = { clientId: "test", roster: false, write: () => {} };
  try {
    await host.handle({ id: "1", type: "durable_slow", thread: "d548ccaf-1111-2222-3333-444444444444" } as never, connection);
    await tick();
    const line = lines.find(text => text.startsWith("loop stall "));
    assert.ok(line, `no loop stall line in ${JSON.stringify(lines)}`);
    assert.match(line, /^loop stall \d+ ms from \d\d:\d\d:\d\d\.\d{3}Z \| ran: durable_slow in d548ccaf, 2558 rows, \d+ ms of it in the stall/);
    const stall = Number(/^loop stall (\d+) ms/.exec(line)![1]);
    assert.ok(stall >= 600, `stall ${stall} ms`);
    const day = readCounts(join(dataDir, "loop-stalls.json")).days[new Date().toISOString().slice(0, 10)];
    assert.equal(day?.over500, 1);
    assert.equal(day?.byCause.durable_slow?.count, 1);
    assert.equal(JSON.parse(readFileSync(join(dataDir, "loop-stalls.json"), "utf8")).days[new Date().toISOString().slice(0, 10)].over1s, 0);
  } finally {
    await host.shutdown();
  }
});

test("a kernel host request in a child conversation names its session and row count", async () => {
  const lines: string[] = [];
  const stalls = new LoopStalls({ log: line => lines.push(line) });
  try {
    await track("agent_observe.list", "72ba1ed2-e04e-4284-a4da-3547edb6a3d9-202116", async () => {
      block(600);
      return { current: {}, agents: Array.from({ length: 40 }, () => ({})) };
    });
    await tick();
    assert.match(lines.join("\n"), /ran: agent_observe\.list in 72ba1ed2-202116, 40 rows/);
  } finally {
    stalls.stop();
  }
});

test("a stall in untracked work names the last host.log line written in it", async () => {
  const lines: string[] = [];
  const stalls = new LoopStalls({ log: line => lines.push(line) });
  try {
    await tick();
    noteLine("scheduler: reopening 01a17e5d for rlm_heartbeat eda876d6");
    block(600);
    await tick();
    const line = lines.find(text => text.startsWith("loop stall "));
    assert.ok(line);
    assert.match(line, /ran: no tracked work \| last log line: "scheduler: reopening 01a17e5d for rlm_heartbeat eda876d6"/);
    assert.equal(stalls.counts.days[new Date().toISOString().slice(0, 10)]?.byCause["untracked, see last log line"]?.count, 1);
  } finally {
    stalls.stop();
  }
});

test("a stall right after another names no last log line when the only line written was the monitor's own", async () => {
  const lines: string[] = [];
  // PiHost.log notes every line it writes, the monitor's own too.
  const stalls = new LoopStalls({ log: line => { noteLine(line); lines.push(line); } });
  try {
    await tick();
    block(600);
    await tick();
    block(600);
    await tick();
    const own = lines.filter(text => text.startsWith("loop stall "));
    assert.equal(own.length, 2, JSON.stringify(lines));
    assert.match(own[1]!, /ran: no tracked work \| loop thread on CPU \d+ ms/);
    assert.equal(stalls.counts.days[new Date().toISOString().slice(0, 10)]?.byCause.untracked?.count, 2);
  } finally {
    stalls.stop();
  }
});

test("a stall says how long the loop thread ran on a CPU in it, so work and GC read apart from a thread that waited", async () => {
  const lines: string[] = [];
  const stalls = new LoopStalls({ log: line => lines.push(line) });
  try {
    await tick();
    block(600);
    await tick();
    // Atomics.wait holds the loop with the thread off CPU, as a thread that waits for a core or on a blocking call does.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
    await tick();
    const cpu = lines.map(line => Number(/loop thread on CPU (\d+) ms/.exec(line)?.[1]));
    assert.equal(cpu.length, 2, JSON.stringify(lines));
    assert.ok(cpu[0]! >= 500, `a busy stall ran ${cpu[0]} ms on CPU: ${lines[0]}`);
    assert.ok(cpu[1]! < 200, `a waiting stall ran ${cpu[1]} ms on CPU: ${lines[1]}`);
  } finally {
    stalls.stop();
  }
});

/** Holds the loop for `ms` in its own frames, as untracked work such as a model turn's request build does. */
function buildLongRequestForTest(ms: number): number {
  const end = performance.now() + ms;
  let sum = 0;
  while (performance.now() < end) for (let i = 0; i < 100_000; i++) sum += Math.sqrt(i);
  return sum;
}

test("a stall no tracked work explains names the function that held the loop, and writes its samples to a .cpuprofile", async () => {
  const lines: string[] = [];
  const dir = join(root, "stall-profiles");
  // A second host's profiler in the same process, as in a test file with two hosts, hears of the first one's profiles too.
  const other = new StallProfiler();
  const stalls = new LoopStalls({ log: line => lines.push(line), profiler: new StallProfiler({ dir }) });
  try {
    await tick();
    buildLongRequestForTest(700);
    await tick();
    const line = lines.find(text => text.startsWith("loop stall "));
    assert.ok(line, JSON.stringify(lines));
    assert.match(line, /ran: no tracked work \|.* \| profile self: buildLongRequestForTest pi-host\/test\/loop-stall\.test\.ts:\d+ (\d+) ms/);
    const selfMs = Number(/profile self: buildLongRequestForTest \S+ (\d+) ms/.exec(line)![1]);
    assert.ok(selfMs >= 500, `the profile gave the loop holder ${selfMs} ms: ${line}`);
    const file = /profile file (\S+\.cpuprofile)/.exec(line)?.[1];
    assert.ok(file && file.startsWith(dir), line);
    const profile = JSON.parse(readFileSync(file, "utf8")) as { nodes: unknown[]; samples: number[]; timeDeltas: number[] };
    assert.equal(profile.samples.length, profile.timeDeltas.length);
    assert.ok(profile.samples.length >= 20, `${profile.samples.length} samples in the stall`);
  } finally {
    stalls.stop();
    other.stop();
  }
});

test("a loop held under 500 ms writes no line", async () => {
  const lines: string[] = [];
  const stalls = new LoopStalls({ log: line => lines.push(line) });
  try {
    await tick();
    block(300);
    await tick();
    assert.deepEqual(lines, []);
  } finally {
    stalls.stop();
  }
});
