// 10-23 on us-metal02: a process died during the chat service restart to release-a908e31 at 01:23Z and left
// extension-loads.json.lock.recovery behind, and every archive on the box then failed with "Extension load record recovery is busy".
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type JsonFile, transactJsonFile } from "../src/locked-json.ts";

const deadPid = (): number => Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);

function staleLock(recoveryOwner: number | null, recoveryAgeMs = 0) {
  const dir = mkdtempSync(join(tmpdir(), "locked-json-"));
  const file: JsonFile<{ n: number }> = { path: join(dir, "extension-loads.json"), label: "Extension load record", initial: () => ({ n: 0 }), parse: value => value as { n: number } };
  mkdirSync(file.path + ".lock");
  writeFileSync(file.path + ".lock/pid", String(deadPid()));
  const recovery = file.path + ".lock.recovery";
  mkdirSync(recovery);
  if (recoveryOwner !== null) writeFileSync(recovery + "/pid", String(recoveryOwner));
  if (recoveryAgeMs) { const then = (Date.now() - recoveryAgeMs) / 1000; utimesSync(recovery, then, then); }
  return { dir, file };
}

test("a recovery folder left by a dead process is taken over, and the stale lock under it is cleared", async () => {
  const { dir, file } = staleLock(deadPid());
  try { assert.deepEqual((await transactJsonFile(file, state => { state.n++; })).state, { n: 1 }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a recovery folder with no owner, as older releases left it, is taken over once it is older than the lock's stale rule", async () => {
  const { dir, file } = staleLock(null, 31000);
  try { assert.deepEqual((await transactJsonFile(file, state => { state.n++; })).state, { n: 1 }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a recovery folder held by a live process, or a fresh one with no owner yet, still blocks", async () => {
  for (const owner of [process.pid, null]) {
    const { dir, file } = staleLock(owner);
    try { await assert.rejects(transactJsonFile(file, () => {}), /Extension load record recovery is busy/); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("eight processes that race for a stale lock under a dead recovery folder never hold it at once", async () => {
  const { dir, file } = staleLock(deadPid());
  try {
    const worker = `import { transactJsonFile } from ${JSON.stringify(new URL("../src/locked-json.ts", import.meta.url).href)};
      const file = { path: ${JSON.stringify(file.path)}, label: "Extension load record", initial: () => ({ n: 0 }), parse: value => value };
      for (let done = 0; done < 25;) {
        try { await transactJsonFile(file, state => { state.n++; }); done++; }
        catch (error) { if (!/busy/.test(String(error))) throw error; }
      }`;
    const runs = Array.from({ length: 8 }, () => new Promise<number | null>(resolve =>
      spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", worker], { stdio: "inherit" }).on("exit", resolve)));
    assert.deepEqual(await Promise.all(runs), Array(8).fill(0));
    assert.deepEqual(JSON.parse(readFileSync(file.path, "utf8")), { n: 200 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
