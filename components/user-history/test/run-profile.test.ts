import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CPU_PROFILE_DIR, startRunProfile } from "../src/run-profile.ts";

const burn = (ms: number): void => { const end = Date.now() + ms; let x = 0; while (Date.now() < end) x += Math.sqrt(x + 1); };

test("a run with the cpu-profiles folder saves one profile whose samples cover its busy time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "run-profile-"));
  try {
    await mkdir(join(dir, CPU_PROFILE_DIR));
    const profile = await startRunProfile({ dataDir: dir, log: () => {} });
    burn(200);
    const file = await profile.stop();
    assert.ok(file);
    assert.equal(await profile.stop(), file);
    const saved = JSON.parse(await readFile(file, "utf8")) as { samples: number[]; timeDeltas: number[]; nodes: unknown[] };
    assert.ok(saved.samples.length > 50, `${saved.samples.length} samples`);
    assert.equal(saved.samples.length, saved.timeDeltas.length);
    assert.deepEqual((await readdir(join(dir, CPU_PROFILE_DIR))).length, 1);
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
