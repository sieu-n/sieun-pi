import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { CPU_PROFILE_DIR, HEAP_PROFILE_SUFFIX, KEEP_MS, startRunProfile } from "../src/run-profile.ts";

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
    const saved = async () => (await readdir(join(dir, CPU_PROFILE_DIR))).filter(name => name.endsWith(".cpuprofile"));
    // Under release-chat's 20 concurrent test files on 11-19 the first window had not reached the disk 1 s in, so the run waits for it.
    const started = Date.now();
    while ((await saved()).length === 0 && Date.now() - started < 30_000) { burn(40); await sleep(5); }
    const rolled = await saved();
    if (rolled.length === 0) await profile.stop();
    assert.ok(rolled.length >= 1, `${rolled.length} profiles saved before the stop`);
    // d7 11-20: reading the heap profile forces a full GC, 896 ms with a 1.25 GB heap, so only the stop writes one.
    assert.ok(!(await readdir(join(dir, CPU_PROFILE_DIR))).some(name => name.endsWith(HEAP_PROFILE_SUFFIX)));
    burn(300);
    const last = await profile.stop();
    assert.ok(last);
    const windows = (await readdir(join(dir, CPU_PROFILE_DIR))).filter(name => name.endsWith(".cpuprofile")).sort();
    assert.ok(windows.length >= 2 && windows.includes(last.split("/").at(-1)!), windows.join(", "));
    assert.deepEqual((await readdir(join(dir, CPU_PROFILE_DIR))).filter(name => name.endsWith(HEAP_PROFILE_SUFFIX)), [last.split("/").at(-1)!.replace(/\.cpuprofile$/, HEAP_PROFILE_SUFFIX)]);
    for (const name of windows) {
      const saved = JSON.parse(await readFile(join(dir, CPU_PROFILE_DIR, name), "utf8")) as { samples: number[]; timeDeltas: number[] };
      const covered = saved.timeDeltas.slice(1).reduce((sum, delta) => sum + delta, 0) / 1000;
      assert.ok(saved.samples.length > 1 && covered / (saved.samples.length - 1) >= 5, `${name}: ${saved.samples.length} samples over ${covered} ms`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// d7 11-20: the live chat's 18:06Z to 19:06Z roll on 11-19 took 1,835 ms and stalled its loop 1.7 s. Its stop disposed V8's CPU profiler and
// the next start logged every compiled function again, which costs about 10 ms per 1,000 functions, so a roll now keeps a bridge profile open.
test("a roll restarts the profile without paying a fresh profiler start", async () => {
  const dir = await mkdtemp(join(tmpdir(), "run-profile-"));
  const compiled = Array.from({ length: 20_000 }, (_, at) => new Function("x", `return x + ${at};`) as (x: number) => number);
  assert.ok(compiled.reduce((sum, fn) => sum + fn(1), 0) > 0);
  const fresh = new Session();
  fresh.connect();
  await fresh.post("Profiler.enable");
  let freshStart = Infinity;
  for (let round = 0; round < 2; round++) {
    const at = performance.now();
    await fresh.post("Profiler.start");
    freshStart = Math.min(freshStart, performance.now() - at);
    await fresh.post("Profiler.stop");
  }
  fresh.disconnect();
  const lines: string[] = [];
  try {
    await mkdir(join(dir, CPU_PROFILE_DIR));
    const profile = await startRunProfile({ dataDir: dir, log: line => lines.push(line), rollMs: 200 });
    const started = Date.now();
    const rolled = (): string | undefined => lines.find(line => / in \d+ ms/.test(line));
    while (!rolled() && Date.now() - started < 30_000) { burn(20); await sleep(5); }
    await profile.stop();
    const took = Number(/ in (\d+) ms/.exec(rolled() ?? "")?.[1] ?? NaN);
    assert.ok(took * 2 < freshStart, `the roll took ${took} ms against ${freshStart.toFixed(1)} ms for a fresh start`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a run deletes the profiles older than a week and keeps the rest of the folder", async () => {
  const dir = await mkdtemp(join(tmpdir(), "run-profile-"));
  try {
    const folder = join(dir, CPU_PROFILE_DIR);
    await mkdir(folder);
    const old = new Date(Date.now() - KEEP_MS - 3_600_000);
    for (const name of ["old.cpuprofile", "old.heapprofile", "old-notes.txt", "new.cpuprofile"]) await writeFile(join(folder, name), "{}");
    for (const name of ["old.cpuprofile", "old.heapprofile", "old-notes.txt"]) await utimes(join(folder, name), old, old);
    const lines: string[] = [];
    const profile = await startRunProfile({ dataDir: dir, log: line => lines.push(line) });
    const last = await profile.stop();
    assert.ok(last);
    assert.deepEqual((await readdir(folder)).filter(name => !name.includes("pid")).sort(), ["new.cpuprofile", "old-notes.txt"]);
    assert.ok(lines.some(line => line.includes("deleted 2 profiles")), lines.join("\n"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
