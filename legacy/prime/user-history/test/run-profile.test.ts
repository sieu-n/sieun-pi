import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { CPU_PROFILE_DIR, HEAP_PROFILE_SUFFIX, startRunProfile } from "../src/run-profile.ts";

const burn = (ms: number): void => { const end = Date.now() + ms; let x = 0; while (Date.now() < end) x += Math.sqrt(x + 1); };

test("a run with the cpu-profiles folder saves one profile whose samples cover its busy time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "run-profile-"));
  try {
    await mkdir(join(dir, CPU_PROFILE_DIR));
    const profile = await startRunProfile({ dataDir: dir, log: () => {} });
    burn(300);
    const file = await profile.stop();
    assert.ok(file);
    assert.equal(await profile.stop(), file);
    const saved = JSON.parse(await readFile(file, "utf8")) as { samples: number[]; timeDeltas: number[]; nodes: unknown[] };
    // Under the release's full suite the sampler got 46 samples for the 200 ms burn on 10-21 at 02:5xZ, so the check reads the time the
    // samples cover, which stays whole when the sampler thread runs less often.
    assert.equal(saved.samples.length, saved.timeDeltas.length);
    const covered = saved.timeDeltas.reduce((sum, delta) => sum + delta, 0) / 1000;
    assert.ok(saved.samples.length > 5 && covered >= 270, `${saved.samples.length} samples over ${covered} ms`);
    assert.deepEqual((await readdir(join(dir, CPU_PROFILE_DIR))).length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

type HeapNode = { callFrame: { functionName: string }; selfSize: number; children: HeapNode[] };
const total = (node: HeapNode): number => node.selfSize + node.children.reduce((sum, child) => sum + total(child), 0);
const heldBy = (node: HeapNode, name: string): number =>
  node.callFrame.functionName === name ? total(node) : node.children.reduce((sum, child) => sum + heldBy(child, name), 0);

test("the heap profile beside the cpu profile names the code that holds memory at the stop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "run-profile-"));
  const held: string[][] = [];
  function holdRows(): void {
    for (let at = 0; at < 200; at++) { const rows: string[] = []; for (let index = 0; index < 1000; index++) rows.push(`row ${at} ${index}`); held.push(rows); }
  }
  try {
    await mkdir(join(dir, CPU_PROFILE_DIR));
    const profile = await startRunProfile({ dataDir: dir, log: () => {} });
    holdRows();
    const file = await profile.stop();
    assert.ok(file);
    const heap = JSON.parse(await readFile(file.replace(/\.cpuprofile$/, HEAP_PROFILE_SUFFIX), "utf8")) as { head: HeapNode };
    assert.ok(heldBy(heap.head, "holdRows") > 1024 * 1024, `holdRows holds ${heldBy(heap.head, "holdRows")} bytes in the profile`);
    assert.equal(held.length, 200);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a run with no cpu-profiles folder profiles nothing and writes nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "run-profile-"));
  try {
    const profile = await startRunProfile({ dataDir: dir, log: () => {} });
    assert.equal(await profile.stop(), null);
    assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// d7 11-20: one profile at 1 ms held every sample of a 32 h run in the live chat's native memory, 9.5 GB of anonymous memory in all, and its
// major GCs grew to 0.6 s. The run now saves and restarts its profile each window, at 10 ms a sample, so it holds one window of samples.
test("a long run saves its profile each window at 10 ms a sample and keeps profiling after each save", async () => {
  const dir = await mkdtemp(join(tmpdir(), "run-profile-"));
  try {
    await mkdir(join(dir, CPU_PROFILE_DIR));
    const profile = await startRunProfile({ dataDir: dir, log: () => {}, rollMs: 400 });
    const started = Date.now();
    while (Date.now() - started < 1_000) { burn(40); await sleep(5); }
    const rolled = (await readdir(join(dir, CPU_PROFILE_DIR))).filter(name => name.endsWith(".cpuprofile"));
    assert.ok(rolled.length >= 1, `${rolled.length} profiles saved before the stop`);
    assert.ok((await readdir(join(dir, CPU_PROFILE_DIR))).some(name => name.endsWith(HEAP_PROFILE_SUFFIX)));
    burn(300);
    const last = await profile.stop();
    assert.ok(last);
    const windows = (await readdir(join(dir, CPU_PROFILE_DIR))).filter(name => name.endsWith(".cpuprofile")).sort();
    assert.ok(windows.length >= 2 && windows.includes(last.split("/").at(-1)!), windows.join(", "));
    for (const name of windows) {
      const saved = JSON.parse(await readFile(join(dir, CPU_PROFILE_DIR, name), "utf8")) as { samples: number[]; timeDeltas: number[] };
      const covered = saved.timeDeltas.slice(1).reduce((sum, delta) => sum + delta, 0) / 1000;
      assert.ok(saved.samples.length > 1 && covered / (saved.samples.length - 1) >= 5, `${name}: ${saved.samples.length} samples over ${covered} ms`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
