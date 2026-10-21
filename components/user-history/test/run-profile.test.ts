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
    // Under the release's full suite the sampler got 46 samples for the 200 ms burn on 10-21 at 02:5xZ, so the check reads the time the
    // samples cover, which stays whole when the sampler thread runs less often.
    assert.equal(saved.samples.length, saved.timeDeltas.length);
    const covered = saved.timeDeltas.reduce((sum, delta) => sum + delta, 0) / 1000;
    assert.ok(saved.samples.length > 10 && covered >= 180, `${saved.samples.length} samples over ${covered} ms`);
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
