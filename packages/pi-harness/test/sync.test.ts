import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { readState, stateFile, updateState } from "../src/core/store.ts";

const repo = resolve(import.meta.dirname, "../../..");
const syncPy = join(repo, "components/prime-sync/sync.py");
const harnessPy = join(repo, "packages/pi-rlm/python/src/rlm/harness.py");

function python(code: string, ...args: string[]) {
  const run = spawnSync("python3", ["-c", code, ...args], { encoding: "utf8", env: { ...process.env, PRIME_SYNC_HOME: tmpdir(), PRIME_SYNC_CONFIG: "/nonexistent" } });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

test("prime-sync's merge reads a file pi-harness wrote and writes back a file pi-harness reads, entry for entry", { skip: !existsSync(syncPy) }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-sync-"));
  try {
    await updateState(dir, "global", s => {
      for (const kind of ["prompt", "memory", "skill", "subagent"] as const)
        s.entries[kind][`${kind}_1`] = { id: `${kind}_1`, kind, title: `T ${kind}`, content: "c 한국어", path: "p", scope: "global", reference: kind === "skill" ? { type: "python", import: "m", callable: "f" } : {}, arguments: {}, metadata: {}, source: "agent", created_at: "2026-10-27T00:00:00+00:00", updated_at: "2026-10-27T00:00:00+00:00", version: 2 };
      s.refinements.push({ id: "refine_1", trigger: "t", changes: ["create memory:memory_1"], evidence: "", outcome: "", created_at: "2026-10-27T00:00:00+00:00" });
    });
    const out = python(
      `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("sync", sys.argv[1]); sync = importlib.util.module_from_spec(spec); spec.loader.exec_module(sync)
current = json.loads(open(sys.argv[2]).read())
files = sync.harness_files(current)
remote = dict(files); remote["harness/memory/remote_1.json"] = sync.canonical({**current["entries"]["memory"]["memory_1"], "id": "remote_1", "title": "from another box"})
merged = sync.merge(files, None, remote)
open(sys.argv[2], "w").write(json.dumps(sync.harness_from(merged, current), indent=2, ensure_ascii=False))
print(len(files))`,
      syncPy,
      stateFile(dir),
    );
    assert.equal(out.trim(), "5");
    const state = readState(dir, "global");
    assert.deepEqual(Object.keys(state.entries.memory).sort(), ["memory_1", "remote_1"]);
    assert.equal(state.entries.skill.skill_1.reference.callable, "f");
    assert.equal(state.refinements[0].id, "refine_1");
    await updateState(dir, "global", s => { s.entries.memory.after = { ...s.entries.memory.memory_1, id: "after" }; });
    assert.equal(Object.keys(JSON.parse(readFileSync(stateFile(dir), "utf8")).entries.memory).length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the vendored harness.py and pi-harness share one lock, so 4 Python and 4 TS writers lose no entry", { skip: !existsSync(harnessPy) || !readFileSync(harnessPy, "utf8").includes("class _FileLock") }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-mixed-"));
  try {
    const { spawn } = await import("node:child_process");
    const ts = `import { updateState } from ${JSON.stringify(new URL("../src/core/store.ts", import.meta.url).href)};
      for (let i = 0; i < 25; i++) await updateState(${JSON.stringify(dir)}, "global", s => { const id = process.argv[1] + "_" + i; s.entries.memory[id] = { id, kind: "memory", title: id, content: "c", path: "general", scope: "global", reference: {}, arguments: {}, metadata: {}, source: "agent", created_at: "", updated_at: "", version: 1 }; });`;
    const py = `import importlib.util, sys
spec = importlib.util.spec_from_file_location("harness", sys.argv[1]); h = importlib.util.module_from_spec(spec); sys.modules["harness"] = h; spec.loader.exec_module(h)
state = h.HarnessState(sys.argv[2] + "/harness_state.json", scope="global")
for i in range(25): state.create_memory(f"{sys.argv[3]} {i}", "c", id=f"{sys.argv[3]}_{i}")`;
    const exits = await Promise.all([
      ...Array.from({ length: 4 }, (_, n) => new Promise(r => spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", ts, `ts${n}`], { stdio: "inherit" }).on("exit", r))),
      ...Array.from({ length: 4 }, (_, n) => new Promise(r => spawn("python3", ["-c", py, harnessPy, dir, `py${n}`], { stdio: "inherit" }).on("exit", r))),
    ]);
    assert.deepEqual(exits, Array(8).fill(0));
    assert.equal(Object.keys(readState(dir, "global").entries.memory).length, 200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
