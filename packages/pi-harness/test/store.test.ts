import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentDir, globalHarnessDir, mergeStates, readState, stateFile, updateState } from "../src/store.ts";

const temp = () => mkdtempSync(join(tmpdir(), "pi-harness-store-"));
const deadPid = () => Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
const entry = (id: string) => ({ id, kind: "memory" as const, title: id, content: `content ${id}`, path: "general", scope: "global" as const, reference: {}, arguments: {}, metadata: {}, source: "agent", created_at: "2026-10-27T00:00:00+00:00", updated_at: "2026-10-27T00:00:00+00:00", version: 1 });

test("paths follow harness.py: RLM_GLOBAL_HARNESS_STATE_DIR, then the agent dir from PRIME_AGENT_CODING_AGENT_DIR or PI_CODING_AGENT_DIR", () => {
  assert.equal(globalHarnessDir({ RLM_GLOBAL_HARNESS_STATE_DIR: "/x/g", PI_CODING_AGENT_DIR: "/y" }), "/x/g");
  assert.equal(globalHarnessDir({ RLM_GLOBAL_HARNESS_STATE_DIR: " ", PI_CODING_AGENT_DIR: "/y" }), "/y/harness");
  assert.equal(globalHarnessDir({ PRIME_AGENT_CODING_AGENT_DIR: "/p", PI_CODING_AGENT_DIR: "/y" }), "/p/harness");
  assert.match(agentDir({}), /\.prime\/agent$/);
});

test("a malformed file reads as empty, a bad entry is skipped, and a topic is read as the path", () => {
  const dir = temp();
  try {
    writeFileSync(stateFile(dir), "{not json");
    assert.deepEqual(readState(dir, "local").entries.memory, {});
    writeFileSync(stateFile(dir), JSON.stringify({ entries: { memory: { a: { title: 1, content: "x" }, b: { title: "B", content: "c", topic: "old/topic", version: "3" } } }, refinements: [{ id: "r", trigger: "t", changes: "one" }, { id: 5 }] }));
    const state = readState(dir, "local");
    assert.deepEqual(Object.keys(state.entries.memory), ["b"]);
    assert.equal(state.entries.memory.b.path, "old/topic");
    assert.equal(state.entries.memory.b.version, 3);
    assert.equal(state.entries.memory.b.scope, "local");
    assert.deepEqual(state.refinements.map(r => r.changes), [["one"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateState keeps the file mode, writes the schema harness.py and prime-sync read, and leaves no lock or temp file", async () => {
  const dir = temp();
  try {
    await updateState(dir, "global", s => { s.entries.memory.a = entry("a"); });
    assert.equal(statSync(stateFile(dir)).mode & 0o777, 0o600);
    chmodSync(stateFile(dir), 0o640);
    await updateState(dir, "global", s => { s.entries.memory.b = entry("b"); });
    assert.equal(statSync(stateFile(dir)).mode & 0o777, 0o640);
    const raw = JSON.parse(readFileSync(stateFile(dir), "utf8"));
    assert.deepEqual(Object.keys(raw), ["schema", "entries", "refinements"]);
    assert.deepEqual(Object.keys(raw.entries), ["prompt", "memory", "skill", "subagent"]);
    assert.equal(existsSync(stateFile(dir) + ".lock"), false);
    assert.equal(await updateState(dir, "global", () => false), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock left by a dead process is cleared, and a live owner's lock is waited for", async () => {
  const dir = temp();
  try {
    mkdirSync(stateFile(dir) + ".lock", { recursive: true });
    writeFileSync(stateFile(dir) + ".lock/pid", String(deadPid()));
    await updateState(dir, "global", s => { s.entries.memory.a = entry("a"); });
    assert.ok(readState(dir, "global").entries.memory.a);
    mkdirSync(stateFile(dir) + ".lock");
    writeFileSync(stateFile(dir) + ".lock/pid", String(process.pid));
    let done = false;
    const pending = updateState(dir, "global", s => { s.entries.memory.b = entry("b"); }).then(() => (done = true));
    await new Promise(r => setTimeout(r, 150));
    assert.equal(done, false);
    rmSync(stateFile(dir) + ".lock", { recursive: true });
    await pending;
    assert.ok(readState(dir, "global").entries.memory.b);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("eight processes that write the same store at once lose no entry", async () => {
  const dir = temp();
  try {
    const worker = `import { updateState } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
      const id = process.argv[1];
      for (let i = 0; i < 20; i++) await updateState(${JSON.stringify(dir)}, "global", s => {
        s.entries.memory[id + "_" + i] = { id: id + "_" + i, kind: "memory", title: "t", content: "c", path: "general", scope: "global", reference: {}, arguments: {}, metadata: {}, source: "agent", created_at: "", updated_at: "", version: 1 };
      });`;
    const runs = Array.from({ length: 8 }, (_, n) => new Promise<number | null>(resolve =>
      spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", worker, `w${n}`], { stdio: "inherit" }).on("exit", resolve)));
    assert.deepEqual(await Promise.all(runs), Array(8).fill(0));
    assert.equal(Object.keys(readState(dir, "global").entries.memory).length, 160);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the merged view shows a clashing local id as local:<id>, as Prime's digest does", () => {
  const g = readState("/nonexistent", "global");
  const l = readState("/nonexistent", "local");
  g.entries.memory.x = entry("x");
  l.entries.memory.x = { ...entry("x"), scope: "local" };
  assert.deepEqual(Object.keys(mergeStates(g, l).entries.memory), ["x", "local:x"]);
});
